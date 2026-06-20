import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { EventRef } from "./event-ref.ts";
import { createEventRef } from "./event-ref.ts";
import type {
  LedgerStorageRow,
  LedgerStorageScope,
} from "./internal-storage.ts";
import type {
  EventEnvelope,
  LedgerIndexerContext,
  QuerySchema,
} from "./ledger.ts";
import type {
  ProjectionCompiledSql,
  ProjectionCompilerAggregate,
  ProjectionCompilerAssignment,
  ProjectionCompilerColumnReference,
  ProjectionCompilerExpression,
  ProjectionCompilerJoinClause,
  ProjectionCompilerOrderClause,
  ProjectionStatementCompiler,
  ProjectionCompilerWhereClause,
} from "./projection-sql-compiler.ts";
import {
  type ProjectionColumn,
  type ProjectionColumnMetadata,
  type ProjectionColumnKind,
  type ProjectionColumnValue,
  type ProjectionRow,
  type ProjectionSchemaMetadata,
  type ProjectionSchemaTables,
  type ProjectionTableColumnName,
  type ProjectionTableColumns,
  type ProjectionTableKey,
  type ProjectionTableMetadata,
  type ProjectionTableName,
} from "./projections.ts";

type AnyQuerySchema = QuerySchema<TSchema, TSchema>;
const projectionExpressionBrand: unique symbol = Symbol(
  "sledge.projectionExpression",
);
declare const projectionExpressionValueBrand: unique symbol;

const ProjectionEventRowSchema = Type.Object({
  causation_event_id: Type.Union([Type.Null(), Type.Number()]),
  dedupe_key: Type.Union([Type.Null(), Type.String()]),
  event_id: Type.Number(),
  event_name: Type.String(),
  payload_json: Type.String(),
  ts_ms: Type.Number(),
});
const maxProjectionEventReadIdsPerStatement = 900;

export type AnyProjectionSchema = {
  readonly metadata: ProjectionSchemaMetadata;
};

export type ProjectionIndexerEvent<TEventName extends string> = {
  readonly eventName: TEventName;
  readonly eventId: number;
  readonly ref: EventRef<TEventName>;
};

export type ProjectionWriteRow<TTable> = ProjectionRow<
  ProjectionTableColumns<TTable>
>;

type ProjectionExpressionMetadata =
  | {
      readonly kind: "add";
      readonly columnName: string;
      readonly value: ProjectionExpressionOperandMetadata;
    }
  | {
      readonly kind: "coalesce";
      readonly columnName: string;
      readonly value: ProjectionExpressionOperandMetadata;
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
      readonly value: ProjectionExpressionOperandMetadata;
    };

type ProjectionExpressionOperandMetadata =
  | ProjectionExpressionMetadata
  | {
      readonly kind: "value";
      readonly columnName: string;
      readonly value: unknown;
    };

export type ProjectionExpression<TValue> = {
  readonly [projectionExpressionBrand]: true;
  readonly [projectionExpressionValueBrand]?: TValue;
  readonly metadata: ProjectionExpressionMetadata;
};

export type ProjectionExpressionOperand<
  TTable,
  TColumnName extends ProjectionTableColumnName<TTable>,
> =
  | ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
  | ProjectionExpression<
      ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
    >;

export type ProjectionExpressionBuilder<TTable> = {
  add<const TColumnName extends ProjectionIntegerColumnName<TTable>>(
    columnName: TColumnName,
    value: ProjectionExpressionOperand<TTable, TColumnName>,
  ): ProjectionExpression<
    ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
  >;
  coalesce<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    value: ProjectionExpressionOperand<TTable, TColumnName>,
  ): ProjectionExpression<
    ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
  >;
  column<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionExpression<
    ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
  >;
  max<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    value: ProjectionExpressionOperand<TTable, TColumnName>,
  ): ProjectionExpression<
    ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
  >;
};

export type ProjectionUpsertExpressionBuilder<TTable> =
  ProjectionExpressionBuilder<TTable> & {
    excluded<const TColumnName extends ProjectionTableColumnName<TTable>>(
      columnName: TColumnName,
    ): ProjectionExpression<
      ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
    >;
  };

type ProjectionUpdateValue<TColumn> =
  | ProjectionColumnValue<TColumn>
  | ProjectionExpression<ProjectionColumnValue<TColumn>>;

export type ProjectionUpdateRow<TTable> = {
  readonly [TColumnName in ProjectionTableColumnName<TTable>]?: ProjectionUpdateValue<
    ProjectionTableColumns<TTable>[TColumnName]
  >;
};

export type ProjectionUpdateSet<TTable> =
  | ProjectionUpdateRow<TTable>
  | ((
      expressions: ProjectionExpressionBuilder<TTable>,
    ) => ProjectionUpdateRow<TTable>);

export type ProjectionUpsertUpdateSet<TTable> =
  | ProjectionUpdateRow<TTable>
  | ((
      expressions: ProjectionUpsertExpressionBuilder<TTable>,
    ) => ProjectionUpdateRow<TTable>);

type ProjectionWhereValue<
  TTable,
  TColumnName extends ProjectionTableColumnName<TTable>,
> =
  ProjectionTableColumns<TTable>[TColumnName] extends ProjectionColumn<
    "json",
    infer TValue,
    boolean
  >
    ? TValue
    : NonNullable<
        ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
      >;

export type ProjectionWhereOperator = "=" | "!=" | "<" | "<=" | ">" | ">=";

type ProjectionColumnScalar<TColumn> =
  TColumn extends ProjectionColumn<ProjectionColumnKind, infer TValue, boolean>
    ? NonNullable<TValue>
    : never;

type ProjectionCompatibleColumnNames<TTable, TValue> = {
  readonly [TColumnName in ProjectionTableColumnName<TTable>]: ProjectionColumnScalar<
    ProjectionTableColumns<TTable>[TColumnName]
  > extends TValue
    ? TValue extends ProjectionColumnScalar<
        ProjectionTableColumns<TTable>[TColumnName]
      >
      ? TColumnName
      : never
    : never;
}[ProjectionTableColumnName<TTable>];

export type ProjectionWhereCondition<TTable> =
  | {
      readonly [TColumnName in ProjectionTableColumnName<TTable>]: {
        readonly columnName: TColumnName;
        readonly kind: "comparison";
        readonly operator: ProjectionWhereOperator;
        readonly value: ProjectionWhereValue<TTable, TColumnName>;
      };
    }[ProjectionTableColumnName<TTable>]
  | {
      readonly [TColumnName in ProjectionTableColumnName<TTable>]: {
        readonly columnName: TColumnName;
        readonly kind: "in";
        readonly values: readonly ProjectionWhereValue<TTable, TColumnName>[];
      };
    }[ProjectionTableColumnName<TTable>]
  | {
      readonly [TColumnName in ProjectionTableColumnName<TTable>]: {
        readonly columnName: TColumnName;
        readonly kind: "is_not_null";
      };
    }[ProjectionTableColumnName<TTable>]
  | {
      readonly [TColumnName in ProjectionTableColumnName<TTable>]: {
        readonly columnName: TColumnName;
        readonly kind: "is_null";
      };
    }[ProjectionTableColumnName<TTable>];

export type ProjectionQualifiedWhereCondition<
  TTables,
  TTableNames extends ProjectionTableName<TTables>,
> =
  | {
      readonly [TTableName in TTableNames]: {
        readonly [TColumnName in ProjectionTableColumnName<
          TTables[TTableName]
        >]: {
          readonly columnName: TColumnName;
          readonly kind: "comparison";
          readonly operator: ProjectionWhereOperator;
          readonly tableName: TTableName;
          readonly value: ProjectionWhereValue<
            TTables[TTableName],
            TColumnName
          >;
        };
      }[ProjectionTableColumnName<TTables[TTableName]>];
    }[TTableNames]
  | {
      readonly [TTableName in TTableNames]: {
        readonly [TColumnName in ProjectionTableColumnName<
          TTables[TTableName]
        >]: {
          readonly columnName: TColumnName;
          readonly kind: "in";
          readonly tableName: TTableName;
          readonly values: readonly ProjectionWhereValue<
            TTables[TTableName],
            TColumnName
          >[];
        };
      }[ProjectionTableColumnName<TTables[TTableName]>];
    }[TTableNames]
  | {
      readonly [TTableName in TTableNames]: {
        readonly [TColumnName in ProjectionTableColumnName<
          TTables[TTableName]
        >]: {
          readonly columnName: TColumnName;
          readonly kind: "is_not_null";
          readonly tableName: TTableName;
        };
      }[ProjectionTableColumnName<TTables[TTableName]>];
    }[TTableNames]
  | {
      readonly [TTableName in TTableNames]: {
        readonly [TColumnName in ProjectionTableColumnName<
          TTables[TTableName]
        >]: {
          readonly columnName: TColumnName;
          readonly kind: "is_null";
          readonly tableName: TTableName;
        };
      }[ProjectionTableColumnName<TTables[TTableName]>];
    }[TTableNames];

export type ProjectionJoinCondition<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TJoinedTableName extends ProjectionTableName<TTables>,
> = {
  readonly [TFromColumnName in ProjectionTableColumnName<
    TTables[TFromTableName]
  >]: {
    readonly fromColumn: TFromColumnName;
    readonly toColumn: ProjectionCompatibleColumnNames<
      TTables[TJoinedTableName],
      ProjectionColumnScalar<
        ProjectionTableColumns<TTables[TFromTableName]>[TFromColumnName]
      >
    >;
  };
}[ProjectionTableColumnName<TTables[TFromTableName]>];

export type ProjectionOrderDirection = "asc" | "desc";
export type ProjectionNullOrder = "first" | "last";

export type ProjectionSelectedRow<
  TTable,
  TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
> = {
  readonly [TColumnName in TColumnNames[number]]: ProjectionColumnValue<
    ProjectionTableColumns<TTable>[TColumnName]
  >;
};

type ProjectionIntegerColumnName<TTable> = {
  readonly [TColumnName in ProjectionTableColumnName<TTable>]: ProjectionTableColumns<TTable>[TColumnName] extends ProjectionColumn<
    "integer",
    unknown,
    boolean
  >
    ? TColumnName
    : never;
}[ProjectionTableColumnName<TTable>];

type ProjectionNullableColumnName<TTable> = {
  readonly [TColumnName in ProjectionTableColumnName<TTable>]: ProjectionTableColumns<TTable>[TColumnName] extends ProjectionColumn<
    ProjectionColumnKind,
    unknown,
    true
  >
    ? TColumnName
    : never;
}[ProjectionTableColumnName<TTable>];

type ProjectionIntegerAggregateValue<
  TTable,
  TColumnName extends ProjectionIntegerColumnName<TTable>,
> = NonNullable<
  ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
> | null;

export type ProjectionWriteResult = {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
};

export type ProjectionInsertBuilder<TTable> = {
  values(
    row: ProjectionWriteRow<TTable>,
  ): ProjectionInsertConflictBuilder<TTable>;
};

export type ProjectionInsertConflictBuilder<TTable> = {
  execute(): Promise<ProjectionWriteResult>;
  onConflict<const TColumns extends ProjectionTableKey<TTable>>(
    columns: TColumns,
  ): ProjectionInsertOnConflictBuilder<TTable>;
};

