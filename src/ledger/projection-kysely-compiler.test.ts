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

test("kysely projection compiler lowers add-column DDL", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: [],
        sql: `compiled:${node.kind}`,
      };
    },
  };
  const compiler = createKyselyProjectionStatementCompiler({
    dialect: "sqlite",
    queryCompiler,
  });

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
      text: "compiled:AlterTableNode",
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    columnAlterations: [
      {
        column: {
          column: {
            column: {
              kind: "IdentifierNode",
              name: "email",
            },
            kind: "ColumnNode",
          },
          dataType: {
            dataType: "text",
            kind: "DataTypeNode",
          },
          kind: "ColumnDefinitionNode",
        },
        kind: "AddColumnNode",
      },
    ],
    kind: "AlterTableNode",
    table: {
      kind: "TableNode",
      table: {
        kind: "SchemableIdentifierNode",
        identifier: {
          kind: "IdentifierNode",
          name: "users",
        },
      },
    },
  });
});

test("kysely projection compiler lowers left joins", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: [],
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
          columnName: "completedAtMs",
          tableName: "completions",
        },
      ],
      fromTableName: "operations",
      joins: [
        {
          kind: "left",
          left: {
            columnName: "operationKey",
            tableName: "operations",
          },
          right: {
            columnName: "operationKey",
            tableName: "completions",
          },
          tableName: "completions",
        },
      ],
      limit: null,
      orderBy: [],
      where: [],
    }),
    {
      params: [],
      text: "compiled:SelectQueryNode",
    },
  );
  assert.equal(calls.length, 1);
  const query = readRecord(calls[0], "compiled query");
  const joins = readArray(query["joins"], "query joins");
  const join = readRecord(joins[0], "first join");

  assert.equal(join["kind"], "JoinNode");
  assert.equal(join["joinType"], "LeftJoin");
});

test("kysely projection compiler lowers semantic event scans", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: ["user.created", 0, 42, 25],
        sql: `compiled:${node.kind}`,
      };
    },
  };
  const compiler = createKyselyProjectionStatementCompiler({
    dialect: "sqlite",
    queryCompiler,
  });

  assert.deepEqual(
    compiler.compileEventScan({
      afterEventId: 42,
      eventName: "user.created",
      limit: 25,
    }),
    {
      params: ["user.created", 0, 42, 25],
      text: "compiled:SelectQueryNode",
    },
  );
  assert.equal(calls.length, 1);
  const query = readRecord(calls[0], "compiled query");
  const from = readRecord(query["from"], "query from");
  const froms = readArray(from["froms"], "query froms");
  const table = readRecord(froms[0], "events table");
  const tableName = readRecord(table["table"], "events table name");
  const tableIdentifier = readRecord(
    tableName["identifier"],
    "events table identifier",
  );
  const orderBy = readRecord(query["orderBy"], "order by");
  const orderItems = readArray(orderBy["items"], "order by items");
  const limit = readRecord(query["limit"], "limit");
  const limitValue = readRecord(limit["limit"], "limit value");
  const where = readRecord(query["where"], "where");

  assert.equal(query["kind"], "SelectQueryNode");
  assert.equal(tableIdentifier["name"], "events");
  assert.equal(orderItems.length, 1);
  assert.equal(limitValue["value"], 25);
  assert.equal(where["kind"], "WhereNode");
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

test("kysely projection compiler lowers explicit null ordering", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: [],
        sql: 'select "requests"."requestId" as "requestId" from "requests" order by case when "requests"."remainingUses" is null then 1 else 0 end asc',
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
          columnName: "requestId",
          tableName: "requests",
        },
      ],
      fromTableName: "requests",
      joins: [],
      limit: null,
      orderBy: [
        {
          column: {
            columnName: "remainingUses",
            tableName: "requests",
          },
          kind: "nulls",
          order: "last",
        },
      ],
      where: [],
    }),
    {
      params: [],
      text: 'select "requests"."requestId" as "requestId" from "requests" order by case when "requests"."remainingUses" is null then 1 else 0 end asc',
    },
  );
  assert.equal(calls.length, 1);
  const query = readRecord(calls[0], "compiled query");
  const orderBy = readRecord(query["orderBy"], "order by");
  const orderItems = readArray(orderBy["items"], "order by items");
  const orderItem = readRecord(orderItems[0], "first order item");
  const orderCase = readRecord(orderItem["orderBy"], "order case");
  const orderWhen = readRecord(
    readArray(orderCase["when"], "order case whens")[0],
    "first order case when",
  );
  const condition = readRecord(orderWhen["condition"], "null order condition");
  const operator = readRecord(condition["operator"], "null order operator");
  const result = readRecord(orderWhen["result"], "null order result");
  const fallback = readRecord(orderCase["else"], "null order else");

  assert.equal(orderCase["kind"], "CaseNode");
  assert.equal(operator["operator"], "is");
  assert.equal(result["value"], 1);
  assert.equal(result["immediate"], true);
  assert.equal(fallback["value"], 0);
  assert.equal(fallback["immediate"], true);
});

