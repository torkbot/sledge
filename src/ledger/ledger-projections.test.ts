import assert from "node:assert/strict";
import test from "node:test";

import { Type, type TSchema } from "typebox";

import {
  readLedgerImplementations,
  type LedgerImplementations,
  type LedgerStorageRow,
  type LedgerStorageScope,
} from "./internal-storage.ts";
import type {
  EventEnvelope,
  EventRef,
  LedgerIndexerContext,
  MaterializationImplementationRegistration,
  QuerySchema,
  RegisteredLedgerModel,
} from "./ledger.ts";
import type {
  AnyProjectionSchema,
  ProjectionIndexerDefinitions,
  ProjectionQueryDefinitions,
} from "./projection-access.ts";
import {
  createEventRef,
  defineLedgerShape,
  defineMaterializationHistory,
  defineMaterializationSchema,
  defineMaterializations,
  withMaterializations,
} from "./ledger.ts";

const UserCreatedSchema = Type.Object({
  userId: Type.String(),
  email: Type.String(),
});

const shape = defineLedgerShape({
  events: {
    "user.created": UserCreatedSchema,
  },
  queues: {},
  signals: {},
  signalQueues: {},
});

const schema = defineMaterializationSchema({
  namespace: "test",
  version: 1,
  tables: {
    users: (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          email: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
  },
});

const history = defineMaterializationHistory(schema, (m) => [
  m.migration(1, "create users", (s) => [
    s.createTable("users", (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          email: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
    ),
  ]),
]);

const materializations = defineMaterializations({
  history,
  indexers: {
    upsertUser: {
      sourceEvent: "user.created",
      input: Type.Object({
        userId: Type.String(),
        email: Type.String(),
      }),
    },
  },
  queries: {
    userById: {
      params: Type.Object({
        userId: Type.String(),
      }),
      result: Type.Union([
        Type.Null(),
        Type.Object({
          userId: Type.String(),
          email: Type.String(),
          source: Type.Object({
            eventName: Type.Literal("user.created"),
            eventId: Type.Number(),
          }),
        }),
      ]),
    },
  },
});

const definedModel = withMaterializations(shape, materializations);

const implementations = {
  indexers: {
    upsertUser: async ({ input, event, db }) => {
      await db
        .insertInto("users")
        .values({
          userId: input.userId,
          email: input.email,
          source: event.ref,
        })
        .onConflict(["userId"])
        .doUpdateSet({
          email: input.email,
          source: event.ref,
        })
        .execute();
    },
  },
  queries: {
    userById: async ({ params, db }) => {
      return await db
        .selectFrom("users")
        .select(["userId", "email", "source"])
        .where("userId", "=", params.userId)
        .executeTakeFirst();
    },
  },
} satisfies MaterializationImplementationRegistration<
  typeof schema,
  typeof materializations.indexers,
  typeof materializations.queries
>;

const registeredModelWithoutHandlers = definedModel.register({
  indexers: implementations.indexers,
  queries: implementations.queries,
});

type FakeStatementCall = {
  readonly method: "all" | "exec" | "get" | "run";
  readonly params: readonly unknown[];
  readonly sql: string;
};

function createFakeScope(input: {
  readonly allRows: readonly LedgerStorageRow[];
  readonly getRow: LedgerStorageRow | undefined;
}): {
  readonly calls: readonly FakeStatementCall[];
  readonly scope: LedgerStorageScope;
} {
  const calls: FakeStatementCall[] = [];

  return {
    calls,
    scope: {
      exec: async (sql) => {
        calls.push({
          method: "exec",
          params: [],
          sql,
        });
      },
      prepare: (sql) => {
        return {
          all: async (...params) => {
            calls.push({
              method: "all",
              params,
              sql,
            });

            return input.allRows;
          },
          get: async (...params) => {
            calls.push({
              method: "get",
              params,
              sql,
            });

            return input.getRow;
          },
          run: async (...params) => {
            calls.push({
              method: "run",
              params,
              sql,
            });

            return {
              changes: 1,
              lastInsertRowid: 0,
            };
          },
        };
      },
    },
  };
}

function createUserCreatedContext(eventId: number): LedgerIndexerContext<{
  readonly "user.created": typeof UserCreatedSchema;
}> {
  const event: EventEnvelope<
    {
      readonly "user.created": typeof UserCreatedSchema;
    },
    "user.created"
  > = {
    eventId,
    ref: createEventRef("user.created", eventId),
    tsMs: 1_000,
    eventName: "user.created",
    payload: {
      userId: "u_123",
      email: "alice@example.com",
    },
    causationEventId: null,
    dedupeKey: null,
  };

  return {
    event,
  };
}

function readTestLedgerImplementations<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, QuerySchema<TSchema, TSchema>>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
>(
  model: RegisteredLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues,
    TProjectionSchema,
    TIndexerDefinitions,
    TQueryDefinitions
  >,
): LedgerImplementations<TIndexers, TQueries, TEvents> {
  return readLedgerImplementations<TIndexers, TQueries, TEvents>(model);
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    }),
  ]);
}

