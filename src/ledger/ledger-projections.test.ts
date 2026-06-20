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
import { createProjectionImplementations } from "./projection-access.ts";
import {
  createSqliteProjectionStatementCompiler,
  type ProjectionStatementCompiler,
} from "./projection-sql-compiler.ts";
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
  statementCompiler: ProjectionStatementCompiler = createSqliteProjectionStatementCompiler(),
): LedgerImplementations<TIndexers, TQueries, TEvents> {
  return readLedgerImplementations<TIndexers, TQueries, TEvents>(model, {
    statementCompiler,
  });
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

test("projection implementations compile through the supplied statement compiler", async () => {
  const sqliteCompiler = createSqliteProjectionStatementCompiler();
  const statementCompiler: ProjectionStatementCompiler = {
    ...sqliteCompiler,
    compileSelect: (statement) => {
      const compiled = sqliteCompiler.compileSelect(statement);

      return {
        params: compiled.params,
        text: `${compiled.text} /* supplied compiler */`,
      };
    },
  };
  const generatedImplementations = createProjectionImplementations({
    events: shape.shape.events,
    statementCompiler,
    projections: schema,
    indexers: {},
    queries: materializations.queries,
    register: {
      queries: implementations.queries,
    },
  }) as LedgerImplementations<
    {},
    typeof materializations.queries,
    typeof shape.shape.events
  >;
  const query = generatedImplementations.queries?.userById;

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

  await query(fake.scope, {
    userId: "u_123",
  });

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: ["u_123", 1],
    sql: 'SELECT "userId" AS "userId", "email" AS "email", "source" AS "source" FROM "users" WHERE "userId" = ? LIMIT ? /* supplied compiler */',
  });
});

test("registered projection implementations use the adapter-supplied statement compiler", async () => {
  const sqliteCompiler = createSqliteProjectionStatementCompiler();
  const statementCompiler: ProjectionStatementCompiler = {
    ...sqliteCompiler,
    compileSelect: (statement) => {
      const compiled = sqliteCompiler.compileSelect(statement);

      return {
        params: compiled.params,
        text: `${compiled.text} /* adapter compiler */`,
      };
    },
  };
  const generatedImplementations = readTestLedgerImplementations(
    registeredModelWithoutHandlers,
    statementCompiler,
  );
  const query = generatedImplementations.queries?.userById;

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

  await query(fake.scope, {
    userId: "u_123",
  });

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: ["u_123", 1],
    sql: 'SELECT "userId" AS "userId", "email" AS "email", "source" AS "source" FROM "users" WHERE "userId" = ? LIMIT ? /* adapter compiler */',
  });
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

