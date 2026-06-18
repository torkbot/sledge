import type { Static, TSchema } from "typebox";

import {
  bindLedgerModel,
  defineLedgerModel,
  registerLedgerModel,
} from "./ledger.ts";
import type { EventRef } from "./event-ref.ts";
import { createEventRef } from "./event-ref.ts";
import type {
  BoundLedgerModel,
  DefinedLedgerModel,
  LedgerImplementations,
  LedgerIndexerContext,
  LedgerStorageRow,
  LedgerStorageScope,
  QuerySchema,
  RegisterFunction,
  RegisteredLedgerModel,
} from "./ledger.ts";
import {
  defineProjectionSchemaForEvents,
  type ProjectionColumnMetadata,
  type ProjectionColumnValue,
  type ProjectionRow,
  type ProjectionSchema,
  type ProjectionSchemaEventName,
  type ProjectionSchemaMetadata,
  type ProjectionSchemaTables,
  type ProjectionTableColumnName,
  type ProjectionTableColumns,
  type ProjectionTableFactories,
  type ProjectionTableKey,
  type ProjectionTableMetadata,
  type ProjectionTableName,
  type ProjectionTablesForFactories,
} from "./projections.ts";

type AnyQuerySchema = QuerySchema<TSchema, TSchema>;
type AnyProjectionSchema = {
  readonly metadata: ProjectionSchemaMetadata;
};

export type LedgerShape<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = {
  readonly events: TEvents;
  readonly queues: TQueues;
  readonly signals: TSignals;
  readonly signalQueues: TSignalQueues;
};

export type DefinedLedgerShape<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = {
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  withProjections<
    const TProjectionSchema extends AnyProjectionSchema,
    const TIndexerFactories extends
      ProjectionIndexerFactories<TProjectionSchema>,
    const TQueryFactories extends ProjectionQueryFactories<TProjectionSchema>,
  >(
    defineSchema: (
      builder: LedgerProjectionSchemaBuilder<Extract<keyof TEvents, string>>,
    ) => TProjectionSchema &
      ProjectionSchemaCompatibleWithEvents<
        Extract<keyof TEvents, string>,
        TProjectionSchema
      >,
    access: {
      readonly indexers: TIndexerFactories;
      readonly queries: TQueryFactories;
    },
  ): DefinedProjectedLedgerModel<
    TEvents,
    TQueues,
    TProjectionSchema,
    ProjectionIndexerSchemas<
      InferProjectionIndexerDefinitions<TIndexerFactories>
    >,
    ProjectionQuerySchemas<InferProjectionQueryDefinitions<TQueryFactories>>,
    TSignals,
    TSignalQueues
  >;
};

export function defineLedgerShape<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
>(input: {
  readonly events: TEvents;
  readonly queues: TQueues;
  readonly signals: TSignals;
  readonly signalQueues: TSignalQueues;
}): DefinedLedgerShape<TEvents, TQueues, TSignals, TSignalQueues> {
  const shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues> = {
    events: input.events,
    queues: input.queues,
    signals: input.signals,
    signalQueues: input.signalQueues,
  };

  return {
    shape,
    withProjections: (defineSchema, accessDefinition) => {
      const projections = defineSchema(
        createLedgerProjectionSchemaBuilder<Extract<keyof TEvents, string>>(),
      );
      const access = createProjectionAccess({
        projections,
        indexers: accessDefinition.indexers,
        queries: accessDefinition.queries,
      });

      return createProjectedLedgerModel({
        shape,
        access,
      });
    },
  };
}

export type LedgerProjectionSchemaBuilder<TEventName extends string> = {
  schema<const TFactories extends ProjectionTableFactories<TEventName>>(
    factories: TFactories,
  ): ProjectionSchema<ProjectionTablesForFactories<TFactories>, {}, TEventName>;
};

export type ProjectionIndexerEvent<TEventName extends string> = {
  readonly eventName: TEventName;
  readonly eventId: number;
  readonly ref: EventRef<TEventName>;
};

export type ProjectionWriteRow<TTable> = ProjectionRow<
  ProjectionTableColumns<TTable>
>;

export type ProjectionUpdateRow<TTable> = {
  readonly [TColumnName in ProjectionTableColumnName<TTable>]?: ProjectionColumnValue<
    ProjectionTableColumns<TTable>[TColumnName]
  >;
};

type ProjectionWhereValue<
  TTable,
  TColumnName extends ProjectionTableColumnName<TTable>,
