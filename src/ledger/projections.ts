import type { EventRef } from "./event-ref.ts";

export type { EventRef } from "./event-ref.ts";

declare const projectionColumnValueBrand: unique symbol;
declare const projectionSchemaEventNamesBrand: unique symbol;
declare const projectionSchemaRelationsBrand: unique symbol;
declare const projectionSchemaTablesBrand: unique symbol;
declare const projectionTableColumnsBrand: unique symbol;
declare const projectionTablePrimaryKeyBrand: unique symbol;
declare const projectionTableUniqueKeysBrand: unique symbol;

const reservedProjectionTableNames = new Set(["events", "work"]);
const reservedProjectionIndexNames = new Set(["idx_work_due", "idx_work_ref"]);

export type ProjectionColumnKind =
  | "boolean"
  | "event_ref"
  | "integer"
  | "json"
  | "text";

export type ProjectionColumnMetadata = {
  readonly kind: ProjectionColumnKind;
  readonly nullable: boolean;
  readonly eventName: string | null;
};

export type ProjectionColumn<
  TKind extends ProjectionColumnKind,
  TValue,
  TNullable extends boolean,
> = {
  readonly metadata: ProjectionColumnMetadata & {
    readonly kind: TKind;
    readonly nullable: TNullable;
  };
  notNull(): ProjectionColumn<TKind, TValue, false>;
  readonly [projectionColumnValueBrand]?: TValue;
};

export type ProjectionColumns = Record<
  string,
  ProjectionColumn<ProjectionColumnKind, unknown, boolean>
>;

export type ProjectionColumnValue<TColumn> =
  TColumn extends ProjectionColumn<
    ProjectionColumnKind,
    infer TValue,
    infer TNullable
  >
    ? TNullable extends true
      ? TValue | null
      : TValue
    : never;

export type ProjectionRow<TColumns extends ProjectionColumns> = {
  readonly [TColumnName in keyof TColumns]: ProjectionColumnValue<
    TColumns[TColumnName]
  >;
};

export type ProjectionSchemaTables<TSchema> = TSchema extends {
  readonly [projectionSchemaTablesBrand]?: infer TTables;
}
  ? TTables
  : never;

export type ProjectionSchemaEventName<TSchema> = TSchema extends {
  readonly [projectionSchemaEventNamesBrand]?: infer TEventName;
}
  ? TEventName extends string
    ? TEventName
    : never
  : never;

export type ProjectionTableColumns<TTable> = TTable extends {
  readonly [projectionTableColumnsBrand]?: infer TColumns;
}
  ? TColumns extends ProjectionColumns
    ? TColumns
    : never
  : never;

type ProjectionTableDefinitionLike = {
  readonly metadata: ProjectionTableMetadata;
};

type ProjectionTableFactory<TEventName extends string> = (
  table: ProjectionTableBuilder<TEventName>,
) => ProjectionTableDefinitionLike;

export type ProjectionIndexMetadata = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
};

export type ProjectionKeyMetadata = {
  readonly columns: readonly string[];
  readonly kind: "primary" | "unique";
  readonly name: string | null;
};

export type ProjectionTableMetadata = {
  readonly name: string;
  readonly columns: Readonly<Record<string, ProjectionColumnMetadata>>;
  readonly primaryKey: readonly string[];
  readonly indexes: readonly ProjectionIndexMetadata[];
  readonly keys: readonly ProjectionKeyMetadata[];
};

type ProjectionColumnName<TColumns extends ProjectionColumns> = Extract<
  keyof TColumns,
  string
>;

type NotNullProjectionColumnName<TColumns extends ProjectionColumns> = {
  readonly [TColumnName in ProjectionColumnName<TColumns>]: TColumns[TColumnName] extends ProjectionColumn<
    ProjectionColumnKind,
    unknown,
    false
  >
    ? TColumnName
    : never;
}[ProjectionColumnName<TColumns>];

type ProjectionColumnList<TColumns extends ProjectionColumns> =
  readonly ProjectionColumnName<TColumns>[];

type ProjectionNotNullColumnList<TColumns extends ProjectionColumns> =
  readonly NotNullProjectionColumnName<TColumns>[];

type ProjectionKeyList<TColumns extends ProjectionColumns> =
  readonly ProjectionColumnList<TColumns>[];

