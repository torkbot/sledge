import type { Static, TSchema } from "typebox";

import type {
  AnyRegisteredLedgerModule,
  LedgerIndexerContext,
  LedgerTiming,
} from "./ledger.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";
import type {
  LedgerApplication,
  LedgerApplicationCapabilities,
  LedgerApplicationModules,
  LedgerDriver,
  OpenedLedger,
} from "../sledge.ts";

const registeredLedgerImplementationFactoryBrand: unique symbol = Symbol(
  "sledge.registeredLedgerImplementationFactory",
);
const registeredLedgerProjectionCompilerFactoryBrand: unique symbol = Symbol(
  "sledge.registeredLedgerProjectionCompilerFactory",
);
const registeredLedgerProjectionSchemasBrand: unique symbol = Symbol(
  "sledge.registeredLedgerProjectionSchemas",
);
const ledgerApplicationConfigureFunctions = new WeakMap<object, unknown>();
const ledgerDriverOpenFunctions = new WeakMap<object, LedgerDriverOpen>();
const ledgerModuleOwnerReaders = new WeakMap<object, () => string>();
// Scoped link provenance flows privately into the registered carrier. This
// lets reveal validate construction ownership without adding public brands or
// mutable owner fields to any ledger phase.
const ledgerModuleConstructionScopes = new WeakMap<object, object>();
const ledgerModuleContributions = new WeakSet<object>();
const ledgerModuleComposers = new WeakMap<
  object,
  (first: object, ...rest: readonly object[]) => object
>();
export const registeredLedgerContractsBrand: unique symbol = Symbol(
  "sledge.registeredLedgerContracts",
);
export const composedLedgerModulesBrand: unique symbol = Symbol(
  "sledge.composedLedgerModules",
);
export const registeredLedgerRuntimeBrand: unique symbol = Symbol(
  "sledge.registeredLedgerRuntime",
);

export function attachLedgerApplicationConfigure<
  TApplication extends object,
  TConfigure,
>(application: TApplication, configure: TConfigure): TApplication {
  ledgerApplicationConfigureFunctions.set(application, configure);
  return application;
}

export function readLedgerApplicationConfigure<TConfigure>(
  application: object,
): TConfigure | undefined {
  return ledgerApplicationConfigureFunctions.get(application) as
    | TConfigure
    | undefined;
}

export type LedgerDriverOpen = <
  const TApplication extends LedgerApplication<
    object,
    AnyRegisteredLedgerModule
  >,
>(input: {
  readonly application: TApplication;
  readonly timing: LedgerTiming;
}) => Promise<
  OpenedLedger<
    LedgerApplicationCapabilities<TApplication>,
    LedgerApplicationModules<TApplication>
  >
>;

export function attachLedgerDriverOpen<TDriver extends object>(
  driver: TDriver,
  open: LedgerDriverOpen,
): TDriver {
  ledgerDriverOpenFunctions.set(driver, open);
  return driver;
}

export function createLedgerDriver(open: LedgerDriverOpen): LedgerDriver {
  // The public brand prevents callers from constructing a driver. Runtime
  // authenticity is enforced independently by this private open registry.
  const driver = {} as LedgerDriver;
  attachLedgerDriverOpen(driver, open);
  return Object.freeze(driver);
}

export function readLedgerDriverOpen(
  driver: object,
): LedgerDriverOpen | undefined {
  return ledgerDriverOpenFunctions.get(driver);
}

export function attachLedgerModuleOwner<TModuleOwner extends object>(
  owner: TModuleOwner,
  readModuleId: () => string,
): TModuleOwner {
  ledgerModuleOwnerReaders.set(owner, readModuleId);
  return owner;
}

export function readLedgerModuleOwnerId<TModuleId extends string>(owner: {
  readonly moduleId: TModuleId;
}): TModuleId {
  const readModuleId = ledgerModuleOwnerReaders.get(owner);

  if (readModuleId === undefined) {
    throw new Error("invalid ledger module owner");
  }

  return readModuleId() as TModuleId;
}

export function attachLedgerModuleConstructionScope<TValue extends object>(
  value: TValue,
  scope: object,
): TValue {
  ledgerModuleConstructionScopes.set(value, scope);
  return value;
}

export function inheritLedgerModuleConstructionScope(
  source: object,
  target: object,
): void {
  const scope = ledgerModuleConstructionScopes.get(source);

  if (scope !== undefined) {
    ledgerModuleConstructionScopes.set(target, scope);
  }
}

export function belongsToLedgerModuleConstructionScope(
  value: object,
  scope: object,
): boolean {
  return ledgerModuleConstructionScopes.get(value) === scope;
}

export function sharesLedgerModuleConstructionScope(
  left: object,
  right: object,
): boolean {
  const scope = ledgerModuleConstructionScopes.get(left);

  return (
    scope !== undefined && ledgerModuleConstructionScopes.get(right) === scope
  );
}

export function attachLedgerModuleContribution<TContribution extends object>(
  contribution: TContribution,
): TContribution {
  ledgerModuleContributions.add(contribution);
  return contribution;
}

export function isLedgerModuleContribution(contribution: object): boolean {
  return ledgerModuleContributions.has(contribution);
}

/**
 * Gives each registered module the internal graph-construction capability
 * needed by adapter-owned assembly without exposing another public API.
 */
export function attachLedgerModuleComposer(
  module: object,
  compose: (first: object, ...rest: readonly object[]) => object,
): void {
  ledgerModuleComposers.set(module, compose);
}

export function isRegisteredLedgerModule(module: object): boolean {
  return ledgerModuleComposers.has(module);
}

export function composeRegisteredLedgerModules(
  first: object,
  ...rest: readonly object[]
): object {
  const compose = ledgerModuleComposers.get(first);

  if (compose === undefined) {
    throw new Error("registered ledger module cannot compose a graph");
  }

  return compose(first, ...rest);
}
export const storageRuntimeIdentityBrand: unique symbol = Symbol(
  "sledge.storageRuntimeIdentity",
);

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
