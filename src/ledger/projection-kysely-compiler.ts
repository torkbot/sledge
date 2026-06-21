import type {
  ProjectionColumnMetadata,
  ProjectionForeignKeyAction,
  ProjectionForeignKeyMetadata,
} from "./projections.ts";
import type {
  ProjectionCompiledSql,
  ProjectionCompilerAddColumnStatement,
  ProjectionCompilerAggregate,
  ProjectionCompilerAggregateStatement,
  ProjectionCompilerAssignment,
  ProjectionCompilerColumnReference,
  ProjectionCompilerCreateIndexStatement,
  ProjectionCompilerCreateTableStatement,
  ProjectionCompilerDeleteStatement,
  ProjectionCompilerEventReadStatement,
  ProjectionCompilerEventScanStatement,
  ProjectionCompilerExpression,
  ProjectionCompilerInsertStatement,
  ProjectionCompilerJoinClause,
  ProjectionCompilerOrderClause,
  ProjectionCompilerSelectStatement,
  ProjectionCompilerSelection,
  ProjectionCompilerUpdateStatement,
  ProjectionCompilerUnionSelectArm,
  ProjectionCompilerUnionSelectStatement,
  ProjectionCompilerWhereClause,
  ProjectionStatementCompiler,
} from "./projection-sql-compiler.ts";

export type KyselyProjectionDialect = "postgres" | "sqlite";

export type KyselyProjectionCompiledQuery = {
  readonly parameters: readonly unknown[];
  readonly sql: string;
};

export type KyselyProjectionOperationNode = Readonly<
  Record<string, unknown>
> & {
  readonly kind: string;
};

export type KyselyProjectionQueryCompiler = {
  compileQuery(
    node: KyselyProjectionOperationNode,
    queryId: unknown,
  ): KyselyProjectionCompiledQuery;
};

export type KyselyProjectionQueryCompilerConstructor =
  new () => KyselyProjectionQueryCompiler;

export type KyselyProjectionStatementCompilerInput = {
  readonly dialect: KyselyProjectionDialect;
  readonly queryCompiler: KyselyProjectionQueryCompiler;
};

export type KyselySqliteProjectionStatementCompilerInput = {
  readonly SqliteQueryCompiler: KyselyProjectionQueryCompilerConstructor;
};

const insertValuePlaceholder = Symbol("sledge.projection.insertValue");
const projectionEventRowColumnNames = [
  "event_id",
  "ts_ms",
  "event_name",
  "payload_json",
  "causation_event_id",
  "dedupe_key",
] as const;

export function createKyselyProjectionStatementCompiler(
  input: KyselyProjectionStatementCompilerInput,
): ProjectionStatementCompiler {
  return {
    compileAddColumn: (statement) =>
      compileAddColumnStatement(input, statement),
    compileAggregate: (statement) =>
      compileAggregateStatement(input, statement),
    compileCreateIndex: (statement) =>
      compileCreateIndexStatement(input, statement),
    compileCreateTable: (statement) =>
      compileCreateTableStatement(input, statement),
    compileDelete: (statement) => compileDeleteStatement(input, statement),
    compileEventRead: (statement) =>
      compileEventReadStatement(input, statement),
    compileEventScan: (statement) =>
      compileEventScanStatement(input, statement),
    compileInsert: (statement) => compileInsertStatement(input, statement),
    compileSelect: (statement) => compileSelectStatement(input, statement),
    compileUnionSelect: (statement) =>
      compileUnionSelectStatement(input, statement),
    compileUpdate: (statement) => compileUpdateStatement(input, statement),
  };
}

export function createKyselySqliteProjectionStatementCompiler(
  input: KyselySqliteProjectionStatementCompilerInput,
): ProjectionStatementCompiler {
  return createKyselyProjectionStatementCompiler({
    dialect: "sqlite",
    queryCompiler: new input.SqliteQueryCompiler(),
  });
}

function compileAddColumnStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerAddColumnStatement,
): ProjectionCompiledSql {
  return compileQuery(input.queryCompiler, {
    columnAlterations: [
      {
        column: columnDefinitionNode(statement.columnName, statement.column),
        kind: "AddColumnNode",
      },
    ],
    kind: "AlterTableNode",
    table: tableNode(statement.tableName),
  });
}

function compileAggregateStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerAggregateStatement,
): ProjectionCompiledSql {
  if (statement.aggregates.length === 0) {
    throw new Error("aggregate select must include at least one aggregate");
  }

  const query: KyselyProjectionOperationNode = {
    from: fromNode([tableNode(statement.fromTableName)]),
    kind: "SelectQueryNode",
    selections: statement.aggregates.map(selectionNodeForAggregate),
  };
  const where = whereNodeForClauses(statement.where);

  if (where !== null) {
    return compileQuery(input.queryCompiler, {
      ...query,
      where,
    });
  }

  return compileQuery(input.queryCompiler, query);
}

function compileCreateIndexStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerCreateIndexStatement,
): ProjectionCompiledSql {
  const query: KyselyProjectionOperationNode = {
    columns: statement.index.columns.map(columnNode),
    ifNotExists: true,
    kind: "CreateIndexNode",
    name: identifierNode(statement.index.name),
    table: tableNode(statement.tableName),
  };

  if (statement.index.unique) {
    return compileQuery(input.queryCompiler, {
      ...query,
      unique: true,
    });
  }

  return compileQuery(input.queryCompiler, query);
}

function compileCreateTableStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerCreateTableStatement,
): ProjectionCompiledSql {
  const constraints: KyselyProjectionOperationNode[] = [];

  if (statement.table.primaryKey.length > 0) {
    constraints.push({
      columns: statement.table.primaryKey.map(columnNode),
      kind: "PrimaryKeyConstraintNode",
    });
  }

  for (const [relationName, foreignKey] of Object.entries(
    statement.metadata.relations,
  )) {
    if (foreignKey.fromTable === statement.table.name) {
      constraints.push(foreignKeyConstraintNode(relationName, foreignKey));
    }
  }

  const query: KyselyProjectionOperationNode = {
    columns: Object.entries(statement.table.columns).map(
      ([columnName, column]) => {
        return columnDefinitionNode(columnName, column);
      },
    ),
    constraints,
    ifNotExists: true,
    kind: "CreateTableNode",
    table: tableNode(statement.table.name),
  };

  return compileQuery(input.queryCompiler, query);
}

function compileDeleteStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerDeleteStatement,
): ProjectionCompiledSql {
  const query: KyselyProjectionOperationNode = {
    from: fromNode([tableNode(statement.tableName)]),
    kind: "DeleteQueryNode",
  };
  const where = whereNodeForClauses(statement.where);

  if (where !== null) {
    return compileQuery(input.queryCompiler, {
      ...query,
      where,
    });
  }

  return compileQuery(input.queryCompiler, query);
}

function compileEventReadStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerEventReadStatement,
): ProjectionCompiledSql {
  if (statement.eventIds.length === 0) {
    throw new Error("event read must include at least one event id");
  }

  const query: KyselyProjectionOperationNode = {
    from: fromNode([tableNode("events")]),
    kind: "SelectQueryNode",
    selections: projectionEventRowColumnNames.map((columnName) =>
      selectionNode(referenceNode(null, columnName)),
    ),
    where: whereNode(
      andOperationNodes([
        binaryOperationNode(
          referenceNode(null, "event_name"),
          "=",
          valueNode(statement.eventName),
        ),
        binaryOperationNode(referenceNode(null, "signal"), "=", valueNode(0)),
        inNode(referenceNode(null, "event_id"), statement.eventIds),
      ]),
    ),
  };

  return compileQuery(input.queryCompiler, query);
}

function compileEventScanStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerEventScanStatement,
): ProjectionCompiledSql {
  const whereClauses: KyselyProjectionOperationNode[] = [
    binaryOperationNode(
      referenceNode(null, "event_name"),
      "=",
      valueNode(statement.eventName),
    ),
    binaryOperationNode(referenceNode(null, "signal"), "=", valueNode(0)),
  ];

  if (statement.afterEventId !== null) {
    whereClauses.push(
      binaryOperationNode(
        referenceNode(null, "event_id"),
        ">",
        valueNode(statement.afterEventId),
      ),
    );
  }

  let query: KyselyProjectionOperationNode = {
    from: fromNode([tableNode("events")]),
    kind: "SelectQueryNode",
    orderBy: orderByNode([
      {
        column: {
          columnName: "event_id",
          tableName: null,
        },
        direction: "asc",
        kind: "column",
      },
    ]),
    selections: projectionEventRowColumnNames.map((columnName) =>
      selectionNode(referenceNode(null, columnName)),
    ),
    where: whereNode(andOperationNodes(whereClauses)),
  };

  if (statement.limit !== null) {
    query = {
      ...query,
      limit: limitNode(valueNode(statement.limit)),
    };
  }

  return compileQuery(input.queryCompiler, query);
}

function compileInsertStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerInsertStatement,
): ProjectionCompiledSql {
  const query: KyselyProjectionOperationNode = {
    columns: statement.columns.map(columnNode),
    into: tableNode(statement.tableName),
    kind: "InsertQueryNode",
    values: valuesNode([
      valueListNode(
        statement.columns.map(() => valueNode(insertValuePlaceholder)),
      ),
    ]),
  };

  const queryWithConflict = attachInsertConflict(input, query, statement);
  const compiled = compileQuery(input.queryCompiler, queryWithConflict);

  return {
    params: compiled.params.slice(statement.columns.length),
    text: compiled.text,
  };
}

function attachInsertConflict(
  input: KyselyProjectionStatementCompilerInput,
  query: KyselyProjectionOperationNode,
  statement: ProjectionCompilerInsertStatement,
): KyselyProjectionOperationNode {
  if (statement.conflict === null) {
    return query;
  }

  const onConflictBase: KyselyProjectionOperationNode = {
    columns: statement.conflict.conflictColumns.map(columnNode),
    kind: "OnConflictNode",
  };

  if (statement.conflict.kind === "do_nothing") {
    return {
      ...query,
      onConflict: {
        ...onConflictBase,
        doNothing: true,
      },
    };
  }

  if (statement.conflict.assignments.length === 0) {
    throw new Error("update values must include at least one column");
  }

  return {
    ...query,
    onConflict: {
      ...onConflictBase,
      updates: statement.conflict.assignments.map((assignment) =>
        columnUpdateNode(input.dialect, assignment),
      ),
    },
  };
}

function compileSelectStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerSelectStatement,
): ProjectionCompiledSql {
  let query: KyselyProjectionOperationNode = {
    from: fromNode([tableNode(statement.fromTableName)]),
    kind: "SelectQueryNode",
    selections: statement.columns.map(selectionNodeForColumnReference),
  };

  if (statement.joins.length > 0) {
    query = {
      ...query,
      joins: statement.joins.map(joinNode),
    };
  }

  const where = whereNodeForClauses(statement.where);

  if (where !== null) {
    query = {
      ...query,
      where,
    };
  }

  if (statement.orderBy.length > 0) {
    query = {
      ...query,
      orderBy: orderByNode(statement.orderBy),
    };
  }

  if (statement.limit !== null) {
    query = {
      ...query,
      limit: limitNode(valueNode(statement.limit)),
    };
  }

  return compileQuery(input.queryCompiler, query);
}

function compileUnionSelectStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerUnionSelectStatement,
): ProjectionCompiledSql {
  const firstArm = statement.arms[0];

  if (firstArm === undefined || statement.arms.length < 2) {
    throw new Error("union select must include at least two arms");
  }

  let unionQuery = unionSelectArmNode(firstArm);
  const setOperations = statement.arms.slice(1).map((arm) => {
    return {
      all: true,
      expression: unionSelectArmNode(arm),
      kind: "SetOperationNode",
      operator: "union",
    };
  });

  if (setOperations.length > 0) {
    setNodeProperty(unionQuery, "setOperations", setOperations);
  }

  const unionAlias = "sledge_union";
  const query: KyselyProjectionOperationNode = {
    from: fromNode([aliasNode(parensNode(unionQuery), unionAlias)]),
    kind: "SelectQueryNode",
    selections: firstArm.selections.map((selection) =>
      selectionNode(
        aliasNode(referenceNode(unionAlias, selection.alias), selection.alias),
      ),
    ),
  };

  if (statement.orderBy.length > 0) {
    setNodeProperty(query, "orderBy", orderByNode(statement.orderBy));
  }

  if (statement.limit !== null) {
    setNodeProperty(query, "limit", limitNode(valueNode(statement.limit)));
  }

  return compileQuery(input.queryCompiler, query);
}