export type ProjectionInsertOnConflictBuilder<TTable> = {
  doNothing(): ProjectionExecutableWrite;
  doUpdateSet(
    values: ProjectionUpsertUpdateSet<TTable>,
  ): ProjectionExecutableWrite;
};

export type ProjectionExecutableWrite = {
  execute(): Promise<ProjectionWriteResult>;
  executeExpectingOne(): Promise<void>;
};

export type ProjectionWriteDatabase<
  TProjectionSchema extends AnyProjectionSchema,
> = {
  deleteFrom<
    const TTableName extends ProjectionTableName<
      ProjectionSchemaTables<TProjectionSchema>
    >,
  >(
    tableName: TTableName,
  ): ProjectionDeleteBuilder<
    ProjectionSchemaTables<TProjectionSchema>[TTableName]
  >;
  insertInto<
    const TTableName extends ProjectionTableName<
      ProjectionSchemaTables<TProjectionSchema>
    >,
  >(
    tableName: TTableName,
  ): ProjectionInsertBuilder<
    ProjectionSchemaTables<TProjectionSchema>[TTableName]
  >;
  updateTable<
    const TTableName extends ProjectionTableName<
      ProjectionSchemaTables<TProjectionSchema>
    >,
  >(
    tableName: TTableName,
  ): ProjectionUpdateBuilder<
    ProjectionSchemaTables<TProjectionSchema>[TTableName]
  >;
};

export type ProjectionUpdateBuilder<TTable> = {
  set(
    values: ProjectionUpdateSet<TTable>,
  ): ProjectionUpdateWhereBuilder<TTable>;
};

export type ProjectionUpdateWhereBuilder<TTable> = ProjectionExecutableWrite & {
  whereAny(
    conditions: readonly ProjectionWhereCondition<TTable>[],
  ): ProjectionUpdateWhereBuilder<TTable>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: ProjectionWhereOperator,
    value: ProjectionWhereValue<TTable, TColumnName>,
  ): ProjectionUpdateWhereBuilder<TTable>;
  whereIn<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTable, TColumnName>[],
  ): ProjectionUpdateWhereBuilder<TTable>;
  whereNotNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionUpdateWhereBuilder<TTable>;
  whereNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionUpdateWhereBuilder<TTable>;
};

export type ProjectionDeleteBuilder<TTable> = ProjectionExecutableWrite & {
  whereAny(
    conditions: readonly ProjectionWhereCondition<TTable>[],
  ): ProjectionDeleteBuilder<TTable>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: ProjectionWhereOperator,
    value: ProjectionWhereValue<TTable, TColumnName>,
  ): ProjectionDeleteBuilder<TTable>;
  whereIn<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTable, TColumnName>[],
  ): ProjectionDeleteBuilder<TTable>;
  whereNotNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionDeleteBuilder<TTable>;
  whereNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionDeleteBuilder<TTable>;
};

export type ProjectionSelectBuilder<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
> = {
  aggregate(): ProjectionAggregateBuilder<
    TTables[TFromTableName],
    {},
    TTables,
    TFromTableName
  >;
  innerJoin<const TJoinedTableName extends ProjectionTableName<TTables>>(
    tableName: TJoinedTableName,
    condition: ProjectionJoinCondition<
      TTables,
      TFromTableName,
      TJoinedTableName
    >,
  ): ProjectionJoinedSelectBuilder<TTables, TFromTableName, TJoinedTableName>;
  select<
    const TColumnNames extends readonly ProjectionTableColumnName<
      TTables[TFromTableName]
    >[],
  >(
    columns: TColumnNames,
  ): ProjectionExecutableSelect<
    TTables[TFromTableName],
    TColumnNames,
    TTables,
    TFromTableName
  >;
};

export type ProjectionJoinedSelectBuilder<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TJoinedTableName extends ProjectionTableName<TTables>,
> = {
  selectFrom<
    const TSelectedTableName extends TFromTableName | TJoinedTableName,
    const TColumnNames extends readonly ProjectionTableColumnName<
      TTables[TSelectedTableName]
    >[],
  >(
    tableName: TSelectedTableName,
    columns: TColumnNames,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TFromTableName | TJoinedTableName,
    TSelectedTableName,
    TColumnNames
  >;
};

export type ProjectionExecutableSelect<
  TTable,
  TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
> = {
  limit(
    limit: number,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  orderBy<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    direction?: ProjectionOrderDirection,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  orderByList<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTable, TColumnName>[],
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  orderByNulls<const TColumnName extends ProjectionNullableColumnName<TTable>>(
    columnName: TColumnName,
    order: ProjectionNullOrder,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  whereAny(
    conditions: readonly ProjectionWhereCondition<TTable>[],
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  whereNotExists<
    const TExistenceTableName extends ProjectionTableName<TTables>,
  >(
    tableName: TExistenceTableName,
    condition: ProjectionJoinCondition<
      TTables,
      TFromTableName,
      TExistenceTableName
    >,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: ProjectionWhereOperator,
    value: ProjectionWhereValue<TTable, TColumnName>,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  whereIn<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTable, TColumnName>[],
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  whereNotNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  whereNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName>;
  execute(): Promise<readonly ProjectionSelectedRow<TTable, TColumnNames>[]>;
  executeTakeFirst(): Promise<ProjectionSelectedRow<
    TTable,
    TColumnNames
  > | null>;
  stream(): AsyncIterable<ProjectionSelectedRow<TTable, TColumnNames>>;
};

export type ProjectionAggregateBuilder<
  TTable,
  TResult,
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
> = {
  count<const TAlias extends string>(
    alias: TAlias,
  ): ProjectionAggregateBuilder<
    TTable,
    TResult & { readonly [TKey in TAlias]: number },
    TTables,
    TFromTableName
  >;
  countNotNull<
    const TAlias extends string,
    const TColumnName extends ProjectionTableColumnName<TTable>,
  >(
    alias: TAlias,
    columnName: TColumnName,
  ): ProjectionAggregateBuilder<
    TTable,
    TResult & { readonly [TKey in TAlias]: number },
    TTables,
    TFromTableName
  >;
  max<
    const TAlias extends string,
    const TColumnName extends ProjectionIntegerColumnName<TTable>,
  >(
    alias: TAlias,
    columnName: TColumnName,
  ): ProjectionAggregateBuilder<
    TTable,
    TResult & {
      readonly [TKey in TAlias]: ProjectionIntegerAggregateValue<
        TTable,
        TColumnName
      >;
    },
    TTables,
    TFromTableName
  >;
  min<
    const TAlias extends string,
    const TColumnName extends ProjectionIntegerColumnName<TTable>,
  >(
    alias: TAlias,
    columnName: TColumnName,
  ): ProjectionAggregateBuilder<
    TTable,
    TResult & {
      readonly [TKey in TAlias]: ProjectionIntegerAggregateValue<
        TTable,
        TColumnName
      >;
    },
    TTables,
    TFromTableName
  >;
  whereAny(
    conditions: readonly ProjectionWhereCondition<TTable>[],
  ): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName>;
  whereNotExists<
    const TExistenceTableName extends ProjectionTableName<TTables>,
  >(
    tableName: TExistenceTableName,
    condition: ProjectionJoinCondition<
      TTables,
      TFromTableName,
      TExistenceTableName
    >,
  ): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: ProjectionWhereOperator,
    value: ProjectionWhereValue<TTable, TColumnName>,
  ): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName>;
  whereIn<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTable, TColumnName>[],
  ): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName>;
  whereNotNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName>;
  whereNull<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
  ): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName>;
  execute(): Promise<TResult>;
};

export type ProjectionExecutableJoinedSelect<
  TTables,
  TTableNames extends ProjectionTableName<TTables>,
  TSelectedTableName extends TTableNames,
  TColumnNames extends readonly ProjectionTableColumnName<
    TTables[TSelectedTableName]
  >[],
> = {
  limit(
    limit: number,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  orderBy<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionTableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
    direction?: ProjectionOrderDirection,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  orderByList<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionTableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTables[TTableName], TColumnName>[],
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  orderByNulls<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionNullableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
    order: ProjectionNullOrder,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  whereAny(
    conditions: readonly ProjectionQualifiedWhereCondition<
      TTables,
      TTableNames
    >[],
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  where<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionTableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
    operator: ProjectionWhereOperator,
    value: ProjectionWhereValue<TTables[TTableName], TColumnName>,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  whereIn<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionTableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
    values: readonly ProjectionWhereValue<TTables[TTableName], TColumnName>[],
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  whereNotNull<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionTableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  whereNull<
    const TTableName extends TTableNames,
    const TColumnName extends ProjectionTableColumnName<TTables[TTableName]>,
  >(
    tableName: TTableName,
    columnName: TColumnName,
  ): ProjectionExecutableJoinedSelect<
    TTables,
    TTableNames,
    TSelectedTableName,
    TColumnNames
  >;
  execute(): Promise<
    readonly ProjectionSelectedRow<TTables[TSelectedTableName], TColumnNames>[]
  >;
  executeTakeFirst(): Promise<ProjectionSelectedRow<
    TTables[TSelectedTableName],
    TColumnNames
  > | null>;
  stream(): AsyncIterable<
    ProjectionSelectedRow<TTables[TSelectedTableName], TColumnNames>
  >;
};

export type ProjectionReadDatabase<
  TProjectionSchema extends AnyProjectionSchema,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readEvent<const TEventName extends Extract<keyof TEvents, string>>(
    ref: EventRef<TEventName>,
  ): Promise<EventEnvelope<TEvents, TEventName> | null>;
  readEvents<const TEventName extends Extract<keyof TEvents, string>>(
    refs: readonly EventRef<TEventName>[],
  ): Promise<readonly (EventEnvelope<TEvents, TEventName> | null)[]>;
  selectFrom<
    const TTableName extends ProjectionTableName<
      ProjectionSchemaTables<TProjectionSchema>
    >,
  >(
    tableName: TTableName,
  ): ProjectionSelectBuilder<
    ProjectionSchemaTables<TProjectionSchema>,
    TTableName
  >;
};

export type ProjectionDatabase<
  TProjectionSchema extends AnyProjectionSchema,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = ProjectionReadDatabase<TProjectionSchema, TEvents> &
  ProjectionWriteDatabase<TProjectionSchema>;

export type ProjectionIndexerRunInput<
  TProjectionSchema extends AnyProjectionSchema,
  TInputSchema extends TSchema,
  TSourceEventName extends string,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly input: Static<TInputSchema>;
  readonly event: ProjectionIndexerEvent<TSourceEventName>;
  readonly db: ProjectionDatabase<TProjectionSchema, TEvents>;
};

export type ProjectionIndexerContract<
  TProjectionSchema extends AnyProjectionSchema,
  TInputSchema extends TSchema,
  TSourceEventName extends string,
> = {
  readonly input: TInputSchema;
  readonly sourceEvent: TSourceEventName;
};

type ProjectionIndexerContractLike = {
  readonly input: TSchema;
  readonly sourceEvent: string;
};

type ProjectionIndexerContractMapValue<TSourceEventName extends string> = {
  readonly input: TSchema;
  readonly sourceEvent: TSourceEventName;
};

export type ProjectionIndexerDefinitions<TSourceEventName extends string> =
  Readonly<Record<string, ProjectionIndexerContractMapValue<TSourceEventName>>>;

export type ProjectionQueryRunInput<
  TProjectionSchema extends AnyProjectionSchema,
  TParamsSchema extends TSchema,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly params: Static<TParamsSchema>;
  readonly db: ProjectionReadDatabase<TProjectionSchema, TEvents>;
};

export type ProjectionQueryContract<
  TParamsSchema extends TSchema,
  TResultSchema extends TSchema,
> = {
  readonly params: TParamsSchema;
  readonly result: TResultSchema;
};

type ProjectionQueryContractLike = {
  readonly params: TSchema;
  readonly result: TSchema;
};

type ProjectionQueryContractMapValue = {
  readonly params: TSchema;
  readonly result: TSchema;
};

export type ProjectionQueryDefinitions = Readonly<
  Record<string, ProjectionQueryContractMapValue>
>;

export type ProjectionIndexerImplementations<
  TProjectionSchema extends AnyProjectionSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly [TName in keyof TIndexerDefinitions]: TIndexerDefinitions[TName] extends {
    readonly input: infer TInputSchema extends TSchema;
    readonly sourceEvent: infer TSourceEventName extends string;
  }
    ? (
        input: ProjectionIndexerRunInput<
          TProjectionSchema,
          TInputSchema,
          TSourceEventName,
          TEvents
        >,
      ) => void | Promise<void>
    : never;
};

