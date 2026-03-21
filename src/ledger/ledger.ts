import type { Static, TSchema } from "@sinclair/typebox";

import type { RuntimeClock, RuntimeScheduler } from "../runtime/contracts.ts";

/**
 * Optional knobs for producer-side event emission.
 */
export type EmitOptions = {
  readonly dedupeKey?: string;
};

/**
 * Optional knobs for event->work materialization.
 */
export type EnqueueOptions = {
  readonly availableAtMs?: number;
};

/**
 * One query contract definition.
 */
export type QuerySchema<
  TParamsSchema extends TSchema,
  TResultSchema extends TSchema,
> = {
  readonly params: TParamsSchema;
  readonly result: TResultSchema;
};

type AnyQuerySchema = QuerySchema<TSchema, TSchema>;

/**
 * Index input schema keyed in model definitions.
 */
export type IndexerDefinition<TInputSchema extends TSchema> = TInputSchema;

/**
 * Query contract keyed in model definitions.
 */
export type QueryDefinition<
  TParamsSchema extends TSchema,
  TResultSchema extends TSchema,
> = QuerySchema<TParamsSchema, TResultSchema>;

/**
 * Durable event envelope shared by projectors and materializers.
 */
export type EventEnvelope<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents,
> = {
  readonly eventId: number;
  readonly tsMs: number;
  readonly eventName: TEventName;
  readonly payload: Static<TEvents[TEventName]>;
  readonly causationEventId: number | null;
  readonly dedupeKey: string | null;
};

/**
 * Queue work payload passed into one handler attempt.
 */
export type QueueWorkItem<
  TQueues extends Record<string, TSchema>,
  TQueueName extends keyof TQueues,
> = {
  readonly workId: number;
  readonly queueName: TQueueName;
  readonly payload: Static<TQueues[TQueueName]>;
  readonly attempt: number;
  readonly sourceEventId: number;
};

/**
 * Queue work lease metadata for one active work attempt.
 */
export interface LeaseHold extends AsyncDisposable {
  /**
   * Cancellation signal for the held lease. This aliases the parent lease
   * signal so call sites can thread `leaseHold.signal` and make the hold scope
   * visibly meaningful in code.
   */
  readonly signal: AbortSignal;
}

export interface WorkLease<
  TQueues extends Record<string, TSchema>,
  TQueueName extends keyof TQueues,
> {
  readonly workId: number;
  readonly queueName: TQueueName;
  readonly sourceEventId: number;
  readonly attempt: number;
  readonly leaseId: string;
  readonly leaseAcquiredAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly signal: AbortSignal;

  /**
   * Hold and actively renew this lease until the returned scope is disposed.
   *
   * Handlers should use `await using` for long-running operations (LLM streams,
   * external API calls, etc.) to prevent lease expiry while still allowing
   * cooperative cancellation through `signal`.
   */
  hold(): LeaseHold;
}

/**
 * Runtime implementations bound to index and query schema contracts.
 */
export type LedgerImplementations<
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> = {
  readonly indexers: {
    readonly [TIndexName in keyof TIndexers]: (
      input: Static<TIndexers[TIndexName]>,
    ) => void | Promise<void>;
  };

  readonly queries: {
    readonly [TQueryName in keyof TQueries]: (
      params: Static<TQueries[TQueryName]["params"]>,
    ) => unknown | Promise<unknown>;
  };
};

/**
 * Runtime actions available while handling one queue work attempt.
 */
export interface QueueActions<
  TEvents extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> {
  emit<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    event: Static<TEvents[TEventName]>,
    options?: EmitOptions,
  ): void;

  query<const TQueryName extends keyof TQueries>(
    queryName: TQueryName,
    params: Static<TQueries[TQueryName]["params"]>,
  ): Promise<Static<TQueries[TQueryName]["result"]>>;
}

/**
 * Runtime actions available while projecting an event into indexes.
 */
export interface ProjectionActions<TIndexers extends Record<string, TSchema>> {
  index<const TIndexName extends keyof TIndexers>(
    indexName: TIndexName,
    input: Static<TIndexers[TIndexName]>,
  ): Promise<void>;
}

/**
 * Explicit completion result for one queue work attempt.
 */
export type QueueHandlerOutcome =
  | { readonly outcome: "ack" }
  | {
      readonly outcome: "retry";
      readonly error: string;
      readonly retryAtMs?: number;
    }
  | { readonly outcome: "dead_letter"; readonly error: string };

/**
 * Ledger model definition surface.
 */
export interface LedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> {
  readonly events: TEvents;
  readonly queues: TQueues;
  readonly indexers: TIndexers;
  readonly queries: TQueries;
}

/**
 * Event->work materialization function.
 */
export type MaterializerFunction<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents,
  TQueues extends Record<string, TSchema>,
> = (input: {
  readonly event: EventEnvelope<TEvents, TEventName>;
  readonly actions: {
    readonly enqueue: <const TQueueName extends keyof TQueues>(
      queueName: TQueueName,
      payload: Static<TQueues[TQueueName]>,
      options?: EnqueueOptions,
    ) => void;
  };
}) => void | Promise<void>;

/**
 * Event->index projection function.
 */
export type ProjectorFunction<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents,
  TIndexers extends Record<string, TSchema>,
> = (input: {
  readonly event: EventEnvelope<TEvents, TEventName>;
  readonly actions: ProjectionActions<TIndexers>;
}) => void | Promise<void>;

/**
 * Queue work handler function.
 */
