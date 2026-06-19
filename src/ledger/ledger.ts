import type { Static, TSchema } from "typebox";

import type { RuntimeClock, RuntimeScheduler } from "../runtime/contracts.ts";
import type { EventRef } from "./event-ref.ts";
import {
  createProjectionAccess,
  createProjectionImplementations,
  type AnyProjectionSchema,
  type ProjectionAccess,
  type ProjectionImplementationRegistration,
  type ProjectionIndexerDefinitions,
  type ProjectionIndexerSchemas,
  type ProjectionQueryDefinitions,
  type ProjectionQuerySchemas,
} from "./projection-access.ts";
import {
  defineProjectionSchemaForEvents,
  type ProjectionColumn,
  type ProjectionRelationBuilder,
  type ProjectionRelations,
  type ProjectionSchema,
  type ProjectionSchemaEventName,
  type ProjectionTableColumns,
  type ProjectionTableFactories,
  type ProjectionTablesForFactories,
} from "./projections.ts";

const registeredLedgerModelBrand: unique symbol = Symbol(
  "sledge.registeredLedgerModel",
);

export type {
  ProjectionExecutableSelect,
  ProjectionExecutableWrite,
  ProjectionIndexerContract,
  ProjectionIndexerDefinitions,
  ProjectionIndexerEvent,
  ProjectionIndexerImplementations,
  ProjectionIndexerRunInput,
  ProjectionInsertBuilder,
  ProjectionInsertConflictBuilder,
  ProjectionInsertOnConflictBuilder,
  ProjectionQueryContract,
  ProjectionQueryDefinitions,
  ProjectionQueryImplementations,
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
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  TQueryDefinitions extends ProjectionQueryDefinitions = {},
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
  > &
    ProjectionImplementationRegistration<
      TProjectionSchema,
      TIndexerDefinitions,
      TQueryDefinitions
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

export type MaterializationSchema<
  TNamespace extends string,
  TVersion extends number,
  TTables,
  TRelations extends ProjectionRelations,
  TEventName extends string,
> = ProjectionSchema<TTables, TRelations, TEventName> & {
  readonly namespace: TNamespace;
  readonly version: TVersion;
};

export type AnyMaterializationSchema = AnyProjectionSchema & {
  readonly namespace: string;
  readonly version: number;
};

export type MaterializationSchemaDefinition<
  TNamespace extends string,
  TVersion extends number,
  TFactories extends ProjectionTableFactories<string>,
  TRelations extends ProjectionRelations,
> = {
  readonly namespace: TNamespace;
  readonly version: TVersion;
  readonly tables: TFactories;
  readonly relations?: (
    relations: ProjectionRelationBuilder<
      ProjectionTablesForFactories<TFactories>
    >,
  ) => TRelations;
};

type EventNameForProjectionColumn<TColumn> =
  TColumn extends ProjectionColumn<
    "event_ref",
    EventRef<infer TEventName>,
    boolean
  >
    ? TEventName
    : never;

type EventNameForProjectionTable<TTable> = {
  readonly [TColumnName in keyof ProjectionTableColumns<TTable>]: EventNameForProjectionColumn<
    ProjectionTableColumns<TTable>[TColumnName]
  >;
}[keyof ProjectionTableColumns<TTable>];

type EventNameForProjectionTables<TTables> = {
  readonly [TTableName in keyof TTables]: EventNameForProjectionTable<
    TTables[TTableName]
  >;
}[keyof TTables] &
  string;

type MaterializationSchemaList = readonly [
  AnyMaterializationSchema,
  ...AnyMaterializationSchema[],
];

type EventNameForMaterializationSchemas<
  TSchemas extends MaterializationSchemaList,
> = {
  readonly [TIndex in keyof TSchemas]: ProjectionSchemaEventName<
    TSchemas[TIndex]
  >;
}[number] &
  string;

export type MaterializationMigrationHandle = {
  readonly namespace: string;
  readonly fromVersion: number;
  readonly toVersion: number;
};

export type MaterializationMigration = {
  readonly from: number;
  readonly to: number;
  up(handle: MaterializationMigrationHandle): void | Promise<void>;
};

export type Materializations<
  TSchemas extends MaterializationSchemaList,
  TCurrentSchema extends TSchemas[number],
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
> = {
  readonly schemas: TSchemas;
  readonly current: TCurrentSchema;
  readonly migrations: readonly MaterializationMigration[];
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
};

export type MaterializationImplementationRegistration<
  TMaterializationSchema extends AnyMaterializationSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
> = ProjectionImplementationRegistration<
  TMaterializationSchema,
  TIndexerDefinitions,
  TQueryDefinitions
>;

export function defineMaterializationSchema<
  const TNamespace extends string,
  const TVersion extends number,
  const TFactories extends ProjectionTableFactories<string>,
  const TRelations extends ProjectionRelations = {},
>(
  definition: MaterializationSchemaDefinition<
    TNamespace,
    TVersion,
    TFactories,
    TRelations
  >,
): MaterializationSchema<
  TNamespace,
  TVersion,
  ProjectionTablesForFactories<TFactories>,
  TRelations,
  EventNameForProjectionTables<ProjectionTablesForFactories<TFactories>>
> {
  validateMaterializationSchemaIdentity(
    definition.namespace,
    definition.version,
  );
  const schema = createMaterializationProjectionSchema(definition);

  return Object.assign(schema, {
    namespace: definition.namespace,
    version: definition.version,
  }) as MaterializationSchema<
    TNamespace,
    TVersion,
    ProjectionTablesForFactories<TFactories>,
    TRelations,
    EventNameForProjectionTables<ProjectionTablesForFactories<TFactories>>
  >;
}

export function defineMaterializations<
  const TSchemas extends readonly [
    AnyMaterializationSchema,
    ...AnyMaterializationSchema[],
  ],
  const TCurrentSchema extends TSchemas[number],
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(input: {
  readonly schemas: TSchemas;
  readonly current: TCurrentSchema;
  readonly migrations: readonly MaterializationMigration[];
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
}): Materializations<
  TSchemas,
  TCurrentSchema,
  TIndexerDefinitions,
  TQueryDefinitions
> {
  validateMaterializationPlan(input);

  return input;
}

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
};

