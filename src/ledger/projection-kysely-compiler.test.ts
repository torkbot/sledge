import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { defineMaterializationSchema } from "./ledger.ts";
import {
  createKyselyProjectionStatementCompiler,
  createKyselySqliteProjectionStatementCompiler,
  type KyselyProjectionOperationNode,
  type KyselyProjectionQueryCompiler,
} from "./projection-kysely-compiler.ts";

test("kysely projection compiler lowers Sledge select IR to operation nodes", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: ["compiled-param"],
        sql: `compiled:${node.kind}`,
      };
    },
  };
  const compiler = createKyselyProjectionStatementCompiler({
    dialect: "sqlite",
    queryCompiler,
  });

  assert.deepEqual(
    compiler.compileSelect({
      columns: [
        {
          columnName: "userId",
          tableName: "users",
        },
      ],
      fromTableName: "users",
      joins: [
        {
          kind: "inner",
          left: {
            columnName: "userId",
            tableName: "users",
          },
          right: {
            columnName: "userId",
            tableName: "sessions",
          },
          tableName: "sessions",
        },
      ],
      limit: 10,
      orderBy: [
        {
          column: {
            columnName: "userId",
            tableName: "users",
          },
          kind: "value_list",
          values: ["u2", "u1"],
        },
      ],
      where: [
        {
          column: {
            columnName: "email",
            tableName: "users",
          },
          kind: "comparison",
          operator: "=",
          value: "a@example.com",
        },
      ],
    }),
    {
      params: ["compiled-param"],
      text: "compiled:SelectQueryNode",
    },
  );
  assert.equal(calls.length, 1);
  const query = readRecord(calls[0], "compiled query");
  const selections = readArray(query["selections"], "query selections");
  const selection = readRecord(selections[0], "first selection");
  const aliasedSelection = readRecord(
    selection["selection"],
    "aliased selection",
  );
  const selectionAlias = readRecord(
    aliasedSelection["alias"],
    "selection alias",
  );
  const joins = readArray(query["joins"], "query joins");
  const join = readRecord(joins[0], "first join");
  const orderBy = readRecord(query["orderBy"], "order by");
  const orderItems = readArray(orderBy["items"], "order by items");
  const orderItem = readRecord(orderItems[0], "first order item");
  const orderCase = readRecord(orderItem["orderBy"], "order case");
  const orderWhens = readArray(orderCase["when"], "order case whens");
  const firstWhen = readRecord(orderWhens[0], "first order case when");
  const firstWhenCondition = readRecord(
    firstWhen["condition"],
    "first order case condition",
  );
  const limit = readRecord(query["limit"], "limit");
  const limitValue = readRecord(limit["limit"], "limit value");
  const where = readRecord(query["where"], "where");
  const wherePredicate = readRecord(where["where"], "where predicate");
  const whereOperator = readRecord(
    wherePredicate["operator"],
    "where operator",
  );
  const whereValue = readRecord(wherePredicate["rightOperand"], "where value");

  assert.equal(query["kind"], "SelectQueryNode");
  assert.equal(selectionAlias["name"], "userId");
  assert.equal(join["kind"], "JoinNode");
  assert.equal(join["joinType"], "InnerJoin");
  assert.equal(orderCase["kind"], "CaseNode");
  assert.equal(orderWhens.length, 2);
  assert.equal(firstWhenCondition["value"], "u2");
  assert.equal(limitValue["value"], 10);
  assert.equal(whereOperator["operator"], "=");
  assert.equal(whereValue["value"], "a@example.com");
});