test("projection access rejects writes started after indexer completion", async () => {
  const lateWrite = {
    current: null as (() => Promise<unknown>) | null,
  };
  const lateWriteModel = withMaterializations(shape, materializations).register(
    {
      indexers: {
        upsertUser: ({ input, event, db }) => {
          lateWrite.current = async () => {
            return await db
              .insertInto("users")
              .values({
                userId: input.userId,
                email: input.email,
                source: event.ref,
              })
              .execute();
          };
        },
      },
      queries: implementations.queries,
    },
  );
  const indexer =
    readTestLedgerImplementations(lateWriteModel).indexers?.upsertUser;

  if (indexer === undefined) {
    throw new Error("expected upsertUser indexer implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await indexer(
    fake.scope,
    {
      userId: "u_123",
      email: "alice@example.com",
    },
    createUserCreatedContext(42),
  );

  const runLateWrite = lateWrite.current;
  if (runLateWrite === null) {
    throw new Error("expected late write closure");
  }

  await assert.rejects(async () => {
    await runLateWrite();
  }, /projection write scope is closed/);
  assert.deepEqual(fake.calls, []);
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

  const expressionShapedJsonFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await updateJson(
    expressionShapedJsonFake.scope,
    {
      userId: "u_expression",
      metadata: {
        metadata: {
          kind: "column",
        },
      },
    },
    createUserCreatedContext(44),
  );

  assert.deepEqual(expressionShapedJsonFake.calls[0], {
    method: "run",
    params: [
      "u_expression",
      JSON.stringify({
        existing: true,
      }),
      JSON.stringify({
        metadata: {
          kind: "column",
        },
      }),
    ],
    sql: 'INSERT INTO "jsonRows" ("userId", "metadata") VALUES (?, ?) ON CONFLICT ("userId") DO UPDATE SET "metadata" = ?',
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
      createUserCreatedContext(45),
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
      createUserCreatedContext(46),
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

test("projection access supports typed application-defined ordering", async () => {
  const profileSchema = defineMaterializationSchema({
    namespace: "profile-docs",
    version: 1,
    tables: {
      profileDocs: (t) =>
        t
          .columns({
            docId: t.text().notNull(),
            version: t.integer().notNull(),
            content: t.text().notNull(),
          })
          .primaryKey(["docId"]),
    },
  });
  const profileMaterializations = defineMaterializations({
    history: defineMaterializationHistory(profileSchema, (m) => [
      m.migration(1, "create profile docs", (s) => [
        s.createTable("profileDocs", (t) =>
          t
            .columns({
              docId: t.text().notNull(),
              version: t.integer().notNull(),
              content: t.text().notNull(),
            })
            .primaryKey(["docId"]),
        ),
      ]),
    ]),
    indexers: {},
    queries: {
      list: {
        params: Type.Object({}),
        result: Type.Array(
          Type.Object({
            docId: Type.String(),
            version: Type.Number(),
            content: Type.String(),
          }),
        ),
      },
    },
  });
  const profileModel = withMaterializations(
    shape,
    profileMaterializations,
  ).register({
    queries: {
      list: async ({ db }) => {
        const rows = await db
          .selectFrom("profileDocs")
          .select(["docId", "version", "content"])
          .orderByList("docId", ["SOUL", "IDENTITY", "USER"])
          .execute();

        return [...rows];
      },
    },
  });
  const list = readTestLedgerImplementations(profileModel).queries?.list;

  if (list === undefined) {
    throw new Error("expected list query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
        content: "soul",
        docId: "SOUL",
        version: 1,
      },
    ],
    getRow: undefined,
  });

  const rows = await list(fake.scope, {});

  assert.deepEqual(fake.calls[0], {
    method: "all",
    params: ["SOUL", 0, "IDENTITY", 1, "USER", 2, 3],
    sql: 'SELECT "docId" AS "docId", "version" AS "version", "content" AS "content" FROM "profileDocs" ORDER BY CASE "docId" WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? ELSE ? END ASC',
  });
  assert.deepEqual(rows, [
    {
      content: "soul",
      docId: "SOUL",
      version: 1,
    },
  ]);
});

test("projection access supports typed disjunction predicate groups", async () => {
  const followupSchema = defineMaterializationSchema({
    namespace: "followups",
    version: 1,
    tables: {
      followups: (t) =>
        t
          .columns({
            followupId: t.text().notNull(),
            targetRunId: t.text().notNull(),
            state: t.text().notNull(),
            requestedAtMs: t.integer().notNull(),
            nextAttemptAfterMs: t.integer(),
          })
          .primaryKey(["followupId"])
          .index("followups_by_state", ["state", "requestedAtMs"]),
    },
  });
  const followupMaterializations = defineMaterializations({
    history: defineMaterializationHistory(followupSchema, (m) => [
      m.migration(1, "create followups", (s) => [
        s.createTable("followups", (t) =>
          t
            .columns({
              followupId: t.text().notNull(),
              targetRunId: t.text().notNull(),
              state: t.text().notNull(),
              requestedAtMs: t.integer().notNull(),
              nextAttemptAfterMs: t.integer(),
            })
            .primaryKey(["followupId"])
            .index("followups_by_state", ["state", "requestedAtMs"]),
        ),
      ]),
    ]),
    indexers: {
      removeFollowups: {
        sourceEvent: "user.created",
        input: Type.Object({
          followupId: Type.String(),
          targetRunId: Type.String(),
        }),
      },
      resolveFollowups: {
        sourceEvent: "user.created",
        input: Type.Object({
          followupId: Type.String(),
          targetRunId: Type.String(),
        }),
      },
    },
    queries: {
      dueFollowups: {
        params: Type.Object({
          limit: Type.Number(),
          nowMs: Type.Number(),
          targetRunId: Type.String(),
        }),
        result: Type.Array(
          Type.Object({
            followupId: Type.String(),
            targetRunId: Type.String(),
            state: Type.String(),
            requestedAtMs: Type.Number(),
            nextAttemptAfterMs: Type.Union([Type.Null(), Type.Number()]),
          }),
        ),
      },
    },
  });
  const followupModel = withMaterializations(
    shape,
    followupMaterializations,
  ).register({
    indexers: {
      removeFollowups: async ({ input, db }) => {
        await db
          .deleteFrom("followups")
          .whereAny([
            {
              columnName: "followupId",
              kind: "comparison",
              operator: "=",
              value: input.followupId,
            },
            {
              columnName: "targetRunId",
              kind: "comparison",
              operator: "=",
              value: input.targetRunId,
            },
          ])
          .execute();
      },
      resolveFollowups: async ({ input, db }) => {
        await db
          .updateTable("followups")
          .set({
            state: "resolved",
          })
          .whereAny([
            {
              columnName: "followupId",
              kind: "comparison",
              operator: "=",
              value: input.followupId,
            },
            {
              columnName: "targetRunId",
              kind: "comparison",
              operator: "=",
              value: input.targetRunId,
            },
          ])
          .execute();
      },
    },
    queries: {
      dueFollowups: async ({ params, db }) => {
        const rows = await db
          .selectFrom("followups")
          .select([
            "followupId",
            "targetRunId",
            "state",
            "requestedAtMs",
            "nextAttemptAfterMs",
          ])
          .whereIn("state", ["active", "needs_attention"])
          .whereAny([
            {
              columnName: "targetRunId",
              kind: "comparison",
              operator: "=",
              value: params.targetRunId,
            },
            {
              columnName: "targetRunId",
              kind: "comparison",
              operator: "=",
              value: "",
            },
          ])
          .whereAny([
            {
              columnName: "nextAttemptAfterMs",
              kind: "is_null",
            },
            {
              columnName: "nextAttemptAfterMs",
              kind: "comparison",
              operator: "<=",
              value: params.nowMs,
            },
          ])
          .orderBy("requestedAtMs", "asc")
          .orderBy("followupId", "asc")
          .limit(params.limit)
          .execute();

        return [...rows];
      },
    },
  });
  const implementations = readTestLedgerImplementations(followupModel);
  const removeFollowups = implementations.indexers?.removeFollowups;
  const resolveFollowups = implementations.indexers?.resolveFollowups;
  const dueFollowups = implementations.queries?.dueFollowups;

  if (removeFollowups === undefined) {
    throw new Error("expected removeFollowups indexer implementation");
  }

  if (resolveFollowups === undefined) {
    throw new Error("expected resolveFollowups indexer implementation");
  }

  if (dueFollowups === undefined) {
    throw new Error("expected dueFollowups query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
        followupId: "f_1",
        targetRunId: "run_1",
        state: "active",
        requestedAtMs: 1_000,
        nextAttemptAfterMs: null,
      },
    ],
    getRow: undefined,
  });

  const rows = await dueFollowups(fake.scope, {
    limit: 25,
    nowMs: 2_000,
    targetRunId: "run_1",
  });

  assert.deepEqual(fake.calls[0], {
    method: "all",
    params: ["active", "needs_attention", "run_1", "", 2_000, 25],
    sql: 'SELECT "followupId" AS "followupId", "targetRunId" AS "targetRunId", "state" AS "state", "requestedAtMs" AS "requestedAtMs", "nextAttemptAfterMs" AS "nextAttemptAfterMs" FROM "followups" WHERE "state" IN (?, ?) AND ("targetRunId" = ? OR "targetRunId" = ?) AND ("nextAttemptAfterMs" IS NULL OR "nextAttemptAfterMs" <= ?) ORDER BY "requestedAtMs" ASC, "followupId" ASC LIMIT ?',
  });
  assert.deepEqual(rows, [
    {
      followupId: "f_1",
      targetRunId: "run_1",
      state: "active",
      requestedAtMs: 1_000,
      nextAttemptAfterMs: null,
    },
  ]);

  await resolveFollowups(
    fake.scope,
    {
      followupId: "f_1",
      targetRunId: "run_1",
    },
    createUserCreatedContext(42),
  );

  assert.deepEqual(fake.calls[1], {
    method: "run",
    params: ["resolved", "f_1", "run_1"],
    sql: 'UPDATE "followups" SET "state" = ? WHERE ("followupId" = ? OR "targetRunId" = ?)',
  });

  await removeFollowups(
    fake.scope,
    {
      followupId: "f_1",
      targetRunId: "run_1",
    },
    createUserCreatedContext(43),
  );

  assert.deepEqual(fake.calls[2], {
    method: "run",
    params: ["f_1", "run_1"],
    sql: 'DELETE FROM "followups" WHERE ("followupId" = ? OR "targetRunId" = ?)',
  });
});

test("projection access supports typed inner joins between materialization tables", async () => {
  const networkSchema = defineMaterializationSchema({
    namespace: "network",
    version: 1,
    tables: {
      policyPromptRequests: (t) =>
        t
          .columns({
            policyPromptId: t.text().notNull(),
            requestId: t.text().notNull(),
          })
          .primaryKey(["policyPromptId", "requestId"])
          .index("policy_prompt_requests_by_request", ["requestId"]),
      requests: (t) =>
        t
          .columns({
            requestId: t.text().notNull(),
            instanceId: t.text().notNull(),
            runId: t.text().notNull(),
            requestedAtMs: t.integer().notNull(),
            resolvedAtMs: t.integer(),
            summary: t.text().notNull(),
          })
          .primaryKey(["requestId"])
          .index("requests_pending", ["resolvedAtMs", "requestedAtMs"]),
    },
  });
  const networkMaterializations = defineMaterializations({
    history: defineMaterializationHistory(networkSchema, (m) => [
      m.migration(1, "create network request tables", (s) => [
        s.createTable("policyPromptRequests", (t) =>
          t
            .columns({
              policyPromptId: t.text().notNull(),
              requestId: t.text().notNull(),
            })
            .primaryKey(["policyPromptId", "requestId"])
            .index("policy_prompt_requests_by_request", ["requestId"]),
        ),
        s.createTable("requests", (t) =>
          t
            .columns({
              requestId: t.text().notNull(),
              instanceId: t.text().notNull(),
              runId: t.text().notNull(),
              requestedAtMs: t.integer().notNull(),
              resolvedAtMs: t.integer(),
              summary: t.text().notNull(),
            })
            .primaryKey(["requestId"])
            .index("requests_pending", ["resolvedAtMs", "requestedAtMs"]),
        ),
      ]),
    ]),
    indexers: {},
    queries: {
      promptRequests: {
        params: Type.Object({
          policyPromptId: Type.String(),
        }),
        result: Type.Array(
          Type.Object({
            requestId: Type.String(),
            instanceId: Type.String(),
            runId: Type.String(),
            requestedAtMs: Type.Number(),
            resolvedAtMs: Type.Union([Type.Null(), Type.Number()]),
            summary: Type.String(),
          }),
        ),
      },
    },
  });
  const networkModel = withMaterializations(
    shape,
    networkMaterializations,
  ).register({
    queries: {
      promptRequests: async ({ params, db }) => {
        const rows = await db
          .selectFrom("policyPromptRequests")
          .innerJoin("requests", {
            fromColumn: "requestId",
            toColumn: "requestId",
          })
          .selectFrom("requests", [
            "requestId",
            "instanceId",
            "runId",
            "requestedAtMs",
            "resolvedAtMs",
            "summary",
          ])
          .where(
            "policyPromptRequests",
            "policyPromptId",
            "=",
            params.policyPromptId,
          )
          .whereNull("requests", "resolvedAtMs")
          .orderBy("requests", "requestedAtMs", "asc")
          .orderBy("requests", "requestId", "asc")
          .execute();

        return [...rows];
      },
    },
  });
  const promptRequests =
    readTestLedgerImplementations(networkModel).queries?.promptRequests;

  if (promptRequests === undefined) {
    throw new Error("expected promptRequests query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
        requestId: "req_1",
        instanceId: "instance_1",
        runId: "run_1",
        requestedAtMs: 1_000,
        resolvedAtMs: null,
        summary: "network access",
      },
    ],
    getRow: undefined,
  });

  const rows = await promptRequests(fake.scope, {
    policyPromptId: "prompt_1",
  });

  assert.deepEqual(fake.calls[0], {
    method: "all",
    params: ["prompt_1"],
    sql: 'SELECT "requests"."requestId" AS "requestId", "requests"."instanceId" AS "instanceId", "requests"."runId" AS "runId", "requests"."requestedAtMs" AS "requestedAtMs", "requests"."resolvedAtMs" AS "resolvedAtMs", "requests"."summary" AS "summary" FROM "policyPromptRequests" INNER JOIN "requests" ON "policyPromptRequests"."requestId" = "requests"."requestId" WHERE "policyPromptRequests"."policyPromptId" = ? AND "requests"."resolvedAtMs" IS NULL ORDER BY "requests"."requestedAtMs" ASC, "requests"."requestId" ASC',
  });
  assert.deepEqual(rows, [
    {
      requestId: "req_1",
      instanceId: "instance_1",
      runId: "run_1",
      requestedAtMs: 1_000,
      resolvedAtMs: null,
      summary: "network access",
    },
  ]);
});

