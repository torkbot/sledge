import type { Static, TSchema } from "typebox";

import type { RuntimeClock, RuntimeScheduler } from "../runtime/contracts.ts";
import type { EventRef } from "./event-ref.ts";
import {
  createProjectionAccess,
  type AnyProjectionSchema,
  type InferProjectionIndexerDefinitions,
  type InferProjectionQueryDefinitions,
  type ProjectionAccess,
  type ProjectionIndexerFactories,
  type ProjectionIndexerSchemas,
  type ProjectionQueryFactories,
  type ProjectionQuerySchemas,
} from "./projection-access.ts";
import {
  defineProjectionSchemaForEvents,
  type ProjectionSchema,
  type ProjectionSchemaEventName,
  type ProjectionTableFactories,
  type ProjectionTablesForFactories,
} from "./projections.ts";

const registeredLedgerModelBrand: unique symbol = Symbol(
  "sledge.registeredLedgerModel",
);

export type {
  ProjectionExecutableSelect,
  ProjectionExecutableWrite,
  ProjectionIndexerBuilder,
  ProjectionIndexerEvent,
  ProjectionIndexerRunInput,
  ProjectionInsertBuilder,
  ProjectionInsertConflictBuilder,
  ProjectionInsertOnConflictBuilder,
  ProjectionQueryBuilder,
  ProjectionQueryRunInput,
  ProjectionReadDatabase,
  ProjectionSelectBuilder,
  ProjectionSelectedRow,
  ProjectionUpdateRow,
  ProjectionWriteDatabase,
  ProjectionWriteRow,
} from "./projection-access.ts";

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
  readonly workKey?: string;
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
  readonly ref: EventRef<Extract<TEventName, string>>;
  readonly tsMs: number;
  readonly eventName: TEventName;
  readonly payload: Static<TEvents[TEventName]>;
  readonly causationEventId: number | null;
  readonly dedupeKey: string | null;
};

export type LedgerIndexerContext<
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly event: EventEnvelope<TEvents, keyof TEvents>;
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

/**
 * Runtime implementations bound to index and query schema contracts.
 */