> = NonNullable<
  ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
>;

export type ProjectionSelectedRow<
  TTable,
  TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
> = {
  readonly [TColumnName in TColumnNames[number]]: ProjectionColumnValue<
    ProjectionTableColumns<TTable>[TColumnName]
  >;
};

export type ProjectionInsertBuilder<TTable> = {
  values(
    row: ProjectionWriteRow<TTable>,
  ): ProjectionInsertConflictBuilder<TTable>;
};

export type ProjectionInsertConflictBuilder<TTable> = {
  execute(): Promise<void>;
  onConflict<const TColumns extends ProjectionTableKey<TTable>>(
    columns: TColumns,
  ): ProjectionInsertOnConflictBuilder<TTable>;
};

export type ProjectionInsertOnConflictBuilder<TTable> = {
  doNothing(): ProjectionExecutableWrite;
  doUpdateSet(values: ProjectionUpdateRow<TTable>): ProjectionExecutableWrite;
};

export type ProjectionExecutableWrite = {
  execute(): Promise<void>;
};

export type ProjectionWriteDatabase<
  TProjectionSchema extends AnyProjectionSchema,
> = {
  insertInto<
    const TTableName extends ProjectionTableName<
      ProjectionSchemaTables<TProjectionSchema>
    >,
  >(
    tableName: TTableName,
  ): ProjectionInsertBuilder<
    ProjectionSchemaTables<TProjectionSchema>[TTableName]
  >;
};

export type ProjectionSelectBuilder<TTable> = {
  select<
    const TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
  >(
    columns: TColumnNames,
  ): ProjectionExecutableSelect<TTable, TColumnNames>;
};

export type ProjectionExecutableSelect<
  TTable,
  TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
> = {
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: "=",
    value: ProjectionWhereValue<TTable, TColumnName>,
  ): ProjectionExecutableSelect<TTable, TColumnNames>;
  execute(): Promise<readonly ProjectionSelectedRow<TTable, TColumnNames>[]>;
  executeTakeFirst(): Promise<ProjectionSelectedRow<
    TTable,
    TColumnNames
  > | null>;
};

export type ProjectionReadDatabase<
  TProjectionSchema extends AnyProjectionSchema,
> = {
  selectFrom<
    const TTableName extends ProjectionTableName<
      ProjectionSchemaTables<TProjectionSchema>
    >,
  >(
    tableName: TTableName,
  ): ProjectionSelectBuilder<
    ProjectionSchemaTables<TProjectionSchema>[TTableName]
  >;
};

export type ProjectionIndexerRunInput<
  TProjectionSchema extends AnyProjectionSchema,
  TInputSchema extends TSchema,
  TSourceEventName extends ProjectionSchemaEventName<TProjectionSchema>,
> = {
  readonly input: Static<TInputSchema>;
  readonly event: ProjectionIndexerEvent<TSourceEventName>;
  readonly db: ProjectionWriteDatabase<TProjectionSchema>;
};

export type ProjectionIndexerDefinition<
  TProjectionSchema extends AnyProjectionSchema,
  TInputSchema extends TSchema,
  TSourceEventName extends ProjectionSchemaEventName<TProjectionSchema>,
> = {
  readonly input: TInputSchema;
  readonly sourceEventName: TSourceEventName;
  run(
    input: ProjectionIndexerRunInput<
      TProjectionSchema,
      TInputSchema,
      TSourceEventName
    >,
  ): void | Promise<void>;
};

type ProjectionIndexerDefinitionLike = {
  readonly input: TSchema;
  readonly sourceEventName: string;
  run(input: {
    readonly input: unknown;
    readonly event: ProjectionIndexerEvent<string>;
    readonly db: ProjectionWriteDatabase<AnyProjectionSchema>;
  }): void | Promise<void>;
};

type ProjectionIndexerFactories<TProjectionSchema extends AnyProjectionSchema> =
  Record<
    string,
    (
      builder: ProjectionIndexerBuilder<TProjectionSchema>,
    ) => ProjectionIndexerDefinitionLike
  >;

export type ProjectionIndexerBuilder<
  TProjectionSchema extends AnyProjectionSchema,
> = {
  sourceEvent<
    const TSourceEventName extends ProjectionSchemaEventName<TProjectionSchema>,
  >(
    eventName: TSourceEventName,
  ): ProjectionIndexerSourceBuilder<TProjectionSchema, TSourceEventName>;
};