test("projection access compiles typed indexer and query definitions to storage operations", async () => {
  const implementations = readTestLedgerImplementations(
    registeredModelWithoutHandlers,
  );
  const indexer = implementations.indexers?.upsertUser;
  const query = implementations.queries?.userById;

  if (indexer === undefined) {
    throw new Error("expected upsertUser indexer implementation");
  }

  if (query === undefined) {
    throw new Error("expected userById query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      userId: "u_123",
      email: "alice@example.com",
      source: 42,
    },
  });

  await indexer(
    fake.scope,
    {
      userId: "u_123",
      email: "alice@example.com",
    },
    createUserCreatedContext(42),
  );

  assert.deepEqual(fake.calls[0], {
    method: "run",
    params: ["u_123", "alice@example.com", 42, "alice@example.com", 42],
    sql: 'INSERT INTO "users" ("userId", "email", "source") VALUES (?, ?, ?) ON CONFLICT ("userId") DO UPDATE SET "email" = ?, "source" = ?',
  });

  const row = await query(fake.scope, {
    userId: "u_123",
  });

  assert.deepEqual(fake.calls[1], {
    method: "get",
    params: ["u_123", 1],
    sql: 'SELECT "userId" AS "userId", "email" AS "email", "source" AS "source" FROM "users" WHERE "userId" = ? LIMIT ?',
  });
  assert.deepEqual(row, {
    userId: "u_123",
    email: "alice@example.com",
    source: {
      eventName: "user.created",
      eventId: 42,
    },
  });

  const invalidRefFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await assert.rejects(async () => {
    const validContext = createUserCreatedContext(1);

    await indexer(
      invalidRefFake.scope,
      {
        userId: "u_123",
        email: "alice@example.com",
      },
      {
        event: {
          ...validContext.event,
          eventId: 0,
          ref: {
            eventName: "user.created",
            eventId: 0,
          } as EventRef<"user.created">,
        },
      },
    );
  }, /event reference id must be a positive safe integer/);
  assert.deepEqual(invalidRefFake.calls, []);

  const invalidStoredRefFake = createFakeScope({
    allRows: [],
    getRow: {
      userId: "u_123",
      email: "alice@example.com",
      source: 0,
    },
  });

  await assert.rejects(async () => {
    await query(invalidStoredRefFake.scope, {
      userId: "u_123",
    });
  }, /users\.source event reference id must be a positive safe integer/);
});

test("projection access waits for unawaited writes before completing indexers", async () => {
  const unawaitedModel = withMaterializations(shape, materializations).register(
    {
      indexers: {
        upsertUser: ({ input, event, db }) => {
          void db
            .insertInto("users")
            .values({
              userId: input.userId,
              email: input.email,
              source: event.ref,
            })
            .execute();
        },
      },
      queries: implementations.queries,
    },
  );
  const indexer =
    readTestLedgerImplementations(unawaitedModel).indexers?.upsertUser;

  if (indexer === undefined) {
    throw new Error("expected upsertUser indexer implementation");
  }

  const runStarted = Promise.withResolvers<void>();
  const releaseRun = Promise.withResolvers<void>();
  const calls: FakeStatementCall[] = [];
  const scope: LedgerStorageScope = {
    exec: async (sql) => {
      calls.push({
        method: "exec",
        params: [],
        sql,
      });
    },
    prepare: (sql) => {
      return {
        all: async (...params) => {
          calls.push({
            method: "all",
            params,
            sql,
          });

          return [];
        },
        get: async (...params) => {
          calls.push({
            method: "get",
            params,
            sql,
          });

          return undefined;
        },
        run: async (...params) => {
          calls.push({
            method: "run",
            params,
            sql,
          });
          runStarted.resolve();
          await releaseRun.promise;

          return {
            changes: 1,
            lastInsertRowid: 0,
          };
        },
      };
    },
  };

  const indexerPromise = Promise.resolve(
    indexer(
      scope,
      {
        userId: "u_123",
        email: "alice@example.com",
      },
      createUserCreatedContext(42),
    ),
  );

  await runStarted.promise;
  assert.equal(await settlesWithin(indexerPromise, 5), false);
  releaseRun.resolve();
  await indexerPromise;
  assert.deepEqual(calls, [
    {
      method: "run",
      params: ["u_123", "alice@example.com", 42],
      sql: 'INSERT INTO "users" ("userId", "email", "source") VALUES (?, ?, ?)',
    },
  ]);
});

