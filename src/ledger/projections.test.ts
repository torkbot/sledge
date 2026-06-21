import assert from "node:assert/strict";
import test from "node:test";

import {
  defineProjectionSchema,
  defineProjectionSchemaForEvents,
  type EventRef,
  type ProjectionForeignKeyAction,
  type ProjectionRelationDefinition,
  type ProjectionRow,
  type ProjectionSchemaTables,
  type ProjectionTableBuilder,
  type ProjectionTableColumns,
  type ProjectionTableMetadata,
} from "./projections.ts";

type RuntimeProjectionTable = {
  readonly metadata: ProjectionTableMetadata;
};

type RuntimeProjectionTableFactory = (
  table: ProjectionTableBuilder<string>,
) => RuntimeProjectionTable;

type RuntimeReferenceBuilder = {
  references(
    tableName: string,
    columns: readonly string[],
  ): ProjectionRelationDefinition;
};

type RuntimeRelationBuilder = {
  foreignKey(
    tableName: string,
    columns: readonly string[],
  ): RuntimeReferenceBuilder;
};

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
  optionalSessions: (t) =>
    t
      .columns({
        optionalSessionId: t.text().notNull(),
        userId: t.text(),
      })
      .primaryKey(["optionalSessionId"]),
}).relations((r) => ({
  sessionUser: r
    .foreignKey("sessions", ["userId"])
    .references("users", ["userId"])
    .onDelete("cascade"),
  optionalSessionUser: r
    .foreignKey("optionalSessions", ["userId"])
    .references("users", ["userId"])
    .onDelete("set_null"),
}));

type Tables = ProjectionSchemaTables<typeof projections>;
type UserColumns = ProjectionTableColumns<Tables["users"]>;
type UserRow = ProjectionRow<UserColumns>;

function assertPositiveProjectionTypes(source: EventRef<"user.created">): void {
  const validUserRow: UserRow = {
    userId: "u_123",
    email: "alice@example.com",
    source,
  };
  const validUserSource: EventRef<"user.created"> = validUserRow.source;

  void validUserSource;
}

void assertPositiveProjectionTypes;

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
        keys: [
          {
            columns: ["userId"],
            kind: "primary",
            name: null,
          },
          {
            columns: ["email"],
            kind: "unique",
            name: "users_email_unique",
          },
        ],
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
        keys: [
          {
            columns: ["sessionId"],
            kind: "primary",
            name: null,
          },
        ],
        indexes: [
          {
            name: "sessions_by_user",
            columns: ["userId"],
            unique: false,
          },
        ],
      },
      optionalSessions: {
        name: "optionalSessions",
        columns: {
          optionalSessionId: {
            kind: "text",
            nullable: false,
            eventName: null,
          },
          userId: {
            kind: "text",
            nullable: true,
            eventName: null,
          },
        },
        primaryKey: ["optionalSessionId"],
        keys: [
          {
            columns: ["optionalSessionId"],
            kind: "primary",
            name: null,
          },
        ],
        indexes: [],
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
      optionalSessionUser: {
        fromTable: "optionalSessions",
        fromColumns: ["userId"],
        toTable: "users",
        toColumns: ["userId"],
        onDelete: "set_null",
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
        users: ((t) => {
          const draft = t.columns({
            userId: t.text(),
          });
          const primaryKey = draft.primaryKey as unknown as (
            columns: readonly string[],
          ) => RuntimeProjectionTable;

          return primaryKey(["userId"]);
        }) satisfies RuntimeProjectionTableFactory,
      }),
    /primary key column userId must be not null/,
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
      defineProjectionSchema({
        Events: (t) =>
          t
            .columns({
              eventId: t.integer().notNull(),
            })
            .primaryKey(["eventId"]),
      }),
    /projection table name Events is reserved for ledger storage/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        idx_work_due: (t) =>
          t
            .columns({
              eventId: t.integer().notNull(),
            })
            .primaryKey(["eventId"]),
      }),
    /projection table name idx_work_due is reserved for ledger storage/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        sqlite_sequence: (t) =>
          t
            .columns({
              eventId: t.integer().notNull(),
            })
            .primaryKey(["eventId"]),
      }),
    /projection table name sqlite_sequence is reserved for ledger storage/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        Users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
      }),
    /projection table name users conflicts with Users/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              UserId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
      }),
    /projection column name UserId conflicts with userId/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
              email: t.text().notNull(),
            })
            .primaryKey(["userId"])
            .index("lookup", ["email"]),
        sessions: (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"])
            .index("LOOKUP", ["userId"]),
      }),
    /projection index name LOOKUP conflicts with lookup/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"])
            .index("idx_work_due", ["userId"]),
      }),
    /projection index name idx_work_due is reserved for ledger storage/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"])
            .index("sqlite_autoindex_users_1", ["userId"]),
      }),
    /projection index name sqlite_autoindex_users_1 is reserved for ledger storage/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"])
            .index("USERS", ["userId"]),
      }),
    /projection index name USERS conflicts with users/,
  );

  assert.throws(
    () =>
      defineProjectionSchema({
        users: (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"])
            .index("events", ["userId"]),
      }),
    /projection index name events is reserved for ledger storage/,
  );

  assert.throws(
    () =>
      projections.relations((r) => {
        const foreignKey = (r as unknown as RuntimeRelationBuilder).foreignKey;

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
        const foreignKey = (r as unknown as RuntimeRelationBuilder).foreignKey;

        return {
          incompatibleReference: foreignKey("sessions", [
            "createdAtMs",
          ]).references("users", ["userId"]),
        };
      }),
    /foreign key reference columns must have matching types/,
  );

  assert.throws(
    () =>
      projections.relations((r) => {
        const foreignKey = (r as unknown as RuntimeRelationBuilder).foreignKey;

        return {
          nonKeyReference: foreignKey("sessions", ["userId"]).references(
            "sessions",
            ["userId"],
          ),
        };
      }),
    /foreign key reference must target a primary or unique key on sessions/,
  );

  assert.throws(() => {
    projections.relations((r) => {
      const relation = r
        .foreignKey("sessions", ["userId"])
        .references("users", ["userId"]);
      const onDelete = relation.onDelete as unknown as (
        action: ProjectionForeignKeyAction,
      ) => ProjectionRelationDefinition;

      return {
        invalidSetNull: onDelete("set_null"),
      };
    });
  }, /foreign key onDelete set_null requires nullable source columns/);
});

function assertProjectionTypes(): void {
  // @ts-expect-error durable event references are ledger-owned opaque values.
  const constructedRef: EventRef<"user.created"> = {
    eventName: "user.created",
    eventId: 1,
  };

  void constructedRef;

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
          userId: t.text(),
        })
        // @ts-expect-error primary keys must use not-null columns.
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
    nonKeyReference: r
      .foreignKey("sessions", ["userId"])
      // @ts-expect-error referenced columns must be primary or unique keys.
      .references("sessions", ["userId"]),
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

  projections.relations((r) => ({
    invalidSetNull: r
      .foreignKey("sessions", ["userId"])
      .references("users", ["userId"])
      // @ts-expect-error set_null requires nullable source columns.
      .onDelete("set_null"),
  }));
}

void assertProjectionTypes;