export type DefinedLedgerModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  TQueryDefinitions extends ProjectionQueryDefinitions = {},
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
    > &
      ProjectionImplementationRegistration<
        TProjectionSchema,
        TIndexerDefinitions,
        TQueryDefinitions
      >,
  ): RegisteredLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues,
    TProjectionSchema,
    TIndexerDefinitions,
    TQueryDefinitions
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
  };
}

export function withMaterializations<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const TSchemas extends MaterializationSchemaList,
  const TCurrentSchema extends TSchemas[number],
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<
    Extract<keyof TEvents, string>
  >,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(
  shape: DefinedLedgerShape<TEvents, TQueues, TSignals, TSignalQueues>,
  materializations: Materializations<
    TSchemas,
    TCurrentSchema,
    TIndexerDefinitions,
    TQueryDefinitions
  > &
    (Exclude<
      EventNameForMaterializationSchemas<TSchemas>,
      Extract<keyof TEvents, string>
    > extends never
      ? unknown
      : never),
): DefinedLedgerModel<
  TEvents,
  TQueues,
  TCurrentSchema,
  ProjectionIndexerSchemas<TIndexerDefinitions>,
  ProjectionQuerySchemas<TQueryDefinitions>,
  TSignals,
  TSignalQueues,
  TIndexerDefinitions,
  TQueryDefinitions
> {
  validateMaterializationEvents(shape.shape, materializations);
  const access = createProjectionAccess({
    projections: materializations.current,
    indexers: materializations.indexers,
    queries: materializations.queries,
  });

  return createDefinedLedgerModel({
    shape: shape.shape,
    access,
  });
}

function createMaterializationProjectionSchema<
  const TFactories extends ProjectionTableFactories<string>,
  const TRelations extends ProjectionRelations,
>(
  definition: MaterializationSchemaDefinition<
    string,
    number,
    TFactories,
    TRelations
  >,
): ProjectionSchema<
  ProjectionTablesForFactories<TFactories>,
  TRelations,
  EventNameForProjectionTables<ProjectionTablesForFactories<TFactories>>
> {
  const defineSchema = defineProjectionSchemaForEvents<string>();
  const schema = defineSchema(definition.tables);

  if (definition.relations === undefined) {
    return schema as ProjectionSchema<
      ProjectionTablesForFactories<TFactories>,
      TRelations,
      EventNameForProjectionTables<ProjectionTablesForFactories<TFactories>>
    >;
  }

  return schema.relations(definition.relations) as ProjectionSchema<
    ProjectionTablesForFactories<TFactories>,
    TRelations,
    EventNameForProjectionTables<ProjectionTablesForFactories<TFactories>>
  >;
}

function validateMaterializationSchemaIdentity(
  namespace: string,
  version: number,
): void {
  if (namespace.length === 0) {
    throw new Error("materialization schema namespace must not be empty");
  }

  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(
      "materialization schema version must be a positive integer",
    );
  }
}