export type ProjectionTableDefinition<
  TColumns extends ProjectionColumns,
  TPrimaryKey extends ProjectionNotNullColumnList<TColumns>,
  TUniqueKeys extends ProjectionKeyList<TColumns>,
> = {
  readonly metadata: ProjectionTableMetadata;
  readonly [projectionTableColumnsBrand]?: TColumns;
  readonly [projectionTablePrimaryKeyBrand]?: TPrimaryKey;
  readonly [projectionTableUniqueKeysBrand]?: TUniqueKeys;
  index<
    const TColumnsToIndex extends readonly ProjectionColumnName<TColumns>[],
  >(
    name: string,
    columns: TColumnsToIndex,
  ): ProjectionTableDefinition<TColumns, TPrimaryKey, TUniqueKeys>;
  unique<
    const TColumnsToIndex extends readonly ProjectionColumnName<TColumns>[],
  >(
    name: string,
    columns: TColumnsToIndex,
  ): ProjectionTableDefinition<
    TColumns,
    TPrimaryKey,
    readonly [...TUniqueKeys, TColumnsToIndex]
  >;
};

export type ProjectionTableDraft<TColumns extends ProjectionColumns> = {
  primaryKey<const TPrimaryKey extends ProjectionNotNullColumnList<TColumns>>(
    columns: TPrimaryKey,
  ): ProjectionTableDefinition<TColumns, TPrimaryKey, readonly [TPrimaryKey]>;
};

export type ProjectionTableBuilder<TEventName extends string> = {
  boolean(): ProjectionColumn<"boolean", boolean, true>;
  eventRef<const TEventNameToReference extends TEventName>(
    eventName: TEventNameToReference,
  ): ProjectionColumn<"event_ref", EventRef<TEventNameToReference>, true>;
  integer(): ProjectionColumn<"integer", number, true>;
  json<TValue>(): ProjectionColumn<"json", TValue, true>;
  text(): ProjectionColumn<"text", string, true>;
  columns<const TColumns extends ProjectionColumns>(
    columns: TColumns,
  ): ProjectionTableDraft<TColumns>;
};

export type ProjectionTableFactories<TEventName extends string> = Record<
  string,
  ProjectionTableFactory<TEventName>
>;

export type ProjectionTablesForFactories<TFactories> = {
  readonly [TTableName in Extract<
    keyof TFactories,
    string
  >]: TFactories[TTableName] extends (
    table: ProjectionTableBuilder<string>,
  ) => infer TTable
    ? TTable
    : never;
};

export type ProjectionTableName<TTables> = Extract<keyof TTables, string>;

export type ProjectionTableColumnName<TTable> = Extract<
  keyof ProjectionTableColumns<TTable>,
  string
>;

type ProjectionTableKeys<TTable> = TTable extends {
  readonly [projectionTableUniqueKeysBrand]?: infer TUniqueKeys;
}
  ? TUniqueKeys extends readonly (readonly string[])[]
    ? TUniqueKeys
    : never
  : never;

export type ProjectionTableKey<TTable> = ProjectionTableKeys<TTable>[number] &
  readonly ProjectionTableColumnName<TTable>[];

type ProjectionColumnScalar<TColumn> =
  TColumn extends ProjectionColumn<ProjectionColumnKind, infer TValue, boolean>
    ? NonNullable<TValue>
    : never;

