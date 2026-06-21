import type {
  ProjectionColumnMetadata,
  ProjectionForeignKeyAction,
  ProjectionForeignKeyMetadata,
  ProjectionIndexMetadata,
  ProjectionSchemaMetadata,
  ProjectionTableMetadata,
} from "./projections.ts";

export type ProjectionCompiledSql = {
  readonly params: readonly unknown[];
  readonly text: string;
};

export type ProjectionCompilerColumnReference = {
  readonly columnName: string;
  readonly tableName: string | null;
};

export type ProjectionCompilerSelection =
  | {
      readonly alias: string;
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "column";
    }
  | {
      readonly alias: string;
      readonly kind: "value";
      readonly value: unknown;
    };

export type ProjectionCompilerExpression =
  | {
      readonly kind: "add";
      readonly columnName: string;
      readonly value: ProjectionCompilerExpression;
    }
  | {
      readonly kind: "coalesce";
      readonly columnName: string;
      readonly value: ProjectionCompilerExpression;
    }
  | {
      readonly kind: "column";
      readonly columnName: string;
    }
  | {
      readonly kind: "excluded";
      readonly columnName: string;
    }
  | {
      readonly kind: "max";
      readonly columnName: string;
      readonly value: ProjectionCompilerExpression;
    }
  | {
      readonly kind: "value";
      readonly value: unknown;
    };

export type ProjectionCompilerAssignment = {
  readonly columnName: string;
  readonly value: ProjectionCompilerExpression;
};

export type ProjectionCompilerWhereOperator =
  | "!="
  | "<"
  | "<="
  | "="
  | ">"
  | ">=";

export type ProjectionCompilerWhereClause =
  | {
      readonly clauses: readonly ProjectionCompilerWhereClause[];
      readonly kind: "any";
    }
  | {
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "comparison";
      readonly operator: ProjectionCompilerWhereOperator;
      readonly value: unknown;
    }
  | {
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "in";
      readonly values: readonly unknown[];
    }
  | {
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "null";
      readonly not: boolean;
    }
  | {
      readonly innerColumn: ProjectionCompilerColumnReference;
      readonly kind: "not_exists";
      readonly outerColumn: ProjectionCompilerColumnReference;
      readonly tableName: string;
    };

export type ProjectionCompilerOrderClause =
  | {
      readonly column: ProjectionCompilerColumnReference;
      readonly direction: "asc" | "desc";
      readonly kind: "column";
    }
  | {
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "nulls";
      readonly order: "first" | "last";
    }
  | {
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "value_list";
      readonly values: readonly unknown[];
    };

export type ProjectionCompilerJoinClause = {
  readonly kind: "inner" | "left";
  readonly left: ProjectionCompilerColumnReference;
  readonly right: ProjectionCompilerColumnReference;
  readonly tableName: string;
};

export type ProjectionCompilerAggregate =
  | {
      readonly alias: string;
      readonly kind: "count";
    }
  | {
      readonly alias: string;
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "count_not_null";
    }
  | {
      readonly alias: string;
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "max";
    }
  | {
      readonly alias: string;
      readonly column: ProjectionCompilerColumnReference;
      readonly kind: "min";
    };

export type ProjectionCompilerInsertStatement = {
  readonly conflict:
    | null
    | {
        readonly conflictColumns: readonly string[];
        readonly kind: "do_nothing";
      }
    | {
        readonly assignments: readonly ProjectionCompilerAssignment[];
        readonly conflictColumns: readonly string[];
        readonly kind: "do_update";
      };
  readonly columns: readonly string[];
  readonly tableName: string;
};

export type ProjectionCompilerSelectStatement = {
  readonly columns: readonly ProjectionCompilerColumnReference[];
  readonly fromTableName: string;
  readonly joins: readonly ProjectionCompilerJoinClause[];
  readonly limit: number | null;
  readonly orderBy: readonly ProjectionCompilerOrderClause[];
  readonly where: readonly ProjectionCompilerWhereClause[];
};

export type ProjectionCompilerUnionSelectArm = {
  readonly fromTableName: string;
  readonly selections: readonly ProjectionCompilerSelection[];
  readonly where: readonly ProjectionCompilerWhereClause[];
};

export type ProjectionCompilerUnionSelectStatement = {
  readonly arms: readonly ProjectionCompilerUnionSelectArm[];
  readonly limit: number | null;
  readonly orderBy: readonly ProjectionCompilerOrderClause[];
};

export type ProjectionCompilerAggregateStatement = {
  readonly aggregates: readonly ProjectionCompilerAggregate[];
  readonly fromTableName: string;
  readonly where: readonly ProjectionCompilerWhereClause[];
};

