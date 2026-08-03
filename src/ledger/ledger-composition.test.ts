import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { Type } from "typebox";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import {
  createBetterSqliteLedger,
  createBetterSqliteStorageRuntime,
} from "./better-sqlite3-ledger.ts";
import {
  createEventRef,
  declareLedgerModule,
  defineMaterialization,
  type WorkRef,
  linkLedgerModule,
} from "./ledger.ts";
import type { AnyComposedLedgerModel } from "./ledger-composition.ts";
import { composeLedgerModulesForTest } from "./ledger-composition.test-support.ts";
import {
  createTursoLedger,
  createTursoStorageRuntime,
} from "./turso-ledger.ts";
import { createBetterSqliteDriver } from "../better-sqlite3-ledger.ts";
import { defineLedger } from "../sledge.ts";
import { createTursoDriver } from "../turso-ledger.ts";

const nowMs = 1_900_000_000_000;
const runtime = new VirtualRuntimeHarness(nowMs);
const timing = {
  clock: runtime.clock,
  scheduler: runtime.scheduler,
};
const RecordIndexerInputSchema = Type.Object({
  eventId: Type.Number(),
});
const CountQueryParamsSchema = Type.Object({});
const CountQueryResultSchema = Type.Number();

function defineGenericSourceModule<const TModuleId extends string>(
  moduleId: TModuleId,
) {
  const shape = declareLedgerModule({
    moduleId,
    events: {
      created: Type.Object({
        id: Type.String(),
      }),
    },
  });
  const materialization = defineMaterialization(shape, {
    namespace: "state",
  })
    .version(1, "initialize generic source state", (schema) => schema)
    .define({
      indexers: {},
      queries: {
        byId: {
          params: Type.Object({
            id: Type.String(),
          }),
          result: Type.Object({
            id: Type.String(),
          }),
        },
      },
    });

  return linkLedgerModule(shape, materialization).register({
    queries: {
      byId: async ({ params }) => {
        return params;
      },
    },
  });
}

function defineGenericConsumerModule<
  const TModuleId extends string,
  const TSourceModuleId extends string,
>(input: {
  readonly moduleId: TModuleId;
  readonly source: ReturnType<
    typeof defineGenericSourceModule<TSourceModuleId>
  >;
}) {
  const shape = declareLedgerModule({
    moduleId: input.moduleId,
    events: {
      sourceCreated: input.source.events.created,
    },
  });
  const materialization = defineMaterialization(shape, {
    namespace: "state",
  })
    .version(1, "initialize generic consumer state", (schema) => schema)
    .define({
      indexers: {},
      queries: {
        sourceById: input.source.queries.byId,
      },
    });

  return linkLedgerModule(shape, materialization).register({
    events: {
      sourceCreated: async ({ event, actions }) => {
        const source = await actions.query("sourceById", {
          id: event.payload.id,
        });

        source.id satisfies string;
      },
    },
  });
}

if (false) {
  // @ts-expect-error Work refs are produced by Sledge, not application strings.
  const invalidWorkRef: WorkRef = "work:v1:application-value";
  void invalidWorkRef;

  const genericSource = defineGenericSourceModule("contract.generic-source");
  const genericConsumer = defineGenericConsumerModule({
    moduleId: "contract.generic-consumer",
    source: genericSource,
  });

  genericConsumer.events
    .sourceCreated satisfies typeof genericSource.events.created;
  genericConsumer.queries
    .sourceById satisfies typeof genericSource.queries.byId;
  composeLedgerModulesForTest(genericSource, genericConsumer);
}