test("projection access supports typed anti-join predicates", async () => {
  const networkSchema = defineMaterializationSchema({
    namespace: "network-anti-join",
    version: 1,
    tables: {
      policyPromptRequests: (t) =>
        t
          .columns({
            policyPromptId: t.text().notNull(),
            requestId: t.text().notNull(),
          })
          .primaryKey(["policyPromptId", "requestId"])
          .index("policy_prompt_requests_by_request", ["requestId"]),
      requests: (t) =>
        t
          .columns({
            requestId: t.text().notNull(),
            requestedAtMs: t.integer().notNull(),
            resolvedAtMs: t.integer(),
            summary: t.text().notNull(),
          })
          .primaryKey(["requestId"])
          .index("requests_pending", ["resolvedAtMs", "requestedAtMs"]),
    },
  });
  const networkMaterializations = defineMaterializations({
    history: defineMaterializationHistory(networkSchema, (m) => [
      m.migration(1, "create network request tables", (s) => [
        s.createTable("policyPromptRequests", (t) =>
          t
            .columns({
              policyPromptId: t.text().notNull(),
              requestId: t.text().notNull(),
            })
            .primaryKey(["policyPromptId", "requestId"])
            .index("policy_prompt_requests_by_request", ["requestId"]),
        ),
        s.createTable("requests", (t) =>
          t
            .columns({
              requestId: t.text().notNull(),
              requestedAtMs: t.integer().notNull(),
              resolvedAtMs: t.integer(),
              summary: t.text().notNull(),
            })
            .primaryKey(["requestId"])
            .index("requests_pending", ["resolvedAtMs", "requestedAtMs"]),
        ),
      ]),
    ]),
    indexers: {},
    queries: {
      unpromptedPending: {
        params: Type.Object({}),
        result: Type.Array(
          Type.Object({
            requestId: Type.String(),
            requestedAtMs: Type.Number(),
            resolvedAtMs: Type.Union([Type.Null(), Type.Number()]),
            summary: Type.String(),
          }),
        ),
      },
    },
  });
  const networkModel = withMaterializations(
    shape,
    networkMaterializations,
  ).register({
    queries: {
      unpromptedPending: async ({ db }) => {
        const rows = await db
          .selectFrom("requests")
          .select(["requestId", "requestedAtMs", "resolvedAtMs", "summary"])
          .whereNotExists("policyPromptRequests", {
            fromColumn: "requestId",
            toColumn: "requestId",
          })
          .whereNull("resolvedAtMs")
          .orderBy("requestedAtMs", "asc")
          .orderBy("requestId", "asc")
          .execute();

        return [...rows];
      },
    },
  });
  const unpromptedPending =
    readTestLedgerImplementations(networkModel).queries?.unpromptedPending;

  if (unpromptedPending === undefined) {
    throw new Error("expected unpromptedPending query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
        requestId: "req_1",
        requestedAtMs: 1_000,
        resolvedAtMs: null,
        summary: "network access",
      },
    ],
    getRow: undefined,
  });

  const rows = await unpromptedPending(fake.scope, {});

  assert.deepEqual(fake.calls[0], {
    method: "all",
    params: [],
    sql: 'SELECT "requestId" AS "requestId", "requestedAtMs" AS "requestedAtMs", "resolvedAtMs" AS "resolvedAtMs", "summary" AS "summary" FROM "requests" WHERE NOT EXISTS (SELECT 1 FROM "policyPromptRequests" WHERE "policyPromptRequests"."requestId" = "requests"."requestId") AND "resolvedAtMs" IS NULL ORDER BY "requestedAtMs" ASC, "requestId" ASC',
  });
  assert.deepEqual(rows, [
    {
      requestId: "req_1",
      requestedAtMs: 1_000,
      resolvedAtMs: null,
      summary: "network access",
    },
  ]);
});

