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
  MaterializationDatabaseFor,
  MaterializationImplementationRegistrationFor,
  MaterializationMigrationDatabaseFor,
  MaterializationReadDatabaseFor,
  MaterializationSchemaFor,
  MaterializationWriteDatabaseFor,
  ProjectionEventScanBuilder,
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
  defineMaterialization,
  withMaterializations,
} from "./ledger.ts";

const UserCreatedSchema = Type.Object({
  userId: Type.String(),
  email: Type.String(),
});

const RunStreamFrameSchema = Type.Object({
  runId: Type.String(),
  frame: Type.String(),
  sequence: Type.Number(),
});

const shape = defineLedgerShape({
  events: {
    "user.created": UserCreatedSchema,
  },
  queues: {},
  signals: {},
  signalQueues: {},
});

const materializations = defineMaterialization(shape, {
  namespace: "test",
})
  .version(1, "create users", (s) =>
    s.createTable("users", (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          email: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
    ),
  )
  .define({
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
const schema = materializations.history.current;
const history = materializations.history;

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
} satisfies MaterializationImplementationRegistrationFor<
  typeof materializations,
  typeof shape.shape.events
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

function createFakeScopeWithRunChanges(input: {
  readonly allRows: readonly LedgerStorageRow[];
  readonly changes: number;
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
              changes: input.changes,
              lastInsertRowid: 0,
            };
          },
        };
      },
    },
  };
}