test("kysely projection compiler strips externally-bound insert value params", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: ["insert-user-id", "insert-email", "updated@example.com"],
        sql: "insert into projection values ($1, $2) on conflict do update set email = greatest(email, $3)",
      };
    },
  };
  const compiler = createKyselyProjectionStatementCompiler({
    dialect: "postgres",
    queryCompiler,
  });

  assert.deepEqual(
    compiler.compileInsert({
      columns: ["userId", "email"],
      conflict: {
        assignments: [
          {
            columnName: "email",
            value: {
              columnName: "email",
              kind: "max",
              value: {
                kind: "value",
                value: "updated@example.com",
              },
            },
          },
        ],
        conflictColumns: ["userId"],
        kind: "do_update",
      },
      tableName: "users",
    }),
    {
      params: ["updated@example.com"],
      text: "insert into projection values ($1, $2) on conflict do update set email = greatest(email, $3)",
    },
  );
  assert.equal(calls.length, 1);
  const onConflict = readRecord(calls[0]?.["onConflict"], "on conflict");
  const updates = readArray(onConflict["updates"], "on conflict updates");
  const update = readRecord(updates[0], "first conflict update");
  const maxValue = readRecord(update["value"], "max update value");
  const maxArgs = readArray(maxValue["arguments"], "max arguments");
  const leftCoalesce = readRecord(maxArgs[0], "left max coalesce");
  const rightCoalesce = readRecord(maxArgs[1], "right max coalesce");

  assert.equal(onConflict["kind"], "OnConflictNode");
  assert.equal(update["kind"], "ColumnUpdateNode");
  assert.equal(maxValue["func"], "greatest");
  assert.equal(leftCoalesce["func"], "coalesce");
  assert.equal(rightCoalesce["func"], "coalesce");
});

test("kysely sqlite projection compiler uses the supplied query compiler constructor", () => {
  const calls: KyselyProjectionOperationNode[] = [];

  class FakeSqliteQueryCompiler implements KyselyProjectionQueryCompiler {
    compileQuery(node: KyselyProjectionOperationNode): {
      readonly parameters: readonly unknown[];
      readonly sql: string;
    } {
      calls.push(node);

      return {
        parameters: [],
        sql: `sqlite:${node.kind}`,
      };
    }
  }

  const compiler = createKyselySqliteProjectionStatementCompiler({
    SqliteQueryCompiler: FakeSqliteQueryCompiler,
  });

  assert.deepEqual(
    compiler.compileDelete({
      tableName: "users",
      where: [],
    }),
    {
      params: [],
      text: "sqlite:DeleteQueryNode",
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "DeleteQueryNode");
});

const hasKysely = existsSync(
  new URL("../../node_modules/kysely/package.json", import.meta.url),
);

test(
  "kysely projection compiler compiles through Kysely when installed",
  {
    skip: hasKysely ? false : "kysely is not installed in this local sandbox",
  },
  async () => {
    const kyselyPackageName = "kysely";
    const moduleUnknown: unknown = await import(kyselyPackageName);
    const SqliteQueryCompiler = readKyselyQueryCompilerConstructor(
      moduleUnknown,
      "SqliteQueryCompiler",
    );
    const compiler = createKyselyProjectionStatementCompiler({
      dialect: "sqlite",
      queryCompiler: new SqliteQueryCompiler(),
    });
    const schema = defineMaterializationSchema({
      namespace: "kysely",
      tables: {
        users: (t) =>
          t
            .columns({
              email: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
      },
      version: 1,
    });
    const usersTable = schema.metadata.tables.users;

    if (usersTable === undefined) {
      throw new Error("expected users table");
    }

    assert.deepEqual(
      compiler.compileCreateTable({
        metadata: schema.metadata,
        table: usersTable,
      }),
      {
        params: [],
        text: 'create table if not exists "users" ("email" text not null, "userId" text not null, primary key ("userId"))',
      },
    );
    assert.deepEqual(
      compiler.compileSelect({
        columns: [
          {
            columnName: "userId",
            tableName: "users",
          },
        ],
        fromTableName: "users",
        joins: [],
        limit: 1,
        orderBy: [],
        where: [
          {
            column: {
              columnName: "email",
              tableName: "users",
            },
            kind: "comparison",
            operator: "=",
            value: "a@example.com",
          },
        ],
      }),
      {
        params: ["a@example.com", 1],
        text: 'select "users"."userId" as "userId" from "users" where "users"."email" = ? limit ?',
      },
    );
  },
);

function readKyselyQueryCompilerConstructor(
  moduleUnknown: unknown,
  name: string,
): new () => KyselyProjectionQueryCompiler {
  if (!isRecord(moduleUnknown)) {
    throw new Error("expected kysely module to be an object");
  }

  const constructorUnknown = moduleUnknown[name];

  if (typeof constructorUnknown !== "function") {
    throw new Error(`expected kysely module to export ${name}`);
  }

  return constructorUnknown as new () => KyselyProjectionQueryCompiler;
}

function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }

  return value;
}

function readRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be an object`);
  }

  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
