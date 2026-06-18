import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { createEventRef } from "./event-ref.ts";
import type {
  EventEnvelope,
  LedgerIndexerContext,
  LedgerStorageRow,
  LedgerStorageScope,
} from "./ledger.ts";
import { defineLedgerShape } from "./ledger.ts";

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

const definedModel = shape.withProjections(
  (p) =>
    p.tables({
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
    }),
  {
    indexers: {
      upsertUser: (i) =>
        i
          .sourceEvent("user.created")
          .input(
            Type.Object({
              userId: Type.String(),
              email: Type.String(),
            }),
          )
          .write(async ({ input, event, db }) => {
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
          }),
    },
    queries: {
      userById: (q) =>
        q
          .params(
            Type.Object({
              userId: Type.String(),
            }),
          )
          .result(
            Type.Union([
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
          )
          .read(async ({ params, db }) => {
            return await db
              .selectFrom("users")
              .select(["userId", "email", "source"])
              .where("userId", "=", params.userId)
              .executeTakeFirst();
          }),
    },
  },
);

const registeredModelWithoutHandlers = definedModel.register({});

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

test("projection access compiles typed indexer and query builders to storage operations", async () => {
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
    registeredModel.implementations.indexers?.upsertUser,
    registeredModelWithoutHandlers.implementations.indexers?.upsertUser,
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

async function assertLedgerProjectionTypes(): Promise<void> {
  shape.withProjections(
    (p) =>
      p.tables({
        sessions: (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              // @ts-expect-error projection event refs must come from the ledger shape.
              source: t.eventRef("session.created").notNull(),
            })
            .primaryKey(["sessionId"]),
      }),
    {
      indexers: {},
      queries: {},
    },
  );

  shape.withProjections(
    (p) =>
      p.tables({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text().notNull(),
              source: t.eventRef("user.created").notNull(),
            })
            .primaryKey(["userId"]),
      }),
    {
      indexers: {
        invalidSource: (i) =>
          i
            // @ts-expect-error source events must come from the projection event-name union.
            .sourceEvent("session.created")
            .input(Type.Object({}))
            .write(() => undefined),
        wrongEventRef: (i) =>
          i
            .sourceEvent("user.created")
            .input(Type.Object({}))
            .write(async ({ db }) => {
              await db
                .insertInto("users")
                .values({
                  userId: "u_123",
                  email: "alice@example.com",
                  // @ts-expect-error event_ref columns only accept matching event refs.
                  source: createEventRef("session.created", 1),
                })
                .execute();
            }),
        incompleteInsert: (i) =>
          i
            .sourceEvent("user.created")
            .input(Type.Object({}))
            .write(async ({ db, event }) => {
              await db
                .insertInto("users")
                // @ts-expect-error inserts must provide every projection column.
                .values({
                  userId: "u_123",
                  source: event.ref,
                })
                .execute();
            }),
        nonKeyConflict: (i) =>
          i
            .sourceEvent("user.created")
            .input(Type.Object({}))
            .write(async ({ db, event }) => {
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
            }),
      },
      queries: {
        selectedColumns: (q) =>
          q
            .params(Type.Object({}))
            .result(Type.Null())
            .read(async ({ db }) => {
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
            }),
      },
    },
  );
}

void assertLedgerProjectionTypes;