function createQueuedFakeScope(input: {
  readonly allRows: readonly (readonly LedgerStorageRow[])[];
  readonly getRows: readonly (LedgerStorageRow | undefined)[];
}): {
  readonly calls: readonly FakeStatementCall[];
  readonly scope: LedgerStorageScope;
} {
  const calls: FakeStatementCall[] = [];
  let allIndex = 0;
  let getIndex = 0;

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
            const rows = input.allRows[allIndex];
            allIndex += 1;
            calls.push({
              method: "all",
              params,
              sql,
            });

            return rows ?? [];
          },
          get: async (...params) => {
            const row = input.getRows[getIndex];
            getIndex += 1;
            calls.push({
              method: "get",
              params,
              sql,
            });

            return row;
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

test("projection access batches typed insert values into one statement", async () => {
  const batchMaterializations = defineMaterialization(shape, {
    namespace: "batch",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
      indexers: {
        seedUsers: {
          sourceEvent: "user.created",
          input: Type.Array(UserCreatedSchema),
        },
      },
      queries: {},
    });
  const batchModel = withMaterializations(
    shape,
    batchMaterializations,
  ).register({
    indexers: {
      seedUsers: async ({ input, event, db }) => {
        await db
          .insertInto("users")
          .values(
            input.map((user) => {
              return {
                email: user.email,
                source: event.ref,
                userId: user.userId,
              };
            }),
          )
          .onConflict(["userId"])
          .doUpdateSet((e) => ({
            email: e.excluded("email"),
            source: e.excluded("source"),
          }))
          .execute();
      },
    },
  });
  const indexer = readTestLedgerImplementations(batchModel).indexers?.seedUsers;

  if (indexer === undefined) {
    throw new Error("expected seedUsers indexer implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await indexer(
    fake.scope,
    [
      {
        userId: "u_1",
        email: "alice@example.com",
      },
      {
        userId: "u_2",
        email: "bob@example.com",
      },
    ],
    createUserCreatedContext(42),
  );

  assert.deepEqual(fake.calls, [
    {
      method: "run",
      params: ["u_1", "alice@example.com", 42, "u_2", "bob@example.com", 42],
      sql: 'INSERT INTO "users" ("userId", "email", "source") VALUES (?, ?, ?), (?, ?, ?) ON CONFLICT ("userId") DO UPDATE SET "email" = excluded."email", "source" = excluded."source"',
    },
  ]);

  const emptyFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await assert.rejects(async () => {
    await indexer(emptyFake.scope, [], createUserCreatedContext(43));
  }, /insert values must include at least one row/);
  assert.deepEqual(emptyFake.calls, []);
});

test("projection access supports typed integer increments without raw SQL", async () => {
  const counterMaterializations = defineMaterialization(shape, {
    namespace: "counter",
  })
    .version(1, "create counters", (s) =>
      s.createTable("counters", (t) =>
        t
          .columns({
            attempts: t.integer().notNull(),
            counterId: t.text().notNull(),
          })
          .primaryKey(["counterId"]),
      ),
    )
    .define({
      indexers: {
        incrementCounter: {
          sourceEvent: "user.created",
          input: Type.Object({
            counterId: Type.String(),
          }),
        },
      },
      queries: {},
    });
  const counterModel = withMaterializations(
    shape,
    counterMaterializations,
  ).register({
    indexers: {
      incrementCounter: async ({ input, db }) => {
        await db
          .updateTable("counters")
          .set((e) => ({
            attempts: e.add("attempts", 1),
          }))
          .where("counterId", "=", input.counterId)
          .executeExpectingOne();
      },
    },
  });
  const indexer =
    readTestLedgerImplementations(counterModel).indexers?.incrementCounter;

  if (indexer === undefined) {
    throw new Error("expected incrementCounter indexer implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await indexer(
    fake.scope,
    {
      counterId: "c_1",
    },
    createUserCreatedContext(42),
  );

  assert.deepEqual(fake.calls, [
    {
      method: "run",
      params: [1, "c_1"],
      sql: 'UPDATE "counters" SET "attempts" = "attempts" + ? WHERE "counterId" = ?',
    },
  ]);
});

test("projection access tracks unawaited executeExpectingOne assertions", async () => {
  const counterMaterializations = defineMaterialization(shape, {
    namespace: "counter-assertions",
  })
    .version(1, "create counters", (s) =>
      s.createTable("counters", (t) =>
        t
          .columns({
            attempts: t.integer().notNull(),
            counterId: t.text().notNull(),
          })
          .primaryKey(["counterId"]),
      ),
    )
    .define({
      indexers: {
        incrementCounter: {
          sourceEvent: "user.created",
          input: Type.Object({
            counterId: Type.String(),
          }),
        },
      },
      queries: {},
    });
  const counterModel = withMaterializations(
    shape,
    counterMaterializations,
  ).register({
    indexers: {
      incrementCounter: ({ input, db }) => {
        void db
          .updateTable("counters")
          .set((e) => ({
            attempts: e.add("attempts", 1),
          }))
          .where("counterId", "=", input.counterId)
          .executeExpectingOne();
      },
    },
  });
  const indexer =
    readTestLedgerImplementations(counterModel).indexers?.incrementCounter;

  if (indexer === undefined) {
    throw new Error("expected incrementCounter indexer implementation");
  }

  const fake = createFakeScopeWithRunChanges({
    allRows: [],
    changes: 0,
    getRow: undefined,
  });

  await assert.rejects(async () => {
    await indexer(
      fake.scope,
      {
        counterId: "c_1",
      },
      createUserCreatedContext(42),
    );
  }, /expected projection write to change one row but changed 0/);
  assert.deepEqual(fake.calls, [
    {
      method: "run",
      params: [1, "c_1"],
      sql: 'UPDATE "counters" SET "attempts" = "attempts" + ? WHERE "counterId" = ?',
    },
  ]);
});

test("projection access supports bounded integer decrements without raw SQL", async () => {
  const grantMaterializations = defineMaterialization(shape, {
    namespace: "grant_consumes",
  })
    .version(1, "create grants", (s) =>
      s.createTable("grants", (t) =>
        t
          .columns({
            grantId: t.text().notNull(),
            remainingUses: t.integer(),
          })
          .primaryKey(["grantId"]),
      ),
    )
    .define({
      indexers: {
        consumeGrant: {
          sourceEvent: "user.created",
          input: Type.Object({
            grantId: Type.String(),
          }),
        },
      },
      queries: {},
    });
  const grantModel = withMaterializations(
    shape,
    grantMaterializations,
  ).register({
    indexers: {
      consumeGrant: async ({ input, db }) => {
        await db
          .updateTable("grants")
          .set((e) => ({
            remainingUses: e.decrementIfPositive("remainingUses"),
          }))
          .where("grantId", "=", input.grantId)
          .executeExpectingOne();
      },
    },
  });
  const indexer =
    readTestLedgerImplementations(grantModel).indexers?.consumeGrant;

  if (indexer === undefined) {
    throw new Error("expected consumeGrant indexer implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });

  await indexer(
    fake.scope,
    {
      grantId: "g_1",
    },
    createUserCreatedContext(42),
  );

  assert.deepEqual(fake.calls, [
    {
      method: "run",
      params: ["g_1"],
      sql: 'UPDATE "grants" SET "remainingUses" = CASE WHEN "remainingUses" IS NULL THEN NULL WHEN "remainingUses" > 0 THEN "remainingUses" - 1 ELSE "remainingUses" END WHERE "grantId" = ?',
    },
  ]);
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
    signals: shape.shape.signals,
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
  const jsonMaterializations = defineMaterialization(shape, {
    namespace: "json",
  })
    .version(1, "create json rows", (s) =>
      s.createTable("jsonRows", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            metadata: t.json<unknown>().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
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
      queries: {
        jsonByMetadata: {
          params: Type.Object({
            metadata: Type.Unknown(),
          }),
          result: Type.Array(
            Type.Object({
              userId: Type.String(),
            }),
          ),
        },
        jsonByMetadataIn: {
          params: Type.Object({
            values: Type.Array(Type.Unknown()),
          }),
          result: Type.Array(
            Type.Object({
              userId: Type.String(),
            }),
          ),
        },
      },
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
    queries: {
      jsonByMetadata: async ({ params, db }) => {
        const rows = await db
          .selectFrom("jsonRows")
          .select(["userId"])
          .where("metadata", "=", params.metadata)
          .execute();

        return [...rows];
      },
      jsonByMetadataIn: async ({ params, db }) => {
        const rows = await db
          .selectFrom("jsonRows")
          .select(["userId"])
          .whereIn("metadata", params.values)
          .execute();

        return [...rows];
      },
    },
  });
  const jsonImplementations =
    readTestLedgerImplementations(registeredJsonModel);
  const insertJson = jsonImplementations.indexers?.insertJson;
  const updateJson = jsonImplementations.indexers?.updateJson;
  const jsonByMetadata = jsonImplementations.queries?.jsonByMetadata;
  const jsonByMetadataIn = jsonImplementations.queries?.jsonByMetadataIn;

  if (insertJson === undefined) {
    throw new Error("expected insertJson indexer implementation");
  }

  if (updateJson === undefined) {
    throw new Error("expected updateJson indexer implementation");
  }

  if (jsonByMetadata === undefined || jsonByMetadataIn === undefined) {
    throw new Error("expected JSON query implementations");
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

  const nullJsonPredicateFake = createFakeScope({
    allRows: [
      {
        userId: "u_null",
      },
    ],
    getRow: undefined,
  });

  await jsonByMetadata(nullJsonPredicateFake.scope, {
    metadata: null,
  });

  assert.deepEqual(nullJsonPredicateFake.calls[0], {
    method: "all",
    params: ["null"],
    sql: 'SELECT "userId" AS "userId" FROM "jsonRows" WHERE "metadata" = ?',
  });

  const nullJsonInPredicateFake = createFakeScope({
    allRows: [
      {
        userId: "u_null",
      },
    ],
    getRow: undefined,
  });

  await jsonByMetadataIn(nullJsonInPredicateFake.scope, {
    values: [null],
  });

  assert.deepEqual(nullJsonInPredicateFake.calls[0], {
    method: "all",
    params: ["null"],
    sql: 'SELECT "userId" AS "userId" FROM "jsonRows" WHERE "metadata" IN (?)',
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
  const stateMaterializations = defineMaterialization(shape, {
    namespace: "stateful",
  })
    .version(1, "create run state", (s) =>
      s.createTable("runState", (t) =>
        t
          .columns({
            runId: t.text().notNull(),
            latestInputEventId: t.integer().notNull(),
            messageJson: t.text(),
          })
          .primaryKey(["runId"]),
      ),
    )
    .define({
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
    sql: 'INSERT INTO "runState" ("runId", "latestInputEventId", "messageJson") VALUES (?, ?, ?) ON CONFLICT ("runId") DO UPDATE SET "latestInputEventId" = MAX(COALESCE("latestInputEventId", excluded."latestInputEventId"), COALESCE(excluded."latestInputEventId", "latestInputEventId")), "messageJson" = COALESCE("messageJson", excluded."messageJson")',
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
  const profileMaterializations = defineMaterialization(shape, {
    namespace: "profile-docs",
  })
    .version(1, "create profile docs", (s) =>
      s.createTable("profileDocs", (t) =>
        t
          .columns({
            docId: t.text().notNull(),
            version: t.integer().notNull(),
            content: t.text().notNull(),
            archivedAtMs: t.integer(),
          })
          .primaryKey(["docId"]),
      ),
    )
    .define({
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
          .orderByNulls("archivedAtMs", "last")
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
    sql: 'SELECT "docId" AS "docId", "version" AS "version", "content" AS "content" FROM "profileDocs" ORDER BY CASE WHEN "archivedAtMs" IS NULL THEN 1 ELSE 0 END ASC, CASE "docId" WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? ELSE ? END ASC',
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
  const followupMaterializations = defineMaterialization(shape, {
    namespace: "followups",
  })
    .version(1, "create followups", (s) =>
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
    )
    .define({
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

test("projection access executeTakeFirst honors explicit zero limits", async () => {
  const limitMaterializations = defineMaterialization(shape, {
    namespace: "limit-zero",
  })
    .version(1, "create limit-zero tables", (s) =>
      s
        .createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        )
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
    )
    .define({
      indexers: {},
      queries: {
        checkLimitZero: {
          params: Type.Object({}),
          result: Type.Null(),
        },
      },
    });
  const limitModel = withMaterializations(
    shape,
    limitMaterializations,
  ).register({
    queries: {
      checkLimitZero: async ({ db }) => {
        const selected = await db
          .selectFrom("users")
          .select(["userId"])
          .limit(0)
          .executeTakeFirst();
        const joined = await db
          .selectFrom("users")
          .innerJoin("sessions", {
            fromColumn: "userId",
            toColumn: "userId",
          })
          .selectFrom("sessions", ["sessionId"])
          .limit(0)
          .executeTakeFirst();
        const unioned = await db
          .unionAll([
            db.unionFrom("users").select({
              id: "userId",
              priority: db.unionValue(0),
            }),
            db.unionFrom("sessions").select({
              id: "sessionId",
              priority: db.unionValue(1),
            }),
          ])
          .limit(0)
          .executeTakeFirst();

        assert.equal(selected, null);
        assert.equal(joined, null);
        assert.equal(unioned, null);

        return null;
      },
    },
  });
  const checkLimitZero =
    readTestLedgerImplementations(limitModel).queries?.checkLimitZero;

  if (checkLimitZero === undefined) {
    throw new Error("expected checkLimitZero query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      id: "should_not_read",
      priority: 0,
      sessionId: "should_not_read",
      userId: "should_not_read",
    },
  });

  const result = await checkLimitZero(fake.scope, {});

  assert.equal(result, null);
  assert.deepEqual(fake.calls, []);
});

test("projection access supports typed union candidate reads", async () => {
  const decisionMaterializations = defineMaterialization(shape, {
    namespace: "network-decision",
  })
    .version(1, "create network decision tables", (s) =>
      s
        .createTable("grants", (t) =>
          t
            .columns({
              grantId: t.text().notNull(),
              instanceId: t.text(),
              scope: t.text().notNull(),
              decision: t.text().notNull(),
              remainingUses: t.integer(),
              createdAtMs: t.integer().notNull(),
              consumedAtMs: t.integer(),
            })
            .primaryKey(["grantId"]),
        )
        .createTable("lanePolicies", (t) =>
          t
            .columns({
              policyEntryId: t.text().notNull(),
              instanceId: t.text().notNull(),
              scope: t.text().notNull(),
              decision: t.text().notNull(),
              updatedAtMs: t.integer().notNull(),
              revokedAtMs: t.integer(),
            })
            .primaryKey(["policyEntryId"]),
        ),
    )
    .define({
      indexers: {},
      queries: {
        checkDecision: {
          params: Type.Object({
            instanceId: Type.String(),
            scope: Type.String(),
          }),
          result: Type.Union([
            Type.Null(),
            Type.Object({
              decisionId: Type.String(),
              decision: Type.String(),
              remainingUses: Type.Union([Type.Null(), Type.Number()]),
            }),
          ]),
        },
      },
    });
  const decisionModel = withMaterializations(
    shape,
    decisionMaterializations,
  ).register({
    queries: {
      checkDecision: async ({ params, db }) => {
        const usableGrantPredicates = [
          {
            columnName: "remainingUses",
            kind: "is_null",
          },
          {
            columnName: "remainingUses",
            kind: "comparison",
            operator: ">",
            value: 0,
          },
        ] as const;
        const globalDenyGrants = db
          .unionFrom("grants")
          .select({
            decisionId: "grantId",
            decision: "decision",
            remainingUses: "remainingUses",
            priority: db.unionValue(0),
            createdAtMs: "createdAtMs",
          })
          .where("scope", "=", params.scope)
          .whereNull("instanceId")
          .where("decision", "=", "always_deny")
          .whereNull("consumedAtMs")
          .whereAny(usableGrantPredicates);
        const lanePolicies = db
          .unionFrom("lanePolicies")
          .select({
            decisionId: "policyEntryId",
            decision: "decision",
            remainingUses: db.unionValue(null),
            priority: db.unionValue(1),
            createdAtMs: "updatedAtMs",
          })
          .where("instanceId", "=", params.instanceId)
          .where("scope", "=", params.scope)
          .whereNull("revokedAtMs");
        const instanceGrants = db
          .unionFrom("grants")
          .select({
            decisionId: "grantId",
            decision: "decision",
            remainingUses: "remainingUses",
            priority: db.unionValue(2),
            createdAtMs: "createdAtMs",
          })
          .where("scope", "=", params.scope)
          .where("instanceId", "=", params.instanceId)
          .whereNull("consumedAtMs")
          .whereAny(usableGrantPredicates);
        const globalGrants = db
          .unionFrom("grants")
          .select({
            decisionId: "grantId",
            decision: "decision",
            remainingUses: "remainingUses",
            priority: db.unionValue(3),
            createdAtMs: "createdAtMs",
          })
          .where("scope", "=", params.scope)
          .whereNull("instanceId")
          .where("decision", "!=", "always_deny")
          .whereNull("consumedAtMs")
          .whereAny(usableGrantPredicates);
        const row = await db
          .unionAll([
            globalDenyGrants,
            lanePolicies,
            instanceGrants,
            globalGrants,
          ])
          .orderBy("priority", "asc")
          .orderByNulls("remainingUses", "last")
          .orderBy("createdAtMs", "desc")
          .limit(1)
          .executeTakeFirst();

        if (row === null) {
          return null;
        }

        return {
          decisionId: row.decisionId,
          decision: row.decision,
          remainingUses: row.remainingUses,
        };
      },
    },
  });
  const checkDecision =
    readTestLedgerImplementations(decisionModel).queries?.checkDecision;

  if (checkDecision === undefined) {
    throw new Error("expected checkDecision query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      decisionId: "policy_1",
      decision: "allow",
      remainingUses: null,
      priority: 1,
      createdAtMs: 2_000,
    },
  });

  const result = await checkDecision(fake.scope, {
    instanceId: "instance_1",
    scope: "github.com",
  });

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: [
      0,
      "github.com",
      "always_deny",
      0,
      null,
      1,
      "instance_1",
      "github.com",
      2,
      "github.com",
      "instance_1",
      0,
      3,
      "github.com",
      "always_deny",
      0,
      1,
    ],
    sql: 'SELECT * FROM (SELECT "grantId" AS "decisionId", "decision" AS "decision", "remainingUses" AS "remainingUses", ? AS "priority", "createdAtMs" AS "createdAtMs" FROM "grants" WHERE "scope" = ? AND "instanceId" IS NULL AND "decision" = ? AND "consumedAtMs" IS NULL AND ("remainingUses" IS NULL OR "remainingUses" > ?) UNION ALL SELECT "policyEntryId" AS "decisionId", "decision" AS "decision", ? AS "remainingUses", ? AS "priority", "updatedAtMs" AS "createdAtMs" FROM "lanePolicies" WHERE "instanceId" = ? AND "scope" = ? AND "revokedAtMs" IS NULL UNION ALL SELECT "grantId" AS "decisionId", "decision" AS "decision", "remainingUses" AS "remainingUses", ? AS "priority", "createdAtMs" AS "createdAtMs" FROM "grants" WHERE "scope" = ? AND "instanceId" = ? AND "consumedAtMs" IS NULL AND ("remainingUses" IS NULL OR "remainingUses" > ?) UNION ALL SELECT "grantId" AS "decisionId", "decision" AS "decision", "remainingUses" AS "remainingUses", ? AS "priority", "createdAtMs" AS "createdAtMs" FROM "grants" WHERE "scope" = ? AND "instanceId" IS NULL AND "decision" != ? AND "consumedAtMs" IS NULL AND ("remainingUses" IS NULL OR "remainingUses" > ?)) ORDER BY "priority" ASC, CASE WHEN "remainingUses" IS NULL THEN 1 ELSE 0 END ASC, "createdAtMs" DESC LIMIT ?',
  });
  assert.deepEqual(result, {
    decisionId: "policy_1",
    decision: "allow",
    remainingUses: null,
  });
});

test("projection access decodes boolean and nullable union literals", async () => {
  const unionMaterializations = defineMaterialization(shape, {
    namespace: "union",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        checkUnion: {
          params: Type.Object({}),
          result: Type.Union([
            Type.Null(),
            Type.Object({
              isPrimary: Type.Boolean(),
              maybeEmail: Type.Union([Type.Null(), Type.String()]),
              userId: Type.String(),
            }),
          ]),
        },
      },
    });
  const unionModel = withMaterializations(
    shape,
    unionMaterializations,
  ).register({
    queries: {
      checkUnion: async ({ db }) => {
        return await db
          .unionAll([
            db.unionFrom("users").select({
              maybeEmail: db.unionValue(null),
              isPrimary: db.unionValue(true),
              userId: "userId",
            }),
            db.unionFrom("users").select({
              maybeEmail: "email",
              isPrimary: db.unionValue(false),
              userId: "userId",
            }),
          ])
          .orderBy("isPrimary", "desc")
          .executeTakeFirst();
      },
    },
  });
  const checkUnion =
    readTestLedgerImplementations(unionModel).queries?.checkUnion;

  if (checkUnion === undefined) {
    throw new Error("expected checkUnion query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      isPrimary: 1,
      maybeEmail: null,
      userId: "u_1",
    },
  });

  const result = await checkUnion(fake.scope, {});

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: [null, 1, 0, 1],
    sql: 'SELECT * FROM (SELECT ? AS "maybeEmail", ? AS "isPrimary", "userId" AS "userId" FROM "users" UNION ALL SELECT "email" AS "maybeEmail", ? AS "isPrimary", "userId" AS "userId" FROM "users") ORDER BY "isPrimary" DESC LIMIT ?',
  });
  assert.deepEqual(result, {
    isPrimary: true,
    maybeEmail: null,
    userId: "u_1",
  });
});

test("projection access supports typed inner joins between materialization tables", async () => {
  const networkMaterializations = defineMaterialization(shape, {
    namespace: "network",
  })
    .version(1, "create network request tables", (s) =>
      s
        .createTable("policyPromptRequests", (t) =>
          t
            .columns({
              policyPromptId: t.text().notNull(),
              requestId: t.text().notNull(),
              tenantId: t.text().notNull(),
            })
            .primaryKey(["tenantId", "policyPromptId", "requestId"])
            .index("policy_prompt_requests_by_request", ["requestId"]),
        )
        .createTable("requests", (t) =>
          t
            .columns({
              requestId: t.text().notNull(),
              instanceId: t.text().notNull(),
              runId: t.text().notNull(),
              requestedAtMs: t.integer().notNull(),
              resolvedAtMs: t.integer(),
              summary: t.text().notNull(),
              tenantId: t.text().notNull(),
            })
            .primaryKey(["requestId"])
            .index("requests_pending", ["resolvedAtMs", "requestedAtMs"]),
        ),
    )
    .define({
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
          .innerJoin("requests", [
            {
              fromColumn: "tenantId",
              toColumn: "tenantId",
            },
            {
              fromColumn: "requestId",
              toColumn: "requestId",
            },
          ])
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
    sql: 'SELECT "requests"."requestId" AS "requestId", "requests"."instanceId" AS "instanceId", "requests"."runId" AS "runId", "requests"."requestedAtMs" AS "requestedAtMs", "requests"."resolvedAtMs" AS "resolvedAtMs", "requests"."summary" AS "summary" FROM "policyPromptRequests" INNER JOIN "requests" ON "policyPromptRequests"."tenantId" = "requests"."tenantId" AND "policyPromptRequests"."requestId" = "requests"."requestId" WHERE "policyPromptRequests"."policyPromptId" = ? AND "requests"."resolvedAtMs" IS NULL ORDER BY "requests"."requestedAtMs" ASC, "requests"."requestId" ASC',
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
  const networkMaterializations = defineMaterialization(shape, {
    namespace: "network-anti-join",
  })
    .version(1, "create network request tables", (s) =>
      s
        .createTable("policyPromptRequests", (t) =>
          t
            .columns({
              policyPromptId: t.text().notNull(),
              requestId: t.text().notNull(),
            })
            .primaryKey(["policyPromptId", "requestId"])
            .index("policy_prompt_requests_by_request", ["requestId"]),
        )
        .createTable("requests", (t) =>
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
    )
    .define({
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

test("projection access supports left-joined optional rows", async () => {
  const operationMaterializations = defineMaterialization(shape, {
    namespace: "operation-status",
  })
    .version(1, "create operation status tables", (s) =>
      s
        .createTable("operations", (t) =>
          t
            .columns({
              operationKey: t.text().notNull(),
              requestedAtMs: t.integer().notNull(),
            })
            .primaryKey(["operationKey"]),
        )
        .createTable("completions", (t) =>
          t
            .columns({
              completedAtMs: t.integer().notNull(),
              operationKey: t.text().notNull(),
            })
            .primaryKey(["operationKey"]),
        ),
    )
    .define({
      indexers: {},
      queries: {
        completionByOperation: {
          params: Type.Object({
            operationKey: Type.String(),
          }),
          result: Type.Union([
            Type.Null(),
            Type.Object({
              completedAtMs: Type.Union([Type.Null(), Type.Number()]),
            }),
          ]),
        },
      },
    });
  const operationModel = withMaterializations(
    shape,
    operationMaterializations,
  ).register({
    queries: {
      completionByOperation: async ({ params, db }) => {
        return await db
          .selectFrom("operations")
          .leftJoin("completions", {
            fromColumn: "operationKey",
            toColumn: "operationKey",
          })
          .selectFrom("completions", ["completedAtMs"])
          .where("operations", "operationKey", "=", params.operationKey)
          .executeTakeFirst();
      },
    },
  });
  const completionByOperation =
    readTestLedgerImplementations(operationModel).queries
      ?.completionByOperation;

  if (completionByOperation === undefined) {
    throw new Error("expected completionByOperation query implementation");
  }

  const fake = createFakeScope({
    allRows: [],
    getRow: {
      completedAtMs: null,
    },
  });
  const row = await completionByOperation(fake.scope, {
    operationKey: "op_123",
  });

  assert.deepEqual(fake.calls[0], {
    method: "get",
    params: ["op_123", 1],
    sql: 'SELECT "completions"."completedAtMs" AS "completedAtMs" FROM "operations" LEFT JOIN "completions" ON "operations"."operationKey" = "completions"."operationKey" WHERE "operations"."operationKey" = ? LIMIT ?',
  });
  assert.deepEqual(row, {
    completedAtMs: null,
  });
});

test("projection access rejects unsafe predicate and self-join shapes", async () => {
  const nodeMaterializations = defineMaterialization(shape, {
    namespace: "node-shapes",
  })
    .version(1, "create nodes", (s) =>
      s.createTable("nodes", (t) =>
        t
          .columns({
            nodeId: t.text().notNull(),
            parentId: t.text(),
          })
          .primaryKey(["nodeId"]),
      ),
    )
    .define({
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
  const toolMaterializations = defineMaterialization(shape, {
    namespace: "tool-aggregates",
  })
    .version(1, "create tool call tables", (s) =>
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
    )
    .define({
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
  const eventMaterializations = defineMaterialization(shape, {
    namespace: "events",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
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
        sourceEventScan: {
          params: Type.Object({
            afterEventId: Type.Number(),
            limit: Type.Number(),
          }),
          result: Type.Array(UserCreatedSchema),
        },
        sourceEventScanByUser: {
          params: Type.Object({
            userId: Type.String(),
          }),
          result: Type.Array(UserCreatedSchema),
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
      sourceEventScan: async ({ params, db }) => {
        const events = await db
          .scanEvents("user.created")
          .afterEventId(params.afterEventId)
          .limit(params.limit)
          .execute();

        return events.map((event) => {
          return event.payload;
        });
      },
      sourceEventScanByUser: async ({ params, db }) => {
        const events = await db
          .scanEvents("user.created")
          .wherePayload("userId", params.userId)
          .orderByEventId("desc")
          .limit(1)
          .execute();

        return events.map((event) => {
          return event.payload;
        });
      },
    },
  });
  const eventQueries = readTestLedgerImplementations(eventModel).queries;
  const sourceEvent = eventQueries?.sourceEvent;
  const sourceEvents = eventQueries?.sourceEvents;
  const sourceEventScan = eventQueries?.sourceEventScan;
  const sourceEventScanByUser = eventQueries?.sourceEventScanByUser;

  if (sourceEvent === undefined) {
    throw new Error("expected sourceEvent query implementation");
  }

  if (sourceEvents === undefined) {
    throw new Error("expected sourceEvents query implementation");
  }

  if (sourceEventScan === undefined) {
    throw new Error("expected sourceEventScan query implementation");
  }

  if (sourceEventScanByUser === undefined) {
    throw new Error("expected sourceEventScanByUser query implementation");
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

  const scanFake = createFakeScope({
    allRows: [
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
  const scannedPayloads = await sourceEventScan(scanFake.scope, {
    afterEventId: 42,
    limit: 25,
  });

  assert.deepEqual(scanFake.calls[0], {
    method: "all",
    params: ["user.created", 0, 42, 25],
    sql: 'SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND "event_id" > ? ORDER BY "event_id" ASC LIMIT ?',
  });
  assert.deepEqual(scannedPayloads, [
    {
      userId: "u_456",
      email: "bob@example.com",
    },
  ]);

  const payloadScanFake = createFakeScope({
    allRows: [
      {
        causation_event_id: null,
        dedupe_key: null,
        event_id: 44,
        event_name: "user.created",
        payload_json: JSON.stringify({
          userId: "u_456",
          email: "bob-latest@example.com",
        }),
        ts_ms: 1_200,
      },
    ],
    getRow: undefined,
  });
  const payloadScannedPayloads = await sourceEventScanByUser(
    payloadScanFake.scope,
    {
      userId: "u_456",
    },
  );

  assert.deepEqual(payloadScanFake.calls[0], {
    method: "all",
    params: ["user.created", 0, "$.userId", "u_456", 1],
    sql: 'SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND json_extract("payload_json", ?) = ? ORDER BY "event_id" DESC LIMIT ?',
  });
  assert.deepEqual(payloadScannedPayloads, [
    {
      userId: "u_456",
      email: "bob-latest@example.com",
    },
  ]);
});

test("projection access scans semantic signals without exposing events table", async () => {
  const signalShape = defineLedgerShape({
    events: {
      "user.created": UserCreatedSchema,
    },
    queues: {},
    signals: {
      "run.stream.frame": RunStreamFrameSchema,
    },
    signalQueues: {},
  });
  const signalMaterializations = defineMaterialization(signalShape, {
    namespace: "signals",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        frameBoundsByRun: {
          params: Type.Object({
            afterSignalEventId: Type.Number(),
            runId: Type.String(),
          }),
          result: Type.Object({
            maxEventId: Type.Union([Type.Null(), Type.Number()]),
            minEventId: Type.Union([Type.Null(), Type.Number()]),
          }),
        },
        framesByRun: {
          params: Type.Object({
            afterSignalEventId: Type.Number(),
            limit: Type.Number(),
            runId: Type.String(),
          }),
          result: Type.Array(RunStreamFrameSchema),
        },
      },
    });
  const signalModel = withMaterializations(
    signalShape,
    signalMaterializations,
  ).register({
    queries: {
      frameBoundsByRun: async ({ params, db }) => {
        return await db
          .scanSignals("run.stream.frame")
          .wherePayload("runId", params.runId)
          .afterEventId(params.afterSignalEventId)
          .eventIdBounds();
      },
      framesByRun: async ({ params, db }) => {
        const frames = await db
          .scanSignals("run.stream.frame")
          .wherePayload("runId", params.runId)
          .afterEventId(params.afterSignalEventId)
          .limit(params.limit)
          .execute();

        return frames.map((frame) => {
          return frame.payload;
        });
      },
    },
  });
  const frameBoundsByRun =
    readTestLedgerImplementations(signalModel).queries?.frameBoundsByRun;
  const framesByRun =
    readTestLedgerImplementations(signalModel).queries?.framesByRun;

  if (frameBoundsByRun === undefined) {
    throw new Error("expected frameBoundsByRun query implementation");
  }

  if (framesByRun === undefined) {
    throw new Error("expected framesByRun query implementation");
  }

  const fake = createFakeScope({
    allRows: [
      {
        causation_event_id: null,
        dedupe_key: null,
        event_id: 101,
        event_name: "run.stream.frame",
        payload_json: JSON.stringify({
          runId: "run_1",
          frame: "thinking",
          sequence: 1,
        }),
        ts_ms: 1_000,
      },
    ],
    getRow: undefined,
  });
  const frames = await framesByRun(fake.scope, {
    afterSignalEventId: 100,
    limit: 25,
    runId: "run_1",
  });

  assert.deepEqual(fake.calls[0], {
    method: "all",
    params: ["run.stream.frame", 1, "$.runId", "run_1", 100, 25],
    sql: 'SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND json_extract("payload_json", ?) = ? AND "event_id" > ? ORDER BY "event_id" ASC LIMIT ?',
  });
  assert.deepEqual(frames, [
    {
      runId: "run_1",
      frame: "thinking",
      sequence: 1,
    },
  ]);

  const boundsFake = createFakeScope({
    allRows: [],
    getRow: {
      max_event_id: 120,
      min_event_id: 101,
    },
  });
  const bounds = await frameBoundsByRun(boundsFake.scope, {
    afterSignalEventId: 100,
    runId: "run_1",
  });

  assert.deepEqual(boundsFake.calls[0], {
    method: "get",
    params: ["run.stream.frame", 1, "$.runId", "run_1", 100],
    sql: 'SELECT MIN("event_id") AS "min_event_id", MAX("event_id") AS "max_event_id" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND json_extract("payload_json", ?) = ? AND "event_id" > ?',
  });
  assert.deepEqual(bounds, {
    maxEventId: 120,
    minEventId: 101,
  });
});

test("projection facade supports TorkBot-style surface operation materialization", async () => {
  const SurfaceOperationRequestedSchema = Type.Object({
    operationKey: Type.String(),
    requestedAtMs: Type.Number(),
    surfaceInstanceId: Type.String(),
    surfaceRefUrl: Type.String(),
    surfaceType: Type.String(),
  });
  const SurfaceOperationCompletedSchema = Type.Object({
    completedAtMs: Type.Number(),
    operationKey: Type.String(),
  });
  const SurfaceOperationFailedSchema = Type.Object({
    error: Type.String(),
    failedAtMs: Type.Number(),
    operationKey: Type.String(),
  });
  const surfaceEvents = {
    "surface.operation.completed": SurfaceOperationCompletedSchema,
    "surface.operation.failed": SurfaceOperationFailedSchema,
    "surface.operation.requested": SurfaceOperationRequestedSchema,
  };
  const surfaceShape = defineLedgerShape({
    events: surfaceEvents,
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const surfaceMaterializations = defineMaterialization(surfaceShape, {
    namespace: "surface-operations",
  })
    .version(1, "create surface operations", (s) =>
      s.createTable("surfaceOperations", (t) =>
        t
          .columns({
            completed: t.eventRef("surface.operation.completed"),
            completedAtMs: t.integer(),
            error: t.text(),
            failed: t.eventRef("surface.operation.failed"),
            failedAtMs: t.integer(),
            operationKey: t.text().notNull(),
            requested: t.eventRef("surface.operation.requested").notNull(),
            requestedAtMs: t.integer().notNull(),
            surfaceInstanceId: t.text().notNull(),
            surfaceRefUrl: t.text().notNull(),
            surfaceType: t.text().notNull(),
          })
          .primaryKey(["operationKey"])
          .index("surface_operations_pending", [
            "completedAtMs",
            "failedAtMs",
            "requestedAtMs",
          ]),
      ),
    )
    .define({
      indexers: {
        recordCompleted: {
          input: SurfaceOperationCompletedSchema,
          sourceEvent: "surface.operation.completed",
        },
        recordFailed: {
          input: SurfaceOperationFailedSchema,
          sourceEvent: "surface.operation.failed",
        },
        recordRequested: {
          input: SurfaceOperationRequestedSchema,
          sourceEvent: "surface.operation.requested",
        },
      },
      queries: {
        operationByKey: {
          params: Type.Object({ operationKey: Type.String() }),
          result: Type.Unknown(),
        },
        pendingOperations: {
          params: Type.Object({ limit: Type.Number() }),
          result: Type.Unknown(),
        },
        rebuildPreview: {
          params: Type.Object({ afterEventId: Type.Number() }),
          result: Type.Unknown(),
        },
      },
    });
  const surfaceModel = withMaterializations(
    surfaceShape,
    surfaceMaterializations,
  ).register({
    indexers: {
      recordCompleted: async ({ input, event, db }) => {
        await db
          .updateTable("surfaceOperations")
          .set({
            completed: event.ref,
            completedAtMs: input.completedAtMs,
            error: null,
            failed: null,
            failedAtMs: null,
          })
          .where("operationKey", "=", input.operationKey)
          .whereNull("completed")
          .execute();
      },
      recordFailed: async ({ input, event, db }) => {
        await db
          .updateTable("surfaceOperations")
          .set({
            error: input.error,
            failed: event.ref,
            failedAtMs: input.failedAtMs,
          })
          .where("operationKey", "=", input.operationKey)
          .whereNull("completed")
          .whereNull("failed")
          .execute();
      },
      recordRequested: async ({ input, event, db }) => {
        await db
          .insertInto("surfaceOperations")
          .values({
            completed: null,
            completedAtMs: null,
            error: null,
            failed: null,
            failedAtMs: null,
            operationKey: input.operationKey,
            requested: event.ref,
            requestedAtMs: input.requestedAtMs,
            surfaceInstanceId: input.surfaceInstanceId,
            surfaceRefUrl: input.surfaceRefUrl,
            surfaceType: input.surfaceType,
          })
          .onConflict(["operationKey"])
          .doUpdateSet({
            requested: event.ref,
            requestedAtMs: input.requestedAtMs,
            surfaceInstanceId: input.surfaceInstanceId,
            surfaceRefUrl: input.surfaceRefUrl,
            surfaceType: input.surfaceType,
          })
          .execute();
      },
    },
    queries: {
      operationByKey: async ({ params, db }) => {
        const row = await db
          .selectFrom("surfaceOperations")
          .select([
            "completed",
            "completedAtMs",
            "error",
            "failed",
            "failedAtMs",
            "operationKey",
            "requested",
            "requestedAtMs",
            "surfaceInstanceId",
            "surfaceRefUrl",
            "surfaceType",
          ])
          .where("operationKey", "=", params.operationKey)
          .executeTakeFirst();

        if (row === null) {
          return null;
        }

        const requested = await db.readEvent(row.requested);
        const completed =
          row.completed === null ? null : await db.readEvent(row.completed);

        return {
          completedPayload: completed?.payload ?? null,
          operationKey: row.operationKey,
          requestedPayload: requested?.payload ?? null,
          surfaceRefUrl: row.surfaceRefUrl,
        };
      },
      pendingOperations: async ({ params, db }) => {
        const rows = await db
          .selectFrom("surfaceOperations")
          .select(["operationKey", "requested", "requestedAtMs"])
          .whereNull("completed")
          .whereNull("failed")
          .orderBy("requestedAtMs", "asc")
          .orderBy("operationKey", "asc")
          .limit(params.limit)
          .execute();

        return rows.map((row) => {
          return {
            operationKey: row.operationKey,
            requestedEventId: row.requested.eventId,
            requestedAtMs: row.requestedAtMs,
          };
        });
      },
      rebuildPreview: async ({ params, db }) => {
        const requestedEvents = await db
          .scanEvents("surface.operation.requested")
          .afterEventId(params.afterEventId)
          .execute();
        const completedRefs = await db
          .scanEvents("surface.operation.completed")
          .afterEventId(params.afterEventId)
          .latestEventRefsByPayload("operationKey");
        const failedRefs = await db
          .scanEvents("surface.operation.failed")
          .afterEventId(params.afterEventId)
          .latestEventRefsByPayload("operationKey");
        const latestCompleted = new Map<string, number>();
        const latestFailed = new Map<string, number>();

        for (const eventRef of completedRefs) {
          latestCompleted.set(eventRef.payloadValue, eventRef.ref.eventId);
        }

        for (const eventRef of failedRefs) {
          latestFailed.set(eventRef.payloadValue, eventRef.ref.eventId);
        }

        return requestedEvents.map((event) => {
          const completedEventId =
            latestCompleted.get(event.payload.operationKey) ?? null;

          return {
            completedEventId,
            failedEventId:
              completedEventId === null
                ? (latestFailed.get(event.payload.operationKey) ?? null)
                : null,
            operationKey: event.payload.operationKey,
            requestedEventId: event.eventId,
          };
        });
      },
    },
  });
  const implementations = readTestLedgerImplementations(surfaceModel);
  const recordRequested = implementations.indexers?.recordRequested;
  const recordCompleted = implementations.indexers?.recordCompleted;
  const pendingOperations = implementations.queries?.pendingOperations;
  const operationByKey = implementations.queries?.operationByKey;
  const rebuildPreview = implementations.queries?.rebuildPreview;

  if (recordRequested === undefined) {
    throw new Error("expected recordRequested indexer implementation");
  }

  if (recordCompleted === undefined) {
    throw new Error("expected recordCompleted indexer implementation");
  }

  if (pendingOperations === undefined) {
    throw new Error("expected pendingOperations query implementation");
  }

  if (operationByKey === undefined) {
    throw new Error("expected operationByKey query implementation");
  }

  if (rebuildPreview === undefined) {
    throw new Error("expected rebuildPreview query implementation");
  }

  const requestedInput = {
    operationKey: "op_1",
    requestedAtMs: 1_000,
    surfaceInstanceId: "discord:123",
    surfaceRefUrl: "discord://channels/123/456",
    surfaceType: "discord",
  };
  const completedInput = {
    completedAtMs: 1_100,
    operationKey: "op_1",
  };
  const requestedContext: LedgerIndexerContext<typeof surfaceEvents> = {
    event: {
      causationEventId: null,
      dedupeKey: null,
      eventId: 101,
      eventName: "surface.operation.requested",
      payload: requestedInput,
      ref: createEventRef("surface.operation.requested", 101),
      tsMs: 1_000,
    },
  };
  const completedContext: LedgerIndexerContext<typeof surfaceEvents> = {
    event: {
      causationEventId: 101,
      dedupeKey: null,
      eventId: 102,
      eventName: "surface.operation.completed",
      payload: completedInput,
      ref: createEventRef("surface.operation.completed", 102),
      tsMs: 1_100,
    },
  };

  const requestedFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });
  await recordRequested(requestedFake.scope, requestedInput, requestedContext);

  assert.equal(requestedFake.calls[0]?.method, "run");
  assert.match(
    requestedFake.calls[0]?.sql ?? "",
    /^INSERT INTO "surfaceOperations"/,
  );
  assert.match(
    requestedFake.calls[0]?.sql ?? "",
    /ON CONFLICT \("operationKey"\) DO UPDATE SET/,
  );

  const completedFake = createFakeScope({
    allRows: [],
    getRow: undefined,
  });
  await recordCompleted(completedFake.scope, completedInput, completedContext);

  assert.deepEqual(completedFake.calls[0], {
    method: "run",
    params: [102, 1_100, null, null, null, "op_1"],
    sql: 'UPDATE "surfaceOperations" SET "completed" = ?, "completedAtMs" = ?, "error" = ?, "failed" = ?, "failedAtMs" = ? WHERE "operationKey" = ? AND "completed" IS NULL',
  });

  const pendingFake = createFakeScope({
    allRows: [
      {
        operationKey: "op_1",
        requested: 101,
        requestedAtMs: 1_000,
      },
    ],
    getRow: undefined,
  });
  const pendingRows = await pendingOperations(pendingFake.scope, { limit: 50 });

  assert.deepEqual(pendingFake.calls[0], {
    method: "all",
    params: [50],
    sql: 'SELECT "operationKey" AS "operationKey", "requested" AS "requested", "requestedAtMs" AS "requestedAtMs" FROM "surfaceOperations" WHERE "completed" IS NULL AND "failed" IS NULL ORDER BY "requestedAtMs" ASC, "operationKey" ASC LIMIT ?',
  });
  assert.deepEqual(pendingRows, [
    {
      operationKey: "op_1",
      requestedAtMs: 1_000,
      requestedEventId: 101,
    },
  ]);

  const getFake = createQueuedFakeScope({
    allRows: [
      [
        {
          causation_event_id: null,
          dedupe_key: null,
          event_id: 101,
          event_name: "surface.operation.requested",
          payload_json: JSON.stringify(requestedInput),
          ts_ms: 1_000,
        },
      ],
      [
        {
          causation_event_id: 101,
          dedupe_key: null,
          event_id: 102,
          event_name: "surface.operation.completed",
          payload_json: JSON.stringify(completedInput),
          ts_ms: 1_100,
        },
      ],
    ],
    getRows: [
      {
        completed: 102,
        completedAtMs: 1_100,
        error: null,
        failed: null,
        failedAtMs: null,
        operationKey: "op_1",
        requested: 101,
        requestedAtMs: 1_000,
        surfaceInstanceId: "discord:123",
        surfaceRefUrl: "discord://channels/123/456",
        surfaceType: "discord",
      },
    ],
  });
  const operation = await operationByKey(getFake.scope, {
    operationKey: "op_1",
  });

  assert.deepEqual(operation, {
    completedPayload: {
      completedAtMs: 1_100,
      operationKey: "op_1",
    },
    operationKey: "op_1",
    requestedPayload: {
      operationKey: "op_1",
      requestedAtMs: 1_000,
      surfaceInstanceId: "discord:123",
      surfaceRefUrl: "discord://channels/123/456",
      surfaceType: "discord",
    },
    surfaceRefUrl: "discord://channels/123/456",
  });

  const rebuildFake = createQueuedFakeScope({
    allRows: [
      [
        {
          causation_event_id: null,
          dedupe_key: null,
          event_id: 101,
          event_name: "surface.operation.requested",
          payload_json: JSON.stringify(requestedInput),
          ts_ms: 1_000,
        },
      ],
      [
        {
          event_id: 102,
          payload_value: "op_1",
        },
      ],
      [],
    ],
    getRows: [],
  });
  const rebuilt = await rebuildPreview(rebuildFake.scope, {
    afterEventId: 0,
  });

  assert.deepEqual(
    rebuildFake.calls.map((call) => call.params),
    [
      ["surface.operation.requested", 0, 0],
      ["$.operationKey", "surface.operation.completed", 0, 0, "$.operationKey"],
      ["$.operationKey", "surface.operation.failed", 0, 0, "$.operationKey"],
    ],
  );
  assert.equal(
    rebuildFake.calls[1]?.sql,
    'SELECT json_extract("payload_json", ?) AS "payload_value", MAX("event_id") AS "event_id" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND "event_id" > ? AND json_extract("payload_json", ?) IS NOT NULL GROUP BY "payload_value"',
  );
  assert.deepEqual(rebuilt, [
    {
      completedEventId: 102,
      failedEventId: null,
      operationKey: "op_1",
      requestedEventId: 101,
    },
  ]);
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
  assert.equal(definedModel.materializationHistory, history);
  assert.equal(registeredModel.materializationHistory, history);
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
  assert.equal(registeredModel.materializationHistory, null);
  assert.deepEqual(registeredModel.projections.metadata, {
    tables: {},
    relations: {},
  });
});

test("ledger materialization migrations apply relations over inferred tables", () => {
  const relationMaterializations = defineMaterialization(shape, {
    namespace: "relations",
  })
    .version(1, "create relation tables", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        )
        .addForeignKey("sessionUser", (r) =>
          r.foreignKey("sessions", ["userId"]).references("users", ["userId"]),
        ),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, relationMaterializations);

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
  const relationMaterializations = defineMaterialization(shape, {
    namespace: "ddl",
  })
    .version(1, "create ddl tables", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"])
            .index("sessionsByUser", ["userId"]),
        )
        .addForeignKey("sessionUser", (r) =>
          r
            .foreignKey("sessions", ["userId"])
            .references("users", ["userId"])
            .onDelete("cascade"),
        ),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const relationSchema = relationMaterializations.history.current;
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
  assert.deepEqual(
    compiler.compileAddColumn({
      column: {
        eventName: null,
        kind: "text",
        nullable: true,
      },
      columnName: "email",
      tableName: "users",
    }),
    {
      params: [],
      text: 'ALTER TABLE "users" ADD COLUMN "email" TEXT',
    },
  );
});

test("materialization migrations derive schema and record typed operations", () => {
  const materializationsV2 = defineMaterialization(shape, {
    namespace: "plan",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "add user email", (s) =>
      s
        .addColumn("users", "email", (t) => t.text())
        .createIndex("usersByEmail", "users", ["email"])
        .createUniqueIndex("usersByEmailUnique", "users", ["email"])
        .data("backfill user email", async ({ db }) => {
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
    )
    .define({
      indexers: {},
      queries: {},
    });
  const historyV2 = materializationsV2.history;

  assert.equal(historyV2.namespace, "plan");
  assert.equal(historyV2.currentVersion, 2);
  const firstMigrationVersion: 1 = historyV2.migrations[0].version;
  const secondMigrationVersion: 2 = historyV2.migrations[1].version;

  // @ts-expect-error generated histories carry the exact version tuple.
  historyV2.migrations[2];
  void firstMigrationVersion;
  void secondMigrationVersion;

  assert.deepEqual(historyV2.current.metadata.tables.users, {
    columns: {
      email: {
        eventName: null,
        kind: "text",
        nullable: true,
      },
      userId: {
        eventName: null,
        kind: "text",
        nullable: false,
      },
    },
    indexes: [
      {
        columns: ["email"],
        name: "usersByEmail",
        unique: false,
      },
      {
        columns: ["email"],
        name: "usersByEmailUnique",
        unique: true,
      },
    ],
    keys: [
      {
        columns: ["userId"],
        kind: "primary",
        name: null,
      },
      {
        columns: ["email"],
        kind: "unique",
        name: "usersByEmailUnique",
      },
    ],
    name: "users",
    primaryKey: ["userId"],
  });
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

  assert.deepEqual(secondMigration.operations[1], {
    index: {
      columns: ["email"],
      name: "usersByEmail",
      unique: false,
    },
    kind: "create_index",
    tableName: "users",
  });
  assert.deepEqual(secondMigration.operations[2], {
    index: {
      columns: ["email"],
      name: "usersByEmailUnique",
      unique: true,
    },
    kind: "create_index",
    tableName: "users",
  });

  const dataOperation = secondMigration.operations[3];

  if (dataOperation === undefined) {
    throw new Error("expected data migration operation");
  }

  if (dataOperation.kind !== "data") {
    throw new Error("expected data migration operation");
  }

  assert.equal(dataOperation.description, "backfill user email");
  assert.equal(typeof dataOperation.run, "function");

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "required-plan",
    })
      .version(1, "create users", (s) =>
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      )
      .version(2, "add required user email", (s) =>
        s.addColumn("users", "email", (t) => t.text().notNull()),
      )
      .define({
        indexers: {},
        queries: {},
      });
  }, /materialization add column users\.email cannot add a non-null column without a default/);

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "starts-at-two",
    })
      .version(2, "create users", (s) =>
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      )
      .define({
        indexers: {},
        queries: {},
      });
  }, /must start at version 1/);

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "duplicate-version",
    })
      .version(1, "create users", (s) =>
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      )
      .version(1, "duplicate", (s) =>
        s.addColumn("users", "email", (t) => t.text()),
      )
      .define({
        indexers: {},
        queries: {},
      });
  }, /duplicate materialization migration version 1/);

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "out-of-order",
    })
      .version(2, "create users", (s) =>
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      )
      .version(1, "add user email", (s) =>
        s.addColumn("users", "email", (t) => t.text()),
      )
      .define({
        indexers: {},
        queries: {},
      });
  }, /ascending version order/);

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "unknown-index-column",
    }).version(1, "create users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .createIndex("usersByEmail", "users", ["email" as never]),
    );
  }, /materialization create index references unknown column email/);

  assert.doesNotThrow(() => {
    defineMaterialization(shape, {
      namespace: "data-before-column",
    })
      .version(1, "create users", (s) =>
        s
          .createTable("users", (t) =>
            t
              .columns({
                userId: t.text().notNull(),
              })
              .primaryKey(["userId"]),
          )
          .data("premature backfill", () => undefined),
      )
      .version(2, "add user email", (s) =>
        s
          .addColumn("users", "email", (t) => t.text())
          .createIndex("usersByEmail", "users", ["email"])
          .createUniqueIndex("usersByEmailUnique", "users", ["email"]),
      )
      .define({
        indexers: {},
        queries: {},
      });
  });

  assert.doesNotThrow(() => {
    defineMaterialization(shape, {
      namespace: "data-after-column",
    })
      .version(1, "create users", (s) =>
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
      )
      .version(2, "add user email", (s) =>
        s
          .addColumn("users", "email", (t) => t.text())
          .data("premature keyed backfill", () => undefined)
          .createIndex("usersByEmail", "users", ["email"])
          .createUniqueIndex("usersByEmailUnique", "users", ["email"]),
      )
      .define({
        indexers: {},
        queries: {},
      });
  });

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "duplicate-index",
    })
      .version(1, "create users", (s) =>
        s.createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text(),
            })
            .primaryKey(["userId"]),
        ),
      )
      .version(2, "duplicate user email index", (s) =>
        s
          .createIndex("usersByEmail", "users", ["email"])
          .createIndex("usersByEmail", "users", ["userId"]),
      );
  }, /materialization history index usersByEmail conflicts with usersByEmail/);
});

