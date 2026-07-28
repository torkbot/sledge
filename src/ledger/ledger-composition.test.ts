import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { Type } from "typebox";

import {
  createBetterSqliteLedger,
  createBetterSqliteStorageRuntime,
} from "./better-sqlite3-ledger.ts";
import {
  composeLedgerModels,
  defineLedgerShape,
  defineMaterialization,
  withMaterializations,
} from "./ledger.ts";
import {
  createTursoLedger,
  createTursoStorageRuntime,
} from "./turso-ledger.ts";

const nowMs = 1_900_000_000_000;
const timing = {
  clock: {
    nowMs: () => nowMs,
  },
};
const RecordIndexerInputSchema = Type.Object({
  eventId: Type.Number(),
});
const CountQueryParamsSchema = Type.Object({});
const CountQueryResultSchema = Type.Number();

for (const driver of ["better-sqlite3", "turso"] as const) {
  test(`${driver} composes modules into one atomic ledger`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), `sledge-composition-${driver}-`),
    );
    const databaseUrl = join(directory, "ledger.sqlite");
    const contributions: string[] = [];
    let rejectAppend = false;
    let phase = "define models";

    try {
      const sourceShape = defineLedgerShape({
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
        signals: {},
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
      const sourceDefinition = withMaterializations(
        sourceShape,
        sourceMaterializations,
      );
      const source = sourceDefinition.register({
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
          created: async ({ event, actions }) => {
            await actions.index("store", {
              eventId: event.eventId,
            });
            actions.enqueue("deliver", {
              eventId: event.eventId,
            });
            const count = await actions.query("count", {});
            contributions.push(`source:${count}`);
          },
        },
      });

      const laterShape = defineLedgerShape({
        moduleId: "contract.later",
        events: {
          sourceCreated: sourceShape.events.created,
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
      const laterDefinition = withMaterializations(
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

      const consumerShape = defineLedgerShape({
        moduleId: "contract.consumer",
        events: {
          sourceCreated: sourceShape.events.created,
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
            sourceCount: sourceDefinition.queries.count,
            laterCount: laterDefinition.queries.count,
            ownCount: {
              params: CountQueryParamsSchema,
              result: CountQueryResultSchema,
            },
          },
        });
      const consumerDefinition = withMaterializations(
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
            actions.enqueue("deliver", {
              eventId: event.eventId,
            });
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

      const failureShape = defineLedgerShape({
        moduleId: "contract.failure",
        events: {
          sourceCreated: sourceShape.events.created,
        },
        queues: {},
        signals: {},
        signalQueues: {},
      });
      const failure = failureShape.register({
        events: {
          sourceCreated: () => {
            contributions.push("failure");

            if (rejectAppend) {
              throw new Error("reject append");
            }
          },
        },
      });
      const model = composeLedgerModels(source, consumer, later, failure);
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

      phase = "open first ledger";
      let ledger = await openLedger();

      try {
        phase = "append and query";
        assert.equal(Object.isFrozen(sourceShape.events.created), true);
        assert.deepEqual(Object.keys(sourceShape.events.created), []);
        assert.equal(
          consumerShape.events.sourceCreated,
          sourceShape.events.created,
        );
        assert.equal(
          consumerDefinition.queries.sourceCount,
          sourceDefinition.queries.count,
        );

        const event = await ledger.emit(sourceShape.events.created, {
          id: "account-1",
        });

        assert.equal(event.eventId, 1);
        assert.equal(event.event, sourceShape.events.created);
        assert.deepEqual(contributions, [
          "source:1",
          "consumer:1:0",
          "consumer-own:1",
          "later:1",
          "failure",
        ]);
        assert.equal(
          await ledger.query(consumerDefinition.queries.sourceCount, {}),
          1,
        );
        assert.equal(
          await ledger.query(consumerDefinition.queries.laterCount, {}),
          1,
        );
        assert.equal(
          await ledger.query(consumerDefinition.queries.ownCount, {}),
          1,
        );

        rejectAppend = true;
        await assert.rejects(
          ledger.emit(sourceShape.events.created, {
            id: "account-2",
          }),
          /reject append/,
        );
        assert.equal(await ledger.query(sourceDefinition.queries.count, {}), 1);
        assert.equal(await ledger.query(laterDefinition.queries.count, {}), 1);
        assert.equal(
          await ledger.query(consumerDefinition.queries.ownCount, {}),
          1,
        );

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
        assert.equal(persisted.value.event.event, sourceShape.events.created);
        assert.equal(persisted.value.event.eventId, 1);
      } finally {
        phase = "close first ledger";
        await ledger.close();
      }

      phase = "open second ledger";
      ledger = await openLedger();
      try {
        phase = "query after restart";
        assert.equal(await ledger.query(sourceDefinition.queries.count, {}), 1);
        assert.equal(await ledger.query(laterDefinition.queries.count, {}), 1);
        assert.equal(
          await ledger.query(consumerDefinition.queries.ownCount, {}),
          1,
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
                `SELECT version
                 FROM sledge_storage_layout
                 WHERE singleton = 1`,
              )
              .get(),
            {
              version: 1,
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

  test(`${driver} rejects a pre-composition database before mutation`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), `sledge-legacy-layout-${driver}-`),
    );
    const databaseUrl = join(directory, "ledger.sqlite");

    try {
      const database = new Database(databaseUrl);
      database.exec(`
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT
        )
      `);
      database.close();

      const shape = defineLedgerShape({
        moduleId: "contract.layout",
        events: {
          pinged: Type.Object({}),
        },
        queues: {},
        signals: {},
        signalQueues: {},
      });
      const model = composeLedgerModels(shape.register({}));
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
      const ledger = await openLedger();

      await assert.rejects(
        async () => {
          await ledger.close();
        },
        (error: unknown) => {
          return errorTreeIncludesMessage(
            error,
            "database uses the pre-composition Sledge storage layout",
          );
        },
      );

      const inspection = new Database(databaseUrl, {
        readonly: true,
      });
      try {
        const names = inspection
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'table'
             ORDER BY name`,
          )
          .all()
          .map((row) => readStringColumn(row, "name"));

        assert.deepEqual(names, ["events", "sqlite_sequence"]);
      } finally {
        inspection.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}

test("composition requires unique module ids and exact contract owners", () => {
  const sourceShape = defineLedgerShape({
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
  const source = sourceShape.register({});
  const consumerShape = defineLedgerShape({
    moduleId: "contract.consumer",
    events: {
      sourceCreated: sourceShape.events.created,
    },
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const consumer = consumerShape.register({});

  assert.throws(
    () => composeLedgerModels(source, source),
    /duplicate ledger module id contract\.owner/,
  );

  if (false) {
    const root = composeLedgerModels(source, consumer);
    // @ts-expect-error Composition is defined once at the root.
    composeLedgerModels(root);
  }

  const imposterShape = defineLedgerShape({
    moduleId: "contract.owner",
    events: {
      other: Type.Object({}),
    },
    queues: {},
    signals: {},
    signalQueues: {},
  });

  assert.throws(
    () => composeLedgerModels(imposterShape.register({}), consumer),
    /references unavailable event contract\.owner\.created/,
  );

  const queryOwnerShape = defineLedgerShape({
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
  const queryOwnerDefinition = withMaterializations(
    queryOwnerShape,
    queryOwnerMaterializations,
  );
  const queryConsumerShape = defineLedgerShape({
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
  const queryConsumer = withMaterializations(
    queryConsumerShape,
    queryConsumerMaterializations,
  ).register({});
  const queryImposterShape = defineLedgerShape({
    moduleId: "contract.query-owner",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });

  assert.throws(
    () => composeLedgerModels(queryImposterShape.register({}), queryConsumer),
    /references unavailable query contract\.query-owner\.count/,
  );

  const caseCollidingShape = defineLedgerShape({
    moduleId: "Contract.Owner",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });

  assert.throws(
    () => composeLedgerModels(source, caseCollidingShape.register({})),
    /duplicate ledger module id Contract\.Owner/,
  );

  if (false) {
    defineLedgerShape({
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
  const shape = defineLedgerShape({
    moduleId: "contract.minimal",
    events: {
      created: Type.Object({}),
    },
  });

  assert.deepEqual(shape.shape.queues, {});
  assert.deepEqual(shape.shape.signals, {});
  assert.deepEqual(shape.shape.signalQueues, {});
  assert.doesNotThrow(() => composeLedgerModels(shape.register({})));
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