export type ProjectionQueryImplementations<
  TProjectionSchema extends AnyProjectionSchema,
  TQueryDefinitions extends ProjectionQueryDefinitions,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly [TName in keyof TQueryDefinitions]: TQueryDefinitions[TName] extends {
    readonly params: infer TParamsSchema extends TSchema;
    readonly result: infer TResultSchema extends TSchema;
  }
    ? (
        input: ProjectionQueryRunInput<
          TProjectionSchema,
          TParamsSchema,
          TEvents
        >,
      ) => Static<TResultSchema> | Promise<Static<TResultSchema>>
    : never;
};

export type ProjectionIndexerSchemas<TDefinitions> = {
  readonly [TName in Extract<
    keyof TDefinitions,
    string
  >]: TDefinitions[TName] extends {
    readonly input: infer TInputSchema;
  }
    ? TInputSchema extends TSchema
      ? TInputSchema
      : never
    : never;
};

export type ProjectionIndexerSchemasForEvent<
  TDefinitions,
  TEventName extends string,
> = {
  readonly [TName in Extract<
    keyof TDefinitions,
    string
  > as TDefinitions[TName] extends {
    readonly input: infer TInputSchema;
    readonly sourceEvent: TEventName;
  }
    ? TInputSchema extends TSchema
      ? TName
      : never
    : never]: TDefinitions[TName] extends {
    readonly input: infer TInputSchema;
  }
    ? TInputSchema extends TSchema
      ? TInputSchema
      : never
    : never;
};

export type ProjectionQuerySchemas<TDefinitions> = {
  readonly [TName in Extract<
    keyof TDefinitions,
    string
  >]: TDefinitions[TName] extends {
    readonly params: infer TParamsSchema;
    readonly result: infer TResultSchema;
  }
    ? TParamsSchema extends TSchema
      ? TResultSchema extends TSchema
        ? QuerySchema<TParamsSchema, TResultSchema>
        : never
      : never
    : never;
};

export type ProjectionAccess<
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
> = {
  readonly projections: TProjectionSchema;
  readonly indexers: TIndexers;
  readonly queries: TQueries;
  readonly indexerDefinitions: TIndexerDefinitions;
  readonly queryDefinitions: TQueryDefinitions;
};

export function createProjectionAccess<
  const TProjectionSchema extends AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(input: {
  readonly projections: TProjectionSchema;
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
}): ProjectionAccess<
  TProjectionSchema,
  ProjectionIndexerSchemas<TIndexerDefinitions>,
  ProjectionQuerySchemas<TQueryDefinitions>,
  TIndexerDefinitions,
  TQueryDefinitions
> {
  const indexers: Record<string, TSchema> = {};
  const queries: Record<string, AnyQuerySchema> = {};

  for (const [indexerName, definition] of Object.entries(input.indexers)) {
    indexers[indexerName] = definition.input;
  }

  for (const [queryName, definition] of Object.entries(input.queries)) {
    queries[queryName] = {
      params: definition.params,
      result: definition.result,
    };
  }

  return {
    projections: input.projections,
    indexers,
    queries,
    indexerDefinitions: input.indexers,
    queryDefinitions: input.queries,
  } as ProjectionAccess<
    TProjectionSchema,
    ProjectionIndexerSchemas<TIndexerDefinitions>,
    ProjectionQuerySchemas<TQueryDefinitions>,
    TIndexerDefinitions,
    TQueryDefinitions
  >;
}

export type ProjectionImplementationRegistration<
  TProjectionSchema extends AnyProjectionSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = (keyof TIndexerDefinitions extends never
  ? {
      readonly indexers?: never;
    }
  : {
      readonly indexers: ProjectionIndexerImplementations<
        TProjectionSchema,
        TIndexerDefinitions,
        TEvents
      >;
    }) &
  (keyof TQueryDefinitions extends never
    ? {
        readonly queries?: never;
      }
    : {
        readonly queries: ProjectionQueryImplementations<
          TProjectionSchema,
          TQueryDefinitions,
          TEvents
        >;
      });

export function createProjectionImplementations<
  const TEvents extends Record<string, TSchema>,
  const TProjectionSchema extends AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(input: {
  readonly events: TEvents;
  readonly statementCompiler: ProjectionStatementCompiler;
  readonly projections: TProjectionSchema;
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
  readonly register: ProjectionImplementationRegistration<
    TProjectionSchema,
    TIndexerDefinitions,
    TQueryDefinitions,
    TEvents
  >;
}): unknown {
  const indexerImplementations: Record<
    string,
    (
      scope: LedgerStorageScope,
      input: unknown,
      context: LedgerIndexerContext,
    ) => Promise<void>
  > = {};
  const queryImplementations: Record<
    string,
    (scope: LedgerStorageScope, params: unknown) => Promise<unknown>
  > = {};

  for (const [indexerName, definition] of Object.entries(input.indexers)) {
    const implementation = input.register.indexers?.[indexerName];

    if (implementation === undefined) {
      throw new Error(
        `missing projection indexer implementation ${indexerName}`,
      );
    }

    indexerImplementations[indexerName] = async (
      scope,
      indexerInput,
      context,
    ) => {
      await runProjectionIndexer(
        input.projections,
        definition,
        implementation,
        scope,
        indexerInput,
        context,
        input.events,
        input.statementCompiler,
      );
    };
  }

  for (const [queryName, definition] of Object.entries(input.queries)) {
    const implementation = input.register.queries?.[queryName];

    if (implementation === undefined) {
      throw new Error(`missing projection query implementation ${queryName}`);
    }

    queryImplementations[queryName] = async (scope, params) => {
      return await implementation({
        params,
        db: createProjectionReadDatabase(
          input.projections.metadata,
          scope,
          input.events,
          input.statementCompiler,
        ),
      });
    };
  }

  return {
    indexers: indexerImplementations,
    queries: queryImplementations,
  };
}

async function runProjectionIndexer(
  projections: AnyProjectionSchema,
  definition: ProjectionIndexerContractLike,
  implementation: (
    input: ProjectionIndexerRunInput<
      AnyProjectionSchema,
      TSchema,
      string,
      Record<string, TSchema>
    >,
  ) => void | Promise<void>,
  scope: LedgerStorageScope,
  input: unknown,
  context: LedgerIndexerContext,
  events: Record<string, TSchema>,
  statementCompiler: ProjectionStatementCompiler,
): Promise<void> {
  const event = createProjectionIndexerEvent(definition.sourceEvent, context);
  const pendingWrites = new Set<Promise<unknown>>();
  let acceptingWrites = true;
  const trackWrite: ProjectionWriteTracker = (run) => {
    if (!acceptingWrites) {
      return Promise.reject(new Error("projection write scope is closed"));
    }

    let tracked: Promise<unknown>;
    const runPromise = run();
    tracked = runPromise.finally(() => {
      pendingWrites.delete(tracked);
    });
    pendingWrites.add(tracked);

    return runPromise;
  };

  let implementationError: unknown = null;

  try {
    await implementation({
      input,
      event,
      db: createProjectionDatabase(
        projections.metadata,
        scope,
        events,
        trackWrite,
        statementCompiler,
      ),
    });
  } catch (error: unknown) {
    implementationError = error;
  }

  acceptingWrites = false;
  const writeError = await settleProjectionWrites(pendingWrites);

  if (implementationError !== null) {
    throw implementationError;
  }

  if (writeError !== null) {
    throw writeError;
  }
}

async function settleProjectionWrites(
  pendingWrites: ReadonlySet<Promise<unknown>>,
): Promise<unknown | null> {
  if (pendingWrites.size === 0) {
    return null;
  }

  const settled = await Promise.allSettled([...pendingWrites]);
  const failed = settled.find((result) => result.status === "rejected");

  return failed === undefined ? null : failed.reason;
}

function createProjectionIndexerEvent(
  sourceEventName: string,
  context: LedgerIndexerContext,
): ProjectionIndexerEvent<string> {
  const eventName = String(context.event.eventName);

  if (eventName !== sourceEventName) {
    throw new Error(
      `projection indexer expected source event ${sourceEventName} but received ${eventName}`,
    );
  }

  return {
    eventName,
    eventId: context.event.eventId,
    ref: createEventRef(eventName, context.event.eventId),
  };
}

function createProjectionDatabase<
  TProjectionSchema extends AnyProjectionSchema,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  events: Record<string, TSchema>,
  trackWrite: ProjectionWriteTracker,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionDatabase<TProjectionSchema, Record<string, TSchema>> {
  return {
    ...createProjectionReadDatabase(metadata, scope, events, statementCompiler),
    ...createProjectionWriteDatabase(
      metadata,
      scope,
      trackWrite,
      statementCompiler,
    ),
  };
}

function createProjectionWriteDatabase<
  TProjectionSchema extends AnyProjectionSchema,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  trackWrite: ProjectionWriteTracker,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionWriteDatabase<TProjectionSchema> {
  return {
    deleteFrom: (tableName) => {
      const table = readProjectionTable(metadata, String(tableName));
      return createProjectionDeleteBuilder(
        scope,
        table,
        [],
        trackWrite,
        statementCompiler,
      );
    },
    insertInto: (tableName) => {
      const table = readProjectionTable(metadata, String(tableName));

      return {
        values: (row) => {
          const rowValues = row as Readonly<Record<string, unknown>>;
          const insertColumns = validateProjectionWriteRow(
            "insert values",
            table,
            rowValues,
            true,
          );
          const insertValues = insertColumns.map((columnName) => {
            return serializeProjectionColumnValue(
              table.columns[columnName],
              rowValues[columnName],
              `${table.name}.${columnName}`,
            );
          });

          return createInsertConflictBuilder<
            ProjectionSchemaTables<TProjectionSchema>[typeof tableName]
          >(
            scope,
            table,
            insertColumns,
            insertValues,
            trackWrite,
            statementCompiler,
          );
        },
      };
    },
    updateTable: (tableName) => {
      const table = readProjectionTable(metadata, String(tableName));

      return {
        set: (values) => {
          const updateAssignments = readProjectionUpdateAssignments(
            table,
            resolveProjectionUpdateSet(table, values),
            false,
          );

          return createProjectionUpdateWhereBuilder(
            scope,
            table,
            updateAssignments,
            [],
            trackWrite,
            statementCompiler,
          );
        },
      };
    },
  };
}