function unionSelectArmNode(
  arm: ProjectionCompilerUnionSelectArm,
): KyselyProjectionOperationNode {
  if (arm.selections.length === 0) {
    throw new Error("union select arm must include at least one selection");
  }

  const query: KyselyProjectionOperationNode = {
    from: fromNode([tableNode(arm.fromTableName)]),
    kind: "SelectQueryNode",
    selections: arm.selections.map(selectionNodeForSelection),
  };
  const where = whereNodeForClauses(arm.where);

  if (where !== null) {
    return {
      ...query,
      where,
    };
  }

  return query;
}

function compileUpdateStatement(
  input: KyselyProjectionStatementCompilerInput,
  statement: ProjectionCompilerUpdateStatement,
): ProjectionCompiledSql {
  if (statement.assignments.length === 0) {
    throw new Error("update values must include at least one column");
  }

  const query: KyselyProjectionOperationNode = {
    kind: "UpdateQueryNode",
    table: tableNode(statement.tableName),
    updates: statement.assignments.map((assignment) =>
      columnUpdateNode(input.dialect, assignment),
    ),
  };
  const where = whereNodeForClauses(statement.where);

  if (where !== null) {
    return compileQuery(input.queryCompiler, {
      ...query,
      where,
    });
  }

  return compileQuery(input.queryCompiler, query);
}

function compileQuery(
  queryCompiler: KyselyProjectionQueryCompiler,
  query: KyselyProjectionOperationNode,
): ProjectionCompiledSql {
  const compiled = queryCompiler.compileQuery(query, {});

  return {
    params: compiled.parameters,
    text: compiled.sql,
  };
}

function selectionNodeForColumnReference(
  column: ProjectionCompilerColumnReference,
): KyselyProjectionOperationNode {
  return selectionNode(
    aliasNode(
      referenceNode(column.tableName, column.columnName),
      column.columnName,
    ),
  );
}

function selectionNodeForSelection(
  selection: ProjectionCompilerSelection,
): KyselyProjectionOperationNode {
  switch (selection.kind) {
    case "column":
      return selectionNode(
        aliasNode(
          referenceNode(
            selection.column.tableName,
            selection.column.columnName,
          ),
          selection.alias,
        ),
      );
    case "value":
      return selectionNode(
        aliasNode(valueNode(selection.value), selection.alias),
      );
  }
}

function selectionNodeForAggregate(
  aggregate: ProjectionCompilerAggregate,
): KyselyProjectionOperationNode {
  let aggregateNode: KyselyProjectionOperationNode;

  switch (aggregate.kind) {
    case "count":
      aggregateNode = aggregateFunctionNode("count", [rawNode("*")]);
      break;
    case "count_not_null":
      aggregateNode = aggregateFunctionNode("count", [
        referenceNode(aggregate.column.tableName, aggregate.column.columnName),
      ]);
      break;
    case "max":
      aggregateNode = aggregateFunctionNode("max", [
        referenceNode(aggregate.column.tableName, aggregate.column.columnName),
      ]);
      break;
    case "min":
      aggregateNode = aggregateFunctionNode("min", [
        referenceNode(aggregate.column.tableName, aggregate.column.columnName),
      ]);
      break;
  }

  return selectionNode(aliasNode(aggregateNode, aggregate.alias));
}

function columnUpdateNode(
  dialect: KyselyProjectionDialect,
  assignment: ProjectionCompilerAssignment,
): KyselyProjectionOperationNode {
  return {
    column: columnNode(assignment.columnName),
    kind: "ColumnUpdateNode",
    value: expressionNode(dialect, assignment.value),
  };
}

function expressionNode(
  dialect: KyselyProjectionDialect,
  expression: ProjectionCompilerExpression,
): KyselyProjectionOperationNode {
  switch (expression.kind) {
    case "add":
      return binaryOperationNode(
        referenceNode(null, expression.columnName),
        "+",
        expressionNode(dialect, expression.value),
      );
    case "coalesce":
      return functionNode("coalesce", [
        referenceNode(null, expression.columnName),
        expressionNode(dialect, expression.value),
      ]);
    case "decrement_if_positive":
      return decrementIfPositiveNode(expression.columnName);
    case "column":
      return referenceNode(null, expression.columnName);
    case "excluded":
      return referenceNode("excluded", expression.columnName);
    case "max":
      return nullSafeScalarMaxNode(dialect, expression);
    case "value":
      return valueNode(expression.value);
  }
}