test("projection access rejects non-serializable JSON values before storage", async () => {
  const jsonSchema = defineMaterializationSchema({
    namespace: "json",
    version: 1,
    tables: {
      jsonRows: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            metadata: t.json<unknown>().notNull(),
          })
          .primaryKey(["userId"]),
    },
  });
  const jsonMaterializations = defineMaterializations({
    history: defineMaterializationHistory(jsonSchema, (m) => [
      m.migration(1, "create json rows", (s) => [
        s.createTable("jsonRows", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              metadata: t.json<unknown>().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
    ]),
    indexers: {
      insertJson: {
        sourceEvent: "user.created",
        input: Type.Object({
          userId: Type.String(),
          metadata: Type.Unknown(),
        }),
      },
      updateJson: {
        sourceEvent: "user.created",
        input: Type.Object({
          userId: Type.String(),
          metadata: Type.Unknown(),
        }),
      },
    },
    queries: {},
  });
  const registeredJsonModel = withMaterializations(
    shape,
    jsonMaterializations,
  ).register({
    indexers: {
      insertJson: async ({ input, db }) => {
        await db
          .insertInto("jsonRows")
          .values({
            userId: input.userId,
            metadata: input.metadata,
          })
          .execute();
      },
      updateJson: async ({ input, db }) => {
        await db
          .insertInto("jsonRows")
          .values({
            userId: input.userId,
            metadata: {
              existing: true,
            },
          })
          .onConflict(["userId"])
          .doUpdateSet({
            metadata: input.metadata,
          })
          .execute();
      },
    },
  });
  const jsonImplementations =
    readTestLedgerImplementations(registeredJsonModel);
  const insertJson = jsonImplementations.indexers?.insertJson;
  const updateJson = jsonImplementations.indexers?.updateJson;

  if (insertJson === undefined) {
    throw new Error("expected insertJson indexer implementation");
  }

  if (updateJson === undefined) {
    throw new Error("expected updateJson indexer implementation");
  }

  const validFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await insertJson(
    validFake.scope,
    {
      userId: "u_json",
      metadata: {
        active: true,
        count: 1,
        tags: ["alpha"],
      },
    },
    createUserCreatedContext(42),
  );

  assert.deepEqual(validFake.calls[0], {
    method: "run",
    params: [
      "u_json",
      JSON.stringify({
        active: true,
        count: 1,
        tags: ["alpha"],
      }),
    ],
    sql: 'INSERT INTO "jsonRows" ("userId", "metadata") VALUES (?, ?)',
  });

  const nullJsonFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await insertJson(
    nullJsonFake.scope,
    {
      userId: "u_null",
      metadata: null,
    },
    createUserCreatedContext(43),
  );

  assert.deepEqual(nullJsonFake.calls[0], {
    method: "run",
    params: ["u_null", "null"],
    sql: 'INSERT INTO "jsonRows" ("userId", "metadata") VALUES (?, ?)',
  });

  const invalidInsertFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await assert.rejects(async () => {
    await insertJson(
      invalidInsertFake.scope,
      {
        userId: "u_json",
        metadata: undefined,
      },
      createUserCreatedContext(44),
    );
  }, /jsonRows\.metadata must be JSON-serializable/);
  assert.deepEqual(invalidInsertFake.calls, []);

  const invalidUpdateFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await assert.rejects(async () => {
    await updateJson(
      invalidUpdateFake.scope,
      {
        userId: "u_json",
        metadata: {
          nested: () => undefined,
        },
      },
      createUserCreatedContext(45),
    );
  }, /jsonRows\.metadata\.nested must be JSON-serializable/);
  assert.deepEqual(invalidUpdateFake.calls, []);
});

test("projection access supports stateful indexers and ordered range queries", async () => {
  const stateSchema = defineMaterializationSchema({
    namespace: "stateful",
    version: 1,
    tables: {
      runState: (t) =>
        t
          .columns({
            runId: t.text().notNull(),
            latestInputEventId: t.integer().notNull(),
            messageJson: t.text(),
          })
          .primaryKey(["runId"]),
    },
  });
  const stateMaterializations = defineMaterializations({
    history: defineMaterializationHistory(stateSchema, (m) => [
      m.migration(1, "create run state", (s) => [
        s.createTable("runState", (t) =>
          t
            .columns({
              runId: t.text().notNull(),
              latestInputEventId: t.integer().notNull(),
              messageJson: t.text(),
            })
            .primaryKey(["runId"]),
        ),
      ]),
    ]),
    indexers: {
      checkpoint: {
        sourceEvent: "user.created",
        input: Type.Object({
          runId: Type.String(),
          inputEventId: Type.Number(),
          messageJson: Type.String(),
        }),
      },
      remove: {
        sourceEvent: "user.created",
        input: Type.Object({
          runId: Type.String(),
        }),
      },
    },
    queries: {
      due: {
        params: Type.Object({
          afterEventId: Type.Number(),
          limit: Type.Number(),
        }),
        result: Type.Array(
          Type.Object({
            runId: Type.String(),
            latestInputEventId: Type.Number(),
            messageJson: Type.Union([Type.Null(), Type.String()]),
          }),
        ),
      },
    },
  });
  const stateModel = withMaterializations(
    shape,
    stateMaterializations,
  ).register({
    indexers: {
      checkpoint: async ({ input, db }) => {
        const current = await db
          .selectFrom("runState")
          .select(["latestInputEventId"])
          .where("runId", "=", input.runId)
          .executeTakeFirst();

        if (
          current !== null &&
          current.latestInputEventId > input.inputEventId
        ) {
          return;
        }

        await db
          .insertInto("runState")
          .values({
            runId: input.runId,
            latestInputEventId: input.inputEventId,
            messageJson: input.messageJson,
          })
          .onConflict(["runId"])
          .doUpdateSet((e) => ({
            latestInputEventId: e.max(
              "latestInputEventId",
              e.excluded("latestInputEventId"),
            ),
            messageJson: e.coalesce("messageJson", e.excluded("messageJson")),
          }))
          .execute();
      },
      remove: async ({ input, db }) => {
        const result = await db
          .deleteFrom("runState")
          .where("runId", "=", input.runId)
          .execute();

        assert.equal(result.changes, 1);
      },
    },
    queries: {
      due: async ({ params, db }) => {
        const rows = await db
          .selectFrom("runState")
          .select(["runId", "latestInputEventId", "messageJson"])
          .where("latestInputEventId", ">", params.afterEventId)
          .whereNull("messageJson")
          .orderBy("latestInputEventId", "asc")
          .orderBy("runId")
          .limit(params.limit)
          .execute();

        return [...rows];
      },
    },
  });
  const implementations = readTestLedgerImplementations(stateModel);
  const checkpoint = implementations.indexers?.checkpoint;
  const remove = implementations.indexers?.remove;
  const due = implementations.queries?.due;

  if (checkpoint === undefined) {
    throw new Error("expected checkpoint indexer implementation");
  }

  if (remove === undefined) {
    throw new Error("expected remove indexer implementation");
  }

  if (due === undefined) {
    throw new Error("expected due query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
        runId: "run_1",
        latestInputEventId: 10,
        messageJson: null,
      },
    ],
    getRow: {
      latestInputEventId: 1,
    },
  });

  await checkpoint(
    fake.scope,
    {
      runId: "run_1",
      inputEventId: 10,
      messageJson: "hello",
    },
    createUserCreatedContext(42),
  );

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: ["run_1", 1],
    sql: 'SELECT "latestInputEventId" AS "latestInputEventId" FROM "runState" WHERE "runId" = ? LIMIT ?',
  });
  assert.deepEqual(fake.calls[1], {
    method: "run",
    params: ["run_1", 10, "hello"],
    sql: 'INSERT INTO "runState" ("runId", "latestInputEventId", "messageJson") VALUES (?, ?, ?) ON CONFLICT ("runId") DO UPDATE SET "latestInputEventId" = MAX("latestInputEventId", excluded."latestInputEventId"), "messageJson" = COALESCE("messageJson", excluded."messageJson")',
  });

  const rows = await due(fake.scope, {
    afterEventId: 0,
    limit: 25,
  });

  assert.deepEqual(fake.calls[2], {
    method: "all",
    params: [0, 25],
    sql: 'SELECT "runId" AS "runId", "latestInputEventId" AS "latestInputEventId", "messageJson" AS "messageJson" FROM "runState" WHERE "latestInputEventId" > ? AND "messageJson" IS NULL ORDER BY "latestInputEventId" ASC, "runId" ASC LIMIT ?',
  });
  assert.deepEqual(rows, [
    {
      runId: "run_1",
      latestInputEventId: 10,
      messageJson: null,
    },
  ]);

  await remove(
    fake.scope,
    {
      runId: "run_1",
    },
    createUserCreatedContext(43),
  );

  assert.deepEqual(fake.calls[3], {
    method: "run",
    params: ["run_1"],
    sql: 'DELETE FROM "runState" WHERE "runId" = ?',
  });
});