test("materialization data migrations can scan typed ledger events", async () => {
  const backfilled: string[] = [];
  const migrationMaterializations = defineMaterialization(shape, {
    namespace: "event-backfill",
  })
    .version(1, "create and backfill users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .data("backfill users from events", async ({ db }) => {
          const events = await db
            .scanEvents("user.created")
            .afterEventId(0)
            .limit(10)
            .execute();

          for (const event of events) {
            backfilled.push(`${event.payload.userId}:${event.payload.email}`);
          }
        }),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const migrationHistory = migrationMaterializations.history;
  const migrationSchema = migrationHistory.current;
  const migration = migrationHistory.migrations[0];

  if (migration === undefined) {
    throw new Error("expected migration");
  }

  const dataOperation = migration.operations[1];

  if (dataOperation === undefined) {
    throw new Error("expected data migration operation");
  }

  if (dataOperation.kind !== "data") {
    throw new Error("expected data migration operation");
  }

  const event: EventEnvelope<typeof shape.shape.events, "user.created"> = {
    eventId: 1,
    ref: createEventRef("user.created", 1),
    tsMs: 1_000,
    eventName: "user.created",
    payload: {
      userId: "u_123",
      email: "alice@example.com",
    },
    causationEventId: null,
    dedupeKey: null,
  };
  const scanBuilder: ProjectionEventScanBuilder<
    typeof shape.shape.events,
    "user.created"
  > = {
    afterEventId: () => scanBuilder,
    limit: () => scanBuilder,
    orderByEventId: () => scanBuilder,
    wherePayload: () => scanBuilder,
    eventIdBounds: async () => ({
      maxEventId: event.eventId,
      minEventId: event.eventId,
    }),
    latestEventRefsByPayload: async () => [
      {
        payloadValue: event.payload.userId,
        ref: event.ref,
      },
    ],
    execute: async () => [event],
    stream: async function* () {
      yield event;
    },
  };
  const migrationDb: MaterializationMigrationDatabaseFor<
    typeof migrationMaterializations,
    typeof shape.shape.events
  > = {
    deleteFrom: () => {
      throw new Error("unexpected migration delete");
    },
    insertInto: () => {
      throw new Error("unexpected migration insert");
    },
    readEvent: () => {
      throw new Error("unexpected migration event read");
    },
    readEvents: () => {
      throw new Error("unexpected migration event batch read");
    },
    scanEvents: (eventName) => {
      assert.equal(eventName, "user.created");

      return scanBuilder as ProjectionEventScanBuilder<
        typeof shape.shape.events,
        typeof eventName
      >;
    },
    selectFrom: () => {
      throw new Error("unexpected migration select");
    },
    updateTable: () => {
      throw new Error("unexpected migration update");
    },
  };

  await dataOperation.run({
    db: migrationDb,
  });

  assert.deepEqual(backfilled, ["u_123:alice@example.com"]);
});