type CompatibleColumnNames<TTable, TValue> = {
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

type CompatibleReferenceColumns<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TFromColumns extends readonly ProjectionTableColumnName<
    TTables[TFromTableName]
  >[],
  TToTableName extends ProjectionTableName<TTables>,
> = {
  readonly [TIndex in keyof TFromColumns]: TFromColumns[TIndex] extends ProjectionTableColumnName<
    TTables[TFromTableName]
  >
    ? CompatibleColumnNames<
        TTables[TToTableName],
        ProjectionColumnScalar<
          ProjectionTableColumns<TTables[TFromTableName]>[TFromColumns[TIndex]]
        >
      >
    : never;
} & { readonly length: TFromColumns["length"] };

type ProjectionColumnNullable<TColumn> =
  TColumn extends ProjectionColumn<
    ProjectionColumnKind,
    unknown,
    infer TNullable
  >
    ? TNullable
    : never;

type ProjectionColumnsAllowSetNull<
  TTable,
  TColumns extends readonly ProjectionTableColumnName<TTable>[],
> = false extends {
  readonly [TIndex in keyof TColumns]: TColumns[TIndex] extends ProjectionTableColumnName<TTable>
    ? ProjectionColumnNullable<ProjectionTableColumns<TTable>[TColumns[TIndex]]>
    : false;
}[number]
  ? false
  : true;

export type ProjectionForeignKeyAction =
  | "cascade"
  | "no_action"
  | "restrict"
  | "set_null";

export type ProjectionForeignKeyMetadata = {
  readonly fromTable: string;
  readonly fromColumns: readonly string[];
  readonly toTable: string;
  readonly toColumns: readonly string[];
  readonly onDelete: ProjectionForeignKeyAction;
};

export type ProjectionRelationDefinition = {
  readonly metadata: ProjectionForeignKeyMetadata;
  onDelete(action: ProjectionForeignKeyAction): ProjectionRelationDefinition;
};

export type ProjectionReferenceBuilder<
  TTables,
  TFromTableName extends ProjectionTableName<TTables>,
  TFromColumns extends readonly ProjectionTableColumnName<
    TTables[TFromTableName]
  >[],
> = {
  references<
    const TToTableName extends ProjectionTableName<TTables>,
    const TToColumns extends ProjectionTableKey<TTables[TToTableName]>,
  >(
    tableName: TToTableName,
    columns: TToColumns &
      CompatibleReferenceColumns<
        TTables,
        TFromTableName,
        TFromColumns,
        TToTableName
      >,
  ): ProjectionRelationDefinitionForSource<
    ProjectionColumnsAllowSetNull<TTables[TFromTableName], TFromColumns>
  >;
};

export type ProjectionRelationDefinitionForSource<TCanSetNull extends boolean> =
  {
    readonly metadata: ProjectionForeignKeyMetadata;
    onDelete(
      action: TCanSetNull extends true
        ? ProjectionForeignKeyAction
        : Exclude<ProjectionForeignKeyAction, "set_null">,
    ): ProjectionRelationDefinitionForSource<TCanSetNull>;
  };

export type ProjectionRelationBuilder<TTables> = {
  foreignKey<
    const TFromTableName extends ProjectionTableName<TTables>,
    const TFromColumns extends readonly ProjectionTableColumnName<
      TTables[TFromTableName]
    >[],
  >(
    tableName: TFromTableName,
    columns: TFromColumns,
  ): ProjectionReferenceBuilder<TTables, TFromTableName, TFromColumns>;
};

export type ProjectionRelations = Record<string, ProjectionRelationDefinition>;

export type ProjectionSchemaMetadata = {
  readonly tables: Readonly<Record<string, ProjectionTableMetadata>>;
  readonly relations: Readonly<Record<string, ProjectionForeignKeyMetadata>>;
};

export type ProjectionSchema<
  TTables,
  TRelations extends ProjectionRelations,
  TEventName extends string = string,
> = {
  readonly metadata: ProjectionSchemaMetadata;
  readonly [projectionSchemaEventNamesBrand]?: TEventName;
  readonly [projectionSchemaTablesBrand]?: TTables;
  readonly [projectionSchemaRelationsBrand]?: TRelations;
  relations<const TNextRelations extends ProjectionRelations>(
    build: (relations: ProjectionRelationBuilder<TTables>) => TNextRelations,
  ): ProjectionSchema<TTables, TNextRelations, TEventName>;
};

export function defineProjectionSchema<
  const TFactories extends ProjectionTableFactories<string>,
>(
  factories: TFactories,
): ProjectionSchema<ProjectionTablesForFactories<TFactories>, {}, string> {
  return defineProjectionSchemaInternal(factories);
}

export function defineProjectionSchemaForEvents<TEventName extends string>() {
  return <const TFactories extends ProjectionTableFactories<TEventName>>(
    factories: TFactories,
  ): ProjectionSchema<
    ProjectionTablesForFactories<TFactories>,
    {},
    TEventName
  > => {
    return defineProjectionSchemaInternal(factories);
  };
}

function defineProjectionSchemaInternal<
  TEventName extends string,
  const TFactories extends ProjectionTableFactories<TEventName>,
>(
  factories: TFactories,
): ProjectionSchema<ProjectionTablesForFactories<TFactories>, {}, TEventName> {
  const tableBuilder = createProjectionTableBuilder<TEventName>();
  const tableMetadata: Record<string, ProjectionTableMetadata> = {};

  validateUniqueSqliteIdentifiers(
    "projection table name",
    Object.keys(factories),
  );

  for (const [tableName, factory] of Object.entries(factories)) {
    if (typeof factory !== "function") {
      throw new Error(
        `projection table ${tableName} factory must be a function`,
      );
    }

    const tableFactory = factory as (
      table: ProjectionTableBuilder<TEventName>,
    ) => unknown;
    const table = tableFactory(tableBuilder);
    const metadata = readProjectionTableMetadata(table, tableName);
    tableMetadata[tableName] = renameTableMetadata(metadata, tableName);
  }

  validateProjectionSchemaIndexNames(tableMetadata);

  return createProjectionSchema<
    ProjectionTablesForFactories<TFactories>,
    {},
    TEventName
  >(tableMetadata, {});
}

function readProjectionTableMetadata(
  table: unknown,
  tableName: string,
): ProjectionTableMetadata {
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error(
      `projection table ${tableName} factory must return a table definition`,
    );
  }

  const metadata = (table as { readonly metadata?: unknown }).metadata;

  if (!isProjectionTableMetadata(metadata)) {
    throw new Error(
      `projection table ${tableName} factory must return a table definition`,
    );
  }

  return metadata;
}

