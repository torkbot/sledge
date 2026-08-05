import { Type, type Static, type TSchema, type TUnsafe } from "typebox";
import { Value } from "typebox/value";

import type {
  EventPayload,
  EventToken,
  LedgerCursor,
  LedgerQuerySnapshot,
  LedgerStreamEvent,
  LedgerModuleOwner,
  QueryParameters,
  QueryResult,
  QueryToken,
} from "./ledger/ledger.ts";
import {
  LedgerHistoryExpiredError,
  readLedgerEventTokenModuleIdInternal,
  readLedgerQueryTokenModuleIdInternal,
} from "./ledger/ledger.ts";
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

/**
 * Complete terminal state of a durable computation.
 *
 * Throwing is deliberately absent: an exception belongs to the current work
 * attempt and normally requests retry. A settlement is a durable program fact.
 */
export type Settlement<TResult, TFailure> =
  | { readonly outcome: "succeeded"; readonly value: TResult }
  | { readonly outcome: "failed"; readonly error: TFailure }
  | { readonly outcome: "cancelled" };

/** Constructors for the three mutually exclusive terminal states. */
export const Settlement = Object.freeze({
  succeeded<TResult>(value: TResult): Settlement<TResult, never> {
    return { outcome: "succeeded", value };
  },

  failed<TFailure>(error: TFailure): Settlement<never, TFailure> {
    return { outcome: "failed", error };
  },

  cancelled(): Settlement<never, never> {
    return { outcome: "cancelled" };
  },
});

/** Exhaustively translates a settlement into ordinary program code. */
export function matchSettlement<TResult, TFailure, TOutput>(
  settlement: Settlement<TResult, TFailure>,
  cases: {
    readonly succeeded: (value: TResult) => TOutput;
    readonly failed: (error: TFailure) => TOutput;
    readonly cancelled: () => TOutput;
  },
): TOutput {
  if (settlement.outcome === "succeeded") {
    return cases.succeeded(settlement.value);
  }

  if (settlement.outcome === "failed") {
    return cases.failed(settlement.error);
  }

  return cases.cancelled();
}

export type ResultObservation<
  TResult = unknown,
  TOwnerModuleId extends string = string,
  TFailure = unknown,