export type ProjectionIndexerSourceBuilder<
  TProjectionSchema extends AnyProjectionSchema,
  TSourceEventName extends ProjectionSchemaEventName<TProjectionSchema>,
> = {
  input<const TInputSchema extends TSchema>(
    schema: TInputSchema,
  ): ProjectionIndexerInputBuilder<
    TProjectionSchema,
    TInputSchema,
    TSourceEventName
  >;
};

export type ProjectionIndexerInputBuilder<
  TProjectionSchema extends AnyProjectionSchema,
  TInputSchema extends TSchema,
  TSourceEventName extends ProjectionSchemaEventName<TProjectionSchema>,
> = {
  write(
    run: (
      input: ProjectionIndexerRunInput<
        TProjectionSchema,
        TInputSchema,
        TSourceEventName
      >,
    ) => void | Promise<void>,
  ): ProjectionIndexerDefinition<
    TProjectionSchema,
    TInputSchema,
    TSourceEventName
  >;
};

export type ProjectionQueryRunInput<
  TProjectionSchema extends AnyProjectionSchema,
  TParamsSchema extends TSchema,
> = {
  readonly params: Static<TParamsSchema>;
  readonly db: ProjectionReadDatabase<TProjectionSchema>;
};

export type ProjectionQueryDefinition<
  TProjectionSchema extends AnyProjectionSchema,
  TParamsSchema extends TSchema,
  TResultSchema extends TSchema,
> = {
  readonly params: TParamsSchema;
  readonly result: TResultSchema;
  run(
    input: ProjectionQueryRunInput<TProjectionSchema, TParamsSchema>,
  ): unknown | Promise<unknown>;
};

type ProjectionQueryDefinitionLike = {
  readonly params: TSchema;
  readonly result: TSchema;
  run(input: {
    readonly params: unknown;
    readonly db: ProjectionReadDatabase<AnyProjectionSchema>;
  }): unknown | Promise<unknown>;
};

type ProjectionQueryFactories<TProjectionSchema extends AnyProjectionSchema> =
  Record<
    string,
    (
      builder: ProjectionQueryBuilder<TProjectionSchema>,
    ) => ProjectionQueryDefinitionLike
  >;

export type ProjectionQueryBuilder<
  TProjectionSchema extends AnyProjectionSchema,
> = {
  params<const TParamsSchema extends TSchema>(
    schema: TParamsSchema,
  ): ProjectionQueryParamsBuilder<TProjectionSchema, TParamsSchema>;
};

export type ProjectionQueryParamsBuilder<
  TProjectionSchema extends AnyProjectionSchema,
  TParamsSchema extends TSchema,
> = {
  result<const TResultSchema extends TSchema>(
    schema: TResultSchema,
  ): ProjectionQueryResultBuilder<
    TProjectionSchema,
    TParamsSchema,
    TResultSchema
  >;
};

export type ProjectionQueryResultBuilder<
  TProjectionSchema extends AnyProjectionSchema,
  TParamsSchema extends TSchema,
  TResultSchema extends TSchema,
> = {
  read(
    run: (
      input: ProjectionQueryRunInput<TProjectionSchema, TParamsSchema>,
    ) => Static<TResultSchema> | Promise<Static<TResultSchema>>,
  ): ProjectionQueryDefinition<TProjectionSchema, TParamsSchema, TResultSchema>;
};

type FactoryReturn<TFactory> = TFactory extends (
  builder: never,
) => infer TReturn
  ? TReturn
  : never;

type InferProjectionIndexerDefinitions<TFactories> = {
  readonly [TName in Extract<keyof TFactories, string>]: FactoryReturn<
    TFactories[TName]
  >;
};

type InferProjectionQueryDefinitions<TFactories> = {
  readonly [TName in Extract<keyof TFactories, string>]: FactoryReturn<
    TFactories[TName]
  >;
};