type ProjectionWriteTracker = <T>(run: () => Promise<T>) => Promise<T>;

function createInsertConflictBuilder<TTable>(
  scope: LedgerStorageScope,
  table: ProjectionTableMetadata,
  insertColumns: readonly string[],
  insertValues: readonly unknown[],
  trackWrite: ProjectionWriteTracker,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionInsertConflictBuilder<TTable> {
  return {
    execute: () => {
      const sql = buildInsertSql(statementCompiler, table, insertColumns, null);
      return trackWrite(async () => {
        return await scope
          .prepare(sql.text)
          .run(...insertValues, ...sql.params);
      });
    },
    onConflict: (conflictColumns) => {
      validateProjectionKey("conflict target", table, conflictColumns);

      return {
        doNothing: () => {
          const sql = buildInsertSql(statementCompiler, table, insertColumns, {
            kind: "do_nothing",
            conflictColumns,
          });

          return createProjectionExecutableWrite(
            scope,
            sql.text,
            [...insertValues, ...sql.params],
            trackWrite,
          );
        },
        doUpdateSet: (values) => {
          const updateAssignments = readProjectionUpdateAssignments(
            table,
            resolveProjectionUpsertUpdateSet(table, values),
            true,
          );

          return {
            execute: () => {
              const sql = buildInsertSql(
                statementCompiler,
                table,
                insertColumns,
                {
                  kind: "do_update",
                  conflictColumns,
                  updateAssignments,
                },
              );
              return trackWrite(async () => {
                return await scope
                  .prepare(sql.text)
                  .run(...insertValues, ...sql.params);
              });
            },
            executeExpectingOne: async () => {
              const sql = buildInsertSql(
                statementCompiler,
                table,
                insertColumns,
                {
                  kind: "do_update",
                  conflictColumns,
                  updateAssignments,
                },
              );
              await createProjectionExecutableWrite(
                scope,
                sql.text,
                [...insertValues, ...sql.params],
                trackWrite,
              ).executeExpectingOne();
            },
          };
        },
      };
    },
  };
}

function createProjectionExecutableWrite(
  scope: LedgerStorageScope,
  sql: string,
  params: readonly unknown[],
  trackWrite: ProjectionWriteTracker,
): ProjectionExecutableWrite {
  return {
    execute: () => {
      return trackWrite(async () => {
        return await scope.prepare(sql).run(...params);
      });
    },
    executeExpectingOne: async () => {
      const result = await trackWrite(async () => {
        return await scope.prepare(sql).run(...params);
      });
      assertProjectionWriteChangedOne(result);
    },
  };
}

function assertProjectionWriteChangedOne(result: ProjectionWriteResult): void {
  if (result.changes !== 1) {
    throw new Error(
      `expected projection write to change one row but changed ${result.changes}`,
    );
  }
}

function createProjectionUpdateWhereBuilder<TTable>(
  scope: LedgerStorageScope,
  table: ProjectionTableMetadata,
  updateAssignments: readonly ProjectionUpdateAssignment[],
  whereClauses: readonly ProjectionWhereClause[],
  trackWrite: ProjectionWriteTracker,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionUpdateWhereBuilder<TTable> {
  const executable = () => {
    const sql = buildUpdateSql(
      statementCompiler,
      table,
      updateAssignments,
      whereClauses,
    );
    return createProjectionExecutableWrite(
      scope,
      sql.text,
      sql.params,
      trackWrite,
    );
  };

  return {
    execute: () => executable().execute(),
    executeExpectingOne: () => executable().executeExpectingOne(),
    whereAny: (conditions) => {
      return createProjectionUpdateWhereBuilder(
        scope,
        table,
        updateAssignments,
        [...whereClauses, createProjectionAnyWhereClause(table, conditions)],
        trackWrite,
        statementCompiler,
      );
    },
    where: (columnName, operator, value) => {
      return createProjectionUpdateWhereBuilder(
        scope,
        table,
        updateAssignments,
        [
          ...whereClauses,
          createProjectionComparisonWhereClause(
            table,
            String(columnName),
            operator,
            value,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
    whereIn: (columnName, values) => {
      return createProjectionUpdateWhereBuilder(
        scope,
        table,
        updateAssignments,
        [
          ...whereClauses,
          createProjectionInWhereClause(
            table,
            String(columnName),
            values,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
    whereNotNull: (columnName) => {
      return createProjectionUpdateWhereBuilder(
        scope,
        table,
        updateAssignments,
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            table,
            String(columnName),
            true,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
    whereNull: (columnName) => {
      return createProjectionUpdateWhereBuilder(
        scope,
        table,
        updateAssignments,
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            table,
            String(columnName),
            false,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
  };
}

function createProjectionDeleteBuilder<TTable>(
  scope: LedgerStorageScope,
  table: ProjectionTableMetadata,
  whereClauses: readonly ProjectionWhereClause[],
  trackWrite: ProjectionWriteTracker,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionDeleteBuilder<TTable> {
  const executable = () => {
    const sql = buildDeleteSql(statementCompiler, table, whereClauses);
    return createProjectionExecutableWrite(
      scope,
      sql.text,
      sql.params,
      trackWrite,
    );
  };

  return {
    execute: () => executable().execute(),
    executeExpectingOne: () => executable().executeExpectingOne(),
    whereAny: (conditions) => {
      return createProjectionDeleteBuilder(
        scope,
        table,
        [...whereClauses, createProjectionAnyWhereClause(table, conditions)],
        trackWrite,
        statementCompiler,
      );
    },
    where: (columnName, operator, value) => {
      return createProjectionDeleteBuilder(
        scope,
        table,
        [
          ...whereClauses,
          createProjectionComparisonWhereClause(
            table,
            String(columnName),
            operator,
            value,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
    whereIn: (columnName, values) => {
      return createProjectionDeleteBuilder(
        scope,
        table,
        [
          ...whereClauses,
          createProjectionInWhereClause(
            table,
            String(columnName),
            values,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
    whereNotNull: (columnName) => {
      return createProjectionDeleteBuilder(
        scope,
        table,
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            table,
            String(columnName),
            true,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
    whereNull: (columnName) => {
      return createProjectionDeleteBuilder(
        scope,
        table,
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            table,
            String(columnName),
            false,
            null,
          ),
        ],
        trackWrite,
        statementCompiler,
      );
    },
  };
}

function createProjectionReadDatabase<
  TProjectionSchema extends AnyProjectionSchema,
  TEvents extends Record<string, TSchema>,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  events: TEvents,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionReadDatabase<TProjectionSchema, TEvents> {
  return {
    readEvent: async (ref) => {
      return await readProjectionEvent(scope, events, ref, statementCompiler);
    },
    readEvents: async (refs) => {
      return await readProjectionEvents(scope, events, refs, statementCompiler);
    },
    selectFrom: (tableName) => {
      const table = readProjectionTable(metadata, String(tableName));

      return {
        aggregate: () => {
          return createProjectionAggregateBuilder(
            metadata,
            scope,
            table,
            [],
            [],
            statementCompiler,
          );
        },
        innerJoin: (joinedTableName, condition) => {
          const joinedTable = readProjectionTable(
            metadata,
            String(joinedTableName),
          );
          const joinClause = createProjectionInnerJoinClause(
            table,
            joinedTable,
            String(condition.fromColumn),
            String(condition.toColumn),
          );

          return createProjectionJoinedSelectBuilder(
            metadata,
            scope,
            table,
            [joinClause],
            statementCompiler,
          );
        },
        select: (columns) => {
          validateProjectionColumns("selected columns", table, columns);

          return createProjectionExecutableSelect(
            metadata,
            scope,
            table,
            table,
            columns,
            columns.map((columnName) =>
              createProjectionColumnReference(null, String(columnName)),
            ),
            [],
            [],
            [],
            null,
            statementCompiler,
          );
        },
      };
    },
  };
}

type ProjectionWhereClause = ProjectionCompilerWhereClause;

type ProjectionOrderClause = ProjectionCompilerOrderClause;

type ProjectionColumnReference = ProjectionCompilerColumnReference;

type ProjectionJoinClause = ProjectionCompilerJoinClause;

type ProjectionAggregate = ProjectionCompilerAggregate;

type CompiledProjectionSql = ProjectionCompiledSql;

type ProjectionUpdateAssignment = ProjectionCompilerAssignment;

function createProjectionAggregateBuilder<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TTable,
  TResult,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  table: ProjectionTableMetadata,
  aggregates: readonly ProjectionAggregate[],
  whereClauses: readonly ProjectionWhereClause[],
  statementCompiler: ProjectionStatementCompiler,
): ProjectionAggregateBuilder<TTable, TResult, TTables, TFromTableName> {
  const createNext = <TNextResult>(
    nextAggregates: readonly ProjectionAggregate[],
    nextWhereClauses: readonly ProjectionWhereClause[],
  ) => {
    return createProjectionAggregateBuilder<
      TTables,
      TFromTableName,
      TTable,
      TNextResult
    >(
      metadata,
      scope,
      table,
      nextAggregates,
      nextWhereClauses,
      statementCompiler,
    );
  };

  return {
    count: (alias) => {
      validateProjectionAggregateAlias(alias, aggregates);

      return createNext<TResult & { readonly [TKey in typeof alias]: number }>(
        [
          ...aggregates,
          {
            alias,
            kind: "count",
          },
        ],
        whereClauses,
      );
    },
    countNotNull: (alias, columnName) => {
      validateProjectionAggregateAlias(alias, aggregates);
      validateProjectionColumns("aggregate column", table, [
        String(columnName),
      ]);

      return createNext<TResult & { readonly [TKey in typeof alias]: number }>(
        [
          ...aggregates,
          {
            alias,
            column: createProjectionColumnReference(null, String(columnName)),
            kind: "count_not_null",
          },
        ],
        whereClauses,
      );
    },
    max: (alias, columnName) => {
      const aggregateColumnName = String(columnName);
      validateProjectionAggregateAlias(alias, aggregates);
      validateProjectionAggregateIntegerColumn(table, aggregateColumnName);

      return createNext<
        TResult & {
          readonly [TKey in typeof alias]: ProjectionIntegerAggregateValue<
            TTable,
            typeof columnName
          >;
        }
      >(
        [
          ...aggregates,
          {
            alias,
            column: createProjectionColumnReference(null, aggregateColumnName),
            kind: "max",
          },
        ],
        whereClauses,
      );
    },
    min: (alias, columnName) => {
      const aggregateColumnName = String(columnName);
      validateProjectionAggregateAlias(alias, aggregates);
      validateProjectionAggregateIntegerColumn(table, aggregateColumnName);

      return createNext<
        TResult & {
          readonly [TKey in typeof alias]: ProjectionIntegerAggregateValue<
            TTable,
            typeof columnName
          >;
        }
      >(
        [
          ...aggregates,
          {
            alias,
            column: createProjectionColumnReference(null, aggregateColumnName),
            kind: "min",
          },
        ],
        whereClauses,
      );
    },
    execute: async () => {
      const sql = buildAggregateSql(
        statementCompiler,
        table,
        aggregates,
        whereClauses,
      );
      const row = await scope.prepare(sql.text).get(...sql.params);

      if (row === undefined) {
        throw new Error("aggregate query did not return a row");
      }

      return decodeProjectionAggregateRow(
        aggregates,
        row,
      ) as unknown as TResult;
    },
    whereAny: (conditions) => {
      return createNext<TResult>(aggregates, [
        ...whereClauses,
        createProjectionAnyWhereClause(table, conditions),
      ]);
    },
    whereNotExists: (tableName, condition) => {
      const existenceTable = readProjectionTable(metadata, String(tableName));

      return createNext<TResult>(aggregates, [
        ...whereClauses,
        createProjectionNotExistsWhereClause(
          table,
          existenceTable,
          String(condition.fromColumn),
          String(condition.toColumn),
        ),
      ]);
    },
    where: (columnName, operator, value) => {
      return createNext<TResult>(aggregates, [
        ...whereClauses,
        createProjectionComparisonWhereClause(
          table,
          String(columnName),
          operator,
          value,
          null,
        ),
      ]);
    },
    whereIn: (columnName, values) => {
      return createNext<TResult>(aggregates, [
        ...whereClauses,
        createProjectionInWhereClause(table, String(columnName), values, null),
      ]);
    },
    whereNotNull: (columnName) => {
      return createNext<TResult>(aggregates, [
        ...whereClauses,
        createProjectionNullWhereClause(table, String(columnName), true, null),
      ]);
    },
    whereNull: (columnName) => {
      return createNext<TResult>(aggregates, [
        ...whereClauses,
        createProjectionNullWhereClause(table, String(columnName), false, null),
      ]);
    },
  };
}

function createProjectionJoinedSelectBuilder<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TJoinedTableName extends ProjectionTableName<TTables>,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  fromTable: ProjectionTableMetadata,
  joinClauses: readonly ProjectionJoinClause[],
  statementCompiler: ProjectionStatementCompiler,
): ProjectionJoinedSelectBuilder<TTables, TFromTableName, TJoinedTableName> {
  return {
    selectFrom: (tableName, columns) => {
      const selectedTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );
      validateProjectionColumns("selected columns", selectedTable, columns);

      return createProjectionExecutableJoinedSelect(
        metadata,
        scope,
        fromTable,
        selectedTable,
        columns,
        columns.map((columnName) =>
          createProjectionColumnReference(
            selectedTable.name,
            String(columnName),
          ),
        ),
        joinClauses,
        [],
        [],
        null,
        statementCompiler,
      );
    },
  };
}

function createProjectionExecutableSelect<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TTable,
  const TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  fromTable: ProjectionTableMetadata,
  table: ProjectionTableMetadata,
  selectedColumns: TColumnNames,
  selectedColumnReferences: readonly ProjectionColumnReference[],
  joinClauses: readonly ProjectionJoinClause[],
  whereClauses: readonly ProjectionWhereClause[],
  orderClauses: readonly ProjectionOrderClause[],
  limitClause: number | null,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionExecutableSelect<TTable, TColumnNames, TTables, TFromTableName> {
  return {
    limit: (limit) => {
      validateProjectionLimit(limit);
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        limit,
        statementCompiler,
      );
    },
    orderBy: (columnName, direction = "asc") => {
      validateProjectionColumns("order column", table, [String(columnName)]);
      validateProjectionOrderDirection(direction);

      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        [
          ...orderClauses,
          {
            column: createProjectionColumnReference(null, String(columnName)),
            direction,
            kind: "column",
          },
        ],
        limitClause,
        statementCompiler,
      );
    },
    orderByList: (columnName, values) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        [
          ...orderClauses,
          createProjectionValueListOrderClause(
            table,
            String(columnName),
            values,
            null,
          ),
        ],
        limitClause,
        statementCompiler,
      );
    },
    orderByNulls: (columnName, order) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        [
          ...orderClauses,
          createProjectionNullOrderClause(
            table,
            String(columnName),
            order,
            null,
          ),
        ],
        limitClause,
        statementCompiler,
      );
    },
    whereAny: (conditions) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        [...whereClauses, createProjectionAnyWhereClause(table, conditions)],
        orderClauses,
        limitClause,
        statementCompiler,
      );
    },
    whereNotExists: (tableName, condition) => {
      const existenceTable = readProjectionTable(metadata, String(tableName));

      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        [
          ...whereClauses,
          createProjectionNotExistsWhereClause(
            fromTable,
            existenceTable,
            String(condition.fromColumn),
            String(condition.toColumn),
          ),
        ],
        orderClauses,
        limitClause,
        statementCompiler,
      );
    },
    where: (columnName, operator, value) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        [
          ...whereClauses,
          createProjectionComparisonWhereClause(
            table,
            String(columnName),
            operator,
            value,
            null,
          ),
        ],
        orderClauses,
        limitClause,
        statementCompiler,
      );
    },
    whereIn: (columnName, values) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        [
          ...whereClauses,
          createProjectionInWhereClause(
            table,
            String(columnName),
            values,
            null,
          ),
        ],
        orderClauses,
        limitClause,
        statementCompiler,
      );
    },
    whereNotNull: (columnName) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            table,
            String(columnName),
            true,
            null,
          ),
        ],
        orderClauses,
        limitClause,
        statementCompiler,
      );
    },
    whereNull: (columnName) => {
      return createProjectionExecutableSelect(
        metadata,
        scope,
        fromTable,
        table,
        selectedColumns,
        selectedColumnReferences,
        joinClauses,
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            table,
            String(columnName),
            false,
            null,
          ),
        ],
        orderClauses,
        limitClause,
        statementCompiler,
      );
    },
    execute: async () => {
      const sql = buildSelectSql(
        statementCompiler,
        fromTable,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        limitClause,
      );
      const rows = await scope.prepare(sql.text).all(...sql.params);

      const decodedRows = rows.map((row) => {
        return decodeProjectionSelectedRow(table, selectedColumns, row);
      });

      return decodedRows as unknown as readonly ProjectionSelectedRow<
        TTable,
        TColumnNames
      >[];
    },
    executeTakeFirst: async () => {
      const sql = buildSelectSql(
        statementCompiler,
        fromTable,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        1,
      );
      const row = await scope.prepare(sql.text).get(...sql.params);

      if (row === undefined) {
        return null;
      }

      return decodeProjectionSelectedRow(
        table,
        selectedColumns,
        row,
      ) as ProjectionSelectedRow<TTable, TColumnNames>;
    },
    stream: async function* () {
      const sql = buildSelectSql(
        statementCompiler,
        fromTable,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        limitClause,
      );
      const rows = await scope.prepare(sql.text).all(...sql.params);

      for (const row of rows) {
        yield decodeProjectionSelectedRow(
          table,
          selectedColumns,
          row,
        ) as ProjectionSelectedRow<TTable, TColumnNames>;
      }
    },
  };
}

function createProjectionExecutableJoinedSelect<
  TTables,
  TTableNames extends ProjectionTableName<TTables>,
  TSelectedTableName extends TTableNames,
  const TColumnNames extends readonly ProjectionTableColumnName<
    TTables[TSelectedTableName]
  >[],
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
  fromTable: ProjectionTableMetadata,
  table: ProjectionTableMetadata,
  selectedColumns: TColumnNames,
  selectedColumnReferences: readonly ProjectionColumnReference[],
  joinClauses: readonly ProjectionJoinClause[],
  whereClauses: readonly ProjectionWhereClause[],
  orderClauses: readonly ProjectionOrderClause[],
  limitClause: number | null,
  statementCompiler: ProjectionStatementCompiler,
): ProjectionExecutableJoinedSelect<
  TTables,
  TTableNames,
  TSelectedTableName,
  TColumnNames
