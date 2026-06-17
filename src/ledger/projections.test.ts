import assert from "node:assert/strict";
import test from "node:test";

import {
  defineProjectionSchema,
  defineProjectionSchemaForEvents,
  type EventRef,
  type ProjectionRow,
  type ProjectionSchemaTables,
  type ProjectionTableColumns,
} from "./projections.ts";

const defineEventProjectionSchema = defineProjectionSchemaForEvents<
  "session.created" | "user.created"
>();

const projections = defineEventProjectionSchema({
  users: (t) =>
    t
      .columns({
        userId: t.text().notNull(),
        email: t.text().notNull(),
        source: t.eventRef("user.created").notNull(),
      })
      .primaryKey(["userId"])
      .unique("users_email_unique", ["email"]),
  sessions: (t) =>
    t
      .columns({
        sessionId: t.text().notNull(),
        userId: t.text().notNull(),
        createdAtMs: t.integer().notNull(),
        source: t.eventRef("session.created").notNull(),
      })
      .primaryKey(["sessionId"])
      .index("sessions_by_user", ["userId"]),
}).relations((r) => ({
  sessionUser: r
    .foreignKey("sessions", ["userId"])
    .references("users", ["userId"])
    .onDelete("cascade"),
}));

type Tables = ProjectionSchemaTables<typeof projections>;
type UserColumns = ProjectionTableColumns<Tables["users"]>;
type UserRow = ProjectionRow<UserColumns>;

const validUserRow: UserRow = {
  userId: "u_123",
  email: "alice@example.com",
  source: {
    eventName: "user.created",
    eventId: 1,
  },
};

const validUserSource: EventRef<"user.created"> = validUserRow.source;

void validUserSource;

test("defineProjectionSchema records table, column, index, and relation metadata", () => {
  assert.deepEqual(projections.metadata, {
    tables: {
      users: {
        name: "users",
        columns: {
          userId: {
            kind: "text",
            nullable: false,
            eventName: null,
          },
          email: {
            kind: "text",
            nullable: false,
            eventName: null,
          },
          source: {
            kind: "event_ref",
            nullable: false,
            eventName: "user.created",
          },
        },
        primaryKey: ["userId"],
        indexes: [
          {
            name: "users_email_unique",
            columns: ["email"],
            unique: true,
          },
        ],
      },
      sessions: {
        name: "sessions",
        columns: {
          sessionId: {
            kind: "text",
            nullable: false,
            eventName: null,
          },
          userId: {
            kind: "text",
            nullable: false,
            eventName: null,
          },
          createdAtMs: {
            kind: "integer",
            nullable: false,
            eventName: null,
          },
          source: {
            kind: "event_ref",
            nullable: false,
            eventName: "session.created",
          },
        },
        primaryKey: ["sessionId"],
        indexes: [
          {
            name: "sessions_by_user",
            columns: ["userId"],
            unique: false,
          },
        ],
      },
    },
    relations: {
      sessionUser: {
        fromTable: "sessions",
        fromColumns: ["userId"],
        toTable: "users",
        toColumns: ["userId"],
        onDelete: "cascade",
      },
    },
  });
});

test("projection builders validate runtime metadata", () => {
  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey([]),
      }),
    /primary key must include at least one column/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        "": (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
      }),
    /projection table name must be non-empty/,
  );

  assert.throws(
    () =>
      projections.relations((r) => {
        const foreignKey = r.foreignKey as (
          tableName: string,
          columns: readonly string[],
        ) => ReturnType<typeof r.foreignKey>;

        return {
          invalidTable: foreignKey("missing", ["userId"]).references("users", [
            "userId",
          ]),
        };
      }),
    /foreign key references unknown table missing/,
  );

  assert.throws(
    () =>
      projections.relations((r) => {
        const foreignKey = r.foreignKey as (
          tableName: string,
          columns: readonly string[],
        ) => {
          references(
            tableName: string,
            columns: readonly string[],
          ): ReturnType<ReturnType<typeof r.foreignKey>["references"]>;
        };

        return {
          incompatibleReference: foreignKey("sessions", [
            "createdAtMs",
          ]).references("users", ["userId"]),
        };
      }),
    /foreign key reference columns must have matching types/,
  );
});

function assertProjectionTypes(): void {
  defineProjectionSchemaForEvents<"user.created">()({
    users: (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          // @ts-expect-error unknown durable event names cannot be referenced.
          source: t.eventRef("session.created").notNull(),
        })
        .primaryKey(["userId"]),
  });

  defineProjectionSchema({
    users: (t) =>
      t
        .columns({
          userId: t.text().notNull(),
        })
        // @ts-expect-error primary keys must reference declared columns.
        .primaryKey(["missing"]),
  });

  projections.relations((r) => ({
    invalidTable: r
      // @ts-expect-error foreign keys must start from a declared table.
      .foreignKey("missing", ["userId"])
      .references("users", ["userId"]),
  }));

  projections.relations((r) => ({
    invalidColumn: r
      // @ts-expect-error foreign keys must start from declared columns.
      .foreignKey("sessions", ["missing"])
      .references("users", ["userId"]),
  }));

  projections.relations((r) => ({
    incompatibleReference: r
      .foreignKey("sessions", ["createdAtMs"])
      // @ts-expect-error referenced columns must have compatible scalar types.
      .references("users", ["userId"]),
  }));
}

void assertProjectionTypes;
