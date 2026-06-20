import type { Static, TSchema } from "typebox";

import type { LedgerIndexerContext } from "./ledger.ts";

const registeredLedgerImplementationsBrand: unique symbol = Symbol(
  "sledge.registeredLedgerImplementations",
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

type RegisteredLedgerImplementationCarrier<
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, LedgerImplementationQuerySchema>,
  TEvents extends Record<string, TSchema>,
> = {
  readonly [registeredLedgerImplementationsBrand]?: LedgerImplementations<
    TIndexers,
    TQueries,
    TEvents
  >;
};

export function attachLedgerImplementations<
  TModel extends object,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, LedgerImplementationQuerySchema>,
  TEvents extends Record<string, TSchema>,
>(
  model: TModel,
  implementations: LedgerImplementations<TIndexers, TQueries, TEvents>,
): TModel {
  Object.defineProperty(model, registeredLedgerImplementationsBrand, {
    configurable: false,
    enumerable: false,
    value: implementations,
    writable: false,
  });

  return model;
}

export function readLedgerImplementations<
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, LedgerImplementationQuerySchema>,
  TEvents extends Record<string, TSchema>,
>(model: object): LedgerImplementations<TIndexers, TQueries, TEvents> {
  const carrier = model as RegisteredLedgerImplementationCarrier<
    TIndexers,
    TQueries,
    TEvents
  >;
  const implementations = carrier[registeredLedgerImplementationsBrand];

  if (implementations === undefined) {
    throw new Error("registered ledger model is missing implementations");
  }

  return implementations;
}