test("projection access hydrates semantic event references without exposing events table", async () => {
  const eventMaterializations = defineMaterializations({
    history,
    indexers: {},
    queries: {
      sourceEvent: {
        params: Type.Object({
          eventId: Type.Number(),
        }),
        result: Type.Union([Type.Null(), UserCreatedSchema]),
      },
    },
  });
  const eventModel = withMaterializations(
    shape,
    eventMaterializations,
  ).register({
    queries: {
      sourceEvent: async ({ params, db }) => {
        const event = await db.readEvent(
          createEventRef("user.created", params.eventId),
        );

        return event === null ? null : event.payload;
      },
    },
  });
  const sourceEvent =
    readTestLedgerImplementations(eventModel).queries?.sourceEvent;

  if (sourceEvent === undefined) {
    throw new Error("expected sourceEvent query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      causation_event_id: null,
      dedupe_key: null,
      event_id: 42,
      event_name: "user.created",
      payload_json: JSON.stringify({
        userId: "u_123",
        email: "alice@example.com",
      }),
      ts_ms: 1_000,
    },
  });

  const payload = await sourceEvent(fake.scope, {
    eventId: 42,
  });

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: [42, "user.created"],
    sql: `SELECT event_id, ts_ms, event_name, payload_json, causation_event_id, dedupe_key
       FROM events
       WHERE event_id = ?
         AND event_name = ?
         AND signal = 0`,
  });
  assert.deepEqual(payload, {
    userId: "u_123",
    email: "alice@example.com",
  });
});

