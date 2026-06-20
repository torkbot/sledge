import type { Static, TSchema } from "typebox";

import type { EventRef } from "./event-ref.ts";
import { createEventRef } from "./event-ref.ts";
import type {
  LedgerImplementations,
  LedgerStorageRow,
  LedgerStorageScope,
} from "./internal-storage.ts";
import type { LedgerIndexerContext, QuerySchema } from "./ledger.ts";
import {
  type ProjectionColumnMetadata,
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
  TSourceEventName extends string,
> = {
  readonly input: Static<TInputSchema>;
  readonly event: ProjectionIndexerEvent<TSourceEventName>;
  readonly db: ProjectionWriteDatabase<TProjectionSchema>;
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
> = {
  readonly params: Static<TParamsSchema>;
  readonly db: ProjectionReadDatabase<TProjectionSchema>;
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
> = {
  readonly [TName in keyof TIndexerDefinitions]: TIndexerDefinitions[TName] extends {
    readonly input: infer TInputSchema extends TSchema;
    readonly sourceEvent: infer TSourceEventName extends string;
  }
    ? (
        input: ProjectionIndexerRunInput<
          TProjectionSchema,
          TInputSchema,
          TSourceEventName
        >,
      ) => void | Promise<void>
    : never;
};

export type ProjectionQueryImplementations<
  TProjectionSchema extends AnyProjectionSchema,
  TQueryDefinitions extends ProjectionQueryDefinitions,
> = {
  readonly [TName in keyof TQueryDefinitions]: TQueryDefinitions[TName] extends {
    readonly params: infer TParamsSchema extends TSchema;
    readonly result: infer TResultSchema extends TSchema;
  }
    ? (
        input: ProjectionQueryRunInput<TProjectionSchema, TParamsSchema>,
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
> = (keyof TIndexerDefinitions extends never
  ? {
      readonly indexers?: never;
    }
  : {
      readonly indexers: ProjectionIndexerImplementations<
        TProjectionSchema,
        TIndexerDefinitions
      >;
    }) &
  (keyof TQueryDefinitions extends never
    ? {
        readonly queries?: never;
      }
    : {
        readonly queries: ProjectionQueryImplementations<
          TProjectionSchema,
          TQueryDefinitions
        >;
      });

export function createProjectionImplementations<
  const TProjectionSchema extends AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(input: {
  readonly projections: TProjectionSchema;
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
  readonly register: ProjectionImplementationRegistration<
    TProjectionSchema,
    TIndexerDefinitions,
    TQueryDefinitions
  >;
}): LedgerImplementations<
  ProjectionIndexerSchemas<TIndexerDefinitions>,
  ProjectionQuerySchemas<TQueryDefinitions>
> {
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
        db: createProjectionReadDatabase(input.projections.metadata, scope),
      });
    };
  }

  return {
    indexers: indexerImplementations,
    queries: queryImplementations,
  } as LedgerImplementations<
    ProjectionIndexerSchemas<TIndexerDefinitions>,
    ProjectionQuerySchemas<TQueryDefinitions>
  >;
}

async function runProjectionIndexer(
  projections: AnyProjectionSchema,
  definition: ProjectionIndexerContractLike,
  implementation: (
    input: ProjectionIndexerRunInput<AnyProjectionSchema, TSchema, string>,
  ) => void | Promise<void>,
  scope: LedgerStorageScope,
  input: unknown,
  context: LedgerIndexerContext,
): Promise<void> {
  const event = createProjectionIndexerEvent(definition.sourceEvent, context);

  await implementation({
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
  const selectedSql = selectedColumns
    .map((columnName) => {
      const quotedColumnName = quoteIdentifier(columnName);
      return `${quotedColumnName} AS ${quotedColumnName}`;
    })
    .join(", ");
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
      return serializeJson(value, context);
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