type ProjectionIndexerSchemas<TDefinitions> = {
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

type ProjectionQuerySchemas<TDefinitions> = {
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
> = {
  readonly projections: TProjectionSchema;
  readonly indexers: TIndexers;
  readonly queries: TQueries;
  readonly implementations: LedgerImplementations<TIndexers, TQueries>;
};

type ProjectionSchemaCompatibleWithEvents<
  TEventName extends string,
  TProjectionSchema,
> =
  Exclude<
    ProjectionSchemaEventName<TProjectionSchema>,
    TEventName
  > extends never
    ? unknown
    : {
        readonly projectionEventNamesMustComeFromLedgerShape: never;
      };

type ProjectionAccessIndexers<TAccess> = TAccess extends {
  readonly indexers: infer TIndexers;
}
  ? TIndexers extends Record<string, TSchema>
    ? TIndexers
    : never
  : never;

type ProjectionAccessProjectionSchema<TAccess> = TAccess extends {
  readonly projections: infer TProjectionSchema;
}
  ? TProjectionSchema extends AnyProjectionSchema
    ? TProjectionSchema
    : never
  : never;

type ProjectionAccessQueries<TAccess> = TAccess extends {
  readonly queries: infer TQueries;
}
  ? TQueries extends Record<string, AnyQuerySchema>
    ? TQueries
    : never
  : never;

function createProjectionAccess<
  const TProjectionSchema extends AnyProjectionSchema,
  const TIndexerFactories extends ProjectionIndexerFactories<TProjectionSchema>,
  const TQueryFactories extends ProjectionQueryFactories<TProjectionSchema>,
>(input: {
  readonly projections: TProjectionSchema;
  readonly indexers: TIndexerFactories;
  readonly queries: TQueryFactories;
}): ProjectionAccess<
  TProjectionSchema,
  ProjectionIndexerSchemas<
    InferProjectionIndexerDefinitions<TIndexerFactories>
  >,
  ProjectionQuerySchemas<InferProjectionQueryDefinitions<TQueryFactories>>
> {
  const indexerBuilder = createProjectionIndexerBuilder(input.projections);
  const queryBuilder = createProjectionQueryBuilder(input.projections);

  const indexers: Record<string, TSchema> = {};
  const queries: Record<string, AnyQuerySchema> = {};
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

  for (const [indexerName, factory] of Object.entries(input.indexers)) {
    const definition = factory(indexerBuilder);
    indexers[indexerName] = definition.input;
    indexerImplementations[indexerName] = async (
      scope,
      indexerInput,
      context,
    ) => {
      await runProjectionIndexer(
        input.projections,
        definition,
        scope,
        indexerInput,
        context,
      );
    };
  }

  for (const [queryName, factory] of Object.entries(input.queries)) {
    const definition = factory(queryBuilder);
    queries[queryName] = {
      params: definition.params,
      result: definition.result,
    };
    queryImplementations[queryName] = async (scope, params) => {
      return await definition.run({
        params,
        db: createProjectionReadDatabase(input.projections.metadata, scope),
      });
    };
  }

  return {
    projections: input.projections,
    indexers,
    queries,
    implementations: {
      indexers: indexerImplementations,
      queries: queryImplementations,
    },
  } as ProjectionAccess<
    TProjectionSchema,
    ProjectionIndexerSchemas<
      InferProjectionIndexerDefinitions<TIndexerFactories>
    >,
    ProjectionQuerySchemas<InferProjectionQueryDefinitions<TQueryFactories>>
  >;
}

export type DefinedProjectedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = DefinedLedgerModel<
  TEvents,
  TQueues,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> & {
  readonly access: ProjectionAccess<TProjectionSchema, TIndexers, TQueries>;
};

export type RegisteredProjectedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = RegisteredLedgerModel<
  TEvents,
  TQueues,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> & {
  readonly access: ProjectionAccess<TProjectionSchema, TIndexers, TQueries>;
};

function createProjectedLedgerModel<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const TAccess extends ProjectionAccess<
    AnyProjectionSchema,
    Record<string, TSchema>,
    Record<string, AnyQuerySchema>
  >,
>(input: {
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  readonly access: TAccess;
}): DefinedProjectedLedgerModel<
  TEvents,
  TQueues,
  ProjectionAccessProjectionSchema<TAccess>,
  ProjectionAccessIndexers<TAccess>,
  ProjectionAccessQueries<TAccess>,
  TSignals,
  TSignalQueues
> {
  const access = input.access as unknown as ProjectionAccess<
    ProjectionAccessProjectionSchema<TAccess>,
    ProjectionAccessIndexers<TAccess>,
    ProjectionAccessQueries<TAccess>
  >;
  const definedModel = defineLedgerModel<
    TEvents,
    TQueues,
    ProjectionAccessIndexers<TAccess>,
    ProjectionAccessQueries<TAccess>,
    TSignals,
    TSignalQueues
  >({
    events: input.shape.events,
    queues: input.shape.queues,
    signals: input.shape.signals,
    signalQueues: input.shape.signalQueues,
    indexers: access.indexers,
    queries: access.queries,
  });

  return {
    model: definedModel.model,
    access,
  };
}

export function registerProjectedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
>(
  model: DefinedProjectedLedgerModel<
    TEvents,
    TQueues,
    TProjectionSchema,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
  register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
): RegisteredProjectedLedgerModel<
  TEvents,
  TQueues,
  TProjectionSchema,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> {
  const registered = registerLedgerModel(model, register);

  return {
    model: registered.model,
    register: registered.register,
    access: model.access,
  };
}

export function bindProjectedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
>(
  model: RegisteredProjectedLedgerModel<
    TEvents,
    TQueues,
    TProjectionSchema,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
): BoundLedgerModel<
  TEvents,
  TQueues,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> {
  const implementations = model.access.implementations as LedgerImplementations<
    TIndexers,
    TQueries,
    TEvents
  >;

  return bindLedgerModel(model, implementations);
}

function createLedgerProjectionSchemaBuilder<
  TEventName extends string,
>(): LedgerProjectionSchemaBuilder<TEventName> {
  const defineSchema = defineProjectionSchemaForEvents<TEventName>();

  return {
    schema: (factories) => {
      return defineSchema(factories);
    },
  };
}

function createProjectionIndexerBuilder<
  TProjectionSchema extends AnyProjectionSchema,
>(
  _projections: TProjectionSchema,
): ProjectionIndexerBuilder<TProjectionSchema> {
  return {
    sourceEvent: (sourceEventName) => {
      return {
        input: (inputSchema) => {
          return {
            write: (run) => {
              return {
                input: inputSchema,
                sourceEventName,
                run,
              };
            },
          };
        },
      };
    },
  };
}

function createProjectionQueryBuilder<
  TProjectionSchema extends AnyProjectionSchema,
>(_projections: TProjectionSchema): ProjectionQueryBuilder<TProjectionSchema> {
  return {
    params: (paramsSchema) => {
      return {
        result: (resultSchema) => {
          return {
            read: (run) => {
              return {
                params: paramsSchema,
                result: resultSchema,
                run,
              };
            },
          };
        },
      };
    },
  };
}

async function runProjectionIndexer(
  projections: AnyProjectionSchema,
  definition: ProjectionIndexerDefinitionLike,
  scope: LedgerStorageScope,
  input: unknown,
  context: LedgerIndexerContext,
): Promise<void> {
  const event = createProjectionIndexerEvent(
    definition.sourceEventName,
    context,
  );

  await definition.run({
    input,
    event,
    db: createProjectionWriteDatabase(projections.metadata, scope),
  });
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

function createProjectionWriteDatabase<
  TProjectionSchema extends AnyProjectionSchema,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
): ProjectionWriteDatabase<TProjectionSchema> {
  return {
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
          >(scope, table, insertColumns, insertValues);
        },
      };
    },
  };
}