> {
  const createNext = (
    nextWhereClauses: readonly ProjectionWhereClause[],
    nextOrderClauses: readonly ProjectionOrderClause[],
    nextLimitClause: number | null,
  ) => {
    return createProjectionExecutableJoinedSelect<
      TTables,
      TTableNames,
      TSelectedTableName,
      TColumnNames
    >(
      metadata,
      scope,
      fromTable,
      table,
      selectedColumns,
      selectedColumnReferences,
      joinClauses,
      nextWhereClauses,
      nextOrderClauses,
      nextLimitClause,
      statementCompiler,
    );
  };

  return {
    limit: (limit) => {
      validateProjectionLimit(limit);

      return createNext(whereClauses, orderClauses, limit);
    },
    orderBy: (tableName, columnName, direction = "asc") => {
      const orderTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );
      validateProjectionColumns("order column", orderTable, [
        String(columnName),
      ]);
      validateProjectionOrderDirection(direction);

      return createNext(
        whereClauses,
        [
          ...orderClauses,
          {
            column: createProjectionColumnReference(
              orderTable.name,
              String(columnName),
            ),
            direction,
            kind: "column",
          },
        ],
        limitClause,
      );
    },
    orderByList: (tableName, columnName, values) => {
      const orderTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );

      return createNext(
        whereClauses,
        [
          ...orderClauses,
          createProjectionValueListOrderClause(
            orderTable,
            String(columnName),
            values,
            orderTable.name,
          ),
        ],
        limitClause,
      );
    },
    orderByNulls: (tableName, columnName, order) => {
      const orderTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );

      return createNext(
        whereClauses,
        [
          ...orderClauses,
          createProjectionNullOrderClause(
            orderTable,
            String(columnName),
            order,
            orderTable.name,
          ),
        ],
        limitClause,
      );
    },
    whereAny: (conditions) => {
      return createNext(
        [
          ...whereClauses,
          createProjectionQualifiedAnyWhereClause(
            metadata,
            fromTable,
            joinClauses,
            conditions,
          ),
        ],
        orderClauses,
        limitClause,
      );
    },
    where: (tableName, columnName, operator, value) => {
      const whereTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );

      return createNext(
        [
          ...whereClauses,
          createProjectionComparisonWhereClause(
            whereTable,
            String(columnName),
            operator,
            value,
            whereTable.name,
          ),
        ],
        orderClauses,
        limitClause,
      );
    },
    whereIn: (tableName, columnName, values) => {
      const whereTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );

      return createNext(
        [
          ...whereClauses,
          createProjectionInWhereClause(
            whereTable,
            String(columnName),
            values,
            whereTable.name,
          ),
        ],
        orderClauses,
        limitClause,
      );
    },
    whereNotNull: (tableName, columnName) => {
      const whereTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );

      return createNext(
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            whereTable,
            String(columnName),
            true,
            whereTable.name,
          ),
        ],
        orderClauses,
        limitClause,
      );
    },
    whereNull: (tableName, columnName) => {
      const whereTable = readProjectionJoinedTable(
        metadata,
        fromTable,
        joinClauses,
        String(tableName),
      );

      return createNext(
        [
          ...whereClauses,
          createProjectionNullWhereClause(
            whereTable,
            String(columnName),
            false,
            whereTable.name,
          ),
        ],
        orderClauses,
        limitClause,
      );
    },
    execute: async () => {
      const sql = buildSelectSql(
        statementCompiler,
        fromTable,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        limitClause,
      );
      const rows = await scope.prepare(sql.text).all(...sql.params);

      return rows.map((row) => {
        return decodeProjectionSelectedRow(
          table,
          selectedColumns,
          row,
        ) as ProjectionSelectedRow<TTables[TSelectedTableName], TColumnNames>;
      });
    },
    executeTakeFirst: async () => {
      const sql = buildSelectSql(
        statementCompiler,
        fromTable,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        1,
      );
      const row = await scope.prepare(sql.text).get(...sql.params);

      if (row === undefined) {
        return null;
      }

      return decodeProjectionSelectedRow(
        table,
        selectedColumns,
        row,
      ) as ProjectionSelectedRow<TTables[TSelectedTableName], TColumnNames>;
    },
    stream: async function* () {
      const sql = buildSelectSql(
        statementCompiler,
        fromTable,
        selectedColumnReferences,
        joinClauses,
        whereClauses,
        orderClauses,
        limitClause,
      );
      const rows = await scope.prepare(sql.text).all(...sql.params);

      for (const row of rows) {
        yield decodeProjectionSelectedRow(
          table,
          selectedColumns,
          row,
        ) as ProjectionSelectedRow<TTables[TSelectedTableName], TColumnNames>;
      }
    },
  };
}