test("ledger projection construction feeds generated contracts and implementations into the current runtime model", () => {
  const registeredModel = definedModel.register({
    indexers: implementations.indexers,
    queries: implementations.queries,
    events: {
      "user.created": async ({ event, actions }) => {
        await actions.index("upsertUser", {
          userId: event.payload.userId,
          email: event.payload.email,
        });
      },
    },
  });

  assert.equal(registeredModel.model.events["user.created"], UserCreatedSchema);
  assert.equal(
    registeredModel.model.indexers.upsertUser,
    definedModel.model.indexers.upsertUser,
  );
  assert.equal(
    registeredModel.model.queries.userById,
    definedModel.model.queries.userById,
  );
  assert.equal(
    typeof readTestLedgerImplementations(registeredModel).indexers?.upsertUser,
    "function",
  );
  assert.equal(registeredModel.projections, definedModel.projections);
});

test("ledger shape can register without projections", () => {
  const registeredModel = shape.register({
    events: {
      "user.created": ({ event }) => {
        void event.payload.userId;
      },
    },
  });

  assert.equal(registeredModel.model.events["user.created"], UserCreatedSchema);
  assert.deepEqual(registeredModel.model.indexers, {});
  assert.deepEqual(registeredModel.model.queries, {});
  assert.deepEqual(registeredModel.projections.metadata, {
    tables: {},
    relations: {},
  });
});

test("ledger projection definition applies relations over inferred tables", () => {
  const relationSchema = defineMaterializationSchema({
    namespace: "relations",
    version: 1,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      sessions: (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
            userId: t.text().notNull(),
          })
          .primaryKey(["sessionId"]),
    },
    relations: (r) => ({
      sessionUser: r
        .foreignKey("sessions", ["userId"])
        .references("users", ["userId"]),
    }),
  });
  const model = withMaterializations(
    shape,
    defineMaterializations({
      history: defineMaterializationHistory(relationSchema, (m) => [
        m.migration(1, "create relation tables", (s) => [
          s.createTable("users", (t) =>
            t
              .columns({
                userId: t.text().notNull(),
              })
              .primaryKey(["userId"]),
          ),
          s.createTable("sessions", (t) =>
            t
              .columns({
                sessionId: t.text().notNull(),
                userId: t.text().notNull(),
              })
              .primaryKey(["sessionId"]),
          ),
          s.addForeignKey("sessionUser", (r) =>
            r
              .foreignKey("sessions", ["userId"])
              .references("users", ["userId"]),
          ),
        ]),
      ]),
      indexers: {},
      queries: {},
    }),
  );

  assert.deepEqual(model.projections.metadata.relations, {
    sessionUser: {
      fromTable: "sessions",
      fromColumns: ["userId"],
      toTable: "users",
      toColumns: ["userId"],
      onDelete: "restrict",
    },
  });
});

