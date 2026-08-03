import { Type, type Static, type TSchema, type TUnsafe } from "typebox";
import { Value } from "typebox/value";

import type {
  EventPayload,
  EventToken,
  LedgerModuleOwner,
} from "./ledger/ledger.ts";
import { readLedgerEventTokenModuleIdInternal } from "./ledger/ledger.ts";
import {
  readLedgerModuleOwnerId,
  sharesLedgerModuleConstructionScope,
} from "./ledger/internal-storage.ts";
import { ledgerIdentitySeparator } from "./ledger/ledger-identity.ts";

const resultRefBrand: unique symbol = Symbol("sledge.stdlib.resultRef");
const resultOwners = new WeakSet<object>();

/**
 * Stable identity of one producer-owned durable result.
 *
 * The producer module and result payload are phantom types. They prevent refs
 * owned by different modules from being interchanged even when those modules
 * happen to return the same payload shape.
 */
export type ResultRef<
  TResult,
  TOwnerModuleId extends string = string,
> = string & {
  readonly [resultRefBrand]: {
    readonly ownerModuleId: TOwnerModuleId;
    readonly result: TResult;
  };
};

export const AnyResultRefSchema = Type.Unsafe<ResultRef<unknown>>(
  Type.String({
    minLength: 4,
    pattern: `^[\\s\\S]+${ledgerIdentitySeparator}[\\s\\S]+$`,
  }),
);

export const ResultOutcomeSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export type ResultOutcome = Static<typeof ResultOutcomeSchema>;

export type ResultObservation<
  TResult = unknown,
  TOwnerModuleId extends string = string,
> =
  | {
      readonly ref: ResultRef<TResult, TOwnerModuleId>;
      readonly outcome: "succeeded";
      readonly value: TResult;
    }
  | {
      readonly ref: ResultRef<TResult, TOwnerModuleId>;
      readonly outcome: "failed" | "cancelled";
    };

/**
 * Producer-owned terminal event viewed through the small contract needed by
 * generic result consumers such as joins and races.
 */
export interface ResultSource<
  TResult = unknown,
  TOwnerModuleId extends string = string,
  TEvent extends EventToken<TOwnerModuleId, string, TSchema, null> = EventToken<
    TOwnerModuleId,
    string,
    TSchema,
    null
  >,
> {
  readonly event: TEvent;
  observe(payload: unknown): ResultObservation<TResult, TOwnerModuleId>;
}

interface ResultIdentity<
  TModuleId extends string,
  TResultSchema extends TSchema,
> {
  readonly moduleId: TModuleId;
  readonly resultSchema: TResultSchema;
  readonly refSchema: TUnsafe<ResultRef<Static<TResultSchema>, TModuleId>>;
  ref(key: string): ResultRef<Static<TResultSchema>, TModuleId>;
}

/** Result identity before a producer terminal event has been selected. */
export interface DeclaredResult<
  TModuleId extends string,
  TResultSchema extends TSchema,
> extends ResultIdentity<TModuleId, TResultSchema> {
  fromEvent<const TEvent extends EventToken<TModuleId, string, TSchema, null>>(
    event: TEvent,
    observe: (
      payload: EventPayload<TEvent>,
    ) => ResultObservation<Static<TResultSchema>, TModuleId>,
  ): ResultPort<TModuleId, TResultSchema, TEvent>;
}

/** Result identity paired with the producer's one terminal event contract. */
export interface ResultPort<
  TModuleId extends string,
  TResultSchema extends TSchema,
  TEvent extends EventToken<TModuleId, string, TSchema, null> = EventToken<
    TModuleId,
    string,
    TSchema,
    null
  >,
> extends ResultIdentity<TModuleId, TResultSchema> {
  readonly source: ResultSource<Static<TResultSchema>, TModuleId, TEvent>;
}

/**
 * Declares the result capability owned by one ledger module.
 *
 * Calling `fromEvent(...)` once consumes this incomplete phase and returns a
 * new immutable capability. A single terminal contract per module keeps result
 * identity unambiguous without adding another durable name.
 */
export function defineResult<
  const TModuleId extends string,
  const TResultSchema extends TSchema,
>(
  module: LedgerModuleOwner<TModuleId>,
  input: {
    readonly resultSchema: TResultSchema;
  },
): DeclaredResult<TModuleId, TResultSchema> {
  const moduleId = readLedgerModuleOwnerId(module);

  if (resultOwners.has(module)) {
    throw new Error(`ledger module ${moduleId} already defines a result`);
  }

  resultOwners.add(module);

  const escapedModuleId = escapeRegularExpression(moduleId);
  const refSchema = Type.Unsafe<ResultRef<Static<TResultSchema>, TModuleId>>(
    Type.String({
      minLength: moduleId.length + ledgerIdentitySeparator.length + 1,
      pattern: `^${escapedModuleId}${ledgerIdentitySeparator}[\\s\\S]+$`,
    }),
  );
  const ref = (key: string): ResultRef<Static<TResultSchema>, TModuleId> => {
    if (key.length === 0) {
      throw new Error("result key must not be empty");
    }

    return Value.Decode(
      refSchema,
      `${moduleId}${ledgerIdentitySeparator}${key}`,
    );
  };
  const identity: ResultIdentity<TModuleId, TResultSchema> = Object.freeze({
    moduleId,
    ref,
    refSchema,
    resultSchema: input.resultSchema,
  });
  let terminalEventBound = false;
  const fromEvent = <
    const TEvent extends EventToken<TModuleId, string, TSchema, null>,
  >(
    event: TEvent,
    observe: (
      payload: EventPayload<TEvent>,
    ) => ResultObservation<Static<TResultSchema>, TModuleId>,
  ): ResultPort<TModuleId, TResultSchema, TEvent> => {
    readLedgerModuleOwnerId(module);

    const eventModuleId = readLedgerEventTokenModuleIdInternal(event);

    if (eventModuleId !== moduleId) {
      throw new Error(
        `ledger module ${moduleId} result cannot bind event owned by ${eventModuleId}`,
      );
    }

    if (!sharesLedgerModuleConstructionScope(module, event)) {
      throw new Error(
        `ledger module ${moduleId} result event does not belong to this definition`,
      );
    }

    if (terminalEventBound) {
      throw new Error(`ledger module ${moduleId} result is already bound`);
    }

    terminalEventBound = true;
    const source: ResultSource<
      Static<TResultSchema>,
      TModuleId,
      TEvent
    > = Object.freeze({
      event,
      observe: (payload: unknown) => {
        // The exact event token and decoder enter this closure together.
        // Sledge validates that token's payload before invoking an event
        // contribution; this assertion erases the existential event type
        // only after that boundary.
        return observe(payload as EventPayload<TEvent>);
      },
    });

    return Object.freeze({
      ...identity,
      source,
    });
  };
  const declared: DeclaredResult<TModuleId, TResultSchema> = Object.freeze({
    ...identity,
    fromEvent,
  });

  return declared;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