function resolveProjectionUpdateSet<TTable>(
  table: ProjectionTableMetadata,
  values: ProjectionUpdateSet<TTable>,
): ProjectionUpdateRow<TTable> {
  if (typeof values !== "function") {
    return values;
  }

  return values(createProjectionExpressionBuilder(table));
}

function resolveProjectionUpsertUpdateSet<TTable>(
  table: ProjectionTableMetadata,
  values: ProjectionUpsertUpdateSet<TTable>,
): ProjectionUpdateRow<TTable> {
  if (typeof values !== "function") {
    return values;
  }

  return values(createProjectionUpsertExpressionBuilder(table));
}

function createProjectionExpressionBuilder<TTable>(
  table: ProjectionTableMetadata,
): ProjectionExpressionBuilder<TTable> {
  return {
    add: (columnName, value) => {
      const stringColumnName = String(columnName);
      validateProjectionIntegerColumn("add column", table, stringColumnName);
      return createProjectionExpression({
        kind: "add",
        columnName: stringColumnName,
        value: createProjectionExpressionOperandMetadata(
          stringColumnName,
          value,
        ),
      });
    },
    coalesce: (columnName, value) => {
      const stringColumnName = String(columnName);
      validateProjectionColumns("coalesce column", table, [stringColumnName]);
      return createProjectionExpression({
        kind: "coalesce",
        columnName: stringColumnName,
        value: createProjectionExpressionOperandMetadata(
          stringColumnName,
          value,
        ),
      });
    },
    column: (columnName) => {
      const stringColumnName = String(columnName);
      validateProjectionColumns("expression column", table, [stringColumnName]);
      return createProjectionExpression({
        kind: "column",
        columnName: stringColumnName,
      });
    },
    max: (columnName, value) => {
      const stringColumnName = String(columnName);
      validateProjectionColumns("max column", table, [stringColumnName]);
      return createProjectionExpression({
        kind: "max",
        columnName: stringColumnName,
        value: createProjectionExpressionOperandMetadata(
          stringColumnName,
          value,
        ),
      });
    },
  };
}

function createProjectionUpsertExpressionBuilder<TTable>(
  table: ProjectionTableMetadata,
): ProjectionUpsertExpressionBuilder<TTable> {
  return {
    ...createProjectionExpressionBuilder(table),
    excluded: (columnName) => {
      const stringColumnName = String(columnName);
      validateProjectionColumns("excluded column", table, [stringColumnName]);
      return createProjectionExpression({
        kind: "excluded",
        columnName: stringColumnName,
      });
    },
  };
}

function createProjectionExpression<TValue>(
  metadata: ProjectionExpressionMetadata,
): ProjectionExpression<TValue> {
  return {
    [projectionExpressionBrand]: true,
    metadata,
  };
}

function createProjectionExpressionOperandMetadata(
  columnName: string,
  value: unknown,
): ProjectionExpressionOperandMetadata {
  if (isProjectionExpression(value)) {
    return value.metadata;
  }

  return {
    kind: "value",
    columnName,
    value,
  };
}

function isProjectionExpression(
  value: unknown,
): value is ProjectionExpression<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    (value as { readonly [projectionExpressionBrand]?: unknown })[
      projectionExpressionBrand
    ] === true
  );
}

function readProjectionUpdateAssignments(
  table: ProjectionTableMetadata,
  values: ProjectionUpdateRow<unknown>,
  allowExcluded: boolean,
): readonly ProjectionUpdateAssignment[] {
  const updateValuesByColumn = values as Readonly<Record<string, unknown>>;
  const updateColumns = validateProjectionWriteRow(
    "update values",
    table,
    updateValuesByColumn,
    false,
  );

  return updateColumns.map((columnName) => {
    const value = updateValuesByColumn[columnName];

    if (isProjectionExpression(value)) {
      return {
        columnName,
        value: compileProjectionExpression(
          table,
          value.metadata,
          allowExcluded,
        ),
      };
    }

    return {
      columnName,
      value: {
        kind: "value",
        value: serializeProjectionColumnValue(
          table.columns[columnName],
          value,
          `${table.name}.${columnName}`,
        ),
      },
    };
  });
}

function compileProjectionExpression(
  table: ProjectionTableMetadata,
  expression: ProjectionExpressionMetadata,
  allowExcluded: boolean,
): ProjectionCompilerExpression {
  switch (expression.kind) {
    case "add": {
      validateProjectionIntegerColumn(
        "add column",
        table,
        expression.columnName,
      );
      const value = compileProjectionExpressionOperand(
        table,
        expression.value,
        allowExcluded,
      );

      return {
        columnName: expression.columnName,
        kind: "add",
        value,
      };
    }
    case "coalesce": {
      validateProjectionColumns("coalesce column", table, [
        expression.columnName,
      ]);
      const value = compileProjectionExpressionOperand(
        table,
        expression.value,
        allowExcluded,
      );

      return {
        columnName: expression.columnName,
        kind: "coalesce",
        value,
      };
    }
    case "column":
      validateProjectionColumns("expression column", table, [
        expression.columnName,
      ]);
      return {
        columnName: expression.columnName,
        kind: "column",
      };
    case "excluded":
      if (!allowExcluded) {
        throw new Error(
          "excluded column expressions are only valid in upserts",
        );
      }

      validateProjectionColumns("excluded column", table, [
        expression.columnName,
      ]);
      return {
        columnName: expression.columnName,
        kind: "excluded",
      };
    case "max": {
      validateProjectionColumns("max column", table, [expression.columnName]);
      const value = compileProjectionExpressionOperand(
        table,
        expression.value,
        allowExcluded,
      );

      return {
        columnName: expression.columnName,
        kind: "max",
        value,
      };
    }
  }
}

function compileProjectionExpressionOperand(
  table: ProjectionTableMetadata,
  operand: ProjectionExpressionOperandMetadata,
  allowExcluded: boolean,
): ProjectionCompilerExpression {
  if (operand.kind !== "value") {
    return compileProjectionExpression(table, operand, allowExcluded);
  }

  validateProjectionColumns("expression value column", table, [
    operand.columnName,
  ]);

  return {
    kind: "value",
    value: serializeProjectionColumnValue(
      table.columns[operand.columnName],
      operand.value,
      `${table.name}.${operand.columnName}`,
    ),
  };
}

function validateProjectionIntegerColumn(
  label: string,
  table: ProjectionTableMetadata,
  columnName: string,
): void {
  validateProjectionColumns(label, table, [columnName]);

  if (table.columns[columnName]?.kind !== "integer") {
    throw new Error(
      `${label} ${table.name}.${columnName} must be an integer column`,
    );
  }
}

function buildInsertSql(
  statementCompiler: ProjectionStatementCompiler,
  table: ProjectionTableMetadata,
  insertColumns: readonly string[],
  conflict:
    | null
    | {
        readonly kind: "do_nothing";
        readonly conflictColumns: readonly string[];
      }
    | {
        readonly kind: "do_update";
        readonly conflictColumns: readonly string[];
        readonly updateAssignments: readonly ProjectionUpdateAssignment[];
      },
): CompiledProjectionSql {
  return statementCompiler.compileInsert({
    columns: insertColumns,
    conflict:
      conflict === null
        ? null
        : conflict.kind === "do_nothing"
          ? {
              conflictColumns: conflict.conflictColumns,
              kind: "do_nothing",
            }
          : {
              assignments: conflict.updateAssignments,
              conflictColumns: conflict.conflictColumns,
              kind: "do_update",
            },
    tableName: table.name,
  });
}

function buildSelectSql(
  statementCompiler: ProjectionStatementCompiler,
  table: ProjectionTableMetadata,
  selectedColumns: readonly ProjectionColumnReference[],
  joinClauses: readonly ProjectionJoinClause[],
  whereClauses: readonly ProjectionWhereClause[],
  orderClauses: readonly ProjectionOrderClause[],
  limitClause: number | null,
): CompiledProjectionSql {
  return statementCompiler.compileSelect({
    columns: selectedColumns,
    fromTableName: table.name,
    joins: joinClauses,
    limit: limitClause,
    orderBy: orderClauses,
    where: whereClauses,
  });
}

function buildAggregateSql(
  statementCompiler: ProjectionStatementCompiler,
  table: ProjectionTableMetadata,
  aggregates: readonly ProjectionAggregate[],
  whereClauses: readonly ProjectionWhereClause[],
): CompiledProjectionSql {
  return statementCompiler.compileAggregate({
    aggregates,
    fromTableName: table.name,
    where: whereClauses,
  });
}

function buildReadProjectionEventsSql(
  statementCompiler: ProjectionStatementCompiler,
  eventName: string,
  eventIds: readonly number[],
): CompiledProjectionSql {
  return statementCompiler.compileEventRead({
    eventIds,
    eventName,
  });
}

function buildUpdateSql(
  statementCompiler: ProjectionStatementCompiler,
  table: ProjectionTableMetadata,
  assignments: readonly ProjectionUpdateAssignment[],
  whereClauses: readonly ProjectionWhereClause[],
): CompiledProjectionSql {
  return statementCompiler.compileUpdate({
    assignments,
    tableName: table.name,
    where: whereClauses,
  });
}

function buildDeleteSql(
  statementCompiler: ProjectionStatementCompiler,
  table: ProjectionTableMetadata,
  whereClauses: readonly ProjectionWhereClause[],
): CompiledProjectionSql {
  return statementCompiler.compileDelete({
    tableName: table.name,
    where: whereClauses,
  });
}

function createProjectionAnyWhereClause<TTable>(
  table: ProjectionTableMetadata,
  conditions: readonly ProjectionWhereCondition<TTable>[],
): ProjectionWhereClause {
  if (conditions.length === 0) {
    throw new Error("any predicate group must include at least one condition");
  }

  return {
    clauses: conditions.map((condition) => {
      return createProjectionWhereClauseFromCondition(table, condition, null);
    }),
    kind: "any",
  };
}

