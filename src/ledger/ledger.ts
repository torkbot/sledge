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
 * Durable event envelope shared by event/signal registration handlers.
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
}

/**
 * Runtime implementations bound to index and query schema contracts.
 */
export type LedgerImplementations<
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, AnyQuerySchema> = {},
> = {
  readonly indexers?: {
    readonly [TIndexName in keyof TIndexers]: (
      input: Static<TIndexers[TIndexName]>,
    ) => void | Promise<void>;
  };

  readonly queries?: {
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
  TSignals extends Record<string, TSchema> = {},
> {
  emit<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    event: Static<TEvents[TEventName]>,
    options?: EmitOptions,
  ): void;

  emitSignal<const TSignalName extends keyof TSignals>(
    signalName: TSignalName,
    signal: Static<TSignals[TSignalName]>,
    options?: EmitOptions,
  ): void;

  query<const TQueryName extends keyof TQueries>(
    queryName: TQueryName,
    params: Static<TQueries[TQueryName]["params"]>,
  ): Promise<Static<TQueries[TQueryName]["result"]>>;
}

/**
 * Runtime actions available while handling one signal queue work attempt.
 */
export interface SignalQueueActions<
  TQueries extends Record<string, AnyQuerySchema>,
> {
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

export type QueueHandlerRetryOptions = {
  readonly retryAtMs?: number;
};

/**
 * Explicit queue control methods for non-default outcomes.
 */
export interface QueueHandlerControl {
  retry(error: unknown, options?: QueueHandlerRetryOptions): never;
  deadLetter(error: unknown): never;
}

/**
 * Explicit signal queue control methods for non-default outcomes.
 */
export interface SignalQueueHandlerControl {
  retry(error: unknown, options?: QueueHandlerRetryOptions): never;
}

/**
 * Ledger model definition surface.
 */
export interface LedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, AnyQuerySchema> = {},
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> {
  readonly events: TEvents;
  readonly signals: TSignals;
  readonly queues: TQueues;
  readonly signalQueues: TSignalQueues;
  readonly indexers: TIndexers;
  readonly queries: TQueries;
}

/**
 * Event registration function. This is the single event-side orchestration
 * hook and may both write projections and enqueue durable work.
 */
export type EventHandlerFunction<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents,
  TIndexers extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
> = (input: {
  readonly event: EventEnvelope<TEvents, TEventName>;
  readonly actions: ProjectionActions<TIndexers> & {
    readonly enqueue: <const TQueueName extends keyof TQueues>(
      queueName: TQueueName,
      payload: Static<TQueues[TQueueName]>,
      options?: EnqueueOptions,
    ) => void;
  };
}) => void | Promise<void>;

/**
 * Signal registration function for signal->signal-queue materialization.
 */
export type SignalHandlerFunction<
  TSignals extends Record<string, TSchema>,
  TSignalName extends keyof TSignals,
  TSignalQueues extends Record<string, TSchema>,
> = (input: {
  readonly event: EventEnvelope<TSignals, TSignalName>;
  readonly actions: {
    readonly enqueueSignal: <
      const TSignalQueueName extends keyof TSignalQueues,
    >(
      queueName: TSignalQueueName,
      payload: Static<TSignalQueues[TSignalQueueName]>,
      options?: EnqueueOptions,
    ) => void;
  };
}) => void | Promise<void>;

/**
 * Queue work handler function.
 */
export type QueueHandlerFunction<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TQueueName extends keyof TQueues,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
> = (input: {
  readonly work: QueueWorkItem<TQueues, TQueueName>;
  readonly lease: WorkLease<TQueues, TQueueName>;
  readonly actions: QueueActions<TEvents, TQueries, TSignals>;
  readonly control: QueueHandlerControl;
}) => void | Promise<void>;

/**
 * Signal queue work handler function.
 */
export type SignalQueueHandlerFunction<
  TSignalQueues extends Record<string, TSchema>,
  TSignalQueueName extends keyof TSignalQueues,
  TQueries extends Record<string, AnyQuerySchema>,
> = (input: {
  readonly work: QueueWorkItem<TSignalQueues, TSignalQueueName>;
  readonly lease: WorkLease<TSignalQueues, TSignalQueueName>;
  readonly actions: SignalQueueActions<TQueries>;
  readonly control: SignalQueueHandlerControl;
}) => void | Promise<void>;

/**
 * Declarative model registration keyed by event/queue names.
 */
export type RegisterFunction<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> = {
  readonly events?: {
    readonly [TEventName in keyof TEvents]?: EventHandlerFunction<
      TEvents,
      TEventName,
      TIndexers,
      TQueues
    >;
  };
  readonly signals?: {
    readonly [TSignalName in keyof TSignals]?: SignalHandlerFunction<
      TSignals,
      TSignalName,
      TSignalQueues
    >;
  };
  readonly queues?: {
    readonly [TQueueName in keyof TQueues]?: QueueHandlerFunction<
      TEvents,
      TQueues,
      TQueueName,
      TQueries,
      TSignals
    >;
  };
  readonly signalQueues?: {
    readonly [TSignalQueueName in keyof TSignalQueues]?: SignalQueueHandlerFunction<
      TSignalQueues,
      TSignalQueueName,
      TQueries
    >;
  };
};
/**
 * Running ledger runtime surface.
 */
export type LedgerCursor = string;

export type LedgerStreamEvent<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents = keyof TEvents,
> = {
  readonly event: EventEnvelope<TEvents, TEventName>;
  /**
   * Opaque resume token. Treat this as an implementation detail and persist it
   * as-is for resume operations.
   */
  readonly cursor: LedgerCursor;
};

export interface SignalSubscription {
  [Symbol.dispose](): void;
}

export type SignalObserverFunction<
  TSignals extends Record<string, TSchema>,
  TSignalName extends keyof TSignals = keyof TSignals,
> = (signal: EventEnvelope<TSignals, TSignalName>) => void | Promise<void>;

export interface Ledger<
  TEvents extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
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

  onSignal<const TSignalName extends keyof TSignals>(
    signalName: TSignalName,
    observer: SignalObserverFunction<TSignals, TSignalName>,
  ): SignalSubscription;

  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<TEvents>>;

  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<TEvents>>;

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

export type DefinedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> = {
  readonly model: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
};

export type RegisteredLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, AnyQuerySchema> = {},
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> = {
  readonly model: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
};

export type BoundLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, AnyQuerySchema> = {},
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> = {
  readonly model: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly implementations: LedgerImplementations<TIndexers, TQueries>;
};

export function defineLedgerModel<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, TSchema> = {},
  const TQueries extends Record<string, AnyQuerySchema> = {},
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
>(input: {
  readonly events: TEvents;
  readonly signals?: TSignals;
  readonly queues: TQueues;
  readonly signalQueues?: TSignalQueues;
  readonly indexers?: TIndexers;
  readonly queries?: TQueries;
}): DefinedLedgerModel<
  TEvents,
  TQueues,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> {
  const model: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  > = {
    events: input.events,
    signals: input.signals ?? ({} as TSignals),
    queues: input.queues,
    signalQueues: input.signalQueues ?? ({} as TSignalQueues),
    indexers: input.indexers ?? ({} as TIndexers),
    queries: input.queries ?? ({} as TQueries),
  };

  return {
    model,
  };
}

export function registerLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
>(
  model: DefinedLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
  register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
): RegisteredLedgerModel<
  TEvents,
  TQueues,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> {
  return {
    model: model.model,
    register,
  };
}

export function bindLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
>(
  model: RegisteredLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
  implementations: LedgerImplementations<TIndexers, TQueries>,
): BoundLedgerModel<
  TEvents,
  TQueues,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues
> {
  return {
    model: model.model,
    register: model.register,
    implementations,
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
    TSignals extends Record<string, TSchema> = {},
    TSignalQueues extends Record<string, TSchema> = {},
  >(input: {
    readonly boundModel: BoundLedgerModel<
      TEvents,
      TQueues,
      TIndexers,
      TQueries,
      TSignals,
      TSignalQueues
    >;
    readonly timing: LedgerTiming;
    readonly leaseMs?: number;
    readonly defaultRetryDelayMs?: number;
    readonly maxInFlight?: number;
    readonly maxBusyRetries?: number;
    readonly maxBusyRetryDelayMs?: number;
  }): Ledger<TEvents, TQueries, TSignals>;
}

export function createLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, TSchema>,
  const TQueries extends Record<string, AnyQuerySchema>,
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
>(input: {
  readonly boundModel: BoundLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly engineFactory: LedgerEngineFactory;
  readonly timing: LedgerTiming;
  readonly leaseMs?: number;
  readonly defaultRetryDelayMs?: number;
  readonly maxInFlight?: number;
  readonly maxBusyRetries?: number;
  readonly maxBusyRetryDelayMs?: number;
}): Ledger<TEvents, TQueries, TSignals> {
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