test("kysely projection compiler lowers union candidate reads", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: [0, "github.com", 1],
        sql: 'select "sledge_union"."decisionId" as "decisionId", "sledge_union"."priority" as "priority" from (select "grantId" as "decisionId", ? as "priority" from "grants" where "scope" = ? union all select "policyEntryId" as "decisionId", ? as "priority" from "lanePolicies") as "sledge_union" order by "priority" asc',
      };
    },
  };
  const compiler = createKyselyProjectionStatementCompiler({
    dialect: "sqlite",
    queryCompiler,
  });

  assert.deepEqual(
    compiler.compileUnionSelect({
      arms: [
        {
          fromTableName: "grants",
          selections: [
            {
              alias: "decisionId",
              column: {
                columnName: "grantId",
                tableName: null,
              },
              kind: "column",
            },
            {
              alias: "priority",
              kind: "value",
              value: 0,
            },
          ],
          where: [
            {
              column: {
                columnName: "scope",
                tableName: null,
              },
              kind: "comparison",
              operator: "=",
              value: "github.com",
            },
          ],
        },
        {
          fromTableName: "lanePolicies",
          selections: [
            {
              alias: "decisionId",
              column: {
                columnName: "policyEntryId",
                tableName: null,
              },
              kind: "column",
            },
            {
              alias: "priority",
              kind: "value",
              value: 1,
            },
          ],
          where: [],
        },
      ],
      limit: null,
      orderBy: [
        {
          column: {
            columnName: "priority",
            tableName: null,
          },
          direction: "asc",
          kind: "column",
        },
      ],
    }),
    {
      params: [0, "github.com", 1],
      text: 'select "sledge_union"."decisionId" as "decisionId", "sledge_union"."priority" as "priority" from (select "grantId" as "decisionId", ? as "priority" from "grants" where "scope" = ? union all select "policyEntryId" as "decisionId", ? as "priority" from "lanePolicies") as "sledge_union" order by "priority" asc',
    },
  );
  assert.equal(calls.length, 1);
  const query = readRecord(calls[0], "compiled query");
  const from = readRecord(query["from"], "query from");
  const froms = readArray(from["froms"], "query froms");
  const aliasedUnion = readRecord(froms[0], "aliased union");
  const parens = readRecord(aliasedUnion["node"], "union parens");
  const unionQuery = readRecord(parens["node"], "union query");
  const setOperations = readArray(
    unionQuery["setOperations"],
    "set operations",
  );
  const setOperation = readRecord(setOperations[0], "first set operation");

  assert.equal(query["kind"], "SelectQueryNode");
  assert.equal(aliasedUnion["kind"], "AliasNode");
  assert.equal(parens["kind"], "ParensNode");
  assert.equal(unionQuery["kind"], "SelectQueryNode");
  assert.equal(setOperation["kind"], "SetOperationNode");
  assert.equal(setOperation["operator"], "union");
  assert.equal(setOperation["all"], true);
});

test("kysely projection compiler lowers typed integer add expressions", () => {
  const calls: KyselyProjectionOperationNode[] = [];
  const queryCompiler: KyselyProjectionQueryCompiler = {
    compileQuery: (node) => {
      calls.push(node);

      return {
        parameters: [1, "c_1"],
        sql: 'update "counters" set "attempts" = "attempts" + ? where "counterId" = ?',
      };
    },
  };
  const compiler = createKyselyProjectionStatementCompiler({
    dialect: "sqlite",
    queryCompiler,
  });

  assert.deepEqual(
    compiler.compileUpdate({
      assignments: [
        {
          columnName: "attempts",
          value: {
            columnName: "attempts",
            kind: "add",
            value: {
              kind: "value",
              value: 1,
            },
          },
        },
      ],
      tableName: "counters",
      where: [
        {
          column: {
            columnName: "counterId",
            tableName: null,
          },
          kind: "comparison",
          operator: "=",
          value: "c_1",
        },
      ],
    }),
    {
      params: [1, "c_1"],
      text: 'update "counters" set "attempts" = "attempts" + ? where "counterId" = ?',
    },
  );
  assert.equal(calls.length, 1);
  const query = readRecord(calls[0], "compiled query");
  const updates = readArray(query["updates"], "query updates");
  const update = readRecord(updates[0], "first update");
  const value = readRecord(update["value"], "add update value");
  const operator = readRecord(value["operator"], "add operator");
  const rightOperand = readRecord(value["rightOperand"], "add right operand");

  assert.equal(query["kind"], "UpdateQueryNode");
  assert.equal(value["kind"], "BinaryOperationNode");
  assert.equal(operator["operator"], "+");
  assert.equal(rightOperand["value"], 1);
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