export type LedgerImplementations<
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, AnyQuerySchema> = {},
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = {
  readonly indexers?: {
    readonly [TIndexName in keyof TIndexers]: (
      scope: LedgerStorageScope,
      input: Static<TIndexers[TIndexName]>,
      context: LedgerIndexerContext<TEvents>,
    ) => void | Promise<void>;
  };

  /**
   * Projection reads. Top-level ledger queries receive an ambient read scope;
   * event projection queries receive the projection transaction scope.
   */
  readonly queries?: {
    readonly [TQueryName in keyof TQueries]: (
      scope: LedgerStorageScope,
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
  ): Promise<void>;

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
  TQueries extends Record<string, AnyQuerySchema>,
> = (input: {
  readonly event: EventEnvelope<TEvents, TEventName>;
  readonly actions: ProjectionActions<TIndexers> & {
    readonly enqueue: <const TQueueName extends keyof TQueues>(
      queueName: TQueueName,
      payload: Static<TQueues[TQueueName]>,
      options?: EnqueueOptions,
    ) => void;
    readonly query: <const TQueryName extends keyof TQueries>(
      queryName: TQueryName,
      params: Static<TQueries[TQueryName]["params"]>,
    ) => Promise<Static<TQueries[TQueryName]["result"]>>;
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
      TQueues,
      TQueries
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

export type WorkState = "pending" | "delayed" | "leased" | "cancelled" | "dead";

export type WorkLeaseSnapshot = {
  readonly leaseId: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
};

export type WorkCancellationSnapshot = {
  readonly requestedAtMs: number;
  readonly reason: string | null;
};

export type WorkRef = {
  readonly sourceEventId: number;
  readonly signal: boolean;
  readonly queueName: string;
  readonly workKey: string;
};

export type WorkSnapshot = {
  readonly workId: number;
  readonly ref: WorkRef | null;
  readonly queueName: string;
  readonly sourceEventId: number;
  readonly attempt: number;
  readonly availableAtMs: number;
  readonly state: WorkState;
  readonly lease: WorkLeaseSnapshot | null;
  readonly cancellation: WorkCancellationSnapshot | null;
  readonly lastError: string | null;
  readonly signal: boolean;
};

export type CancelWorkInput = {
  readonly ref: WorkRef;
  readonly reason?: string;
};

export type CancelWorkResult =
  | {
      readonly status: "cancelled";
      readonly work: WorkSnapshot;
    }
  | {
      readonly status: "already_terminal";
      readonly ref: WorkRef;
      readonly work: WorkSnapshot;
    }
  | {
      readonly status: "not_found";
      readonly ref: WorkRef;
    };

export type QueryWorkInput = {
  readonly workId: number;
};

export type ListWorkInput = {
  readonly queueName?: string;
  readonly sourceEventId?: number;
  readonly states?: readonly WorkState[];
  readonly limit?: number;
};

export interface Ledger<
  TEvents extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema> = {},
> extends AsyncDisposable {
  emit<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    event: Static<TEvents[TEventName]>,
    options?: EmitOptions,
  ): Promise<EventEnvelope<TEvents, TEventName>>;

  query<const TQueryName extends keyof TQueries>(
    queryName: TQueryName,
    params: Static<TQueries[TQueryName]["params"]>,
  ): Promise<Static<TQueries[TQueryName]["result"]>>;

  cancelWork(input: CancelWorkInput): Promise<CancelWorkResult>;

  queryWork(input: QueryWorkInput): Promise<WorkSnapshot | null>;

  listWork(input?: ListWorkInput): Promise<readonly WorkSnapshot[]>;

  /**
   * Subscribe to live signal notifications emitted by this ledger runtime.
   * Signals are process-local and transient; use durable event streams for
   * cross-process consumption.
   */
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

  startWorkers(options: LedgerWorkerOptions): Promise<LedgerWorkers>;

  close(): Promise<void>;
}

export type LedgerWorkerOptions = {
  readonly scheduler: RuntimeScheduler;
  readonly leaseMs?: number;
  readonly defaultRetryDelayMs?: number;
  readonly maxInFlight?: number;
  readonly terminalWorkRetentionMs?: number;
};

export interface LedgerWorkers extends AsyncDisposable {
  close(): Promise<void>;
}

/**
 * Runtime dependencies injected into ledger orchestration.
 */
export type LedgerTiming = {
  readonly clock: RuntimeClock;
};

export type RegisteredLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, AnyQuerySchema> = {},
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
  TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
> = {
  readonly [registeredLedgerModelBrand]: true;
  readonly model: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly projections: TProjectionSchema;
  readonly register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly implementations: LedgerImplementations<TIndexers, TQueries, TEvents>;
};

export type LedgerShape<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = {
  readonly events: TEvents;
  readonly queues: TQueues;
  readonly signals: TSignals;
  readonly signalQueues: TSignalQueues;
};

export type LedgerProjectionSchemaBuilder<TEventName extends string> = {
  tables<const TFactories extends ProjectionTableFactories<TEventName>>(
    factories: TFactories,
  ): ProjectionSchema<ProjectionTablesForFactories<TFactories>, {}, TEventName>;
};

type ProjectionSchemaCompatibleWithEvents<
  TEventName extends string,
  TProjectionSchema,
> =
  Exclude<
    ProjectionSchemaEventName<TProjectionSchema>,
    TEventName
  > extends never
    ? unknown
    : {
        readonly projectionEventNamesMustComeFromLedgerShape: never;
      };

export type DefinedLedgerShape<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = {
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  register(
    register: RegisterFunction<
      TEvents,
      TQueues,
      {},
      {},
      TSignals,
      TSignalQueues
    >,
  ): RegisteredLedgerModel<
    TEvents,
    TQueues,
    {},
    {},
    TSignals,
    TSignalQueues,
    ProjectionSchema<{}, {}, Extract<keyof TEvents, string>>
  >;
  withProjections<
    const TProjectionSchema extends AnyProjectionSchema,
    const TIndexerFactories extends
      ProjectionIndexerFactories<TProjectionSchema>,
    const TQueryFactories extends ProjectionQueryFactories<TProjectionSchema>,
  >(
    defineSchema: (
      builder: LedgerProjectionSchemaBuilder<Extract<keyof TEvents, string>>,
    ) => TProjectionSchema &
      ProjectionSchemaCompatibleWithEvents<
        Extract<keyof TEvents, string>,
        TProjectionSchema
      >,
    access: {
      readonly indexers: TIndexerFactories;
      readonly queries: TQueryFactories;
    },
  ): DefinedLedgerModel<
    TEvents,
    TQueues,
    TProjectionSchema,
    ProjectionIndexerSchemas<
      InferProjectionIndexerDefinitions<TIndexerFactories>
    >,
    ProjectionQuerySchemas<InferProjectionQueryDefinitions<TQueryFactories>>,
    TSignals,
    TSignalQueues
  >;
};

export type DefinedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
> = {
  readonly model: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly projections: TProjectionSchema;
  register(
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
    TSignalQueues,
    TProjectionSchema
  >;
};

export function defineLedgerShape<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
>(input: {
  readonly events: TEvents;
  readonly queues: TQueues;
  readonly signals: TSignals;
  readonly signalQueues: TSignalQueues;
}): DefinedLedgerShape<TEvents, TQueues, TSignals, TSignalQueues> {
  const shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues> = {
    events: input.events,
    queues: input.queues,
    signals: input.signals,
    signalQueues: input.signalQueues,
  };

  return {
    shape,
    register: (register) => {
      return createDefinedLedgerModel({
        shape,
        access: createEmptyProjectionAccess<Extract<keyof TEvents, string>>(),
      }).register(register);
    },
    withProjections: (defineSchema, accessDefinition) => {
      const projections = defineSchema(
        createLedgerProjectionSchemaBuilder<Extract<keyof TEvents, string>>(),
      );
      const access = createProjectionAccess({
        projections,
        indexers: accessDefinition.indexers,
        queries: accessDefinition.queries,
      });

      return createDefinedLedgerModel({
        shape,
        access,
      });
    },
  };
}

function createLedgerProjectionSchemaBuilder<
  TEventName extends string,
>(): LedgerProjectionSchemaBuilder<TEventName> {
  const defineSchema = defineProjectionSchemaForEvents<TEventName>();

  return {
    tables: (factories) => {
      return defineSchema(factories);
    },
  };
}

function createEmptyProjectionAccess<
  TEventName extends string,
>(): ProjectionAccess<ProjectionSchema<{}, {}, TEventName>, {}, {}> {
  return {
    projections: defineProjectionSchemaForEvents<TEventName>()({}),
    indexers: {},
    queries: {},
    implementations: {},
  };
}

function createDefinedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
>(input: {
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  readonly access: ProjectionAccess<TProjectionSchema, TIndexers, TQueries>;
}): DefinedLedgerModel<
  TEvents,
  TQueues,
  TProjectionSchema,
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
    events: input.shape.events,
    queues: input.shape.queues,
    signals: input.shape.signals,
    signalQueues: input.shape.signalQueues,
    indexers: input.access.indexers,
    queries: input.access.queries,
  };

  return {
    model,
    projections: input.access.projections,
    register: (register) => {
      const implementations = input.access
        .implementations as LedgerImplementations<TIndexers, TQueries, TEvents>;

      return {
        [registeredLedgerModelBrand]: true,
        model,
        projections: input.access.projections,
        register,
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
    TSignals extends Record<string, TSchema> = {},
    TSignalQueues extends Record<string, TSchema> = {},
  >(input: {
    readonly model: RegisteredLedgerModel<
      TEvents,
      TQueues,
      TIndexers,
      TQueries,
      TSignals,
      TSignalQueues
    >;
    readonly timing: LedgerTiming;
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
  readonly model: RegisteredLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly engineFactory: LedgerEngineFactory;
  readonly timing: LedgerTiming;
}): Ledger<TEvents, TQueries, TSignals> {
  return input.engineFactory.openLedger({
    model: input.model,
    timing: input.timing,
  });
}
