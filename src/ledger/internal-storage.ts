import type { Static, TSchema } from "typebox";

import type { LedgerIndexerContext } from "./ledger.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";

const registeredLedgerImplementationFactoryBrand: unique symbol = Symbol(
  "sledge.registeredLedgerImplementationFactory",
);
const registeredLedgerProjectionCompilerFactoryBrand: unique symbol = Symbol(
  "sledge.registeredLedgerProjectionCompilerFactory",
);
const registeredLedgerProjectionSchemasBrand: unique symbol = Symbol(
  "sledge.registeredLedgerProjectionSchemas",
);
const ledgerModelResolvers = new WeakMap<object, unknown>();
const preparedLedgerModelStates = new WeakMap<object, unknown>();
export const registeredLedgerContractsBrand: unique symbol = Symbol(
  "sledge.registeredLedgerContracts",
);
export const composedLedgerModulesBrand: unique symbol = Symbol(
  "sledge.composedLedgerModules",
);
export const registeredLedgerRuntimeBrand: unique symbol = Symbol(
  "sledge.registeredLedgerRuntime",
);
export const storageRuntimeIdentityBrand: unique symbol = Symbol(
  "sledge.storageRuntimeIdentity",
);

/**
 * Keeps model-resolution behavior out of the public definition value. The
 * weak association also makes definitions opaque and non-serializable: they
 * are process-local construction plans, never durable ledger state.
 */
export function attachLedgerModelResolver<
  TDefinition extends object,
  TResolver,
>(definition: TDefinition, resolver: TResolver): TDefinition {
  ledgerModelResolvers.set(definition, resolver);
  return definition;
}

export function readLedgerModelResolver<TResolver>(
  definition: object,
): TResolver | undefined {
  return ledgerModelResolvers.get(definition) as TResolver | undefined;
}

/**
 * Associates a prepared model capability with the adapter-owned runtime that
 * produced it. Resolution ports reject values from another resolution run.
 */
export function attachPreparedLedgerModelState<
  TPrepared extends object,
  TState,
>(prepared: TPrepared, state: TState): TPrepared {
  preparedLedgerModelStates.set(prepared, state);
  return prepared;
}

export function readPreparedLedgerModelState<TState>(
  prepared: object,
): TState | undefined {
  return preparedLedgerModelStates.get(prepared) as TState | undefined;
}

export type LedgerStorageRow = Record<string, unknown>;

export interface LedgerStorageStatement {
  run(...params: unknown[]): Promise<{
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }>;

  get(...params: unknown[]): Promise<LedgerStorageRow | undefined>;

  all(...params: unknown[]): Promise<readonly LedgerStorageRow[]>;
}

export interface LedgerStorageScope {
  exec(sql: string): Promise<void>;

  prepare(sql: string): LedgerStorageStatement;
}

type LedgerImplementationQuerySchema = {
  readonly params: TSchema;
  readonly result: TSchema;
};

export type LedgerImplementations<
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, LedgerImplementationQuerySchema> = {},
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly indexers?: {
    readonly [TIndexName in keyof TIndexers]: (
      scope: LedgerStorageScope,
      input: Static<TIndexers[TIndexName]>,
      context: LedgerIndexerContext<TEvents>,
    ) => void | Promise<void>;
  };

  readonly queries?: {
    readonly [TQueryName in keyof TQueries]: (
      scope: LedgerStorageScope,
      params: Static<TQueries[TQueryName]["params"]>,
    ) => unknown | Promise<unknown>;
  };
};

export type LedgerImplementationFactory<
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, LedgerImplementationQuerySchema> = {},
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = (input: {
  readonly statementCompiler: ProjectionStatementCompiler;
}) => LedgerImplementations<TIndexers, TQueries, TEvents>;

type RegisteredLedgerImplementationCarrier<
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, LedgerImplementationQuerySchema>,
  TEvents extends Record<string, TSchema>,
> = {
  readonly [registeredLedgerImplementationFactoryBrand]?: LedgerImplementationFactory<
    TIndexers,
    TQueries,
    TEvents
  >;
};

type RegisteredLedgerProjectionCompilerCarrier = {
  readonly [registeredLedgerProjectionCompilerFactoryBrand]?: (
    compiler: ProjectionStatementCompiler,
  ) => ProjectionStatementCompiler;
};

type RegisteredLedgerProjectionSchemasCarrier = {
  readonly [registeredLedgerProjectionSchemasBrand]?: {
    readonly events: Readonly<Record<string, TSchema>>;
    readonly signals: Readonly<Record<string, TSchema>>;
  };
};

export function attachLedgerImplementationFactory<
  TModel extends object,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, LedgerImplementationQuerySchema>,
  TEvents extends Record<string, TSchema>,
>(
  model: TModel,
  factory: LedgerImplementationFactory<TIndexers, TQueries, TEvents>,
): TModel {
  Object.defineProperty(model, registeredLedgerImplementationFactoryBrand, {
    configurable: false,
    enumerable: false,
    value: factory,
    writable: false,
  });

  return model;
}

export function readLedgerImplementations<
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, LedgerImplementationQuerySchema>,
  TEvents extends Record<string, TSchema>,
>(
  model: object,
  input: {
    readonly statementCompiler: ProjectionStatementCompiler;
  },
): LedgerImplementations<TIndexers, TQueries, TEvents> {
  const carrier = model as RegisteredLedgerImplementationCarrier<
    TIndexers,
    TQueries,
    TEvents
  >;
  const factory = carrier[registeredLedgerImplementationFactoryBrand];

  if (factory === undefined) {
    throw new Error(
      "registered ledger model is missing implementation factory",
    );
  }

  return factory(input);
}

export function attachLedgerProjectionCompilerFactory<TModel extends object>(
  model: TModel,
  factory: (
    compiler: ProjectionStatementCompiler,
  ) => ProjectionStatementCompiler,
): TModel {
  Object.defineProperty(model, registeredLedgerProjectionCompilerFactoryBrand, {
    configurable: false,
    enumerable: false,
    value: factory,
    writable: false,
  });

  return model;
}

export function readLedgerProjectionCompiler(
  model: object,
  compiler: ProjectionStatementCompiler,
): ProjectionStatementCompiler {
  const carrier = model as RegisteredLedgerProjectionCompilerCarrier;
  const factory = carrier[registeredLedgerProjectionCompilerFactoryBrand];

  if (factory === undefined) {
    throw new Error(
      "registered ledger model is missing projection compiler factory",
    );
  }

  return factory(compiler);
}

export function attachLedgerProjectionSchemas<TModel extends object>(
  model: TModel,
  schemas: {
    readonly events: Readonly<Record<string, TSchema>>;
    readonly signals: Readonly<Record<string, TSchema>>;
  },
): TModel {
  Object.defineProperty(model, registeredLedgerProjectionSchemasBrand, {
    configurable: false,
    enumerable: false,
    value: schemas,
    writable: false,
  });

  return model;
}

export function readLedgerProjectionSchemas(model: object): {
  readonly events: Readonly<Record<string, TSchema>>;
  readonly signals: Readonly<Record<string, TSchema>>;
} {
  const carrier = model as RegisteredLedgerProjectionSchemasCarrier;
  const schemas = carrier[registeredLedgerProjectionSchemasBrand];

  if (schemas === undefined) {
    throw new Error("registered ledger model is missing projection schemas");
  }

  return schemas;
}