function isProjectionTableMetadata(
  metadata: unknown,
): metadata is ProjectionTableMetadata {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return false;
  }

  const maybeMetadata = metadata as {
    readonly columns?: unknown;
    readonly indexes?: unknown;
    readonly keys?: unknown;
    readonly name?: unknown;
    readonly primaryKey?: unknown;
  };

  return (
    typeof maybeMetadata.name === "string" &&
    typeof maybeMetadata.columns === "object" &&
    maybeMetadata.columns !== null &&
    !Array.isArray(maybeMetadata.columns) &&
    Array.isArray(maybeMetadata.primaryKey) &&
    Array.isArray(maybeMetadata.indexes) &&
    Array.isArray(maybeMetadata.keys)
  );
}

function createProjectionTableBuilder<
  TEventName extends string,
>(): ProjectionTableBuilder<TEventName> {
  return {
    boolean: () => createColumn("boolean", null, true),
    eventRef: (eventName) => createColumn("event_ref", eventName, true),
    integer: () => createColumn("integer", null, true),
    json: <TValue>() => createColumn<"json", TValue, true>("json", null, true),
    text: () => createColumn("text", null, true),
    columns: (columns) => createTableDraft(columns),
  };
}

function createColumn<
  TKind extends ProjectionColumnKind,
  TValue,
  TNullable extends boolean,
>(
  kind: TKind,
  eventName: string | null,
  nullable: TNullable,
): ProjectionColumn<TKind, TValue, TNullable> {
  return {
    metadata: {
      kind,
      nullable,
      eventName,
    },
    notNull: () => createColumn(kind, eventName, false),
  };
}

function createTableDraft<TColumns extends ProjectionColumns>(
  columns: TColumns,
): ProjectionTableDraft<TColumns> {
  validateUniqueSqliteIdentifiers(
    "projection column name",
    Object.keys(columns),
  );

  return {
    primaryKey: (primaryKey) => {
      validateColumns("primary key", columns, primaryKey);
      validateNotNullColumns("primary key", columns, primaryKey);
      return createTableDefinition({
        name: "",
        columns: metadataForColumns(columns),
        primaryKey,
        indexes: [],
        keys: [
          {
            columns: primaryKey,
            kind: "primary",
            name: null,
          },
        ],
      });
    },
  };
}

function createTableDefinition<
  TColumns extends ProjectionColumns,
  TPrimaryKey extends ProjectionNotNullColumnList<TColumns>,
  TUniqueKeys extends ProjectionKeyList<TColumns>,
>(
  metadata: ProjectionTableMetadata,
): ProjectionTableDefinition<TColumns, TPrimaryKey, TUniqueKeys> {
  return {
    metadata,
    index: (name, columns) => {
      validateIndexName(name);
      validateColumns("index", metadata.columns, columns);
      return createTableDefinition({
        ...metadata,
        indexes: [
          ...metadata.indexes,
          {
            name,
            columns,
            unique: false,
          },
        ],
      });
    },
    unique: (name, columns) => {
      validateIndexName(name);
      validateColumns("unique index", metadata.columns, columns);
      return createTableDefinition({
        ...metadata,
        indexes: [
          ...metadata.indexes,
          {
            name,
            columns,
            unique: true,
          },
        ],
        keys: [
          ...metadata.keys,
          {
            columns,
            kind: "unique",
            name,
          },
        ],
      });
    },
  };
}

