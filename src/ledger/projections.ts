export type EventRef<TEventName extends string> = {
  readonly eventName: TEventName;
  readonly eventId: number;
};

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
  readonly __value?: TValue;
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

export type ProjectionSchemaTables<TSchema> =
  TSchema extends ProjectionSchema<infer TTables, ProjectionRelations>
    ? TTables
    : never;

export type ProjectionTableColumns<TTable> = TTable extends {
  readonly __columns?: infer TColumns;
}
  ? TColumns extends ProjectionColumns
    ? TColumns
    : never
  : never;

type AnyProjectionTableDefinition = ProjectionTableDefinition<
  ProjectionColumns,
  readonly string[]
>;

type AnyProjectionTableFactory<TEventName extends string> = (
  table: ProjectionTableBuilder<TEventName>,
) => AnyProjectionTableDefinition;

type AnyProjectionTableFactories<TEventName extends string> = Record<
  string,
  AnyProjectionTableFactory<TEventName>
>;

export type ProjectionIndexMetadata = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
};

export type ProjectionTableMetadata = {
  readonly name: string;
  readonly columns: Readonly<Record<string, ProjectionColumnMetadata>>;
  readonly primaryKey: readonly string[];
  readonly indexes: readonly ProjectionIndexMetadata[];
};

type ProjectionColumnName<TColumns extends ProjectionColumns> = Extract<
  keyof TColumns,
  string
>;

export type ProjectionTableDefinition<
  TColumns extends ProjectionColumns,
  TPrimaryKey extends readonly ProjectionColumnName<TColumns>[],
> = {
  readonly metadata: ProjectionTableMetadata;
  readonly __columns?: TColumns;
  readonly __primaryKey?: TPrimaryKey;
  index<
    const TColumnsToIndex extends readonly ProjectionColumnName<TColumns>[],
  >(
    name: string,
    columns: TColumnsToIndex,
  ): ProjectionTableDefinition<TColumns, TPrimaryKey>;
  unique<
    const TColumnsToIndex extends readonly ProjectionColumnName<TColumns>[],
  >(
    name: string,
    columns: TColumnsToIndex,
  ): ProjectionTableDefinition<TColumns, TPrimaryKey>;
};

export type ProjectionTableDraft<TColumns extends ProjectionColumns> = {
  primaryKey<
    const TPrimaryKey extends readonly ProjectionColumnName<TColumns>[],
  >(
    columns: TPrimaryKey,
  ): ProjectionTableDefinition<TColumns, TPrimaryKey>;
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

export type ProjectionTableFactory<TEventName extends string> = (
  table: ProjectionTableBuilder<TEventName>,
) => ProjectionTableDefinition<ProjectionColumns, readonly string[]>;

export type ProjectionTableFactories<TEventName extends string> = Record<
  string,
  ProjectionTableFactory<TEventName>
>;

type InferProjectionTables<
  TFactories extends ProjectionTableFactories<TEventName>,
  TEventName extends string,
> = {
  readonly [TTableName in Extract<keyof TFactories, string>]: ReturnType<
    TFactories[TTableName]
  >;
};

type ProjectionTableName<TTables> = Extract<keyof TTables, string>;

type ProjectionTableColumnName<TTable> = Extract<
  keyof ProjectionTableColumns<TTable>,
  string
>;

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
  references<const TToTableName extends ProjectionTableName<TTables>>(
    tableName: TToTableName,
    columns: CompatibleReferenceColumns<
      TTables,
      TFromTableName,
      TFromColumns,
      TToTableName
    >,
  ): ProjectionRelationDefinition;
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
> = {
  readonly metadata: ProjectionSchemaMetadata;
  readonly __tables?: TTables;
  readonly __relations?: TRelations;
  relations<const TNextRelations extends ProjectionRelations>(
    build: (relations: ProjectionRelationBuilder<TTables>) => TNextRelations,
  ): ProjectionSchema<TTables, TNextRelations>;
};

export function defineProjectionSchema<
  const TFactories extends AnyProjectionTableFactories<string>,
>(
  factories: TFactories,
): ProjectionSchema<InferProjectionTables<TFactories, string>, {}> {
  return defineProjectionSchemaInternal(factories);
}

export function defineProjectionSchemaForEvents<TEventName extends string>() {
  return <const TFactories extends AnyProjectionTableFactories<TEventName>>(
    factories: TFactories,
  ): ProjectionSchema<InferProjectionTables<TFactories, TEventName>, {}> => {
    return defineProjectionSchemaInternal(factories);
  };
}

function defineProjectionSchemaInternal<
  TEventName extends string,
  const TFactories extends AnyProjectionTableFactories<TEventName>,
>(
  factories: TFactories,
): ProjectionSchema<InferProjectionTables<TFactories, TEventName>, {}> {
  const tableBuilder = createProjectionTableBuilder<TEventName>();
  const tableMetadata: Record<string, ProjectionTableMetadata> = {};

  for (const [tableName, factory] of Object.entries(factories)) {
    const table = factory(tableBuilder);
    tableMetadata[tableName] = renameTableMetadata(table.metadata, tableName);
  }

  return createProjectionSchema(tableMetadata, {});
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
  return {
    primaryKey: (primaryKey) => {
      validateColumns("primary key", columns, primaryKey);
      return createTableDefinition({
        name: "",
        columns: metadataForColumns(columns),
        primaryKey,
        indexes: [],
      });
    },
  };
}

function createTableDefinition<
  TColumns extends ProjectionColumns,
  TPrimaryKey extends readonly ProjectionColumnName<TColumns>[],
>(
  metadata: ProjectionTableMetadata,
): ProjectionTableDefinition<TColumns, TPrimaryKey> {
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
      });
    },
  };
}

function createProjectionSchema<
  TTables,
  TRelations extends ProjectionRelations,
>(
  tables: Readonly<Record<string, ProjectionTableMetadata>>,
  relations: TRelations,
): ProjectionSchema<TTables, TRelations> {
  return {
    metadata: {
      tables,
      relations: metadataForRelations(relations),
    },
    relations: (build) => {
      const relationDefinitions = build(createRelationBuilder<TTables>(tables));
      return createProjectionSchema(tables, relationDefinitions);
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

          validateRelationColumnCompatibility(
            fromColumnsMetadata,
            toColumnsMetadata,
          );

          return createRelationDefinition({
            fromTable,
            fromColumns,
            toTable,
            toColumns,
            onDelete: "restrict",
          });
        },
      };
    },
  };
}

function createRelationDefinition(
  metadata: ProjectionForeignKeyMetadata,
): ProjectionRelationDefinition {
  return {
    metadata,
    onDelete: (action) => {
      return createRelationDefinition({
        ...metadata,
        onDelete: action,
      });
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

function validateIndexName(name: string): void {
  if (name.length === 0) {
    throw new Error("index name must be non-empty");
  }
}