test("materialization migrations replay foreign keys against current state", () => {
  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "relation-history",
    }).version(1, "create relation tables", (s) =>
      s
        .createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        )
        .addForeignKey("sessionUser", (r) =>
          r
            .foreignKey("sessions", ["userId"])
            .references("users" as never, ["userId"] as never),
        )
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        ),
    );
  }, /foreign key reference references unknown table users/);

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "relation-key-history",
    })
      .version(1, "create relation tables", (s) =>
        s
          .createTable("users", (t) =>
            t
              .columns({
                userId: t.text().notNull(),
                email: t.text().notNull(),
              })
              .primaryKey(["userId"]),
          )
          .createTable("sessions", (t) =>
            t
              .columns({
                sessionId: t.text().notNull(),
                email: t.text().notNull(),
              })
              .primaryKey(["sessionId"]),
          )
          .addForeignKey("sessionUserEmail", (r) =>
            r
              .foreignKey("sessions", ["email"])
              .references("users", ["email" as never]),
          ),
      )
      .version(2, "add email key", (s) =>
        s.createUniqueIndex("usersByEmail", "users", ["email"]),
      );
  }, /foreign key reference must target a primary or unique key on users/);
});

test("materialization migrations derive columns by operation order", () => {
  const reorderedMaterializations = defineMaterialization(shape, {
    namespace: "column-order",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "add display name", (s) =>
      s.addColumn("users", "displayName", (t) => t.text()),
    )
    .define({
      indexers: {},
      queries: {},
    });

  assert.deepEqual(
    Object.keys(
      reorderedMaterializations.history.current.metadata.tables.users
        ?.columns ?? {},
    ),
    ["userId", "email", "displayName"],
  );
});

test("materialization migrations reject event refs outside the ledger shape", () => {
  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "invalid-events",
    })
      .version(1, "create invalid sessions", (s) =>
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              source: t
                // @ts-expect-error runtime validation protects unchecked callers too.
                .eventRef("session.created")
                .notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
      )
      .define({
        indexers: {},
        queries: {},
      });
  }, /references unknown event session\.created/);

  assert.throws(() => {
    defineMaterialization(shape, {
      namespace: "invalid-added-events",
    })
      .version(1, "create sessions", (s) =>
        s.createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        ),
      )
      .version(2, "add invalid source", (s) =>
        s.addColumn("sessions", "source", (t) =>
          // @ts-expect-error runtime validation protects unchecked callers too.
          t.eventRef("session.created"),
        ),
      )
      .define({
        indexers: {},
        queries: {},
      });
  }, /references unknown event session\.created/);
});

