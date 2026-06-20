export type ProjectionCompiledSql = {
  readonly params: readonly unknown[];
  readonly text: string;
};

export type ProjectionCompilerColumnReference = {
  readonly columnName: string;
  readonly tableName: string | null;
};

export type ProjectionCompilerExpression =
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

export type ProjectionCompilerOrderClause = {
  readonly column: ProjectionCompilerColumnReference;
  readonly direction: "asc" | "desc";
};

export type ProjectionCompilerJoinClause = {
  readonly kind: "inner";
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

export type ProjectionCompilerAggregateStatement = {
  readonly aggregates: readonly ProjectionCompilerAggregate[];
  readonly fromTableName: string;
  readonly where: readonly ProjectionCompilerWhereClause[];
};

export type ProjectionCompilerEventReadStatement = {
  readonly eventIds: readonly number[];
  readonly eventName: string;
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

export type ProjectionStatementCompiler = {
  compileAggregate(
    statement: ProjectionCompilerAggregateStatement,
  ): ProjectionCompiledSql;
  compileDelete(
    statement: ProjectionCompilerDeleteStatement,
  ): ProjectionCompiledSql;
  compileEventRead(
    statement: ProjectionCompilerEventReadStatement,
  ): ProjectionCompiledSql;
  compileInsert(
    statement: ProjectionCompilerInsertStatement,
  ): ProjectionCompiledSql;
  compileSelect(
    statement: ProjectionCompilerSelectStatement,
  ): ProjectionCompiledSql;
  compileUpdate(
    statement: ProjectionCompilerUpdateStatement,
  ): ProjectionCompiledSql;
};

export function createSqliteProjectionStatementCompiler(): ProjectionStatementCompiler {
  return {
    compileAggregate: compileAggregateStatement,
    compileDelete: compileDeleteStatement,
    compileEventRead: compileEventReadStatement,
    compileInsert: compileInsertStatement,
    compileSelect: compileSelectStatement,
    compileUpdate: compileUpdateStatement,
  };
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
    const orderSql = statement.orderBy
      .map((clause) => {
        return `${compileColumnReference(clause.column)} ${clause.direction.toUpperCase()}`;
      })
      .join(", ");
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
      const value = compileExpression(expression.value);
      return {
        params: value.params,
        text: `MAX(${quoteIdentifier(expression.columnName)}, ${value.text})`,
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