function createInsertConflictBuilder<TTable>(
  scope: LedgerStorageScope,
  table: ProjectionTableMetadata,
  insertColumns: readonly string[],
  insertValues: readonly unknown[],
): ProjectionInsertConflictBuilder<TTable> {
  return {
    execute: async () => {
      const sql = buildInsertSql(table, insertColumns, null);
      await scope.prepare(sql).run(...insertValues);
    },
    onConflict: (conflictColumns) => {
      validateProjectionKey("conflict target", table, conflictColumns);

      return {
        doNothing: () => {
          return {
            execute: async () => {
              const sql = buildInsertSql(table, insertColumns, {
                kind: "do_nothing",
                conflictColumns,
              });
              await scope.prepare(sql).run(...insertValues);
            },
          };
        },
        doUpdateSet: (values) => {
          const updateValuesByColumn = values as Readonly<
            Record<string, unknown>
          >;
          const updateColumns = validateProjectionWriteRow(
            "update values",
            table,
            updateValuesByColumn,
            false,
          );
          const updateValues = updateColumns.map((columnName) => {
            return serializeProjectionColumnValue(
              table.columns[columnName],
              updateValuesByColumn[columnName],
              `${table.name}.${columnName}`,
            );
          });

          return {
            execute: async () => {
              const sql = buildInsertSql(table, insertColumns, {
                kind: "do_update",
                conflictColumns,
                updateColumns,
              });
              await scope.prepare(sql).run(...insertValues, ...updateValues);
            },
          };
        },
      };
    },
  };
}

function createProjectionReadDatabase<
  TProjectionSchema extends AnyProjectionSchema,