test("withMaterializations rejects unchecked indexer source events outside the ledger shape", () => {
  const invalidIndexerMaterializations = defineMaterialization(shape, {
    namespace: "invalid-indexer-source",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
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
  const multiEventMaterializations = defineMaterialization(multiEventShape, {
    namespace: "source-events",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
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

  const typedMaterializations = defineMaterialization(shape, {
    namespace: "types",
  })
    .version(1, "create users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text().notNull(),
              source: t.eventRef("user.created").notNull(),
            })
            .primaryKey(["userId"]),
        )
        .data("typed user data", async ({ db }) => {
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

          const sourceEvent = await db.readEvent(
            createEventRef("user.created", 1),
          );

          if (sourceEvent !== null) {
            const sourceUserId: string = sourceEvent.payload.userId;
            const sourceEmail: string = sourceEvent.payload.email;
            // @ts-expect-error migration event reads use ledger event payload types.
            const sessionId: string = sourceEvent.payload.sessionId;

            void sourceUserId;
            void sourceEmail;
            void sessionId;
          }

          const sourceEvents = await db
            .scanEvents("user.created")
            .afterEventId(0)
            .limit(10)
            .execute();

          for (const source of sourceEvents) {
            const sourceEmail: string = source.payload.email;

            void sourceEmail;
          }

          // @ts-expect-error migration data cannot select unknown tables.
          db.selectFrom("sessions");
          // @ts-expect-error migration data cannot scan unknown events.
          db.scanEvents("session.created");
          // @ts-expect-error migration data can only select known columns.
          db.selectFrom("users").select(["missing"]);
          // @ts-expect-error migration data can only update known columns.
          db.updateTable("users").set({ missing: "" });
        }),
    )
    .define({
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
  const typedHistory = typedMaterializations.history;
  const typedSchema: MaterializationSchemaFor<typeof typedMaterializations> =
    typedHistory.current;

  const useGeneratedReadDb = (
    db: MaterializationReadDatabaseFor<
      typeof typedMaterializations,
      typeof shape.shape.events
    >,
  ) => {
    db.selectFrom("users").select(["email"]);
    db.scanEvents("user.created");

    // @ts-expect-error generated read databases cannot mutate tables.
    db.updateTable("users");
    // @ts-expect-error generated read databases only expose generated tables.
    db.selectFrom("sessions");
  };

  const useGeneratedWriteDb = (
    db: MaterializationWriteDatabaseFor<typeof typedMaterializations>,
  ) => {
    db.updateTable("users").set({ email: "alice@example.com" });

    // @ts-expect-error generated write databases do not expose reads.
    db.selectFrom("users");
    // @ts-expect-error generated write databases only expose generated tables.
    db.insertInto("sessions");
  };

  const useGeneratedDb = (
    db: MaterializationDatabaseFor<
      typeof typedMaterializations,
      typeof shape.shape.events
    >,
  ) => {
    db.insertInto("users");
    db.selectFrom("users");
    db.readEvent(createEventRef("user.created", 1));

    // @ts-expect-error generated databases only expose generated tables.
    db.selectFrom("sessions");
  };

  void useGeneratedReadDb;
  void useGeneratedWriteDb;
  void useGeneratedDb;

  const invalidMigrationBuilder = defineMaterialization(shape, {
    namespace: "invalid-migration-types",
  }).version(1, "create users", (s) =>
    s.createTable("users", (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          email: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
    ),
  );

  invalidMigrationBuilder.version(2, "unknown table", (s) =>
    // @ts-expect-error migration operations only reference known tables.
    s.createIndex("missing", "sessions", ["sessionId"]),
  );
  invalidMigrationBuilder.version(2, "unknown column", (s) =>
    // @ts-expect-error migration operations only reference known columns.
    s.createIndex("missing", "users", ["missing"]),
  );
  invalidMigrationBuilder.version(2, "invalid event ref", (s) =>
    s.addColumn("users", "sessionSource", (t) =>
      // @ts-expect-error migration event refs must come from the ledger shape.
      t.eventRef("session.created").notNull(),
    ),
  );

  const invalidSource = defineMaterialization(shape, {
    namespace: "invalid-source-types",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
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

  const joinMaterializations = defineMaterialization(shape, {
    namespace: "join-types",
  })
    .version(1, "create join tables", (s) =>
      s
        .createTable("children", (t) =>
          t
            .columns({
              childId: t.text().notNull(),
              parentId: t.text().notNull(),
            })
            .primaryKey(["childId"]),
        )
        .createTable("parents", (t) =>
          t
            .columns({
              deletedAtMs: t.integer(),
              parentId: t.text().notNull(),
              rank: t.integer().notNull(),
            })
            .primaryKey(["parentId"]),
        ),
    )
    .define({
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
        const optionalParent = await db
          .selectFrom("children")
          .leftJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank", "deletedAtMs"])
          .executeTakeFirst();

        if (optionalParent !== null) {
          const rank: number | null = optionalParent.rank;
          const deletedAtMs: number | null = optionalParent.deletedAtMs;
          // @ts-expect-error left-joined rows can be absent.
          const strictRank: number = optionalParent.rank;

          void rank;
          void deletedAtMs;
          void strictRank;
        }

        const requiredChild = await db
          .selectFrom("children")
          .leftJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("children", ["childId"])
          .executeTakeFirst();

        if (requiredChild !== null) {
          const childId: string = requiredChild.childId;

          void childId;
        }

        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          .orderByNulls("parents", "deletedAtMs", "last");
        db.selectFrom("children")
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "parentId",
          })
          .selectFrom("parents", ["rank"])
          // @ts-expect-error joined orderByNulls only accepts nullable columns.
          .orderByNulls("parents", "rank", "last");
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
          // @ts-expect-error joined columns must have compatible value types.
          .innerJoin("parents", {
            fromColumn: "parentId",
            toColumn: "rank",
          })
          .selectFrom("parents", ["rank"]);
        db.selectFrom("children")
          .innerJoin("parents", [
            {
              fromColumn: "parentId",
              toColumn: "parentId",
            },
            {
              fromColumn: "childId",
              // @ts-expect-error composite join columns must have compatible value types.
              toColumn: "rank",
            },
          ])
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
          .values([
            {
              userId: "u_123",
              email: "alice@example.com",
              source: event.ref,
            },
            {
              userId: "u_456",
              email: "bob@example.com",
              source: event.ref,
            },
          ])
          .execute();
        db.insertInto("users").values([
          // @ts-expect-error batch inserts must provide every projection column.
          {
            userId: "u_456",
            source: event.ref,
          },
        ]);
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
        db.selectFrom("users")
          .select(["email"])
          // @ts-expect-error orderByNulls only accepts nullable columns.
          .orderByNulls("email", "last");

        const firstUnionArm = db.unionFrom("users").select({
          deletedAtMs: db.unionValue(null),
          priority: db.unionValue(0),
          userId: "userId",
        });
        const secondUnionArm = db.unionFrom("users").select({
          deletedAtMs: db.unionValue(null),
          priority: db.unionValue(1),
          userId: "email",
        });
        const unionRow = await db
          .unionAll([firstUnionArm, secondUnionArm])
          .orderBy("priority", "asc")
          .orderByNulls("deletedAtMs", "last")
          .executeTakeFirst();

        if (unionRow !== null) {
          const unionUserId: string = unionRow.userId;
          const unionPriority: number = unionRow.priority;
          const unionDeletedAtMs: null = unionRow.deletedAtMs;

          void unionUserId;
          void unionPriority;
          void unionDeletedAtMs;
        }

        const nullableFirstUnionRow = await db
          .unionAll([
            db.unionFrom("users").select({
              maybeEmail: db.unionValue(null),
              priority: db.unionValue(0),
              userId: "userId",
            }),
            db.unionFrom("users").select({
              maybeEmail: "email",
              priority: db.unionValue(1),
              userId: "userId",
            }),
          ])
          .executeTakeFirst();

        if (nullableFirstUnionRow !== null) {
          const maybeEmail: string | null = nullableFirstUnionRow.maybeEmail;
          void maybeEmail;
        }

        db.unionAll([
          firstUnionArm,
          // @ts-expect-error union arms must select the same aliases.
          db.unionFrom("users").select({
            deletedAtMs: db.unionValue(null),
            priority: db.unionValue(2),
            missing: "email",
          }),
        ]);
        db.unionAll([
          firstUnionArm,
          // @ts-expect-error union arm values must match by alias.
          db.unionFrom("users").select({
            deletedAtMs: db.unionValue(null),
            priority: db.unionValue("high"),
            userId: "email",
          }),
        ]);
        db.unionAll([firstUnionArm, secondUnionArm])
          // @ts-expect-error union orderBy only accepts selected aliases.
          .orderBy("email", "asc");
        db.unionAll([firstUnionArm, secondUnionArm])
          // @ts-expect-error union orderByNulls only accepts nullable aliases.
          .orderByNulls("priority", "last");

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

        for await (const scannedEvent of db
          .scanEvents("user.created")
          .wherePayload("userId", "u_1")
          .afterEventId(0)
          .orderByEventId("desc")
          .limit(10)
          .stream()) {
          const userId: string = scannedEvent.payload.userId;

          void userId;
        }

        const latestUserRefs = await db
          .scanEvents("user.created")
          .latestEventRefsByPayload("userId");
        const latestUserRef = latestUserRefs[0] ?? null;

        if (latestUserRef !== null) {
          const payloadValue: string = latestUserRef.payloadValue;
          const ref: EventRef<"user.created"> = latestUserRef.ref;

          void payloadValue;
          void ref;
        }

        db.scanEvents("user.created")
          // @ts-expect-error latest event refs must group by known string payload fields.
          .latestEventRefsByPayload("sessionId");

        db.scanEvents("user.created")
          // @ts-expect-error event payload filters must reference known payload fields.
          .wherePayload("sessionId", "s_1");

        db.scanEvents("user.created")
          // @ts-expect-error event payload filters must use values compatible with the payload field type.
          .wherePayload("userId", 1);

        // @ts-expect-error event scans must reference known ledger events.
        db.scanEvents("session.created");

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
  } satisfies MaterializationImplementationRegistrationFor<
    typeof typedMaterializations,
    typeof shape.shape.events
  >;

  const uniqueEmailMaterializations = defineMaterialization(shape, {
    namespace: "unique-email-types",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "add email uniqueness", (s) =>
      s.createUniqueIndex("usersByEmail", "users", ["email"]),
    )
    .define({
      indexers: {
        upsertByEmail: {
          sourceEvent: "user.created",
          input: Type.Object({}),
        },
      },
      queries: {},
    });
  const uniqueEmailImplementations = {
    indexers: {
      upsertByEmail: async ({ db, event }) => {
        await db
          .insertInto("users")
          .values({
            userId: "u_123",
            email: "alice@example.com",
            source: event.ref,
          })
          .onConflict(["email"])
          .doUpdateSet({
            source: event.ref,
          })
          .execute();
      },
    },
  } satisfies MaterializationImplementationRegistrationFor<
    typeof uniqueEmailMaterializations,
    typeof shape.shape.events
  >;

  const typedSignalShape = defineLedgerShape({
    events: {
      "user.created": UserCreatedSchema,
    },
    queues: {},
    signals: {
      "run.stream.frame": RunStreamFrameSchema,
    },
    signalQueues: {},
  });
  const typedSignalMaterializations = defineMaterialization(typedSignalShape, {
    namespace: "signal-types",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        framesByRun: {
          params: Type.Object({
            runId: Type.String(),
          }),
          result: Type.Array(RunStreamFrameSchema),
        },
      },
    });
  const typedSignalImplementations = {
    queries: {
      framesByRun: async ({ db }) => {
        for await (const signal of db
          .scanSignals("run.stream.frame")
          .wherePayload("runId", "run_1")
          .wherePayload("sequence", 1)
          .stream()) {
          const runId: string = signal.payload.runId;
          const frame: string = signal.payload.frame;
          const sequence: number = signal.payload.sequence;

          void runId;
          void frame;
          void sequence;
        }

        const bounds = await db.scanSignals("run.stream.frame").eventIdBounds();
        const minEventId: number | null = bounds.minEventId;
        const maxEventId: number | null = bounds.maxEventId;
        // @ts-expect-error event id bounds expose minEventId and maxEventId only.
        const missingEventId = bounds.eventId;

        void minEventId;
        void maxEventId;
        void missingEventId;

        const latestSignalRefs = await db
          .scanSignals("run.stream.frame")
          .latestEventRefsByPayload("runId");
        const latestSignalRef = latestSignalRefs[0] ?? null;

        if (latestSignalRef !== null) {
          const payloadValue: string = latestSignalRef.payloadValue;
          const ref: EventRef<"run.stream.frame"> = latestSignalRef.ref;

          void payloadValue;
          void ref;
        }

        db.scanSignals("run.stream.frame")
          // @ts-expect-error latest event refs can only group by string payload fields.
          .latestEventRefsByPayload("sequence");

        db.scanSignals("run.stream.frame")
          // @ts-expect-error signal payload filters must reference known signal payload fields.
          .wherePayload("missing", "value");

        db.scanSignals("run.stream.frame")
          // @ts-expect-error signal payload filters must use values compatible with the payload field type.
          .wherePayload("sequence", "1");

        // @ts-expect-error signal scans must reference known ledger signals.
        db.scanSignals("user.created");

        return [];
      },
    },
  } satisfies MaterializationImplementationRegistrationFor<
    typeof typedSignalMaterializations,
    typeof typedSignalShape.shape.events,
    typeof typedSignalShape.shape.signals
  >;

  void typedImplementations;
  void uniqueEmailImplementations;
  void typedSignalImplementations;
}

void assertLedgerProjectionTypes;
