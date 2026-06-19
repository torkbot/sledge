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
          .primaryKey(["userId"]),
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
  assert.deepEqual(historyV2.migrations[1]?.operations, [
    {
      column: {
        eventName: null,
        kind: "text",
        nullable: true,
      },
      columnName: "email",
      kind: "add_column",
      tableName: "users",
    },
    {
      index: {
        columns: ["email"],
        name: "usersByEmail",
        unique: false,
      },
      kind: "create_index",
      tableName: "users",
    },
    {
      index: {
        columns: ["email"],
        name: "usersByEmailUnique",
        unique: true,
      },
      kind: "create_index",
      tableName: "users",
    },
  ]);

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
  const invalidHistory = defineMaterializationHistory(validSchemaV2, (m) => [
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
  const invalidHistoricalMaterializations = defineMaterializations({
    history: invalidHistory,
    indexers: {},
    queries: {},
  });

  assert.throws(() => {
    withMaterializations(shape, invalidHistoricalMaterializations);
  }, /references unknown event session\.created/);
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