for (const driver of ["better-sqlite3", "turso"] as const) {
  test(`${driver} composes modules into one atomic ledger`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), `sledge-composition-${driver}-`),
    );
    const databaseUrl = join(directory, "ledger.sqlite");
    const contributions: string[] = [];
    let remainingWorkRef: WorkRef | null = null;
    let rejectAppend = false;
    let phase = "define models";

    try {
      const sourceShape = declareLedgerModule({
        moduleId: "contract.source",
        events: {
          created: Type.Object({
            id: Type.String(),
          }),
        },
        queues: {
          deliver: Type.Object({
            eventId: Type.Number(),
          }),
        },
        signals: {
          progressed: Type.Object({
            eventId: Type.Number(),
          }),
        },
        signalQueues: {},
      });
      const sourceMaterializations = defineMaterialization(sourceShape, {
        namespace: "state",
      })
        .version(1, "create records", (s) =>
          s.createTable("records", (t) =>
            t
              .columns({
                eventId: t.integer().notNull(),
              })
              .primaryKey(["eventId"])
              .index("recordsByEvent", ["eventId"]),
          ),
        )
        .define({
          indexers: {
            store: {
              sourceEvent: "created",
              input: RecordIndexerInputSchema,
            },
          },
          queries: {
            count: {
              params: CountQueryParamsSchema,
              result: CountQueryResultSchema,
            },
          },
        });
      const sourceDefinition = linkLedgerModule(
        sourceShape,
        sourceMaterializations,
      );
      const source = sourceDefinition.register({
        indexers: {
          store: async ({ input, db }) => {
            const eventRef = createEventRef("created", input.eventId);
            const event = await db.readEvent(eventRef);
            const [batchEvent] = await db.readEvents([eventRef]);
            const scannedEvents = await db.scanEvents("created").execute();

            assert.equal(event?.eventName, "created");
            assert.equal(batchEvent?.eventName, "created");
            assert.equal(scannedEvents.at(-1)?.eventName, "created");
            assert.equal(scannedEvents.at(-1)?.eventId, input.eventId);

            await db
              .insertInto("records")
              .values({
                eventId: input.eventId,
              })
              .execute();
          },
        },
        queries: {
          count: async ({ db }) => {
            const rows = await db
              .selectFrom("records")
              .select(["eventId"])
              .execute();

            return rows.length;
          },
        },
        events: {
          created: async ({ event, actions }) => {
            if (false) {
              const keyed: Promise<WorkRef> = actions.enqueue(
                "deliver",
                { eventId: event.eventId },
                { workKey: "typed-key" },
              );
              const coalesced: Promise<WorkRef> = actions.enqueue(
                "deliver",
                { eventId: event.eventId },
                { coalescingKey: "typed-coalescing-key" },
              );
              const unaddressed: Promise<null> = actions.enqueue("deliver", {
                eventId: event.eventId,
              });

              void keyed;
              void coalesced;
              void unaddressed;
            }

            await actions.index("store", {
              eventId: event.eventId,
            });
            actions.enqueue(
              "deliver",
              {
                eventId: event.eventId,
              },
              {
                workKey: "delivery",
              },
            );
            const count = await actions.query("count", {});
            contributions.push(`source:${count}`);
          },
        },
      });

      assert.equal(source.events, sourceDefinition.events);
      assert.equal(source.queries, sourceDefinition.queries);
      assert.equal(source.signals, sourceDefinition.signals);

      const laterShape = declareLedgerModule({
        moduleId: "contract.later",
        events: {
          sourceCreated: source.events.created,
        },
        queues: {},
        signals: {},
        signalQueues: {},
      });
      const laterMaterializations = defineMaterialization(laterShape, {
        namespace: "state",
      })
        .version(1, "create records", (s) =>
          s.createTable("records", (t) =>
            t
              .columns({
                eventId: t.integer().notNull(),
              })
              .primaryKey(["eventId"])
              .index("recordsByEvent", ["eventId"]),
          ),
        )
        .define({
          indexers: {
            store: {
              sourceEvent: "sourceCreated",
              input: RecordIndexerInputSchema,
            },
          },
          queries: {
            count: {
              params: CountQueryParamsSchema,
              result: CountQueryResultSchema,
            },
          },
        });
      const laterDefinition = linkLedgerModule(
        laterShape,
        laterMaterializations,
      );
      const later = laterDefinition.register({
        indexers: {
          store: async ({ input, db }) => {
            await db
              .insertInto("records")
              .values({
                eventId: input.eventId,
              })
              .execute();
          },
        },
        queries: {
          count: async ({ db }) => {
            const rows = await db
              .selectFrom("records")
              .select(["eventId"])
              .execute();

            return rows.length;
          },
        },
        events: {
          sourceCreated: async ({ event, actions }) => {
            await actions.index("store", {
              eventId: event.eventId,
            });
            const count = await actions.query("count", {});
            contributions.push(`later:${count}`);
          },
        },
      });

      const consumerShape = declareLedgerModule({
        moduleId: "contract.consumer",
        events: {
          sourceCreated: source.events.created,
        },
        queues: {
          deliver: Type.Object({
            eventId: Type.Number(),
          }),
        },
        signals: {},
        signalQueues: {},
      });
      const consumerMaterializations = defineMaterialization(consumerShape, {
        namespace: "state",
      })
        .version(1, "create records", (s) =>
          s.createTable("records", (t) =>
            t
              .columns({
                eventId: t.integer().notNull(),
              })
              .primaryKey(["eventId"])
              .index("recordsByEvent", ["eventId"]),
          ),
        )
        .define({
          indexers: {
            store: {
              sourceEvent: "sourceCreated",
              input: RecordIndexerInputSchema,
            },
          },
          queries: {
            sourceCount: source.queries.count,
            laterCount: later.queries.count,
            ownCount: {
              params: CountQueryParamsSchema,
              result: CountQueryResultSchema,
            },
          },
        });
      const consumerDefinition = linkLedgerModule(
        consumerShape,
        consumerMaterializations,
      );
      const consumer = consumerDefinition.register({
        indexers: {
          store: async ({ input, db }) => {
            await db
              .insertInto("records")
              .values({
                eventId: input.eventId,
              })
              .execute();
          },
        },
        queries: {
          ownCount: async ({ db }) => {
            const rows = await db
              .selectFrom("records")
              .select(["eventId"])
              .execute();

            return rows.length;
          },
        },
        events: {
          sourceCreated: async ({ event, actions }) => {
            const sourceCount = await actions.query("sourceCount", {});
            const laterCount = await actions.query("laterCount", {});
            contributions.push(`consumer:${sourceCount}:${laterCount}`);
            actions.enqueue(
              "deliver",
              {
                eventId: event.eventId,
              },
              {
                workKey: "delivery",
              },
            );
            await actions.index("store", {
              eventId: event.eventId,
            });
            const ownCount = await actions.query("ownCount", {});
            contributions.push(`consumer-own:${ownCount}`);
          },
        },
      });

      if (false) {
        consumerDefinition.register({
          indexers: {
            store: () => {},
          },
          queries: {
            ownCount: () => 0,
            // @ts-expect-error Referenced queries are implemented only by their owner.
            sourceCount: () => 0,
          },
        });
      }

      const failureShape = declareLedgerModule({
        moduleId: "contract.failure",
        events: {
          sourceCreated: source.events.created,
        },
        queues: {},
        signals: {},
        signalQueues: {},
      });
      const failure = linkLedgerModule(failureShape, null).register({
        events: {
          sourceCreated: () => {
            contributions.push("failure");

            if (rejectAppend) {
              throw new Error("reject append");
            }
          },
        },
      });
      const application = defineLedger((sledge) => {
        const sourceCapabilities = sledge.install({
          module: source,
          capabilities: {},
        });
        const consumerCapabilities = sledge.install({
          module: consumer,
          capabilities: {},
        });
        const laterCapabilities = sledge.install({
          module: later,
          capabilities: {},
        });
        sledge.install({ module: failure, capabilities: {} });

        return sledge.expose({
          consumer: consumerCapabilities,
          later: laterCapabilities,
          source: sourceCapabilities,
        });
      });
      const openLedger = async () => {
        if (driver === "better-sqlite3") {
          const opened = await application.open(
            createBetterSqliteDriver({ databaseUrl }),
            timing,
          );

          return opened.ledger;
        }

        const opened = await application.open(
          createTursoDriver({ databaseUrl }),
          timing,
        );

        return opened.ledger;
      };

      phase = "open first ledger";
      let ledger = await openLedger();

      try {
        phase = "append and query";
        assert.equal(Object.isFrozen(sourceShape.events.created), true);
        assert.deepEqual(Object.keys(sourceShape.events.created), []);
        assert.equal(consumer.events.sourceCreated, source.events.created);
        assert.equal(consumer.queries.sourceCount, source.queries.count);

        const event = await ledger.emit(source.events.created, {
          id: "account-1",
        });

        assert.equal(event.eventId, 1);
        assert.equal(event.event, source.events.created);
        assert.deepEqual(contributions, [
          "source:1",
          "consumer:1:0",
          "consumer-own:1",
          "later:1",
          "failure",
        ]);
        assert.equal(await ledger.query(consumer.queries.sourceCount, {}), 1);
        assert.equal(await ledger.query(consumer.queries.laterCount, {}), 1);
        assert.equal(await ledger.query(consumer.queries.ownCount, {}), 1);

        const work = await ledger.listWork({
          queueName: "deliver",
        });

        assert.equal(work.length, 2);
        assert.deepEqual(
          work.map((item) => item.queueName),
          ["deliver", "deliver"],
        );
        const [firstWork, secondWork] = work;

        if (
          firstWork?.ref === null ||
          firstWork === undefined ||
          secondWork?.ref === null ||
          secondWork === undefined
        ) {
          throw new Error("expected durable work refs");
        }

        assert.equal(typeof firstWork.ref, "string");
        assert.equal(typeof secondWork.ref, "string");
        assert.notEqual(firstWork.ref, secondWork.ref);
        assert.equal(
          (await ledger.queryWork({ workId: firstWork.workId }))?.queueName,
          "deliver",
        );
        assert.deepEqual(
          await ledger.listWork({
            queueName: "sledge::contract.source::queue::deliver",
          }),
          [],
        );
        const cancellation = await ledger.cancelWork({
          ref: firstWork.ref,
          reason: "contract cancellation",
        });

        assert.equal(cancellation.status, "cancelled");

        if (cancellation.status !== "cancelled") {
          throw new Error("expected cancelled work");
        }

        assert.equal(cancellation.work.queueName, "deliver");
        assert.equal(cancellation.work.ref, firstWork.ref);
        assert.deepEqual(
          (await ledger.listWork()).map((item) => item.state),
          ["cancelled", "pending"],
        );
        remainingWorkRef = secondWork.ref;

        rejectAppend = true;
        await assert.rejects(
          ledger.emit(source.events.created, {
            id: "account-2",
          }),
          /reject append/,
        );
        assert.equal(await ledger.query(source.queries.count, {}), 1);
        assert.equal(await ledger.query(later.queries.count, {}), 1);
        assert.equal(await ledger.query(consumer.queries.ownCount, {}), 1);

        const abortController = new AbortController();
        const iterator = ledger
          .tailEvents({
            last: 10,
            signal: abortController.signal,
          })
          [Symbol.asyncIterator]();
        const persisted = await iterator.next();
        abortController.abort();
        await iterator.return?.();

        assert.equal(persisted.done, false);
        assert.equal(persisted.value.event.event, source.events.created);
        assert.equal(persisted.value.event.eventId, 1);
      } finally {
        phase = "close first ledger";
        await ledger.close();
      }

      phase = "open second ledger";
      ledger = await openLedger();
      try {
        phase = "query after restart";
        assert.equal(await ledger.query(source.queries.count, {}), 1);
        assert.equal(await ledger.query(later.queries.count, {}), 1);
        assert.equal(await ledger.query(consumer.queries.ownCount, {}), 1);

        if (remainingWorkRef === null) {
          throw new Error("expected remaining work ref");
        }

        const cancellation = await ledger.cancelWork({
          ref: remainingWorkRef,
          reason: "contract cancellation after restart",
        });

        assert.equal(cancellation.status, "cancelled");
        assert.deepEqual(
          (await ledger.listWork()).map((item) => item.state),
          ["cancelled", "cancelled"],
        );
      } finally {
        phase = "close second ledger";
        await ledger.close();
      }

      phase = "inspect durable schema";
      const storage =
        driver === "better-sqlite3"
          ? createBetterSqliteStorageRuntime(databaseUrl)
          : await createTursoStorageRuntime(databaseUrl);
      try {
        await storage.read(async (database) => {
          const schemaNames = (
            await database
              .prepare(
                `SELECT name
                 FROM sqlite_schema
                 WHERE type IN ('table', 'index')`,
              )
              .all()
          ).map((row) => readStringColumn(row, "name").toLowerCase());

          for (const moduleId of [
            "contract.source",
            "contract.consumer",
            "contract.later",
          ]) {
            assert.equal(
              schemaNames.includes(
                `sledge::${moduleId}::table::records`.toLowerCase(),
              ),
              true,
            );
            assert.equal(
              schemaNames.includes(
                `sledge::${moduleId}::index::recordsByEvent`.toLowerCase(),
              ),
              true,
              JSON.stringify(schemaNames),
            );
          }

          const namespaces = (
            await database
              .prepare(
                `SELECT namespace
                 FROM sledge_materialization_versions
                 ORDER BY namespace`,
              )
              .all()
          ).map((row) => readStringColumn(row, "namespace"));

          assert.deepEqual(namespaces, [
            "sledge::contract.consumer::materialization::state",
            "sledge::contract.later::materialization::state",
            "sledge::contract.source::materialization::state",
          ]);
          assert.deepEqual(
            await database
              .prepare(
                `SELECT event_name
                 FROM events
                 ORDER BY event_id`,
              )
              .all(),
            [
              {
                event_name: "sledge::contract.source::event::created",
              },
            ],
          );
          assert.deepEqual(
            await database
              .prepare(
                `SELECT queue_name
                 FROM work
                 ORDER BY queue_name`,
              )
              .all(),
            [
              {
                queue_name: "sledge::contract.consumer::queue::deliver",
              },
              {
                queue_name: "sledge::contract.source::queue::deliver",
              },
            ],
          );
          assert.deepEqual(
            await database
              .prepare(
                `SELECT module_ids_json
                 FROM sledge_ledger_root
                 WHERE singleton = 1`,
              )
              .get(),
            {
              module_ids_json:
                '["contract.source","contract.consumer","contract.later","contract.failure"]',
            },
          );
        });
      } finally {
        await storage.close();
      }
    } catch (error: unknown) {
      throw new Error(`${driver} composition failed during ${phase}`, {
        cause: error,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test(`${driver} rejects a different composed root for an existing database`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), `sledge-root-identity-${driver}-`),
    );
    const databaseUrl = join(directory, "ledger.sqlite");
    const firstShape = declareLedgerModule({
      moduleId: "contract.root-first",
      events: {},
    });
    const first = linkLedgerModule(firstShape, null).register({});
    const secondShape = declareLedgerModule({
      moduleId: "contract.root-second",
      events: {},
    });
    const second = linkLedgerModule(secondShape, null).register({});
    const openLedger = async (model: AnyComposedLedgerModel) => {
      if (driver === "better-sqlite3") {
        return createBetterSqliteLedger({
          databaseUrl,
          model,
          timing,
        });
      }

      return await createTursoLedger({
        databaseUrl,
        model,
        timing,
      });
    };

    try {
      const owningLedger = await openLedger(
        composeLedgerModulesForTest(first, second),
      );
      await owningLedger.listWork();
      await owningLedger.close();

      for (const mismatchedModel of [
        composeLedgerModulesForTest(second, first),
        composeLedgerModulesForTest(first),
      ]) {
        await assert.rejects(openLedger(mismatchedModel), (error: unknown) =>
          errorTreeIncludesMessage(
            error,
            "database belongs to composed ledger root",
          ),
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test(`${driver} keeps physical event names out of dedupe conflicts`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), `sledge-dedupe-identity-${driver}-`),
    );
    const databaseUrl = join(directory, "ledger.sqlite");
    const first = declareLedgerModule({
      moduleId: "contract.dedupe-first",
      events: {
        created: Type.Object({}),
      },
    });
    const second = declareLedgerModule({
      moduleId: "contract.dedupe-second",
      events: {
        updated: Type.Object({}),
      },
    });
    const model = composeLedgerModulesForTest(
      linkLedgerModule(first, null).register({}),
      linkLedgerModule(second, null).register({}),
    );
    const openLedger = async () => {
      if (driver === "better-sqlite3") {
        return createBetterSqliteLedger({
          databaseUrl,
          model,
          timing,
        });
      }

      return await createTursoLedger({
        databaseUrl,
        model,
        timing,
      });
    };

    try {
      const ledger = await openLedger();

      try {
        await ledger.emit(first.events.created, {}, { dedupeKey: "shared" });
        await assert.rejects(
          ledger.emit(second.events.updated, {}, { dedupeKey: "shared" }),
          (error: unknown) => {
            assert.equal(errorTreeIncludesMessage(error, "sledge::"), false);
            return errorTreeIncludesMessage(
              error,
              "dedupe key shared already belongs to another event contract",
            );
          },
        );
      } finally {
        await ledger.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}

test("composition requires unique module ids and exact contract owners", () => {
  const sourceShape = declareLedgerModule({
    moduleId: "contract.owner",
    events: {
      created: Type.Object({}),
    },
    queues: {
      privateQueue: Type.Object({}),
    },
    signals: {},
    signalQueues: {},
  });
  const source = linkLedgerModule(sourceShape, null).register({});
  const consumerShape = declareLedgerModule({
    moduleId: "contract.consumer",
    events: {
      sourceCreated: sourceShape.events.created,
    },
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const consumer = linkLedgerModule(consumerShape, null).register({});

  assert.throws(
    () => composeLedgerModulesForTest(source, source),
    /duplicate ledger module id contract\.owner/,
  );

  if (false) {
    const root = composeLedgerModulesForTest(source, consumer);
    // @ts-expect-error Composition is defined once at the root.
    composeLedgerModulesForTest(root);
  }

  const imposterShape = declareLedgerModule({
    moduleId: "contract.owner",
    events: {
      other: Type.Object({}),
    },
    queues: {},
    signals: {},
    signalQueues: {},
  });

  assert.throws(
    () =>
      composeLedgerModulesForTest(
        linkLedgerModule(imposterShape, null).register({}),
        consumer,
      ),
    /references unavailable event contract\.owner\.created/,
  );

  const queryOwnerShape = declareLedgerModule({
    moduleId: "contract.query-owner",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const queryOwnerMaterializations = defineMaterialization(queryOwnerShape, {
    namespace: "state",
  })
    .version(1, "create state", (s) =>
      s.createTable("state", (t) =>
        t
          .columns({
            id: t.text().notNull(),
          })
          .primaryKey(["id"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        count: {
          params: CountQueryParamsSchema,
          result: CountQueryResultSchema,
        },
      },
    });
  const queryOwnerDefinition = linkLedgerModule(
    queryOwnerShape,
    queryOwnerMaterializations,
  );
  const queryConsumerShape = declareLedgerModule({
    moduleId: "contract.query-consumer",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const queryConsumerMaterializations = defineMaterialization(
    queryConsumerShape,
    {
      namespace: "state",
    },
  )
    .version(1, "create state", (s) =>
      s.createTable("state", (t) =>
        t
          .columns({
            id: t.text().notNull(),
          })
          .primaryKey(["id"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        sourceCount: queryOwnerDefinition.queries.count,
      },
    });
  const queryConsumer = linkLedgerModule(
    queryConsumerShape,
    queryConsumerMaterializations,
  ).register({});
  const queryImposterShape = declareLedgerModule({
    moduleId: "contract.query-owner",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });

  assert.throws(
    () =>
      composeLedgerModulesForTest(
        linkLedgerModule(queryImposterShape, null).register({}),
        queryConsumer,
      ),
    /references unavailable query contract\.query-owner\.count/,
  );

  const caseCollidingShape = declareLedgerModule({
    moduleId: "Contract.Owner",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });

  assert.throws(
    () =>
      composeLedgerModulesForTest(
        source,
        linkLedgerModule(caseCollidingShape, null).register({}),
      ),
    /duplicate ledger module id Contract\.Owner/,
  );

  if (false) {
    declareLedgerModule({
      moduleId: "contract.invalid-queue-consumer",
      events: {},
      queues: {
        // @ts-expect-error Durable queues are private to their defining module.
        borrowed: sourceShape.queues.privateQueue,
      },
      signals: {},
      signalQueues: {},
    });
  }
});

test("unused queue and signal definitions may be omitted", () => {
  const shape = declareLedgerModule({
    moduleId: "contract.minimal",
    events: {
      created: Type.Object({}),
    },
  });

  assert.deepEqual(shape.shape.queues, {});
  assert.deepEqual(shape.shape.signals, {});
  assert.deepEqual(shape.shape.signalQueues, {});
  assert.doesNotThrow(() =>
    composeLedgerModulesForTest(linkLedgerModule(shape, null).register({})),
  );
});

test("result-bearing events require an owning handler at registration", () => {
  const shape = declareLedgerModule({
    moduleId: "contract.result-handler",
    events: {
      recorded: {
        payload: Type.Object({
          id: Type.String(),
        }),
        outcome: Type.Object({
          revision: Type.Number(),
        }),
      },
    },
  });
  const linked = linkLedgerModule(shape, null);

  if (false) {
    // @ts-expect-error A result-bearing event is unusable without its owner.
    linked.register({});
  }

  assert.throws(
    () => Reflect.apply(linked.register, linked, [{}]),
    /result-bearing event contract\.result-handler\.recorded requires an owning handler/,
  );
});

test("contract maps preserve names inherited by Object.prototype", () => {
  const inheritedName = "__proto__" as const;
  const shape = declareLedgerModule({
    moduleId: "contract.prototype-name",
    events: {
      [inheritedName]: Type.Object({}),
    },
    queues: {
      [inheritedName]: Type.Object({}),
    },
    signals: {
      [inheritedName]: Type.Object({}),
    },
    signalQueues: {
      [inheritedName]: Type.Object({}),
    },
  });
  const materializations = defineMaterialization(shape, {
    namespace: "state",
  })
    .version(1, "create state", (s) =>
      s.createTable("state", (t) =>
        t
          .columns({
            id: t.text().notNull(),
          })
          .primaryKey(["id"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        [inheritedName]: {
          params: CountQueryParamsSchema,
          result: CountQueryResultSchema,
        },
      },
    });
  const definition = linkLedgerModule(shape, materializations);

  assert.equal(Object.hasOwn(shape.events, inheritedName), true);
  assert.equal(Object.hasOwn(shape.signals, inheritedName), true);
  assert.equal(Object.hasOwn(shape.shape.events, inheritedName), true);
  assert.equal(Object.hasOwn(shape.shape.queues, inheritedName), true);
  assert.equal(Object.hasOwn(shape.shape.signals, inheritedName), true);
  assert.equal(Object.hasOwn(shape.shape.signalQueues, inheritedName), true);
  assert.equal(Object.hasOwn(definition.queries, inheritedName), true);
  assert.doesNotThrow(() =>
    composeLedgerModulesForTest(
      definition.register({
        queries: {
          [inheritedName]: () => 0,
        },
        queues: {
          [inheritedName]: () => {},
        },
        signalQueues: {
          [inheritedName]: () => {},
        },
      }),
    ),
  );
});

function errorTreeIncludesMessage(error: unknown, message: string): boolean {
  if (error instanceof Error && error.message.includes(message)) {
    return true;
  }

  if (error instanceof AggregateError) {
    return error.errors.some((cause: unknown) => {
      return errorTreeIncludesMessage(cause, message);
    });
  }

  return false;
}

function readStringColumn(row: unknown, columnName: string): string {
  if (typeof row !== "object" || row === null || !(columnName in row)) {
    throw new Error(`missing ${columnName} column`);
  }

  const value = (row as Record<string, unknown>)[columnName];

  if (typeof value !== "string") {
    throw new Error(`${columnName} column must be a string`);
  }

  return value;
}