export type QueueHandlerFunction<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TQueueName extends keyof TQueues,
  TQueries extends Record<string, AnyQuerySchema>,
> = (input: {
  readonly work: QueueWorkItem<TQueues, TQueueName>;
  readonly lease: WorkLease<TQueues, TQueueName>;
  readonly actions: QueueActions<TEvents, TQueries>;
}) => QueueHandlerOutcome | Promise<QueueHandlerOutcome>;

/**
 * Builder API used to register model behavior.
 */
export interface LedgerBuilder<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> {
  project<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    projector: ProjectorFunction<TEvents, TEventName, TIndexers>,
  ): this;

  materialize<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    materializer: MaterializerFunction<TEvents, TEventName, TQueues>,
  ): this;

  handle<const TQueueName extends keyof TQueues>(
    queueName: TQueueName,
    handler: QueueHandlerFunction<TEvents, TQueues, TQueueName, TQueries>,
  ): this;
}

/**
 * Registration callback used to define model behavior.
 */
export type RegisterFunction<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> = (builder: LedgerBuilder<TEvents, TQueues, TIndexers, TQueries>) => void;

/**
 * Running ledger runtime surface.
 */
export interface Ledger<
  TEvents extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> extends AsyncDisposable {
  emit<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    event: Static<TEvents[TEventName]>,
    options?: EmitOptions,
  ): Promise<void>;

  query<const TQueryName extends keyof TQueries>(
    queryName: TQueryName,
    params: Static<TQueries[TQueryName]["params"]>,
  ): Promise<Static<TQueries[TQueryName]["result"]>>;

  close(): Promise<void>;
}

/**
 * Runtime dependencies injected into ledger orchestration.
 */
export type LedgerTiming = {
  readonly clock: RuntimeClock;
  readonly scheduler: RuntimeScheduler;
};

/**
 * SQLite contention retry tuning for busy lock conflicts.
 */
export type BusyRetryPolicy = {
  /**
   * Maximum number of retries after a SQLITE_BUSY conflict before failing.
   */
  readonly maxBusyRetries?: number;

  /**
   * Upper bound for exponential backoff between SQLITE_BUSY retries.
   */
  readonly maxBusyRetryDelayMs?: number;
};

export type BoundLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> = {
  readonly model: LedgerModel<TEvents, TQueues, TIndexers, TQueries>;
  readonly register: RegisterFunction<TEvents, TQueues, TIndexers, TQueries>;
  readonly implementations: LedgerImplementations<TIndexers, TQueries>;
};

export type DefinedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
> = {
  readonly model: LedgerModel<TEvents, TQueues, TIndexers, TQueries>;
  readonly register: RegisterFunction<TEvents, TQueues, TIndexers, TQueries>;

  bind(
    implementations: LedgerImplementations<TIndexers, TQueries>,
  ): BoundLedgerModel<TEvents, TQueues, TIndexers, TQueries>;
};

export function defineLedgerModel<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, TSchema>,
  const TQueries extends Record<string, AnyQuerySchema>,
>(input: {
  readonly events: TEvents;
  readonly queues: TQueues;
  readonly indexers: TIndexers;
  readonly queries: TQueries;
  readonly register: RegisterFunction<TEvents, TQueues, TIndexers, TQueries>;
}): DefinedLedgerModel<TEvents, TQueues, TIndexers, TQueries> {
  const model: LedgerModel<TEvents, TQueues, TIndexers, TQueries> = {
    events: input.events,
    queues: input.queues,
    indexers: input.indexers,
    queries: input.queries,
  };

  return {
    model,
    register: input.register,
    bind: (implementations) => {
      return {
        model,
        register: input.register,
        implementations,
      };
    },
  };
}

/**
 * Backend runtime factory capability.
 */
export interface LedgerEngineFactory {
  openLedger<
    TEvents extends Record<string, TSchema>,
    TQueues extends Record<string, TSchema>,
    TIndexers extends Record<string, TSchema>,
    TQueries extends Record<string, AnyQuerySchema>,
  >(input: {
    readonly boundModel: BoundLedgerModel<
      TEvents,
      TQueues,
      TIndexers,
      TQueries
    >;
    readonly timing: LedgerTiming;
    readonly leaseMs?: number;
    readonly defaultRetryDelayMs?: number;
    readonly maxInFlight?: number;
    readonly maxBusyRetries?: number;
    readonly maxBusyRetryDelayMs?: number;
  }): Ledger<TEvents, TQueries>;
}

export function createLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, TSchema>,
  const TQueries extends Record<string, AnyQuerySchema>,
>(input: {
  readonly boundModel: BoundLedgerModel<TEvents, TQueues, TIndexers, TQueries>;
  readonly engineFactory: LedgerEngineFactory;
  readonly timing: LedgerTiming;
  readonly leaseMs?: number;
  readonly defaultRetryDelayMs?: number;
  readonly maxInFlight?: number;
  readonly maxBusyRetries?: number;
  readonly maxBusyRetryDelayMs?: number;
}): Ledger<TEvents, TQueries> {
  return input.engineFactory.openLedger({
    boundModel: input.boundModel,
    timing: input.timing,
    leaseMs: input.leaseMs,
    defaultRetryDelayMs: input.defaultRetryDelayMs,
    maxInFlight: input.maxInFlight,
    maxBusyRetries: input.maxBusyRetries,
    maxBusyRetryDelayMs: input.maxBusyRetryDelayMs,
  });
}