test("materialization histories validate versions and record typed operations", () => {
  const schemaV2 = defineMaterializationSchema({
    namespace: "plan",
    version: 2,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text(),
          })
          .primaryKey(["userId"])
          .index("usersByEmail", ["email"])
          .unique("usersByEmailUnique", ["email"]),
    },
  });

  const historyV2 = defineMaterializationHistory(schemaV2, (m) => [
    m.migration(1, "create users", (s) => [
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    ]),
    m.migration(2, "add user email", (s) => [
      s.addColumn("users", "email", (t) => t.text()),
      s.data("backfill user email", async ({ db }) => {
        for await (const row of db
          .selectFrom("users")
          .select(["userId"])
          .stream()) {
          await db
            .updateTable("users")
            .set({
              email: `${row.userId}@example.invalid`,
            })
            .where("userId", "=", row.userId)
            .execute();
        }
      }),
      s.createIndex("usersByEmail", "users", ["email"]),
      s.createUniqueIndex("usersByEmailUnique", "users", ["email"]),
    ]),
  ]);

  assert.equal(
    defineMaterializations({
      history: historyV2,
      indexers: {},
      queries: {},
    }).history.current,
    schemaV2,
  );
  const secondMigration = historyV2.migrations[1];

  assert.ok(secondMigration !== undefined);
  assert.deepEqual(secondMigration.operations[0], {
    column: {
      eventName: null,
      kind: "text",
      nullable: true,
    },
    columnName: "email",
    kind: "add_column",
    tableName: "users",
  });

  const dataOperation = secondMigration.operations[1];

  if (dataOperation.kind !== "data") {
    throw new Error("expected data migration operation");
  }

  assert.equal(dataOperation.description, "backfill user email");
  assert.equal(typeof dataOperation.run, "function");
  assert.deepEqual(secondMigration.operations[2], {
    index: {
      columns: ["email"],
      name: "usersByEmail",
      unique: false,
    },
    kind: "create_index",
    tableName: "users",
  });
  assert.deepEqual(secondMigration.operations[3], {
    index: {
      columns: ["email"],
      name: "usersByEmailUnique",
      unique: true,
    },
    kind: "create_index",
    tableName: "users",
  });

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
    ]);
  }, /latest migration must match current schema version/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(2, "add user email", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
    ]);
  }, /must start at version 1/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
      m.migration(1, "duplicate", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
    ]);
  }, /duplicate materialization migration version 1/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(2, "add user email", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
    ]);
  }, /ascending version order/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
      m.migration(2, "forget user email", (s) => [
        s.createIndex("usersByUserId", "users", ["userId"]),
      ]),
    ]);
  }, /materialization history table users must match current schema columns/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
        s.createIndex("usersByEmail", "users", ["email"]),
      ]),
      m.migration(2, "add user email", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
    ]);
  }, /materialization history index usersByEmail references unknown column email/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
        s.data("premature backfill", () => undefined),
      ]),
      m.migration(2, "add user email", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
    ]);
  }, /materialization data operation requires current schema table users columns/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
      m.migration(2, "forget user email index", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
    ]);
  }, /materialization history table users must match current schema keys/);

  assert.throws(() => {
    defineMaterializationHistory(schemaV2, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
      m.migration(2, "duplicate user email index", (s) => [
        s.createIndex("usersByEmail", "users", ["email"]),
        s.createIndex("usersByEmail", "users", ["userId"]),
      ]),
    ]);
  }, /materialization history index usersByEmail conflicts with usersByEmail/);
});

test("materialization histories replay foreign keys against current state", () => {
  const relationSchema = defineMaterializationSchema({
    namespace: "relation-history",
    version: 1,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      sessions: (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
            userId: t.text().notNull(),
          })
          .primaryKey(["sessionId"]),
    },
    relations: (r) => ({
      sessionUser: r
        .foreignKey("sessions", ["userId"])
        .references("users", ["userId"]),
    }),
  });

  assert.throws(() => {
    defineMaterializationHistory(relationSchema, (m) => [
      m.migration(1, "create relation tables", (s) => [
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
        s.addForeignKey("sessionUser", (r) =>
          r.foreignKey("sessions", ["userId"]).references("users", ["userId"]),
        ),
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
    ]);
  }, /materialization history relation sessionUser references unknown table users/);

  assert.throws(() => {
    defineMaterializationHistory(relationSchema, (m) => [
      m.migration(1, "create relation tables", (s) => [
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
    ]);
  }, /materialization history must match current schema relations/);

  const relationByEmailSchema = defineMaterializationSchema({
    namespace: "relation-key-history",
    version: 2,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
          })
          .primaryKey(["userId"])
          .unique("usersByEmail", ["email"]),
      sessions: (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
            email: t.text().notNull(),
          })
          .primaryKey(["sessionId"]),
    },
    relations: (r) => ({
      sessionUserEmail: r
        .foreignKey("sessions", ["email"])
        .references("users", ["email"]),
    }),
  });

  assert.throws(() => {
    defineMaterializationHistory(relationByEmailSchema, (m) => [
      m.migration(1, "create relation tables", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              email: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
        s.addForeignKey("sessionUserEmail", (r) =>
          r.foreignKey("sessions", ["email"]).references("users", ["email"]),
        ),
      ]),
      m.migration(2, "add email key", (s) => [
        s.createUniqueIndex("usersByEmail", "users", ["email"]),
      ]),
    ]);
  }, /materialization history relation sessionUserEmail must target a primary or unique key on users/);
});