test("projection access rejects unsafe predicate and self-join shapes", async () => {
  const nodeSchema = defineMaterializationSchema({
    namespace: "node-shapes",
    version: 1,
    tables: {
      nodes: (t) =>
        t
          .columns({
            nodeId: t.text().notNull(),
            parentId: t.text(),
          })
          .primaryKey(["nodeId"]),
    },
  });
  const nodeMaterializations = defineMaterializations({
    history: defineMaterializationHistory(nodeSchema, (m) => [
      m.migration(1, "create nodes", (s) => [
        s.createTable("nodes", (t) =>
          t
            .columns({
              nodeId: t.text().notNull(),
              parentId: t.text(),
            })
            .primaryKey(["nodeId"]),
        ),
      ]),
    ]),
    indexers: {},
    queries: {
      nullComparison: {
        params: Type.Object({}),
        result: Type.Null(),
      },
      nullIn: {
        params: Type.Object({}),
        result: Type.Null(),
      },
      selfAntiJoin: {
        params: Type.Object({}),
        result: Type.Null(),
      },
      selfJoin: {
        params: Type.Object({}),
        result: Type.Null(),
      },
    },
  });
  const nodeModel = withMaterializations(shape, nodeMaterializations).register({
    queries: {
      nullComparison: async ({ db }) => {
        await db
          .selectFrom("nodes")
          .select(["nodeId"])
          .where("parentId", "=", null as never)
          .execute();

        return null;
      },
      nullIn: async ({ db }) => {
        await db
          .selectFrom("nodes")
          .select(["nodeId"])
          .whereIn("parentId", [null as never])
          .execute();

        return null;
      },
      selfAntiJoin: async ({ db }) => {
        await db
          .selectFrom("nodes")
          .select(["nodeId"])
          .whereNotExists("nodes", {
            fromColumn: "parentId",
            toColumn: "nodeId",
          })
          .execute();

        return null;
      },
      selfJoin: async ({ db }) => {
        await db
          .selectFrom("nodes")
          .innerJoin("nodes", {
            fromColumn: "parentId",
            toColumn: "nodeId",
          })
          .selectFrom("nodes", ["nodeId"])
          .execute();

        return null;
      },
    },
  });
  const nodeQueries = readTestLedgerImplementations(nodeModel).queries;
  const nullComparison = nodeQueries?.nullComparison;
  const nullIn = nodeQueries?.nullIn;
  const selfAntiJoin = nodeQueries?.selfAntiJoin;
  const selfJoin = nodeQueries?.selfJoin;

  if (
    nullComparison === undefined ||
    nullIn === undefined ||
    selfAntiJoin === undefined ||
    selfJoin === undefined
  ) {
    throw new Error("expected node query implementations");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await assert.rejects(async () => {
    await nullComparison(fake.scope, {});
  }, /nodes\.parentId predicate value cannot be null/);
  await assert.rejects(async () => {
    await nullIn(fake.scope, {});
  }, /nodes\.parentId predicate value cannot be null/);
  await assert.rejects(async () => {
    await selfAntiJoin(fake.scope, {});
  }, /projection anti-join cannot target the same table nodes/);
  await assert.rejects(async () => {
    await selfJoin(fake.scope, {});
  }, /projection inner join cannot target the same table nodes/);
  assert.deepEqual(fake.calls, []);
});

test("projection access supports typed aggregate reads", async () => {
  const toolSchema = defineMaterializationSchema({
    namespace: "tool-aggregates",
    version: 1,
    tables: {
      toolCalls: (t) =>
        t
          .columns({
            toolCallId: t.text().notNull(),
            createdAtMs: t.integer().notNull(),
            runId: t.text().notNull(),
            resultMessageJson: t.text(),
          })
          .primaryKey(["toolCallId"])
          .index("tool_calls_by_run", ["runId"]),
    },
  });
  const toolMaterializations = defineMaterializations({
    history: defineMaterializationHistory(toolSchema, (m) => [
      m.migration(1, "create tool call tables", (s) => [
        s.createTable("toolCalls", (t) =>
          t
            .columns({
              toolCallId: t.text().notNull(),
              createdAtMs: t.integer().notNull(),
              runId: t.text().notNull(),
              resultMessageJson: t.text(),
            })
            .primaryKey(["toolCallId"])
            .index("tool_calls_by_run", ["runId"]),
        ),
      ]),
    ]),
    indexers: {},
    queries: {
      duplicateAlias: {
        params: Type.Object({}),
        result: Type.Object({
          total: Type.Number(),
        }),
      },
      toolSummary: {
        params: Type.Object({
          runId: Type.String(),
        }),
        result: Type.Object({
          completedToolCallCount: Type.Number(),
          firstToolCallAtMs: Type.Union([Type.Null(), Type.Number()]),
          latestToolCallAtMs: Type.Union([Type.Null(), Type.Number()]),
          totalToolCallCount: Type.Number(),
        }),
      },
    },
  });
  const toolModel = withMaterializations(shape, toolMaterializations).register({
    queries: {
      duplicateAlias: async ({ db }) => {
        return await db
          .selectFrom("toolCalls")
          .aggregate()
          .count("total")
          .count("Total")
          .execute();
      },
      toolSummary: async ({ params, db }) => {
        return await db
          .selectFrom("toolCalls")
          .aggregate()
          .count("totalToolCallCount")
          .countNotNull("completedToolCallCount", "resultMessageJson")
          .min("firstToolCallAtMs", "createdAtMs")
          .max("latestToolCallAtMs", "createdAtMs")
          .where("runId", "=", params.runId)
          .execute();
      },
    },
  });
  const toolQueries = readTestLedgerImplementations(toolModel).queries;
  const toolSummary = toolQueries?.toolSummary;
  const duplicateAlias = toolQueries?.duplicateAlias;

  if (toolSummary === undefined) {
    throw new Error("expected toolSummary query implementation");
  }

  if (duplicateAlias === undefined) {
    throw new Error("expected duplicateAlias query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      completedToolCallCount: 2,
      firstToolCallAtMs: 1_000,
      latestToolCallAtMs: 1_500,
      totalToolCallCount: 3,
    },
  });

  const summary = await toolSummary(fake.scope, {
    runId: "run_1",
  });

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: ["run_1"],
    sql: 'SELECT COUNT(*) AS "totalToolCallCount", COUNT("resultMessageJson") AS "completedToolCallCount", MIN("createdAtMs") AS "firstToolCallAtMs", MAX("createdAtMs") AS "latestToolCallAtMs" FROM "toolCalls" WHERE "runId" = ?',
  });
  assert.deepEqual(summary, {
    completedToolCallCount: 2,
    firstToolCallAtMs: 1_000,
    latestToolCallAtMs: 1_500,
    totalToolCallCount: 3,
  });

  const invalidFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await assert.rejects(async () => {
    await duplicateAlias(invalidFake.scope, {});
  }, /projection aggregate alias Total conflicts with total/);
  assert.deepEqual(invalidFake.calls, []);
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
      sourceEvents: {
        params: Type.Object({
          eventIds: Type.Array(Type.Number()),
        }),
        result: Type.Array(Type.Union([Type.Null(), UserCreatedSchema])),
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
      sourceEvents: async ({ params, db }) => {
        const events = await db.readEvents(
          params.eventIds.map((eventId) => {
            return createEventRef("user.created", eventId);
          }),
        );

        return events.map((event) => {
          return event === null ? null : event.payload;
        });
      },
    },
  });
  const eventQueries = readTestLedgerImplementations(eventModel).queries;
  const sourceEvent = eventQueries?.sourceEvent;
  const sourceEvents = eventQueries?.sourceEvents;

  if (sourceEvent === undefined) {
    throw new Error("expected sourceEvent query implementation");
  }

  if (sourceEvents === undefined) {
    throw new Error("expected sourceEvents query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
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
    ],
    getRow: undefined,
  });

  const payload = await sourceEvent(fake.scope, {
    eventId: 42,
  });

  assert.deepEqual(fake.calls[0], {
    method: "all",
    params: ["user.created", 0, 42],
    sql: 'SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND "event_id" IN (?)',
  });
  assert.deepEqual(payload, {
    userId: "u_123",
    email: "alice@example.com",
  });

  const batchFake = createFakeScope({
    allRows: [
      {
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
      {
        causation_event_id: null,
        dedupe_key: null,
        event_id: 43,
        event_name: "user.created",
        payload_json: JSON.stringify({
          userId: "u_456",
          email: "bob@example.com",
        }),
        ts_ms: 1_100,
      },
    ],
    getRow: undefined,
  });

  const payloads = await sourceEvents(batchFake.scope, {
    eventIds: [43, 42, 99, 42],
  });

  assert.deepEqual(batchFake.calls[0], {
    method: "all",
    params: ["user.created", 0, 43, 42, 99],
    sql: 'SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND "event_id" IN (?, ?, ?)',
  });
  assert.deepEqual(payloads, [
    {
      userId: "u_456",
      email: "bob@example.com",
    },
    {
      userId: "u_123",
      email: "alice@example.com",
    },
    null,
    {
      userId: "u_123",
      email: "alice@example.com",
    },
  ]);

  const chunkedBatchFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });
  const chunkedPayloads = (await sourceEvents(chunkedBatchFake.scope, {
    eventIds: Array.from({ length: 901 }, (_value, index) => {
      return index + 1;
    }),
  })) as readonly unknown[];

  assert.equal(chunkedPayloads.length, 901);
  assert.equal(
    chunkedPayloads.every((event) => event === null),
    true,
  );
  assert.equal(chunkedBatchFake.calls.length, 2);
  assert.equal(chunkedBatchFake.calls[0]?.method, "all");
  assert.equal(chunkedBatchFake.calls[0]?.params.length, 902);
  assert.deepEqual(chunkedBatchFake.calls[0]?.params.slice(0, 3), [
    "user.created",
    0,
    1,
  ]);
  assert.equal(chunkedBatchFake.calls[1]?.method, "all");
  assert.deepEqual(chunkedBatchFake.calls[1]?.params, ["user.created", 0, 901]);

  const emptyBatchFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  assert.deepEqual(
    await sourceEvents(emptyBatchFake.scope, { eventIds: [] }),
    [],
  );
  assert.deepEqual(emptyBatchFake.calls, []);
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