function decrementIfPositiveNode(
  columnName: string,
): KyselyProjectionOperationNode {
  return {
    else: referenceNode(null, columnName),
    kind: "CaseNode",
    when: [
      {
        condition: binaryOperationNode(
          referenceNode(null, columnName),
          "is",
          valueNodeImmediate(null),
        ),
        kind: "WhenNode",
        result: valueNodeImmediate(null),
      },
      {
        condition: binaryOperationNode(
          referenceNode(null, columnName),
          ">",
          valueNodeImmediate(0),
        ),
        kind: "WhenNode",
        result: binaryOperationNode(
          referenceNode(null, columnName),
          "-",
          valueNodeImmediate(1),
        ),
      },
    ],
  };
}

function nullSafeScalarMaxNode(
  dialect: KyselyProjectionDialect,
  expression: Extract<ProjectionCompilerExpression, { readonly kind: "max" }>,
): KyselyProjectionOperationNode {
  return functionNode(scalarMaxFunctionName(dialect), [
    functionNode("coalesce", [
      referenceNode(null, expression.columnName),
      expressionNode(dialect, expression.value),
    ]),
    functionNode("coalesce", [
      expressionNode(dialect, expression.value),
      referenceNode(null, expression.columnName),
    ]),
  ]);
}

function scalarMaxFunctionName(dialect: KyselyProjectionDialect): string {
  switch (dialect) {
    case "postgres":
      return "greatest";
    case "sqlite":
      return "max";
  }
}

function whereNodeForClauses(
  clauses: readonly ProjectionCompilerWhereClause[],
): KyselyProjectionOperationNode | null {
  if (clauses.length === 0) {
    return null;
  }

  return whereNode(andOperationNodes(clauses.map(whereOperationNode)));
}

function whereOperationNode(
  clause: ProjectionCompilerWhereClause,
): KyselyProjectionOperationNode {
  switch (clause.kind) {
    case "any":
      if (clause.clauses.length === 0) {
        throw new Error("any predicate group must include at least one clause");
      }

      return parensNode(
        orOperationNodes(clause.clauses.map(whereOperationNode)),
      );
    case "comparison":
      return binaryOperationNode(
        referenceNode(clause.column.tableName, clause.column.columnName),
        clause.operator,
        valueNode(clause.value),
      );
    case "in":
      return inNode(
        referenceNode(clause.column.tableName, clause.column.columnName),
        clause.values,
      );
    case "null":
      return binaryOperationNode(
        referenceNode(clause.column.tableName, clause.column.columnName),
        clause.not ? "is not" : "is",
        valueNodeImmediate(null),
      );
    case "not_exists":
      return {
        kind: "UnaryOperationNode",
        operand: {
          from: fromNode([tableNode(clause.tableName)]),
          kind: "SelectQueryNode",
          selections: [selectionNode(valueNodeImmediate(1))],
          where: whereNode(
            binaryOperationNode(
              referenceNode(
                clause.innerColumn.tableName,
                clause.innerColumn.columnName,
              ),
              "=",
              referenceNode(
                clause.outerColumn.tableName,
                clause.outerColumn.columnName,
              ),
            ),
          ),
        },
        operator: operatorNode("not exists"),
      };
  }
}

function inNode(
  left: KyselyProjectionOperationNode,
  values: readonly unknown[],
): KyselyProjectionOperationNode {
  if (values.length === 0) {
    return rawNode("0 = 1");
  }

  return binaryOperationNode(left, "in", primitiveValueListNode(values));
}

function andOperationNodes(
  nodes: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return binaryLogicOperationNodes("AndNode", nodes);
}

function orOperationNodes(
  nodes: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return binaryLogicOperationNodes("OrNode", nodes);
}

function binaryLogicOperationNodes(
  kind: "AndNode" | "OrNode",
  nodes: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  const firstNode = nodes[0];

  if (firstNode === undefined) {
    throw new Error("logical predicate group must include at least one clause");
  }

  return nodes.slice(1).reduce<KyselyProjectionOperationNode>((left, right) => {
    return {
      kind,
      left,
      right,
    };
  }, firstNode);
}