function createProjectionSchema<
  TTables,
  TRelations extends ProjectionRelations,
  TEventName extends string,
>(
  tables: Readonly<Record<string, ProjectionTableMetadata>>,
  relations: TRelations,
): ProjectionSchema<TTables, TRelations, TEventName> {
  return {
    metadata: {
      tables,
      relations: metadataForRelations(relations),
    },
    relations: <const TNextRelations extends ProjectionRelations>(
      build: (relations: ProjectionRelationBuilder<TTables>) => TNextRelations,
    ) => {
      const relationDefinitions = build(createRelationBuilder<TTables>(tables));
      return createProjectionSchema<TTables, TNextRelations, TEventName>(
        tables,
        relationDefinitions,
      );
    },
  };
}

function createRelationBuilder<TTables>(
  tables: Readonly<Record<string, ProjectionTableMetadata>>,
): ProjectionRelationBuilder<TTables> {
  return {
    foreignKey: (fromTable, fromColumns) => {
      const fromColumnsMetadata = validateRelationEndpoint(
        "foreign key",
        tables,
        String(fromTable),
        fromColumns,
      );

      return {
        references: (toTable, toColumns) => {
          const toColumnsMetadata = validateRelationEndpoint(
            "foreign key reference",
            tables,
            String(toTable),
            toColumns,
          );
          validateRelationReferencesKey(tables, String(toTable), toColumns);

          validateRelationColumnCompatibility(
            fromColumnsMetadata,
            toColumnsMetadata,
          );

          return createRelationDefinition(
            {
              fromTable: String(fromTable),
              fromColumns,
              toTable: String(toTable),
              toColumns,
              onDelete: "restrict",
            },
            fromColumnsMetadata,
          );
        },
      };
    },
  };
}

function createRelationDefinition(
  metadata: ProjectionForeignKeyMetadata,
  fromColumns: readonly ProjectionColumnMetadata[],
): ProjectionRelationDefinition {
  return {
    metadata,
    onDelete: (action) => {
      validateOnDeleteAction(action, fromColumns);

      return createRelationDefinition(
        {
          ...metadata,
          onDelete: action,
        },
        fromColumns,
      );
    },
  };
}

function metadataForColumns(
  columns: Readonly<
    Record<string, ProjectionColumn<ProjectionColumnKind, unknown, boolean>>
  >,
): Readonly<Record<string, ProjectionColumnMetadata>> {
  const metadata: Record<string, ProjectionColumnMetadata> = {};

  for (const [columnName, column] of Object.entries(columns)) {
    metadata[columnName] = column.metadata;
  }

  return metadata;
}

function metadataForRelations(
  relations: ProjectionRelations,
): Readonly<Record<string, ProjectionForeignKeyMetadata>> {
  const metadata: Record<string, ProjectionForeignKeyMetadata> = {};

  for (const [relationName, relation] of Object.entries(relations)) {
    metadata[relationName] = relation.metadata;
  }

  return metadata;
}

function renameTableMetadata(
  metadata: ProjectionTableMetadata,
  name: string,
): ProjectionTableMetadata {
  if (name.length === 0) {
    throw new Error("projection table name must be non-empty");
  }

  if (reservedProjectionTableNames.has(name.toLowerCase())) {
    throw new Error(
      `projection table name ${name} is reserved for ledger storage`,
    );
  }

  return {
    ...metadata,
    name,
  };
}

function validateColumns(
  context: string,
  columns: Readonly<Record<string, unknown>>,
  selectedColumns: readonly string[],
): void {
  if (selectedColumns.length === 0) {
    throw new Error(`${context} must include at least one column`);
  }

  for (const columnName of selectedColumns) {
    if (columns[columnName] === undefined) {
      throw new Error(`${context} references unknown column ${columnName}`);
    }
  }
}