export type ProjectionCompilerEventReadStatement = {
  readonly eventIds: readonly number[];
  readonly eventName: string;
};

export type ProjectionCompilerEventScanStatement = {
  readonly afterEventId: number | null;
  readonly eventName: string;
  readonly limit: number | null;
};

export type ProjectionCompilerUpdateStatement = {
  readonly assignments: readonly ProjectionCompilerAssignment[];
  readonly tableName: string;
  readonly where: readonly ProjectionCompilerWhereClause[];
};

export type ProjectionCompilerDeleteStatement = {
  readonly tableName: string;
  readonly where: readonly ProjectionCompilerWhereClause[];
};

export type ProjectionCompilerCreateTableStatement = {
  readonly metadata: ProjectionSchemaMetadata;
  readonly table: ProjectionTableMetadata;
};

export type ProjectionCompilerCreateIndexStatement = {
  readonly index: ProjectionIndexMetadata;
  readonly tableName: string;
};

export type ProjectionStatementCompiler = {
  compileAggregate(
    statement: ProjectionCompilerAggregateStatement,
  ): ProjectionCompiledSql;
  compileCreateIndex(
    statement: ProjectionCompilerCreateIndexStatement,
  ): ProjectionCompiledSql;
  compileCreateTable(
    statement: ProjectionCompilerCreateTableStatement,
  ): ProjectionCompiledSql;
  compileDelete(
    statement: ProjectionCompilerDeleteStatement,
  ): ProjectionCompiledSql;
  compileEventRead(
    statement: ProjectionCompilerEventReadStatement,
  ): ProjectionCompiledSql;
  compileEventScan(
    statement: ProjectionCompilerEventScanStatement,
  ): ProjectionCompiledSql;
  compileInsert(
    statement: ProjectionCompilerInsertStatement,
  ): ProjectionCompiledSql;
  compileSelect(
    statement: ProjectionCompilerSelectStatement,
  ): ProjectionCompiledSql;
  compileUnionSelect(
    statement: ProjectionCompilerUnionSelectStatement,
  ): ProjectionCompiledSql;
  compileUpdate(
    statement: ProjectionCompilerUpdateStatement,
  ): ProjectionCompiledSql;
};

export function createSqliteProjectionStatementCompiler(): ProjectionStatementCompiler {
  return {
    compileAggregate: compileAggregateStatement,
    compileCreateIndex: compileCreateIndexStatement,
    compileCreateTable: compileCreateTableStatement,
    compileDelete: compileDeleteStatement,
    compileEventRead: compileEventReadStatement,
    compileEventScan: compileEventScanStatement,
    compileInsert: compileInsertStatement,
    compileSelect: compileSelectStatement,
    compileUnionSelect: compileUnionSelectStatement,
    compileUpdate: compileUpdateStatement,
  };
}

function compileCreateTableStatement(
  statement: ProjectionCompilerCreateTableStatement,
): ProjectionCompiledSql {
  const columnDefinitions = Object.entries(statement.table.columns).map(
    ([columnName, column]) => {
      return `${quoteIdentifier(columnName)} ${projectionColumnSqlType(
        column,
      )}${column.nullable ? "" : " NOT NULL"}`;
    },
  );
  const constraints: string[] = [];

  if (statement.table.primaryKey.length > 0) {
    constraints.push(
      `PRIMARY KEY (${statement.table.primaryKey
        .map(quoteIdentifier)
        .join(", ")})`,
    );
  }

  for (const [relationName, foreignKey] of Object.entries(
    statement.metadata.relations,
  )) {
    if (foreignKey.fromTable === statement.table.name) {
      constraints.push(compileForeignKeyConstraint(relationName, foreignKey));
    }
  }

  return {
    params: [],
    text: `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(
      statement.table.name,
    )} (${[...columnDefinitions, ...constraints].join(", ")})`,
  };
}

function compileCreateIndexStatement(
  statement: ProjectionCompilerCreateIndexStatement,
): ProjectionCompiledSql {
  const uniqueSql = statement.index.unique ? "UNIQUE " : "";

  return {
    params: [],
    text: `CREATE ${uniqueSql}INDEX IF NOT EXISTS ${quoteIdentifier(
      statement.index.name,
    )} ON ${quoteIdentifier(statement.tableName)} (${statement.index.columns
      .map(quoteIdentifier)
      .join(", ")})`,
  };
}

function projectionColumnSqlType(column: ProjectionColumnMetadata): string {
  switch (column.kind) {
    case "boolean":
    case "event_ref":
    case "integer":
      return "INTEGER";
    case "json":
    case "text":
      return "TEXT";
  }
}