function binaryOperationNode(
  leftOperand: KyselyProjectionOperationNode,
  operator: string,
  rightOperand: KyselyProjectionOperationNode,
): KyselyProjectionOperationNode {
  return {
    kind: "BinaryOperationNode",
    leftOperand,
    operator: operatorNode(operator),
    rightOperand,
  };
}

function orderByNode(
  clauses: readonly ProjectionCompilerOrderClause[],
): KyselyProjectionOperationNode {
  return {
    items: clauses.map(orderByItemNode),
    kind: "OrderByNode",
  };
}

function orderByItemNode(
  clause: ProjectionCompilerOrderClause,
): KyselyProjectionOperationNode {
  switch (clause.kind) {
    case "column":
      return {
        direction: rawNode(clause.direction),
        kind: "OrderByItemNode",
        orderBy: referenceNode(
          clause.column.tableName,
          clause.column.columnName,
        ),
      };
    case "nulls":
      return {
        direction: rawNode("asc"),
        kind: "OrderByItemNode",
        orderBy: nullOrderCaseNode(clause),
      };
    case "value_list":
      if (clause.values.length === 0) {
        throw new Error("value-list order clause must include values");
      }

      return {
        direction: rawNode("asc"),
        kind: "OrderByItemNode",
        orderBy: valueListOrderCaseNode(clause),
      };
  }
}

function nullOrderCaseNode(
  clause: Extract<ProjectionCompilerOrderClause, { readonly kind: "nulls" }>,
): KyselyProjectionOperationNode {
  const nullRank = clause.order === "first" ? 0 : 1;
  const presentRank = clause.order === "first" ? 1 : 0;

  return {
    else: valueNodeImmediate(presentRank),
    kind: "CaseNode",
    when: [
      {
        condition: binaryOperationNode(
          referenceNode(clause.column.tableName, clause.column.columnName),
          "is",
          valueNodeImmediate(null),
        ),
        kind: "WhenNode",
        result: valueNodeImmediate(nullRank),
      },
    ],
  };
}

function valueListOrderCaseNode(
  clause: Extract<
    ProjectionCompilerOrderClause,
    { readonly kind: "value_list" }
  >,
): KyselyProjectionOperationNode {
  return {
    else: valueNode(clause.values.length),
    kind: "CaseNode",
    value: referenceNode(clause.column.tableName, clause.column.columnName),
    when: clause.values.map((value, index) => {
      return {
        condition: valueNode(value),
        kind: "WhenNode",
        result: valueNode(index),
      };
    }),
  };
}

function joinNode(
  clause: ProjectionCompilerJoinClause,
): KyselyProjectionOperationNode {
  switch (clause.kind) {
    case "inner":
      return {
        joinType: "InnerJoin",
        kind: "JoinNode",
        on: {
          kind: "OnNode",
          on: binaryOperationNode(
            referenceNode(clause.left.tableName, clause.left.columnName),
            "=",
            referenceNode(clause.right.tableName, clause.right.columnName),
          ),
        },
        table: tableNode(clause.tableName),
      };
    case "left":
      return {
        joinType: "LeftJoin",
        kind: "JoinNode",
        on: {
          kind: "OnNode",
          on: binaryOperationNode(
            referenceNode(clause.left.tableName, clause.left.columnName),
            "=",
            referenceNode(clause.right.tableName, clause.right.columnName),
          ),
        },
        table: tableNode(clause.tableName),
      };
  }
}

function foreignKeyConstraintNode(
  name: string,
  foreignKey: ProjectionForeignKeyMetadata,
): KyselyProjectionOperationNode {
  return {
    columns: foreignKey.fromColumns.map(columnNode),
    kind: "ForeignKeyConstraintNode",
    name: identifierNode(name),
    onDelete: foreignKeyActionSql(foreignKey.onDelete),
    references: {
      columns: foreignKey.toColumns.map(columnNode),
      kind: "ReferencesNode",
      table: tableNode(foreignKey.toTable),
    },
  };
}

function columnDefinitionNode(
  columnName: string,
  column: ProjectionColumnMetadata,
): KyselyProjectionOperationNode {
  const node: KyselyProjectionOperationNode = {
    column: columnNode(columnName),
    dataType: dataTypeNode(projectionColumnSqlType(column)),
    kind: "ColumnDefinitionNode",
  };

  if (column.nullable) {
    return node;
  }

  return {
    ...node,
    notNull: true,
  };
}

