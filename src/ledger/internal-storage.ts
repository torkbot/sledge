import type { Static, TSchema } from "typebox";

import type { LedgerIndexerContext } from "./ledger.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";

const registeredLedgerImplementationFactoryBrand: unique symbol = Symbol(
  "sledge.registeredLedgerImplementationFactory",
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