function validateNotNullColumns(
  context: string,
  columns: Readonly<
    Record<string, ProjectionColumn<ProjectionColumnKind, unknown, boolean>>
  >,
  selectedColumns: readonly string[],
): void {
  for (const columnName of selectedColumns) {
    const column = columns[columnName];

    if (column === undefined) {
      throw new Error(`${context} references unknown column ${columnName}`);
    }

    if (column.metadata.nullable) {
      throw new Error(`${context} column ${columnName} must be not null`);
    }
  }
}

function validateRelationEndpoint(
  context: string,
  tables: Readonly<Record<string, ProjectionTableMetadata>>,
  tableName: string,
  columns: readonly string[],
): readonly ProjectionColumnMetadata[] {
  const table = tables[tableName];

  if (table === undefined) {
    throw new Error(`${context} references unknown table ${tableName}`);
  }

  validateColumns(context, table.columns, columns);

  return columns.map((columnName) => {
    const column = table.columns[columnName];

    if (column === undefined) {
      throw new Error(`${context} references unknown column ${columnName}`);
    }

    return column;
  });
}

function validateRelationColumnCompatibility(
  fromColumns: readonly ProjectionColumnMetadata[],
  toColumns: readonly ProjectionColumnMetadata[],
): void {
  if (fromColumns.length !== toColumns.length) {
    throw new Error(
      "foreign key reference must use the same number of columns",
    );
  }

  for (let index = 0; index < fromColumns.length; index += 1) {
    const fromColumn = fromColumns[index];
    const toColumn = toColumns[index];

    if (fromColumn === undefined || toColumn === undefined) {
      throw new Error("foreign key reference column metadata is incomplete");
    }

    if (
      fromColumn.kind !== toColumn.kind ||
      fromColumn.eventName !== toColumn.eventName
    ) {
      throw new Error("foreign key reference columns must have matching types");
    }
  }
}

function validateRelationReferencesKey(
  tables: Readonly<Record<string, ProjectionTableMetadata>>,
  tableName: string,
  columns: readonly string[],
): void {
  const table = tables[tableName];

  if (table === undefined) {
    throw new Error(
      `foreign key reference references unknown table ${tableName}`,
    );
  }

  const referencesKey = table.keys.some((key) => {
    return equalColumnLists(key.columns, columns);
  });

  if (!referencesKey) {
    throw new Error(
      `foreign key reference must target a primary or unique key on ${tableName}`,
    );
  }
}

function validateOnDeleteAction(
  action: ProjectionForeignKeyAction,
  fromColumns: readonly ProjectionColumnMetadata[],
): void {
  if (action !== "set_null") {
    return;
  }

  const allColumnsNullable = fromColumns.every((column) => column.nullable);

  if (!allColumnsNullable) {
    throw new Error(
      "foreign key onDelete set_null requires nullable source columns",
    );
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

function validateIndexName(name: string): void {
  if (name.length === 0) {
    throw new Error("index name must be non-empty");
  }
}

function validateProjectionSchemaIndexNames(
  tables: Readonly<Record<string, ProjectionTableMetadata>>,
): void {
  const indexNames = new Map<string, string>();

  for (const reservedTableName of reservedProjectionTableNames) {
    indexNames.set(reservedTableName, reservedTableName);
  }

  for (const table of Object.values(tables)) {
    indexNames.set(normalizeSqliteIdentifier(table.name), table.name);
  }

  for (const table of Object.values(tables)) {
    for (const index of table.indexes) {
      const normalized = normalizeSqliteIdentifier(index.name);
      if (
        reservedProjectionIndexNames.has(normalized) ||
        reservedProjectionTableNames.has(normalized)
      ) {
        throw new Error(
          `projection index name ${index.name} is reserved for ledger storage`,
        );
      }

      const existing = indexNames.get(normalized);

      if (existing !== undefined) {
        throw new Error(
          `projection index name ${index.name} conflicts with ${existing}`,
        );
      }

      indexNames.set(normalized, index.name);
    }
  }
}

function validateUniqueSqliteIdentifiers(
  context: string,
  identifiers: readonly string[],
): void {
  const names = new Map<string, string>();

  for (const identifier of identifiers) {
    const normalized = normalizeSqliteIdentifier(identifier);
    const existing = names.get(normalized);

    if (existing !== undefined) {
      throw new Error(`${context} ${identifier} conflicts with ${existing}`);
    }

    names.set(normalized, identifier);
  }
}

function normalizeSqliteIdentifier(identifier: string): string {
  return identifier.toLocaleLowerCase("en-US");
}