> = Settlement<TResult, TFailure> & {
  readonly ref: ResultRef<TResult, TOwnerModuleId>;
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
  TFailure = never,
> {
  readonly event: TEvent;
  observe(
    payload: unknown,
  ): ResultObservation<TResult, TOwnerModuleId, TFailure>;
}

/** Projection reader paired with the result identity it resolves. */
export interface ResultReader<
  TResult = unknown,
  TOwnerModuleId extends string = string,
  TQuery extends QueryToken<string, string, TSchema, TSchema> = QueryToken<
    string,
    string,
    TSchema,
    TSchema
  >,
  TFailure = never,
> {
  readonly query: TQuery;
  params(ref: ResultRef<TResult, TOwnerModuleId>): QueryParameters<TQuery>;
  observe(
    result: QueryResult<TQuery>,
    ref: ResultRef<TResult, TOwnerModuleId>,
  ): ResultObservation<TResult, TOwnerModuleId, TFailure> | null;
}

interface ResultIdentity<
  TModuleId extends string,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
> {
  readonly moduleId: TModuleId;
  readonly resultSchema: TResultSchema;
  readonly failureSchema: TFailureSchema;
  readonly refSchema: TUnsafe<ResultRef<Static<TResultSchema>, TModuleId>>;
  readonly observationSchema: TUnsafe<
    ResultObservation<Static<TResultSchema>, TModuleId, Static<TFailureSchema>>
  >;
  ref(key: string): ResultRef<Static<TResultSchema>, TModuleId>;
}

/** Result identity before a producer terminal event has been selected. */
export interface DeclaredResult<
  TModuleId extends string,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
> extends ResultIdentity<TModuleId, TResultSchema, TFailureSchema> {
  fromEvent<const TEvent extends EventToken<TModuleId, string, TSchema, null>>(
    event: TEvent,
    observe: (
      payload: EventPayload<TEvent>,
    ) => ResultObservation<
      Static<TResultSchema>,
      TModuleId,
      Static<TFailureSchema>
    >,
  ): ObservedResult<TModuleId, TResultSchema, TFailureSchema, TEvent>;
}

/** Result identity after its terminal event is known but before it is readable. */
export interface ObservedResult<
  TModuleId extends string,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
  TEvent extends EventToken<TModuleId, string, TSchema, null>,
> extends ResultIdentity<TModuleId, TResultSchema, TFailureSchema> {
  readonly source: ResultSource<
    Static<TResultSchema>,
    TModuleId,
    TEvent,
    Static<TFailureSchema>
  >;

  readFrom<
    const TQuery extends QueryToken<TModuleId, string, TSchema, TSchema>,
  >(
    query: TQuery,
    input: {
      observe(
        result: QueryResult<TQuery>,
        ref: ResultRef<Static<TResultSchema>, TModuleId>,
      ): ResultObservation<
        Static<TResultSchema>,
        TModuleId,
        Static<TFailureSchema>
      > | null;
    },
  ): ResultPort<TModuleId, TResultSchema, TFailureSchema, TEvent, TQuery>;
}

/**
 * Result identity paired with its terminal event and authoritative state read.
 */
export interface ResultPort<
  TModuleId extends string,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
  TEvent extends EventToken<TModuleId, string, TSchema, null> = EventToken<
    TModuleId,
    string,
    TSchema,
    null
  >,
  TQuery extends QueryToken<TModuleId, string, TSchema, TSchema> = QueryToken<
    TModuleId,
    string,
    TSchema,
    TSchema
  >,
> extends ResultIdentity<TModuleId, TResultSchema, TFailureSchema> {
  readonly source: ResultSource<
    Static<TResultSchema>,
    TModuleId,
    TEvent,
    Static<TFailureSchema>
  >;
  readonly reader: ResultReader<
    Static<TResultSchema>,
    TModuleId,
    TQuery,
    Static<TFailureSchema>
  >;
}

/**
 * Type-erased result protocol accepted by generic composition operators.
 *
 * Concrete result ports retain their exact schemas and branded refs. This
 * shape is the common structural boundary that lets an operator consume any
 * such port and expose another port with the same terminal protocol.
 */
export interface ResultPortShape {
  readonly moduleId: string;
  readonly resultSchema: TSchema;
  readonly failureSchema: TSchema;
  readonly refSchema: TSchema;
  readonly observationSchema: TSchema;
  ref(key: string): string;
  readonly source: {
    readonly event: EventToken<string, string, TSchema, null>;
    observe(payload: unknown): ResultObservation;
  };
  readonly reader: {
    readonly query: QueryToken<string, string, TSchema, TSchema>;
    params(ref: string): unknown;
    observe(result: unknown, ref: string): ResultObservation | null;
  };
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
  const TFailureSchema extends TSchema,
>(
  module: LedgerModuleOwner<TModuleId>,
  input: {
    readonly resultSchema: TResultSchema;
    readonly failureSchema: TFailureSchema;
  },
): DeclaredResult<TModuleId, TResultSchema, TFailureSchema> {
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
  const observationSchema = Type.Unsafe<
    ResultObservation<Static<TResultSchema>, TModuleId, Static<TFailureSchema>>
  >(
    Type.Union([
      Type.Object({
        ref: refSchema,
        outcome: Type.Literal("succeeded"),
        value: input.resultSchema,
      }),
      Type.Object({
        ref: refSchema,
        outcome: Type.Literal("failed"),
        error: input.failureSchema,
      }),
      Type.Object({
        ref: refSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]),
  );
  const identity: ResultIdentity<TModuleId, TResultSchema, TFailureSchema> =
    Object.freeze({
      moduleId,
      ref,
      refSchema,
      resultSchema: input.resultSchema,
      failureSchema: input.failureSchema,
      observationSchema,
    });
  let terminalEventBound = false;
  const fromEvent = <
    const TEvent extends EventToken<TModuleId, string, TSchema, null>,
  >(
    event: TEvent,
    observe: (
      payload: EventPayload<TEvent>,
    ) => ResultObservation<
      Static<TResultSchema>,
      TModuleId,
      Static<TFailureSchema>
    >,
  ): ObservedResult<TModuleId, TResultSchema, TFailureSchema, TEvent> => {
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
      TEvent,
      Static<TFailureSchema>
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

    let readerBound = false;
    const readFrom = <
      const TQuery extends QueryToken<TModuleId, string, TSchema, TSchema>,
    >(
      query: TQuery,
      input: {
        observe(
          result: QueryResult<TQuery>,
          ref: ResultRef<Static<TResultSchema>, TModuleId>,
        ): ResultObservation<
          Static<TResultSchema>,
          TModuleId,
          Static<TFailureSchema>
        > | null;
      },
    ): ResultPort<TModuleId, TResultSchema, TFailureSchema, TEvent, TQuery> => {
      readLedgerModuleOwnerId(module);

      const queryModuleId = readLedgerQueryTokenModuleIdInternal(query);

      if (queryModuleId !== moduleId) {
        throw new Error(
          `ledger module ${moduleId} result cannot bind query owned by ${queryModuleId}`,
        );
      }

      if (!sharesLedgerModuleConstructionScope(module, query)) {
        throw new Error(
          `ledger module ${moduleId} result query does not belong to this definition`,
        );
      }

      if (readerBound) {
        throw new Error(
          `ledger module ${moduleId} result reader is already bound`,
        );
      }

      readerBound = true;
      const reader: ResultReader<
        Static<TResultSchema>,
        TModuleId,
        TQuery,
        Static<TFailureSchema>
      > = Object.freeze({
        query,
        // Readable-result queries use the one canonical `{ ref }` parameter.
        // TypeBox's conditional Static type does not reduce through a generic
        // query token, so this is the single internal assertion at that seam.
        params: (ref: ResultRef<Static<TResultSchema>, TModuleId>) =>
          ({ ref }) as QueryParameters<TQuery>,
        observe: input.observe,
      });

      return Object.freeze({
        ...identity,
        source,
        reader,
      });
    };

    return Object.freeze({
      ...identity,
      source,
      readFrom,
    });
  };
  const declared: DeclaredResult<TModuleId, TResultSchema, TFailureSchema> =
    Object.freeze({
      ...identity,
      fromEvent,
    });

  return declared;
}

type ResultQueryLedger<
  TQuery extends QueryToken<string, string, TSchema, TSchema>,
> = {
  query(
    query: TQuery,
    params: QueryParameters<TQuery>,
  ): Promise<QueryResult<TQuery>>;
};

type ResultWaitLedger<
  TQuery extends QueryToken<string, string, TSchema, TSchema>,
> = {
  querySnapshot(
    query: TQuery,
    params: QueryParameters<TQuery>,
  ): Promise<LedgerQuerySnapshot<TQuery>>;

  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<
    LedgerStreamEvent<EventToken<string, string, TSchema, TSchema | null>>
  >;
};

/** Reads the current terminal observation for one typed result, if any. */
export async function readResult<
  const TModuleId extends string,
  const TResultSchema extends TSchema,
  const TFailureSchema extends TSchema,
  const TEvent extends EventToken<TModuleId, string, TSchema, null>,
  const TQuery extends QueryToken<TModuleId, string, TSchema, TSchema>,
>(
  ledger: ResultQueryLedger<TQuery>,
  result: ResultPort<TModuleId, TResultSchema, TFailureSchema, TEvent, TQuery>,
  ref: ResultRef<Static<TResultSchema>, TModuleId>,
): Promise<ResultObservation<
  Static<TResultSchema>,
  TModuleId,
  Static<TFailureSchema>
> | null> {
  const observation = result.reader.observe(
    await ledger.query(result.reader.query, result.reader.params(ref)),
    ref,
  );

  assertRequestedObservation(ref, observation);
  return observation;
}

/**
 * Waits for one typed result without a check-then-subscribe race.
 *
 * The initial state read and stream cursor come from one storage snapshot. A
 * terminal event is therefore either represented by that state or appears
 * after the returned cursor. Explicit history expiry simply restarts from a
 * fresh authoritative snapshot.
 */
export async function waitForResult<
  const TModuleId extends string,
  const TResultSchema extends TSchema,
  const TFailureSchema extends TSchema,
  const TEvent extends EventToken<TModuleId, string, TSchema, null>,
  const TQuery extends QueryToken<TModuleId, string, TSchema, TSchema>,
>(
  ledger: ResultWaitLedger<TQuery>,
  result: ResultPort<TModuleId, TResultSchema, TFailureSchema, TEvent, TQuery>,
  ref: ResultRef<Static<TResultSchema>, TModuleId>,
  signal: AbortSignal,
): Promise<
  ResultObservation<Static<TResultSchema>, TModuleId, Static<TFailureSchema>>
> {
  signal.throwIfAborted();

  for (;;) {
    const snapshot = await ledger.querySnapshot(
      result.reader.query,
      result.reader.params(ref),
    );
    signal.throwIfAborted();

    const existing = result.reader.observe(snapshot.result, ref);
    assertRequestedObservation(ref, existing);

    if (existing !== null) {
      return existing;
    }

    try {
      for await (const item of ledger.resumeEvents({
        cursor: snapshot.cursor,
        signal,
      })) {
        if (item.event.event !== result.source.event) {
          continue;
        }

        const observation = result.source.observe(item.event.payload);

        if (observation.ref === ref) {
          return observation;
        }
      }
    } catch (error: unknown) {
      if (error instanceof LedgerHistoryExpiredError) {
        continue;
      }

      throw error;
    }

    signal.throwIfAborted();
    throw new Error(
      `ledger event stream ended while waiting for result ${ref}`,
    );
  }
}

function assertRequestedObservation<
  TResult,
  TModuleId extends string,
  TFailure,
>(
  ref: ResultRef<TResult, TModuleId>,
  observation: ResultObservation<TResult, TModuleId, TFailure> | null,
): void {
  if (observation !== null && observation.ref !== ref) {
    throw new Error(
      `result reader returned ${observation.ref} while reading ${ref}`,
    );
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