test("materialization histories compare replayed columns by name", () => {
  const reorderedSchema = defineMaterializationSchema({
    namespace: "column-order",
    version: 2,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            displayName: t.text(),
            email: t.text(),
          })
          .primaryKey(["userId"]),
    },
  });
  const reorderedHistory = defineMaterializationHistory(
    reorderedSchema,
    (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
      m.migration(2, "add display name", (s) => [
        s.addColumn("users", "displayName", (t) => t.text()),
      ]),
    ],
  );

  assert.equal(reorderedHistory.current, reorderedSchema);
});

test("withMaterializations rejects materialization event refs outside the ledger shape", () => {
  const invalidSchema = defineMaterializationSchema({
    namespace: "invalid-events",
    version: 1,
    tables: {
      sessions: (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
            source: t.eventRef("session.created").notNull(),
          })
          .primaryKey(["sessionId"]),
    },
  });
  const invalidMaterializations = defineMaterializations({
    history: defineMaterializationHistory(invalidSchema, (m) => [
      m.migration(1, "create invalid sessions", (s) => [
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              source: t.eventRef("session.created").notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
      ]),
    ]),
    indexers: {},
    queries: {},
  });

  assert.throws(() => {
    // @ts-expect-error runtime validation protects unchecked callers too.
    withMaterializations(shape, invalidMaterializations);
  }, /references unknown event session\.created/);

  const validSchemaV2 = defineMaterializationSchema({
    namespace: "invalid-events",
    version: 2,
    tables: {
      sessions: (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
          })
          .primaryKey(["sessionId"]),
    },
  });
  assert.throws(() => {
    defineMaterializationHistory(validSchemaV2, (m) => [
      m.migration(1, "create sessions", (s) => [
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              // @ts-expect-error runtime validation protects unchecked callers too.
              source: t.eventRef("session.created").notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
      ]),
      m.migration(2, "index sessions", (s) => [
        s.createIndex("sessionsBySessionId", "sessions", ["sessionId"]),
      ]),
    ]);
  }, /materialization history table sessions must match current schema columns/);
});

test("withMaterializations rejects unchecked indexer source events outside the ledger shape", () => {
  const invalidIndexerMaterializations = defineMaterializations({
    history,
    indexers: {
      invalidSource: {
        sourceEvent: "session.created",
        input: Type.Object({}),
      },
    },
    queries: {},
  });

  assert.throws(() => {
    // @ts-expect-error runtime validation protects unchecked callers too.
    withMaterializations(shape, invalidIndexerMaterializations);
  }, /references unknown source event session\.created/);
});