function createProjectionWhereClauseFromCondition<TTable>(
  table: ProjectionTableMetadata,
  condition: ProjectionWhereCondition<TTable>,
  tableName: string | null,
): ProjectionWhereClause {
  switch (condition.kind) {
    case "comparison":
      return createProjectionComparisonWhereClause(
        table,
        String(condition.columnName),
        condition.operator,
        condition.value,
        tableName,
      );
    case "in":
      return createProjectionInWhereClause(
        table,
        String(condition.columnName),
        condition.values,
        tableName,
      );
    case "is_not_null":
      return createProjectionNullWhereClause(
        table,
        String(condition.columnName),
        true,
        tableName,
      );
    case "is_null":
      return createProjectionNullWhereClause(
        table,
        String(condition.columnName),
        false,
        tableName,
      );
  }
}

function createProjectionQualifiedAnyWhereClause<
  TTables,
  TTableNames extends ProjectionTableName<TTables>,
>(
  metadata: ProjectionSchemaMetadata,
  fromTable: ProjectionTableMetadata,
  joinClauses: readonly ProjectionJoinClause[],
  conditions: readonly ProjectionQualifiedWhereCondition<
    TTables,
    TTableNames
  >[],
): ProjectionWhereClause {
  if (conditions.length === 0) {
    throw new Error("any predicate group must include at least one condition");
  }

  return {
    clauses: conditions.map((condition) => {
      return createProjectionQualifiedWhereClauseFromCondition(
        metadata,
        fromTable,
        joinClauses,
        condition,
      );
    }),
    kind: "any",
  };
}

function createProjectionQualifiedWhereClauseFromCondition<
  TTables,
  TTableNames extends ProjectionTableName<TTables>,
>(
  metadata: ProjectionSchemaMetadata,
  fromTable: ProjectionTableMetadata,
  joinClauses: readonly ProjectionJoinClause[],
  condition: ProjectionQualifiedWhereCondition<TTables, TTableNames>,
): ProjectionWhereClause {
  const table = readProjectionJoinedTable(
    metadata,
    fromTable,
    joinClauses,
    String(condition.tableName),
  );

  switch (condition.kind) {
    case "comparison":
      return createProjectionComparisonWhereClause(
        table,
        String(condition.columnName),
        condition.operator,
        condition.value,
        table.name,
      );
    case "in":
      return createProjectionInWhereClause(
        table,
        String(condition.columnName),
        condition.values,
        table.name,
      );
    case "is_not_null":
      return createProjectionNullWhereClause(
        table,
        String(condition.columnName),
        true,
        table.name,
      );
    case "is_null":
      return createProjectionNullWhereClause(
        table,
        String(condition.columnName),
        false,
        table.name,
      );
  }
}

function createProjectionComparisonWhereClause(
  table: ProjectionTableMetadata,
  columnName: string,
  operator: ProjectionWhereOperator,
  value: unknown,
  tableName: string | null,
): ProjectionWhereClause {
  validateProjectionColumns("where column", table, [columnName]);
  validateProjectionWhereOperator(operator);

  return {
    column: createProjectionColumnReference(tableName, columnName),
    kind: "comparison",
    operator,
    value: serializeProjectionPredicateValue(table, columnName, value),
  };
}

function createProjectionInWhereClause(
  table: ProjectionTableMetadata,
  columnName: string,
  values: readonly unknown[],
  tableName: string | null,
): ProjectionWhereClause {
  validateProjectionColumns("where column", table, [columnName]);

  return {
    column: createProjectionColumnReference(tableName, columnName),
    kind: "in",
    values: values.map((value) => {
      return serializeProjectionPredicateValue(table, columnName, value);
    }),
  };
}

function serializeProjectionPredicateValue(
  table: ProjectionTableMetadata,
  columnName: string,
  value: unknown,
): unknown {
  const column = table.columns[columnName];

  if (value === null && column?.kind !== "json") {
    throw new Error(
      `${table.name}.${columnName} predicate value cannot be null; use whereNull or whereNotNull`,
    );
  }

  return serializeProjectionColumnValue(
    column,
    value,
    `${table.name}.${columnName}`,
  );
}

function createProjectionNullWhereClause(
  table: ProjectionTableMetadata,
  columnName: string,
  not: boolean,
  tableName: string | null,
): ProjectionWhereClause {
  validateProjectionColumns("where column", table, [columnName]);

  return {
    column: createProjectionColumnReference(tableName, columnName),
    kind: "null",
    not,
  };
}

function createProjectionValueListOrderClause(
  table: ProjectionTableMetadata,
  columnName: string,
  values: readonly unknown[],
  tableName: string | null,
): ProjectionOrderClause {
  validateProjectionColumns("order column", table, [columnName]);

  if (values.length === 0) {
    throw new Error("value-list order clause must include values");
  }

  return {
    column: createProjectionColumnReference(tableName, columnName),
    kind: "value_list",
    values: values.map((value) => {
      return serializeProjectionColumnValue(
        table.columns[columnName],
        value,
        `${table.name}.${columnName}`,
      );
    }),
  };
}

function createProjectionNullOrderClause(
  table: ProjectionTableMetadata,
  columnName: string,
  order: ProjectionNullOrder,
  tableName: string | null,
): ProjectionOrderClause {
  validateProjectionColumns("null order column", table, [columnName]);
  validateProjectionNullOrder(order);

  if (table.columns[columnName]?.nullable !== true) {
    throw new Error(
      `null order column ${table.name}.${columnName} must be nullable`,
    );
  }

  return {
    column: createProjectionColumnReference(tableName, columnName),
    kind: "nulls",
    order,
  };
}

function createProjectionNotExistsWhereClause(
  fromTable: ProjectionTableMetadata,
  existenceTable: ProjectionTableMetadata,
  fromColumn: string,
  toColumn: string,
): ProjectionWhereClause {
  if (fromTable.name === existenceTable.name) {
    throw new Error(
      `projection anti-join cannot target the same table ${fromTable.name}`,
    );
  }

  validateProjectionColumns("not-exists source column", fromTable, [
    fromColumn,
  ]);
  validateProjectionColumns("not-exists target column", existenceTable, [
    toColumn,
  ]);
  validateProjectionJoinColumns(
    fromTable,
    fromColumn,
    existenceTable,
    toColumn,
  );

  return {
    innerColumn: createProjectionColumnReference(existenceTable.name, toColumn),
    kind: "not_exists",
    outerColumn: createProjectionColumnReference(fromTable.name, fromColumn),
    tableName: existenceTable.name,
  };
}

function createProjectionColumnReference(
  tableName: string | null,
  columnName: string,
): ProjectionColumnReference {
  return {
    columnName,
    tableName,
  };
}

function createProjectionInnerJoinClause(
  fromTable: ProjectionTableMetadata,
  joinedTable: ProjectionTableMetadata,
  fromColumn: string,
  toColumn: string,
): ProjectionJoinClause {
  if (fromTable.name === joinedTable.name) {
    throw new Error(
      `projection inner join cannot target the same table ${fromTable.name}`,
    );
  }

  validateProjectionColumns("join source column", fromTable, [fromColumn]);
  validateProjectionColumns("join target column", joinedTable, [toColumn]);
  validateProjectionJoinColumns(fromTable, fromColumn, joinedTable, toColumn);

  return {
    kind: "inner",
    left: createProjectionColumnReference(fromTable.name, fromColumn),
    right: createProjectionColumnReference(joinedTable.name, toColumn),
    tableName: joinedTable.name,
  };
}

function readProjectionJoinedTable(
  metadata: ProjectionSchemaMetadata,
  fromTable: ProjectionTableMetadata,
  joinClauses: readonly ProjectionJoinClause[],
  tableName: string,
): ProjectionTableMetadata {
  if (
    tableName !== fromTable.name &&
    !joinClauses.some((joinClause) => joinClause.tableName === tableName)
  ) {
    throw new Error(`projection join does not include table ${tableName}`);
  }

  return readProjectionTable(metadata, tableName);
}

function readProjectionTable(
  metadata: ProjectionSchemaMetadata,
  tableName: string,
): ProjectionTableMetadata {
  const table = metadata.tables[tableName];

  if (table === undefined) {
    throw new Error(`unknown projection table ${tableName}`);
  }

  return table;
}

function validateProjectionWriteRow(
  context: string,
  table: ProjectionTableMetadata,
  row: Readonly<Record<string, unknown>>,
  requireAllColumns: boolean,
): readonly string[] {
  const columns = Object.keys(row);

  if (columns.length === 0) {
    throw new Error(`${context} must include at least one column`);
  }

  for (const columnName of columns) {
    if (table.columns[columnName] === undefined) {
      throw new Error(`${context} references unknown column ${columnName}`);
    }
  }

  if (!requireAllColumns) {
    return columns;
  }

  for (const columnName of Object.keys(table.columns)) {
    if (!Object.hasOwn(row, columnName)) {
      throw new Error(`${context} missing required column ${columnName}`);
    }
  }

  return Object.keys(table.columns);
}

function validateProjectionColumns(
  context: string,
  table: ProjectionTableMetadata,
  columns: readonly string[],
): void {
  if (columns.length === 0) {
    throw new Error(`${context} must include at least one column`);
  }

  for (const columnName of columns) {
    if (table.columns[columnName] === undefined) {
      throw new Error(`${context} references unknown column ${columnName}`);
    }
  }
}

function validateProjectionJoinColumns(
  fromTable: ProjectionTableMetadata,
  fromColumnName: string,
  joinedTable: ProjectionTableMetadata,
  joinedColumnName: string,
): void {
  const fromColumn = fromTable.columns[fromColumnName];
  const joinedColumn = joinedTable.columns[joinedColumnName];

  if (fromColumn === undefined || joinedColumn === undefined) {
    throw new Error("join columns must reference known columns");
  }

  if (
    fromColumn.kind !== joinedColumn.kind ||
    fromColumn.eventName !== joinedColumn.eventName
  ) {
    throw new Error("join columns must have compatible types");
  }
}

function validateProjectionKey(
  context: string,
  table: ProjectionTableMetadata,
  columns: readonly string[],
): void {
  validateProjectionColumns(context, table, columns);

  const keyExists = table.keys.some((key) => {
    return equalColumnLists(key.columns, columns);
  });

  if (!keyExists) {
    throw new Error(`${context} must reference a primary or unique key`);
  }
}

function validateProjectionAggregateAlias(
  alias: string,
  aggregates: readonly ProjectionAggregate[],
): void {
  if (alias.length === 0) {
    throw new Error("projection aggregate alias must not be empty");
  }

  const normalizedAlias = alias.toLocaleLowerCase("en-US");
  const existing = aggregates.find((aggregate) => {
    return aggregate.alias.toLocaleLowerCase("en-US") === normalizedAlias;
  });

  if (existing !== undefined) {
    throw new Error(
      `projection aggregate alias ${alias} conflicts with ${existing.alias}`,
    );
  }
}

function validateProjectionAggregateIntegerColumn(
  table: ProjectionTableMetadata,
  columnName: string,
): void {
  validateProjectionColumns("aggregate column", table, [columnName]);

  if (table.columns[columnName]?.kind !== "integer") {
    throw new Error(
      `aggregate column ${columnName} must reference an integer column`,
    );
  }
}

function validateProjectionLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("projection limit must be a non-negative safe integer");
  }
}

function validateProjectionOrderDirection(
  direction: ProjectionOrderDirection,
): void {
  if (direction !== "asc" && direction !== "desc") {
    throw new Error(`unsupported projection order direction ${direction}`);
  }
}