function validateMaterializationPlan(input: {
  readonly schemas: readonly [
    AnyMaterializationSchema,
    ...AnyMaterializationSchema[],
  ];
  readonly current: AnyMaterializationSchema;
  readonly migrations: readonly MaterializationMigration[];
}): void {
  const namespace = input.current.namespace;
  validateMaterializationSchemaIdentity(namespace, input.current.version);

  const versions = new Set<number>();
  let currentFound = false;

  for (const schema of input.schemas) {
    validateMaterializationSchemaIdentity(schema.namespace, schema.version);

    if (schema.namespace !== namespace) {
      throw new Error("materialization schemas must share one namespace");
    }

    if (versions.has(schema.version)) {
      throw new Error(
        `duplicate materialization schema version ${schema.version}`,
      );
    }

    versions.add(schema.version);

    if (schema === input.current) {
      currentFound = true;
    }
  }

  if (!currentFound) {
    throw new Error("current materialization schema must be listed in schemas");
  }

  const sortedVersions = [...versions].sort((left, right) => left - right);
  const latestVersion = sortedVersions[sortedVersions.length - 1];

  if (latestVersion !== input.current.version) {
    throw new Error(
      "current materialization schema must have the latest version",
    );
  }

  const migrationEdges = new Set<string>();

  for (const migration of input.migrations) {
    if (!Number.isSafeInteger(migration.from) || migration.from <= 0) {
      throw new Error(
        "materialization migration from must be a positive integer",
      );
    }

    if (!Number.isSafeInteger(migration.to) || migration.to <= 0) {
      throw new Error(
        "materialization migration to must be a positive integer",
      );
    }

    if (!versions.has(migration.from) || !versions.has(migration.to)) {
      throw new Error(
        "materialization migrations must reference known schemas",
      );
    }

    if (migration.to !== migration.from + 1) {
      throw new Error(
        "materialization migrations must connect adjacent versions",
      );
    }

    const edge = `${migration.from}:${migration.to}`;

    if (migrationEdges.has(edge)) {
      throw new Error(
        `duplicate materialization migration ${migration.from} -> ${migration.to}`,
      );
    }

    migrationEdges.add(edge);
  }

  for (let index = 1; index < sortedVersions.length; index += 1) {
    const from = sortedVersions[index - 1];
    const to = sortedVersions[index];

    if (from === undefined || to === undefined) {
      throw new Error("materialization schema versions must not be empty");
    }

    if (to !== from + 1) {
      throw new Error("materialization schema versions must not have gaps");
    }

    const edge = `${from}:${to}`;

    if (!migrationEdges.has(edge)) {
      throw new Error(`missing materialization migration ${from} -> ${to}`);
    }
  }
}

function validateMaterializationEvents<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  TSchemas extends MaterializationSchemaList,
  TCurrentSchema extends TSchemas[number],
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
>(
  shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>,
  materializations: Materializations<
    TSchemas,
    TCurrentSchema,
    TIndexerDefinitions,
    TQueryDefinitions
  >,
): void {
  const eventNames = new Set(Object.keys(shape.events));

  for (const schema of materializations.schemas) {
    for (const table of Object.values(schema.metadata.tables)) {
      for (const [columnName, column] of Object.entries(table.columns)) {
        if (column.eventName === null) {
          continue;
        }

        if (!eventNames.has(column.eventName)) {
          throw new Error(
            `materialization column ${table.name}.${columnName} references unknown event ${column.eventName}`,
          );
        }
      }
    }
  }

  for (const [indexerName, definition] of Object.entries(
    materializations.indexers,
  )) {
    if (eventNames.has(definition.sourceEvent)) {
      continue;
    }

    throw new Error(
      `materialization indexer ${indexerName} references unknown source event ${definition.sourceEvent}`,
    );
  }
}

function createEmptyProjectionAccess<
  TEventName extends string,
>(): ProjectionAccess<ProjectionSchema<{}, {}, TEventName>, {}, {}, {}, {}> {
  return {
    projections: defineProjectionSchemaForEvents<TEventName>()({}),
    indexers: {},
    queries: {},
    indexerDefinitions: {},
    queryDefinitions: {},
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
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
>(input: {
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  readonly access: ProjectionAccess<
    TProjectionSchema,
    TIndexers,
    TQueries,
    TIndexerDefinitions,
    TQueryDefinitions
  >;
}): DefinedLedgerModel<
  TEvents,
  TQueues,
  TProjectionSchema,
  TIndexers,
  TQueries,
  TSignals,
  TSignalQueues,
  TIndexerDefinitions,
  TQueryDefinitions
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
      const implementations = createProjectionImplementations({
        projections: input.access.projections,
        indexers: input.access.indexerDefinitions,
        queries: input.access.queryDefinitions,
        register,
      }) as LedgerImplementations<TIndexers, TQueries, TEvents>;

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