test("sqlite projection compiler compiles materialization schema DDL", () => {
  const relationSchema = defineMaterializationSchema({
    namespace: "ddl",
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
          .primaryKey(["sessionId"])
          .index("sessionsByUser", ["userId"]),
    },
    relations: (r) => ({
      sessionUser: r
        .foreignKey("sessions", ["userId"])
        .references("users", ["userId"])
        .onDelete("cascade"),
    }),
  });
  const usersTable = relationSchema.metadata.tables.users;
  const sessionsTable = relationSchema.metadata.tables.sessions;

  if (usersTable === undefined || sessionsTable === undefined) {
    throw new Error("expected relation schema tables");
  }

  const sessionsByUserIndex = sessionsTable.indexes[0];

  if (sessionsByUserIndex === undefined) {
    throw new Error("expected sessionsByUser index");
  }

  const compiler = createSqliteProjectionStatementCompiler();

  assert.deepEqual(
    compiler.compileCreateTable({
      metadata: relationSchema.metadata,
      table: usersTable,
    }),
    {
      params: [],
      text: 'CREATE TABLE IF NOT EXISTS "users" ("userId" TEXT NOT NULL, PRIMARY KEY ("userId"))',
    },
  );
  assert.deepEqual(
    compiler.compileCreateTable({
      metadata: relationSchema.metadata,
      table: sessionsTable,
    }),
    {
      params: [],
      text: 'CREATE TABLE IF NOT EXISTS "sessions" ("sessionId" TEXT NOT NULL, "userId" TEXT NOT NULL, PRIMARY KEY ("sessionId"), CONSTRAINT "sessionUser" FOREIGN KEY ("userId") REFERENCES "users" ("userId") ON DELETE CASCADE)',
    },
  );
  assert.deepEqual(
    compiler.compileCreateIndex({
      index: sessionsByUserIndex,
      tableName: "sessions",
    }),
    {
      params: [],
      text: 'CREATE INDEX IF NOT EXISTS "sessionsByUser" ON "sessions" ("userId")',
    },
  );
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

  const joinSchema = defineMaterializationSchema({
    namespace: "join-types",
    version: 1,
    tables: {
      children: (t) =>
        t
          .columns({
            childId: t.text().notNull(),
            parentId: t.text().notNull(),
          })
          .primaryKey(["childId"]),
      parents: (t) =>
        t
          .columns({
            parentId: t.text().notNull(),
            rank: t.integer().notNull(),
          })
          .primaryKey(["parentId"]),
    },
  });
  const joinHistory = defineMaterializationHistory(joinSchema, (m) => [
    m.migration(1, "create join tables", (s) => [
      s.createTable("children", (t) =>
        t
          .columns({
            childId: t.text().notNull(),
            parentId: t.text().notNull(),
          })
          .primaryKey(["childId"]),
      ),
      s.createTable("parents", (t) =>
        t
          .columns({
            parentId: t.text().notNull(),
            rank: t.integer().notNull(),
          })
          .primaryKey(["parentId"]),
      ),
    ]),
  ]);
  const joinMaterializations = defineMaterializations({
    history: joinHistory,
    indexers: {},
    queries: {
      joined: {
        params: Type.Object({}),
        result: Type.Null(),
      },
    },
  });

  withMaterializations(shape, joinMaterializations).register({
    queries: {
      joined: async ({ db }) => {
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          .orderByList("parents", "rank", [1, 2]);
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          // @ts-expect-error joined orderByList values must match the qualified column type.
          .orderByList("parents", "rank", ["1"]);
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          .where("parents", "rank", ">", 0);
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            // @ts-expect-error joined columns must have compatible value types.
            toColumn: "rank",
          })
          .selectFrom("parents", ["rank"]);
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          // @ts-expect-error joined where values must match the qualified column type.
          .where("parents", "rank", ">", "0");
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          // @ts-expect-error joined where clauses only reference joined tables.
          .where("users", "userId", "=", "u_123");
        db.selectFrom("parents").select(["rank"]).whereNotExists("children", {
          fromColumn: "parentId",
          toColumn: "parentId",
        });
        db.selectFrom("parents").select(["rank"]).whereNotExists("children", {
          fromColumn: "rank",
          // @ts-expect-error anti-join columns must have compatible value types.
          toColumn: "parentId",
        });
        db.selectFrom("parents")
          .select(["rank"])
          // @ts-expect-error anti-join target table must be declared.
          .whereNotExists("missing", {
            fromColumn: "parentId",
            toColumn: "parentId",
          });

        const aggregateRow = await db
          .selectFrom("parents")
          .aggregate()
          .min("lowestRank", "rank")
          .max("highestRank", "rank")
          .execute();
        const lowestRank: number | null = aggregateRow.lowestRank;
        const highestRank: number | null = aggregateRow.highestRank;

        void lowestRank;
        void highestRank;

        db.selectFrom("parents")
          .aggregate()
          // @ts-expect-error min/max aggregates only accept integer columns.
          .min("badRank", "parentId");

        return null;
      },
    },
  });

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

        db.selectFrom("users")
          .select(["email"])
          .orderByList("email", ["alice@example.com"]);
        db.selectFrom("users")
          .select(["email"])
          // @ts-expect-error orderByList values must match the ordered column type.
          .orderByList("email", [1]);
        db.selectFrom("users")
          .select(["email"])
          // @ts-expect-error orderByList must reference known columns.
          .orderByList("missing", ["alice@example.com"]);

        const event = await db.readEvent(createEventRef("user.created", 1));

        if (event !== null) {
          const userId: string = event.payload.userId;
          void userId;
        }

        const events = await db.readEvents([createEventRef("user.created", 1)]);
        const firstEvent = events[0] ?? null;

        if (firstEvent !== null) {
          const userId: string = firstEvent.payload.userId;
          void userId;
        }

        // @ts-expect-error batch event reads must reference known ledger events.
        db.readEvents([createEventRef("session.created", 1)]);

        const aggregateRow = await db
          .selectFrom("users")
          .aggregate()
          .count("total")
          .countNotNull("withEmail", "email")
          .execute();
        const aggregateTotal: number = aggregateRow.total;
        const aggregateWithEmail: number = aggregateRow.withEmail;
        // @ts-expect-error aggregate results only expose declared aliases.
        const aggregateMissing = aggregateRow.missing;

        void aggregateTotal;
        void aggregateWithEmail;
        void aggregateMissing;

        db.selectFrom("users")
          .aggregate()
          // @ts-expect-error aggregate countNotNull must reference known columns.
          .countNotNull("missingCount", "missing");

        db.selectFrom("users")
          .select(["email"])
          .whereAny([
            {
              columnName: "email",
              kind: "comparison",
              operator: "=",
              value: "alice@example.com",
            },
          ]);
        db.selectFrom("users")
          .select(["email"])
          .whereAny([
            {
              columnName: "email",
              kind: "comparison",
              operator: "=",
              // @ts-expect-error whereAny comparison values must match column types.
              value: 123,
            },
          ]);
        db.selectFrom("users")
          .select(["email"])
          .whereAny([
            {
              // @ts-expect-error whereAny conditions must reference known columns.
              columnName: "missing",
              kind: "is_null",
            },
          ]);

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