function validateProjectionNullOrder(order: ProjectionNullOrder): void {
  if (order !== "first" && order !== "last") {
    throw new Error(`unsupported projection null order ${order}`);
  }
}

function validateProjectionWhereOperator(
  operator: ProjectionWhereOperator,
): void {
  switch (operator) {
    case "!=":
    case "<":
    case "<=":
    case "=":
    case ">":
    case ">=":
      return;
  }

  throw new Error(`unsupported projection where operator ${operator}`);
}

function serializeProjectionColumnValue(
  column: ProjectionColumnMetadata | undefined,
  value: unknown,
  context: string,
): unknown {
  if (column === undefined) {
    throw new Error(`${context} references unknown column metadata`);
  }

  if (column.kind === "json") {
    return serializeJson(value, context);
  }

  if (value === null) {
    if (!column.nullable) {
      throw new Error(`${context} cannot be null`);
    }

    return null;
  }

  switch (column.kind) {
    case "boolean":
      return serializeBoolean(value, context);
    case "event_ref":
      return serializeEventRef(column, value, context);
    case "integer":
      return serializeNumber(value, context);
    case "text":
      return serializeString(value, context);
  }
}

async function readProjectionEvent<
  TEvents extends Record<string, TSchema>,
  TEventName extends Extract<keyof TEvents, string>,
>(
  scope: LedgerStorageScope,
  events: TEvents,
  ref: EventRef<TEventName>,
  statementCompiler: ProjectionStatementCompiler,
): Promise<EventEnvelope<TEvents, TEventName> | null> {
  const eventResults = await readProjectionEvents(
    scope,
    events,
    [ref],
    statementCompiler,
  );

  return eventResults[0] ?? null;
}

type ProjectionEventReadGroup<TEventName extends string> = {
  readonly eventName: TEventName;
  readonly eventIds: number[];
  readonly seenEventIds: Set<number>;
};

type AnyProjectionEventEnvelope<TEvents extends Record<string, TSchema>> =
  EventEnvelope<TEvents, Extract<keyof TEvents, string>>;

async function readProjectionEvents<
  TEvents extends Record<string, TSchema>,
  TEventName extends Extract<keyof TEvents, string>,
>(
  scope: LedgerStorageScope,
  events: TEvents,
  refs: readonly EventRef<TEventName>[],
  statementCompiler: ProjectionStatementCompiler,
): Promise<readonly (EventEnvelope<TEvents, TEventName> | null)[]> {
  const normalizedRefs = refs.map((ref) => {
    return validateProjectionEventRef(events, ref);
  });

  if (normalizedRefs.length === 0) {
    return [];
  }

  const groups = new Map<TEventName, ProjectionEventReadGroup<TEventName>>();

  for (const ref of normalizedRefs) {
    let group = groups.get(ref.eventName);

    if (group === undefined) {
      group = {
        eventIds: [],
        eventName: ref.eventName,
        seenEventIds: new Set<number>(),
      };
      groups.set(ref.eventName, group);
    }

    if (!group.seenEventIds.has(ref.eventId)) {
      group.eventIds.push(ref.eventId);
      group.seenEventIds.add(ref.eventId);
    }
  }

  const eventsByRef = new Map<string, AnyProjectionEventEnvelope<TEvents>>();

  for (const group of groups.values()) {
    const eventSchema = events[group.eventName];

    if (eventSchema === undefined) {
      throw new Error(
        `projection event ref references unknown event ${group.eventName}`,
      );
    }

    for (
      let offset = 0;
      offset < group.eventIds.length;
      offset += maxProjectionEventReadIdsPerStatement
    ) {
      const eventIds = group.eventIds.slice(
        offset,
        offset + maxProjectionEventReadIdsPerStatement,
      );
      const sql = buildReadProjectionEventsSql(
        statementCompiler,
        group.eventName,
        eventIds,
      );
      const rows = await scope.prepare(sql.text).all(...sql.params);

      for (const row of rows) {
        const event = decodeProjectionEventRow(
          eventSchema,
          group.eventName,
          row,
        ) as AnyProjectionEventEnvelope<TEvents>;
        eventsByRef.set(
          createProjectionEventReadKey(event.eventName, event.eventId),
          event,
        );
      }
    }
  }

  return normalizedRefs.map((ref) => {
    return (
      eventsByRef.get(
        createProjectionEventReadKey(ref.eventName, ref.eventId),
      ) ?? null
    );
  }) as readonly (EventEnvelope<TEvents, TEventName> | null)[];
}

function validateProjectionEventRef<
  TEvents extends Record<string, TSchema>,
  TEventName extends Extract<keyof TEvents, string>,
>(events: TEvents, ref: EventRef<TEventName>): EventRef<TEventName> {
  if (events[ref.eventName] === undefined) {
    throw new Error(
      `projection event ref references unknown event ${ref.eventName}`,
    );
  }

  createEventRef(ref.eventName, ref.eventId);

  return ref;
}

function decodeProjectionEventRow<
  TEventName extends string,
  TEventSchema extends TSchema,
>(
  eventSchema: TEventSchema,
  eventName: TEventName,
  row: LedgerStorageRow,
): EventEnvelope<Record<TEventName, TEventSchema>, TEventName> {
  const decodedRow = Value.Decode(ProjectionEventRowSchema, row);

  if (decodedRow.event_name !== eventName) {
    throw new Error(
      `projection event ref expected ${eventName} but storage returned ${decodedRow.event_name}`,
    );
  }

  const payload = Value.Decode(
    eventSchema,
    parseJson(decodedRow.payload_json, "events.payload_json"),
  ) as Static<TEventSchema>;
  const typedRef = createEventRef(eventName, decodedRow.event_id) as EventRef<
    Extract<TEventName, string>
  >;

  return {
    causationEventId: decodedRow.causation_event_id,
    dedupeKey: decodedRow.dedupe_key,
    eventId: decodedRow.event_id,
    eventName,
    payload,
    ref: typedRef,
    tsMs: decodedRow.ts_ms,
  };
}

function createProjectionEventReadKey(
  eventName: string,
  eventId: number,
): string {
  return `${eventName}\u0000${eventId}`;
}

function decodeProjectionSelectedRow(
  table: ProjectionTableMetadata,
  selectedColumns: readonly string[],
  row: LedgerStorageRow,
): Readonly<Record<string, unknown>> {
  const decoded: Record<string, unknown> = {};

  for (const columnName of selectedColumns) {
    decoded[columnName] = decodeProjectionColumnValue(
      table.columns[columnName],
      row[columnName],
      `${table.name}.${columnName}`,
    );
  }

  return decoded;
}

function decodeProjectionAggregateRow(
  aggregates: readonly ProjectionAggregate[],
  row: LedgerStorageRow,
): Readonly<Record<string, unknown>> {
  const decoded: Record<string, unknown> = {};

  for (const aggregate of aggregates) {
    const value = row[aggregate.alias];

    switch (aggregate.kind) {
      case "count":
      case "count_not_null":
        decoded[aggregate.alias] = decodeProjectionStoredIntegerAggregate(
          aggregate.alias,
          value,
        );
        break;
      case "max":
      case "min":
        decoded[aggregate.alias] =
          value === null
            ? null
            : decodeProjectionStoredIntegerAggregate(aggregate.alias, value);
        break;
    }
  }

  return decoded;
}

function decodeProjectionStoredIntegerAggregate(
  alias: string,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`projection aggregate ${alias} must be a stored integer`);
  }

  return value;
}

function decodeProjectionColumnValue(
  column: ProjectionColumnMetadata | undefined,
  value: unknown,
  context: string,
): unknown {
  if (column === undefined) {
    throw new Error(`${context} references unknown column metadata`);
  }

  if (value === null) {
    if (!column.nullable) {
      throw new Error(`${context} cannot be null`);
    }

    return null;
  }

  if (value === undefined) {
    throw new Error(`${context} was not returned by projection query`);
  }

  switch (column.kind) {
    case "boolean":
      return decodeBoolean(value, context);
    case "event_ref":
      return decodeEventRef(column, value, context);
    case "integer":
      return decodeNumber(value, context);
    case "json":
      return parseJson(value, context);
    case "text":
      return decodeString(value, context);
  }
}

function serializeBoolean(value: unknown, context: string): number {
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean`);
  }

  return value ? 1 : 0;
}

function decodeBoolean(value: unknown, context: string): boolean {
  if (value === 0) {
    return false;
  }

  if (value === 1) {
    return true;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${context} must be a stored boolean`);
}

function serializeNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${context} must be a safe integer`);
  }

  return value;
}

function decodeNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${context} must be a stored integer`);
  }

  return value;
}

function serializeString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }

  return value;
}

function decodeString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a stored string`);
  }

  return value;
}

function serializeJson(value: unknown, context: string): string {
  validateJsonValue(value, context, new Set<object>());
  const serialized = JSON.stringify(value);

  if (typeof serialized !== "string") {
    throw new Error(`${context} must be JSON-serializable`);
  }

  return serialized;
}

function validateJsonValue(
  value: unknown,
  context: string,
  seen: Set<object>,
): void {
  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${context} must be a finite JSON number`);
      }

      return;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new Error(`${context} must be JSON-serializable`);
    case "object":
      validateJsonObject(value, context, seen);
      return;
  }
}

function validateJsonObject(
  value: object,
  context: string,
  seen: Set<object>,
): void {
  if (seen.has(value)) {
    throw new Error(`${context} must not contain circular JSON values`);
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      validateJsonArray(value, context, seen);
      return;
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${context} must be a plain JSON object`);
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${context} must not contain symbol keys`);
    }

    for (const [key, item] of Object.entries(
      value as Readonly<Record<string, unknown>>,
    )) {
      validateJsonValue(item, `${context}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function validateJsonArray(
  value: readonly unknown[],
  context: string,
  seen: Set<object>,
): void {
  for (let index = 0; index < value.length; index += 1) {
    validateJsonValue(value[index], `${context}[${index}]`, seen);
  }
}

function serializeEventRef(
  column: ProjectionColumnMetadata,
  value: unknown,
  context: string,
): number {
  if (column.eventName === null) {
    throw new Error(`${context} is missing event reference metadata`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an event reference`);
  }

  const ref = value as {
    readonly eventId?: unknown;
    readonly eventName?: unknown;
  };

  if (ref.eventName !== column.eventName) {
    throw new Error(`${context} must reference event ${column.eventName}`);
  }

  if (
    typeof ref.eventId !== "number" ||
    !Number.isSafeInteger(ref.eventId) ||
    ref.eventId <= 0
  ) {
    throw new Error(
      `${context} event reference id must be a positive safe integer`,
    );
  }

  return ref.eventId;
}

function decodeEventRef(
  column: ProjectionColumnMetadata,
  value: unknown,
  context: string,
): EventRef<string> {
  if (column.eventName === null) {
    throw new Error(`${context} is missing event reference metadata`);
  }

  const eventId = decodeNumber(value, context);

  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error(
      `${context} event reference id must be a positive safe integer`,
    );
  }

  return createEventRef(column.eventName, eventId);
}

function parseJson(value: unknown, context: string): unknown {
  if (typeof value !== "string") {
    throw new Error(`${context} must be stored JSON text`);
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`${context} contains invalid JSON`, {
      cause: error,
    });
  }
}

function equalColumnLists(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((columnName, index) => columnName === right[index]);
}