>(
  metadata: ProjectionSchemaMetadata,
  scope: LedgerStorageScope,
): ProjectionReadDatabase<TProjectionSchema> {
  return {
    selectFrom: (tableName) => {
      const table = readProjectionTable(metadata, String(tableName));

      return {
        select: (columns) => {
          validateProjectionColumns("selected columns", table, columns);

          return createProjectionExecutableSelect(scope, table, columns, []);
        },
      };
    },
  };
}

type ProjectionWhereClause = {
  readonly columnName: string;
  readonly value: unknown;
};

function createProjectionExecutableSelect<
  TTable,
  const TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
>(
  scope: LedgerStorageScope,
  table: ProjectionTableMetadata,
  selectedColumns: TColumnNames,
  whereClauses: readonly ProjectionWhereClause[],
): ProjectionExecutableSelect<TTable, TColumnNames> {
  return {
    where: (columnName, operator, value) => {
      if (operator !== "=") {
        throw new Error(`unsupported projection where operator ${operator}`);
      }

      validateProjectionColumns("where column", table, [String(columnName)]);
      const column = table.columns[String(columnName)];
      const serializedValue = serializeProjectionColumnValue(
        column,
        value,
        `${table.name}.${String(columnName)}`,
      );

      return createProjectionExecutableSelect(scope, table, selectedColumns, [
        ...whereClauses,
        {
          columnName: String(columnName),
          value: serializedValue,
        },
      ]);
    },
    execute: async () => {
      const sql = buildSelectSql(table, selectedColumns, whereClauses);
      const rows = await scope
        .prepare(sql)
        .all(...whereClauses.map((clause) => clause.value));

      const decodedRows = rows.map((row) => {
        return decodeProjectionSelectedRow(table, selectedColumns, row);
      });

      return decodedRows as unknown as readonly ProjectionSelectedRow<
        TTable,
        TColumnNames
      >[];
    },
    executeTakeFirst: async () => {
      const sql = `${buildSelectSql(table, selectedColumns, whereClauses)} LIMIT 1`;
      const row = await scope
        .prepare(sql)
        .get(...whereClauses.map((clause) => clause.value));

      if (row === undefined) {
        return null;
      }

      return decodeProjectionSelectedRow(
        table,
        selectedColumns,
        row,
      ) as ProjectionSelectedRow<TTable, TColumnNames>;
    },
  };
}

function buildInsertSql(
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
        readonly updateColumns: readonly string[];
      },
): string {
  const columnSql = insertColumns.map(quoteIdentifier).join(", ");
  const valuesSql = insertColumns.map(() => "?").join(", ");
  let sql = `INSERT INTO ${quoteIdentifier(table.name)} (${columnSql}) VALUES (${valuesSql})`;

  if (conflict === null) {
    return sql;
  }

  const conflictSql = conflict.conflictColumns.map(quoteIdentifier).join(", ");

  if (conflict.kind === "do_nothing") {
    sql += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
    return sql;
  }

  if (conflict.updateColumns.length === 0) {
    throw new Error("update values must include at least one column");
  }

  const updateSql = conflict.updateColumns
    .map((columnName) => `${quoteIdentifier(columnName)} = ?`)
    .join(", ");
  sql += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateSql}`;

  return sql;
}

function buildSelectSql(
  table: ProjectionTableMetadata,
  selectedColumns: readonly string[],
  whereClauses: readonly ProjectionWhereClause[],
): string {
  const selectedSql = selectedColumns.map(quoteIdentifier).join(", ");
  let sql = `SELECT ${selectedSql} FROM ${quoteIdentifier(table.name)}`;

  if (whereClauses.length === 0) {
    return sql;
  }

  const whereSql = whereClauses
    .map((clause) => `${quoteIdentifier(clause.columnName)} = ?`)
    .join(" AND ");
  sql += ` WHERE ${whereSql}`;

  return sql;
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

function serializeProjectionColumnValue(
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

  switch (column.kind) {
    case "boolean":
      return serializeBoolean(value, context);
    case "event_ref":
      return serializeEventRef(column, value, context);
    case "integer":
      return serializeNumber(value, context);
    case "json":
      return JSON.stringify(value);
    case "text":
      return serializeString(value, context);
  }
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

  if (typeof ref.eventId !== "number" || !Number.isSafeInteger(ref.eventId)) {
    throw new Error(`${context} event reference id must be a safe integer`);
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