async function assertLedgerProjectionTypes(): Promise<void> {
  const multiEventShape = defineLedgerShape({
    events: {
      "session.created": Type.Object({
        sessionId: Type.String(),
      }),
      "user.created": UserCreatedSchema,
    },
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const multiEventSchema = defineMaterializationSchema({
    namespace: "source-events",
    version: 1,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
    },
  });
  const multiEventMaterializations = defineMaterializations({
    history: defineMaterializationHistory(multiEventSchema, (m) => [
      m.migration(1, "create users", (s) => [
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      ]),
    ]),
    indexers: {
      upsertUser: {
        sourceEvent: "user.created",
        input: Type.Object({
          userId: Type.String(),
        }),
      },
    },
    queries: {},
  });
  const multiEventModel = withMaterializations(
    multiEventShape,
    multiEventMaterializations,
  );

  multiEventModel.register({
    indexers: {
      upsertUser: () => undefined,
    },
    events: {
      "session.created": async ({ actions }) => {
        // @ts-expect-error event handlers can only call indexers for their event.
        await actions.index("upsertUser", {
          userId: "u_123",
        });
      },
      "user.created": async ({ actions }) => {
        await actions.index("upsertUser", {
          userId: "u_123",
        });
      },
    },
  });

  const typedSchema = defineMaterializationSchema({
    namespace: "types",
    version: 1,
    tables: {
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
    },
  });

  const typedHistory = defineMaterializationHistory(typedSchema, (m) => [
    m.migration(1, "create users", (s) => [
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
      s.data("typed user data", async ({ db }) => {
        const row = await db
          .selectFrom("users")
          .select(["email"])
          .executeTakeFirst();

        if (row !== null) {
          const email: string = row.email;
          // @ts-expect-error only selected columns are available.
          const userId: string = row.userId;

          void email;
          void userId;
        }

        await db
          .insertInto("users")
          .values({
            userId: "u_123",
            email: "alice@example.com",
            source: createEventRef("user.created", 1),
          })
          .execute();
        await db
          .updateTable("users")
          .set({
            email: "alice@example.com",
          })
          .where("userId", "=", "u_123")
          .execute();
        await db.deleteFrom("users").where("userId", "=", "u_123").execute();

        // @ts-expect-error migration data cannot select unknown tables.
        db.selectFrom("sessions");
        // @ts-expect-error migration data can only select known columns.
        db.selectFrom("users").select(["missing"]);
        // @ts-expect-error migration data can only update known columns.
        db.updateTable("users").set({ missing: "" });
      }),
    ]),
  ]);

  const invalidMigrationHistory = defineMaterializationHistory(
    typedSchema,
    (m) => [
      m.migration(1, "invalid", (s) => [
        // @ts-expect-error migration operations only reference known tables.
        s.createIndex("missing", "sessions", ["sessionId"]),
        // @ts-expect-error migration operations only reference known columns.
        s.addColumn("users", "missing", (t) => t.text()),
        s.addColumn("users", "source", (t) =>
          // @ts-expect-error migration event refs must come from the current schema.
          t.eventRef("session.created").notNull(),
        ),
      ]),
    ],
  );

  void invalidMigrationHistory;

  const invalidSource = defineMaterializations({
    history: typedHistory,
    indexers: {
      invalidSource: {
        sourceEvent: "session.created",
        input: Type.Object({}),
      },
    },
    queries: {},
  });

  // @ts-expect-error indexer source events must come from the ledger shape.
  withMaterializations(shape, invalidSource);

  const typedMaterializations = defineMaterializations({
    history: typedHistory,
    indexers: {
      wrongEventRef: {
        sourceEvent: "user.created",
        input: Type.Object({}),
      },
      incompleteInsert: {
        sourceEvent: "user.created",
        input: Type.Object({}),
      },
      nonKeyConflict: {
        sourceEvent: "user.created",
        input: Type.Object({}),
      },
    },
    queries: {
      selectedColumns: {
        params: Type.Object({}),
        result: Type.Null(),
      },
    },
  });

  const typedImplementations = {
    indexers: {
      wrongEventRef: async ({ db }) => {
        await db
          .insertInto("users")
          .values({
            userId: "u_123",
            email: "alice@example.com",
            // @ts-expect-error event_ref columns only accept matching event refs.
            source: createEventRef("session.created", 1),
          })
          .execute();
      },
      incompleteInsert: async ({ db, event }) => {
        await db
          .insertInto("users")
          // @ts-expect-error inserts must provide every projection column.
          .values({
            userId: "u_123",
            source: event.ref,
          })
          .execute();
      },
      nonKeyConflict: async ({ db, event }) => {
        await db
          .insertInto("users")
          .values({
            userId: "u_123",
            email: "alice@example.com",
            source: event.ref,
          })
          // @ts-expect-error conflict targets must be primary or unique keys.
          .onConflict(["email"])
          .doNothing()
          .execute();
        await db
          .updateTable("users")
          .set((e) => ({
            email: e.coalesce("email", "alice@example.com"),
          }))
          .where("userId", "!=", "u_123")
          .execute();
        db.updateTable("users").set((e) => ({
          // @ts-expect-error normal updates cannot reference upsert excluded values.
          email: e.excluded("email"),
        }));
      },
    },
    queries: {
      selectedColumns: async ({ db }) => {
        const row = await db
          .selectFrom("users")
          .select(["email"])
          .executeTakeFirst();

        if (row !== null) {
          const email: string = row.email;
          // @ts-expect-error only selected columns are available.
          const userId: string = row.userId;

          void email;
          void userId;
        }

        const event = await db.readEvent(createEventRef("user.created", 1));

        if (event !== null) {
          const userId: string = event.payload.userId;
          void userId;
        }

        // @ts-expect-error queries cannot mutate materialization tables.
        db.updateTable("users");

        return null;
      },
    },
  } satisfies MaterializationImplementationRegistration<
    typeof typedSchema,
    typeof typedMaterializations.indexers,
    typeof typedMaterializations.queries,
    typeof shape.shape.events
  >;

  void typedImplementations;
}

void assertLedgerProjectionTypes;