function compileForeignKeyConstraint(
  name: string,
  foreignKey: ProjectionForeignKeyMetadata,
): string {
  return [
    `CONSTRAINT ${quoteIdentifier(name)}`,
    `FOREIGN KEY (${foreignKey.fromColumns.map(quoteIdentifier).join(", ")})`,
    `REFERENCES ${quoteIdentifier(
      foreignKey.toTable,
    )} (${foreignKey.toColumns.map(quoteIdentifier).join(", ")})`,
    `ON DELETE ${projectionForeignKeyActionSql(foreignKey.onDelete)}`,
  ].join(" ");
}

function projectionForeignKeyActionSql(
  action: ProjectionForeignKeyAction,
): string {
  switch (action) {
    case "cascade":
      return "CASCADE";
    case "no_action":
      return "NO ACTION";
    case "restrict":
      return "RESTRICT";
    case "set_null":
      return "SET NULL";
  }
}

function compileAggregateStatement(
  statement: ProjectionCompilerAggregateStatement,
): ProjectionCompiledSql {
  if (statement.aggregates.length === 0) {
    throw new Error("aggregate select must include at least one aggregate");
  }

  const selectedSql = statement.aggregates
    .map((aggregate) => {
      const alias = quoteIdentifier(aggregate.alias);

      switch (aggregate.kind) {
        case "count":
          return `COUNT(*) AS ${alias}`;
        case "count_not_null":
          return `COUNT(${compileColumnReference(aggregate.column)}) AS ${alias}`;
        case "max":
          return `MAX(${compileColumnReference(aggregate.column)}) AS ${alias}`;
        case "min":
          return `MIN(${compileColumnReference(aggregate.column)}) AS ${alias}`;
      }
    })
    .join(", ");
  let text = `SELECT ${selectedSql} FROM ${quoteIdentifier(statement.fromTableName)}`;
  const whereSql = compileWhere(statement.where);

  if (whereSql.text.length > 0) {
    text += ` WHERE ${whereSql.text}`;
  }

  return {
    params: whereSql.params,
    text,
  };
}

function compileEventReadStatement(
  statement: ProjectionCompilerEventReadStatement,
): ProjectionCompiledSql {
  if (statement.eventIds.length === 0) {
    throw new Error("event read must include at least one event id");
  }

  const eventIdsSql = statement.eventIds.map(() => "?").join(", ");

  return {
    params: [statement.eventName, 0, ...statement.eventIds],
    text: `SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ? AND "event_id" IN (${eventIdsSql})`,
  };
}

function compileEventScanStatement(
  statement: ProjectionCompilerEventScanStatement,
): ProjectionCompiledSql {
  const params: unknown[] = [statement.eventName, 0];
  let text =
    'SELECT "event_id", "ts_ms", "event_name", "payload_json", "causation_event_id", "dedupe_key" FROM "events" WHERE "event_name" = ? AND "signal" = ?';

  if (statement.afterEventId !== null) {
    text += ' AND "event_id" > ?';
    params.push(statement.afterEventId);
  }

  text += ' ORDER BY "event_id" ASC';

  if (statement.limit !== null) {
    text += " LIMIT ?";
    params.push(statement.limit);
  }

  return {
    params,
    text,
  };
}

