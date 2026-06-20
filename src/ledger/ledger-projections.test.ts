import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { createEventRef } from "./event-ref.ts";
import type {
  EventEnvelope,
  LedgerIndexerContext,
  LedgerStorageRow,
  LedgerStorageScope,
  MaterializationImplementationRegistration,
} from "./ledger.ts";
import {
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

test("projection access compiles typed indexer and query definitions to storage operations", async () => {
  const indexer =
    registeredModelWithoutHandlers.implementations.indexers?.upsertUser;
  const query =
    registeredModelWithoutHandlers.implementations.queries?.userById;

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
    params: ["u_123"],
    sql: 'SELECT "userId" AS "userId", "email" AS "email", "source" AS "source" FROM "users" WHERE "userId" = ? LIMIT 1',
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
    await indexer(
      invalidRefFake.scope,
      {
        userId: "u_123",
        email: "alice@example.com",
      },
      createUserCreatedContext(0),
    );
  }, /users\.source event reference id must be a positive safe integer/);
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
  const insertJson = registeredJsonModel.implementations.indexers?.insertJson;
  const updateJson = registeredJsonModel.implementations.indexers?.updateJson;

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
      createUserCreatedContext(43),
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
      createUserCreatedContext(44),
    );
  }, /jsonRows\.metadata\.nested must be JSON-serializable/);
  assert.deepEqual(invalidUpdateFake.calls, []);
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
    typeof registeredModel.implementations.indexers?.upsertUser,
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
      ]),
      m.migration(2, "forget user email index", (s) => [
        s.addColumn("users", "email", (t) => t.text()),
      ]),
    ]);
  }, /materialization history table users must match current schema keys/);
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

        return null;
      },
    },
  } satisfies MaterializationImplementationRegistration<
    typeof typedSchema,
    typeof typedMaterializations.indexers,
    typeof typedMaterializations.queries
  >;

  void typedImplementations;
}

void assertLedgerProjectionTypes;