function projectionColumnSqlType(column: ProjectionColumnMetadata): string {
  switch (column.kind) {
    case "boolean":
    case "event_ref":
    case "integer":
      return "integer";
    case "json":
    case "text":
      return "text";
  }
}

function foreignKeyActionSql(action: ProjectionForeignKeyAction): string {
  switch (action) {
    case "cascade":
      return "cascade";
    case "no_action":
      return "no action";
    case "restrict":
      return "restrict";
    case "set_null":
      return "set null";
  }
}

function setNodeProperty(
  node: KyselyProjectionOperationNode,
  key: string,
  value: unknown,
): void {
  (node as Record<string, unknown>)[key] = value;
}

function aggregateFunctionNode(
  func: string,
  aggregated: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return {
    aggregated,
    func,
    kind: "AggregateFunctionNode",
  };
}

function aliasNode(
  node: KyselyProjectionOperationNode,
  alias: string,
): KyselyProjectionOperationNode {
  return {
    alias: identifierNode(alias),
    kind: "AliasNode",
    node,
  };
}

function columnNode(columnName: string): KyselyProjectionOperationNode {
  return {
    column: identifierNode(columnName),
    kind: "ColumnNode",
  };
}

function dataTypeNode(dataType: string): KyselyProjectionOperationNode {
  return {
    dataType,
    kind: "DataTypeNode",
  };
}

function fromNode(
  froms: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return {
    froms,
    kind: "FromNode",
  };
}

function functionNode(
  func: string,
  args: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return {
    arguments: args,
    func,
    kind: "FunctionNode",
  };
}

function identifierNode(name: string): KyselyProjectionOperationNode {
  return {
    kind: "IdentifierNode",
    name,
  };
}

function limitNode(
  limit: KyselyProjectionOperationNode,
): KyselyProjectionOperationNode {
  return {
    kind: "LimitNode",
    limit,
  };
}

function operatorNode(operator: string): KyselyProjectionOperationNode {
  return {
    kind: "OperatorNode",
    operator,
  };
}

function parensNode(
  node: KyselyProjectionOperationNode,
): KyselyProjectionOperationNode {
  return {
    kind: "ParensNode",
    node,
  };
}

function primitiveValueListNode(
  values: readonly unknown[],
): KyselyProjectionOperationNode {
  return {
    kind: "PrimitiveValueListNode",
    values,
  };
}

function rawNode(sql: string): KyselyProjectionOperationNode {
  return {
    kind: "RawNode",
    parameters: [],
    sqlFragments: [sql],
  };
}

function referenceNode(
  tableName: string | null,
  columnName: string,
): KyselyProjectionOperationNode {
  if (tableName === null) {
    return {
      column: columnNode(columnName),
      kind: "ReferenceNode",
    };
  }

  return {
    column: columnNode(columnName),
    kind: "ReferenceNode",
    table: tableNode(tableName),
  };
}

function schemableIdentifierNode(name: string): KyselyProjectionOperationNode {
  return {
    identifier: identifierNode(name),
    kind: "SchemableIdentifierNode",
  };
}

function selectionNode(
  selection: KyselyProjectionOperationNode,
): KyselyProjectionOperationNode {
  return {
    kind: "SelectionNode",
    selection,
  };
}

function tableNode(tableName: string): KyselyProjectionOperationNode {
  return {
    kind: "TableNode",
    table: schemableIdentifierNode(tableName),
  };
}

function valueListNode(
  values: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return {
    kind: "ValueListNode",
    values,
  };
}

function valueNode(value: unknown): KyselyProjectionOperationNode {
  return {
    kind: "ValueNode",
    value,
  };
}

function valueNodeImmediate(value: unknown): KyselyProjectionOperationNode {
  return {
    immediate: true,
    kind: "ValueNode",
    value,
  };
}

function valuesNode(
  values: readonly KyselyProjectionOperationNode[],
): KyselyProjectionOperationNode {
  return {
    kind: "ValuesNode",
    values,
  };
}

function whereNode(
  where: KyselyProjectionOperationNode,
): KyselyProjectionOperationNode {
  return {
    kind: "WhereNode",
    where,
  };
}