function compileInsertStatement(
  statement: ProjectionCompilerInsertStatement,
): ProjectionCompiledSql {
  const columnSql = statement.columns.map(quoteIdentifier).join(", ");
  const valuesSql = statement.columns.map(() => "?").join(", ");
  let text = `INSERT INTO ${quoteIdentifier(statement.tableName)} (${columnSql}) VALUES (${valuesSql})`;

  if (statement.conflict === null) {
    return {
      params: [],
      text,
    };
  }

  const conflictSql = statement.conflict.conflictColumns
    .map(quoteIdentifier)
    .join(", ");

  if (statement.conflict.kind === "do_nothing") {
    text += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
    return {
      params: [],
      text,
    };
  }

  if (statement.conflict.assignments.length === 0) {
    throw new Error("update values must include at least one column");
  }

  const params: unknown[] = [];
  const updateSql = statement.conflict.assignments
    .map((assignment) => {
      const expression = compileExpression(assignment.value);
      params.push(...expression.params);
      return `${quoteIdentifier(assignment.columnName)} = ${expression.text}`;
    })
    .join(", ");
  text += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateSql}`;

  return {
    params,
    text,
  };
}

function compileSelectStatement(
  statement: ProjectionCompilerSelectStatement,
): ProjectionCompiledSql {
  const selectedSql = statement.columns
    .map((column) => {
      const quotedColumnName = quoteIdentifier(column.columnName);
      return `${compileColumnReference(column)} AS ${quotedColumnName}`;
    })
    .join(", ");
  let text = `SELECT ${selectedSql} FROM ${quoteIdentifier(statement.fromTableName)}`;
  const params: unknown[] = [];

  if (statement.joins.length > 0) {
    const joinsSql = statement.joins
      .map((join) => {
        switch (join.kind) {
          case "inner":
            return `INNER JOIN ${quoteIdentifier(join.tableName)} ON ${compileColumnReference(join.left)} = ${compileColumnReference(join.right)}`;
          case "left":
            return `LEFT JOIN ${quoteIdentifier(join.tableName)} ON ${compileColumnReference(join.left)} = ${compileColumnReference(join.right)}`;
        }
      })
      .join(" ");
    text += ` ${joinsSql}`;
  }

  const whereSql = compileWhere(statement.where);

  if (whereSql.text.length > 0) {
    text += ` WHERE ${whereSql.text}`;
    params.push(...whereSql.params);
  }

  if (statement.orderBy.length > 0) {
    const orderBySql = compileOrderBy(statement.orderBy);
    params.push(...orderBySql.params);
    const orderSql = orderBySql.text;
    text += ` ORDER BY ${orderSql}`;
  }

  if (statement.limit !== null) {
    text += " LIMIT ?";
    params.push(statement.limit);
  }

  return {
    params,
    text,
  };
}

function compileUnionSelectStatement(
  statement: ProjectionCompilerUnionSelectStatement,
): ProjectionCompiledSql {
  if (statement.arms.length < 2) {
    throw new Error("union select must include at least two arms");
  }

  const params: unknown[] = [];
  const armSql = statement.arms
    .map((arm) => {
      const compiled = compileUnionSelectArm(arm);
      params.push(...compiled.params);

      return compiled.text;
    })
    .join(" UNION ALL ");
  let text = `SELECT * FROM (${armSql})`;

  if (statement.orderBy.length > 0) {
    const orderBySql = compileOrderBy(statement.orderBy);
    params.push(...orderBySql.params);
    text += ` ORDER BY ${orderBySql.text}`;
  }

  if (statement.limit !== null) {
    text += " LIMIT ?";
    params.push(statement.limit);
  }

  return {
    params,
    text,
  };
}

function compileUnionSelectArm(
  arm: ProjectionCompilerUnionSelectArm,
): ProjectionCompiledSql {
  if (arm.selections.length === 0) {
    throw new Error("union select arm must include at least one selection");
  }

  const params: unknown[] = [];
  const selectedSql = arm.selections
    .map((selection) => {
      const compiled = compileSelection(selection);
      params.push(...compiled.params);

      return compiled.text;
    })
    .join(", ");
  let text = `SELECT ${selectedSql} FROM ${quoteIdentifier(arm.fromTableName)}`;
  const whereSql = compileWhere(arm.where);

  if (whereSql.text.length > 0) {
    text += ` WHERE ${whereSql.text}`;
    params.push(...whereSql.params);
  }

  return {
    params,
    text,
  };
}

function compileSelection(
  selection: ProjectionCompilerSelection,
): ProjectionCompiledSql {
  const alias = quoteIdentifier(selection.alias);

  switch (selection.kind) {
    case "column":
      return {
        params: [],
        text: `${compileColumnReference(selection.column)} AS ${alias}`,
      };
    case "value":
      return {
        params: [selection.value],
        text: `? AS ${alias}`,
      };
  }
}

function compileOrderBy(
  orderClauses: readonly ProjectionCompilerOrderClause[],
): ProjectionCompiledSql {
  const params: unknown[] = [];
  const text = orderClauses
    .map((clause) => {
      switch (clause.kind) {
        case "column":
          return `${compileColumnReference(clause.column)} ${clause.direction.toUpperCase()}`;
        case "nulls": {
          const nullRank = clause.order === "first" ? 0 : 1;
          const presentRank = clause.order === "first" ? 1 : 0;
          return `CASE WHEN ${compileColumnReference(clause.column)} IS NULL THEN ${nullRank} ELSE ${presentRank} END ASC`;
        }
        case "value_list": {
          if (clause.values.length === 0) {
            throw new Error("value-list order clause must include values");
          }

          const cases = clause.values
            .map((value, index) => {
              params.push(value, index);
              return "WHEN ? THEN ?";
            })
            .join(" ");
          params.push(clause.values.length);

          return `CASE ${compileColumnReference(clause.column)} ${cases} ELSE ? END ASC`;
        }
      }
    })
    .join(", ");

  return {
    params,
    text,
  };
}

function compileUpdateStatement(
  statement: ProjectionCompilerUpdateStatement,
): ProjectionCompiledSql {
  if (statement.assignments.length === 0) {
    throw new Error("update values must include at least one column");
  }

  const params: unknown[] = [];
  const setSql = statement.assignments
    .map((assignment) => {
      const expression = compileExpression(assignment.value);
      params.push(...expression.params);
      return `${quoteIdentifier(assignment.columnName)} = ${expression.text}`;
    })
    .join(", ");
  let text = `UPDATE ${quoteIdentifier(statement.tableName)} SET ${setSql}`;
  const whereSql = compileWhere(statement.where);

  if (whereSql.text.length > 0) {
    text += ` WHERE ${whereSql.text}`;
    params.push(...whereSql.params);
  }

  return {
    params,
    text,
  };
}

function compileDeleteStatement(
  statement: ProjectionCompilerDeleteStatement,
): ProjectionCompiledSql {
  let text = `DELETE FROM ${quoteIdentifier(statement.tableName)}`;
  const whereSql = compileWhere(statement.where);

  if (whereSql.text.length > 0) {
    text += ` WHERE ${whereSql.text}`;
  }

  return {
    params: whereSql.params,
    text,
  };
}

function compileWhere(
  whereClauses: readonly ProjectionCompilerWhereClause[],
): ProjectionCompiledSql {
  if (whereClauses.length === 0) {
    return {
      params: [],
      text: "",
    };
  }

  const params: unknown[] = [];
  const text = whereClauses
    .map((clause) => {
      const compiled = compileWhereClause(clause);
      params.push(...compiled.params);

      return compiled.text;
    })
    .join(" AND ");

  return {
    params,
    text,
  };
}

function compileWhereClause(
  clause: ProjectionCompilerWhereClause,
): ProjectionCompiledSql {
  switch (clause.kind) {
    case "any": {
      if (clause.clauses.length === 0) {
        throw new Error("any predicate group must include at least one clause");
      }

      const params: unknown[] = [];
      const text = clause.clauses
        .map((childClause) => {
          const compiled = compileWhereClause(childClause);
          params.push(...compiled.params);

          return compiled.text;
        })
        .join(" OR ");

      return {
        params,
        text: `(${text})`,
      };
    }
    case "comparison":
      return {
        params: [clause.value],
        text: `${compileColumnReference(clause.column)} ${clause.operator} ?`,
      };
    case "in":
      if (clause.values.length === 0) {
        return {
          params: [],
          text: "0 = 1",
        };
      }

      return {
        params: clause.values,
        text: `${compileColumnReference(clause.column)} IN (${clause.values
          .map(() => "?")
          .join(", ")})`,
      };
    case "null":
      return {
        params: [],
        text: `${compileColumnReference(clause.column)} IS ${clause.not ? "NOT " : ""}NULL`,
      };
    case "not_exists":
      return {
        params: [],
        text: `NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(clause.tableName)} WHERE ${compileColumnReference(clause.innerColumn)} = ${compileColumnReference(clause.outerColumn)})`,
      };
  }
}

function compileExpression(
  expression: ProjectionCompilerExpression,
): ProjectionCompiledSql {
  switch (expression.kind) {
    case "add": {
      const value = compileExpression(expression.value);
      return {
        params: value.params,
        text: `${quoteIdentifier(expression.columnName)} + ${value.text}`,
      };
    }
    case "coalesce": {
      const value = compileExpression(expression.value);
      return {
        params: value.params,
        text: `COALESCE(${quoteIdentifier(expression.columnName)}, ${value.text})`,
      };
    }
    case "column":
      return {
        params: [],
        text: quoteIdentifier(expression.columnName),
      };
    case "excluded":
      return {
        params: [],
        text: `excluded.${quoteIdentifier(expression.columnName)}`,
      };
    case "max": {
      const leftValue = compileExpression(expression.value);
      const rightValue = compileExpression(expression.value);
      return {
        params: [...leftValue.params, ...rightValue.params],
        text: `MAX(COALESCE(${quoteIdentifier(expression.columnName)}, ${leftValue.text}), COALESCE(${rightValue.text}, ${quoteIdentifier(expression.columnName)}))`,
      };
    }
    case "value":
      return {
        params: [expression.value],
        text: "?",
      };
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function compileColumnReference(
  reference: ProjectionCompilerColumnReference,
): string {
  if (reference.tableName === null) {
    return quoteIdentifier(reference.columnName);
  }

  return `${quoteIdentifier(reference.tableName)}.${quoteIdentifier(reference.columnName)}`;
}
