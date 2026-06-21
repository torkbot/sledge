import type { Static, TSchema } from "typebox";

import type { RuntimeClock, RuntimeScheduler } from "../runtime/contracts.ts";
import { createEventRef, type EventRef } from "./event-ref.ts";
import type { LedgerImplementations } from "./internal-storage.ts";
import { attachLedgerImplementationFactory } from "./internal-storage.ts";
import {
  createProjectionAccess,
  createProjectionImplementations,
  type AnyProjectionSchema,
  type ProjectionAccess,
  type ProjectionImplementationRegistration,
  type ProjectionIndexerDefinitions,
  type ProjectionIndexerSchemas,
  type ProjectionIndexerSchemasForEvent,
  type ProjectionInsertBuilder,
  type ProjectionEventScanBuilder,
  type ProjectionQueryDefinitions,
  type ProjectionQuerySchemas,
  type ProjectionUpdateRow,
} from "./projection-access.ts";
import {
  defineProjectionSchemaForEvents,
  type ProjectionColumn,
  type ProjectionColumnKind,
  type ProjectionColumnMetadata,
  type ProjectionColumnValue,
  type ProjectionForeignKeyMetadata,
  type ProjectionIndexMetadata,
  type ProjectionRelationBuilder,
  type ProjectionRelationDefinition,
  type ProjectionRelations,
  type ProjectionSchema,
  type ProjectionSchemaEventName,
  type ProjectionSchemaTables,
  type ProjectionTableBuilder,
  type ProjectionTableColumnName,
  type ProjectionTableColumns,
  type ProjectionTableFactories,
  type ProjectionTableMetadata,
  type ProjectionTableName,
  type ProjectionTablesForFactories,
} from "./projections.ts";

const registeredLedgerModelBrand: unique symbol = Symbol(
  "sledge.registeredLedgerModel",
);

export type {
  ProjectionAggregateBuilder,
  ProjectionExecutableSelect,
  ProjectionExecutableUnionSelect,
  ProjectionExecutableJoinedSelect,
  ProjectionExecutableWrite,
  ProjectionEventScanBuilder,
  ProjectionDatabase,
  ProjectionDeleteBuilder,
  ProjectionExpression,
  ProjectionExpressionBuilder,
  ProjectionIndexerContract,
  ProjectionIndexerDefinitions,
  ProjectionIndexerEvent,
  ProjectionIndexerImplementations,
  ProjectionIndexerRunInput,
  ProjectionInsertBuilder,
  ProjectionInsertConflictBuilder,
  ProjectionInsertOnConflictBuilder,
  ProjectionJoinCondition,
  ProjectionJoinedSelectBuilder,
  ProjectionNullOrder,
  ProjectionOrderDirection,
  ProjectionQualifiedWhereCondition,
  ProjectionQueryContract,
  ProjectionQueryDefinitions,
  ProjectionQueryImplementations,
  ProjectionQueryRunInput,
  ProjectionReadDatabase,
  ProjectionSelectBuilder,
  ProjectionSelectedRow,
  ProjectionUnionArm,
  ProjectionUnionArmSelectBuilder,
  ProjectionUnionLiteralValue,
  ProjectionUnionSelectedArm,
  ProjectionUnionSelectedRow,
  ProjectionUnionSelection,
  ProjectionUnionValue,
  ProjectionUpdateRow,
  ProjectionUpdateSet,
  ProjectionUpdateBuilder,
  ProjectionUpdateWhereBuilder,
  ProjectionUpsertExpressionBuilder,
  ProjectionUpsertUpdateSet,
  ProjectionWhereCondition,
  ProjectionWhereOperator,
  ProjectionWriteDatabase,
  ProjectionWriteRow,
  ProjectionWriteResult,
} from "./projection-access.ts";
export { createEventRef };
export type { EventRef };

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

type EventProjectionActionIndexers<
  TIndexers extends Record<string, TSchema>,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TEventName extends string,
> = keyof TIndexerDefinitions extends never
  ? TIndexers
  : ProjectionIndexerSchemasForEvent<TIndexerDefinitions, TEventName>;

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
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
> = (input: {
  readonly event: EventEnvelope<TEvents, TEventName>;
  readonly actions: ProjectionActions<
    EventProjectionActionIndexers<
      TIndexers,
      TIndexerDefinitions,
      Extract<TEventName, string>
    >
  > & {
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
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
> = {
  readonly events?: {
    readonly [TEventName in keyof TEvents]?: EventHandlerFunction<
      TEvents,
      TEventName,
      TIndexers,
      TQueues,
      TQueries,
      TIndexerDefinitions
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
    TSignalQueues,
    TIndexerDefinitions
  > &
    ProjectionImplementationRegistration<
      TProjectionSchema,
      TIndexerDefinitions,
      TQueryDefinitions,
      TEvents
    >;
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

type MaterializationTableName<TSchema extends AnyProjectionSchema> =
  ProjectionTableName<ProjectionSchemaTables<TSchema>>;

type MaterializationColumnName<
  TSchema extends AnyProjectionSchema,
  TTableName extends MaterializationTableName<TSchema>,
> = ProjectionTableColumnName<ProjectionSchemaTables<TSchema>[TTableName]>;

type MaterializationTableForName<
  TSchema extends AnyProjectionSchema,
  TTableName extends MaterializationTableName<TSchema>,
> = ProjectionSchemaTables<TSchema>[TTableName];

type MaterializationSchemaWithRelations<TSchema extends AnyProjectionSchema> =
  TSchema & {
    relations<const TNextRelations extends ProjectionRelations>(
      build: (
        relations: ProjectionRelationBuilder<ProjectionSchemaTables<TSchema>>,
      ) => TNextRelations,
    ): ProjectionSchema<
      ProjectionSchemaTables<TSchema>,
      TNextRelations,
      ProjectionSchemaEventName<TSchema>
    >;
  };

export type MaterializationMigrationColumnBuilder<TEventName extends string> =
  Pick<
    ProjectionTableBuilder<TEventName>,
    "boolean" | "eventRef" | "integer" | "json" | "text"
  >;

type MaterializationMigrationWhereValue<
  TTable,
  TColumnName extends ProjectionTableColumnName<TTable>,
> =
  ProjectionTableColumns<TTable>[TColumnName] extends ProjectionColumn<
    "json",
    infer TValue,
    boolean
  >
    ? TValue
    : NonNullable<
        ProjectionColumnValue<ProjectionTableColumns<TTable>[TColumnName]>
      >;

export type MaterializationMigrationSelectedRow<
  TTable,
  TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
> = {
  readonly [TColumnName in TColumnNames[number]]: ProjectionColumnValue<
    ProjectionTableColumns<TTable>[TColumnName]
  >;
};

export type MaterializationMigrationExecutableSelect<
  TTable,
  TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
> = {
  execute(): Promise<
    readonly MaterializationMigrationSelectedRow<TTable, TColumnNames>[]
  >;
  executeTakeFirst(): Promise<MaterializationMigrationSelectedRow<
    TTable,
    TColumnNames
  > | null>;
  stream(): AsyncIterable<
    MaterializationMigrationSelectedRow<TTable, TColumnNames>
  >;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: "=",
    value: MaterializationMigrationWhereValue<TTable, TColumnName>,
  ): MaterializationMigrationExecutableSelect<TTable, TColumnNames>;
};

export type MaterializationMigrationSelectBuilder<TTable> = {
  select<
    const TColumnNames extends readonly ProjectionTableColumnName<TTable>[],
  >(
    columns: TColumnNames,
  ): MaterializationMigrationExecutableSelect<TTable, TColumnNames>;
};

export type MaterializationMigrationUpdateBuilder<TTable> = {
  set(
    values: ProjectionUpdateRow<TTable>,
  ): MaterializationMigrationUpdateWhereBuilder<TTable>;
};

export type MaterializationMigrationUpdateWhereBuilder<TTable> = {
  execute(): Promise<void>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: "=",
    value: MaterializationMigrationWhereValue<TTable, TColumnName>,
  ): MaterializationMigrationUpdateWhereBuilder<TTable>;
};

export type MaterializationMigrationDeleteBuilder<TTable> = {
  execute(): Promise<void>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: "=",
    value: MaterializationMigrationWhereValue<TTable, TColumnName>,
  ): MaterializationMigrationDeleteBuilder<TTable>;
};

export type MaterializationMigrationDatabase<
  TProjectionSchema extends AnyProjectionSchema,
  TEvents extends Record<string, TSchema>,
> = {
  deleteFrom<
    const TTableName extends MaterializationTableName<TProjectionSchema>,
  >(
    tableName: TTableName,
  ): MaterializationMigrationDeleteBuilder<
    MaterializationTableForName<TProjectionSchema, TTableName>
  >;
  insertInto<
    const TTableName extends MaterializationTableName<TProjectionSchema>,
  >(
    tableName: TTableName,
  ): ProjectionInsertBuilder<
    MaterializationTableForName<TProjectionSchema, TTableName>
  >;
  selectFrom<
    const TTableName extends MaterializationTableName<TProjectionSchema>,
  >(
    tableName: TTableName,
  ): MaterializationMigrationSelectBuilder<
    MaterializationTableForName<TProjectionSchema, TTableName>
  >;
  updateTable<
    const TTableName extends MaterializationTableName<TProjectionSchema>,
  >(
    tableName: TTableName,
  ): MaterializationMigrationUpdateBuilder<
    MaterializationTableForName<TProjectionSchema, TTableName>
  >;
  readEvent<const TEventName extends Extract<keyof TEvents, string>>(
    ref: EventRef<TEventName>,
  ): Promise<EventEnvelope<TEvents, TEventName> | null>;
  readEvents<const TEventName extends Extract<keyof TEvents, string>>(
    refs: readonly EventRef<TEventName>[],
  ): Promise<readonly (EventEnvelope<TEvents, TEventName> | null)[]>;
  scanEvents<const TEventName extends Extract<keyof TEvents, string>>(
    eventName: TEventName,
  ): ProjectionEventScanBuilder<TEvents, TEventName>;
};

export type MaterializationMigrationDataInput<
  TProjectionSchema extends AnyProjectionSchema,
  TEvents extends Record<string, TSchema>,
> = {
  readonly db: MaterializationMigrationDatabase<TProjectionSchema, TEvents>;
};

export type MaterializationMigrationDataFunction<
  TProjectionSchema extends AnyProjectionSchema,
  TEvents extends Record<string, TSchema>,
> = (
  input: MaterializationMigrationDataInput<TProjectionSchema, TEvents>,
) => void | Promise<void>;

export type MaterializationMigrationOperation<
  TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> =
  | {
      readonly kind: "create_table";
      readonly table: ProjectionTableMetadata;
      readonly tableName: string;
    }
  | {
      readonly column: ProjectionColumnMetadata;
      readonly columnName: string;
      readonly kind: "add_column";
      readonly tableName: string;
    }
  | {
      readonly index: ProjectionIndexMetadata;
      readonly kind: "create_index";
      readonly tableName: string;
    }
  | {
      readonly foreignKey: ProjectionForeignKeyMetadata;
      readonly kind: "add_foreign_key";
      readonly name: string;
    }
  | {
      readonly description: string;
      readonly kind: "data";
      readonly run: MaterializationMigrationDataFunction<
        TProjectionSchema,
        TEvents
      >;
    };

export type MaterializationMigrationOperations<
  TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = readonly [
  MaterializationMigrationOperation<TProjectionSchema, TEvents>,
  ...MaterializationMigrationOperation<TProjectionSchema, TEvents>[],
];

export type MaterializationMigration<
  TVersion extends number = number,
  TDescription extends string = string,
  TOperations extends MaterializationMigrationOperations =
    MaterializationMigrationOperations,
> = {
  readonly description: TDescription;
  readonly operations: TOperations;
  readonly version: TVersion;
};

export type MaterializationMigrationList<
  TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = readonly [
  MaterializationMigration<
    number,
    string,
    MaterializationMigrationOperations<TProjectionSchema, TEvents>
  >,
  ...MaterializationMigration<
    number,
    string,
    MaterializationMigrationOperations<TProjectionSchema, TEvents>
  >[],
];

export type MaterializationMigrationStepBuilder<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
> = {
  addColumn<
    const TTableName extends MaterializationTableName<TCurrentSchema>,
    const TColumnName extends MaterializationColumnName<
      TCurrentSchema,
      TTableName
    >,
  >(
    tableName: TTableName,
    columnName: TColumnName,
    build: (
      columns: MaterializationMigrationColumnBuilder<
        ProjectionSchemaEventName<TCurrentSchema>
      >,
    ) => ProjectionTableColumns<
      MaterializationTableForName<TCurrentSchema, TTableName>
    >[TColumnName],
  ): MaterializationMigrationOperation<TCurrentSchema, TEvents>;

  addForeignKey<const TName extends string>(
    name: TName,
    build: (
      relations: ProjectionRelationBuilder<
        ProjectionSchemaTables<TCurrentSchema>
      >,
    ) => ProjectionRelationDefinition,
  ): MaterializationMigrationOperation<TCurrentSchema, TEvents>;

  createIndex<
    const TTableName extends MaterializationTableName<TCurrentSchema>,
    const TColumnNames extends readonly MaterializationColumnName<
      TCurrentSchema,
      TTableName
    >[],
  >(
    name: string,
    tableName: TTableName,
    columns: TColumnNames,
  ): MaterializationMigrationOperation<TCurrentSchema, TEvents>;

  createTable<
    const TTableName extends MaterializationTableName<TCurrentSchema>,
  >(
    tableName: TTableName,
    build: (
      table: ProjectionTableBuilder<ProjectionSchemaEventName<TCurrentSchema>>,
    ) => {
      readonly metadata: ProjectionTableMetadata;
    },
  ): MaterializationMigrationOperation<TCurrentSchema, TEvents>;

  createUniqueIndex<
    const TTableName extends MaterializationTableName<TCurrentSchema>,
    const TColumnNames extends readonly MaterializationColumnName<
      TCurrentSchema,
      TTableName
    >[],
  >(
    name: string,
    tableName: TTableName,
    columns: TColumnNames,
  ): MaterializationMigrationOperation<TCurrentSchema, TEvents>;

  data<const TDescription extends string>(
    description: TDescription,
    run: MaterializationMigrationDataFunction<TCurrentSchema, TEvents>,
  ): MaterializationMigrationOperation<TCurrentSchema, TEvents>;
};

export type MaterializationHistoryBuilder<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
> = {
  migration<
    const TVersion extends number,
    const TDescription extends string,
    const TOperations extends MaterializationMigrationOperations<
      TCurrentSchema,
      TEvents
    >,
  >(
    version: TVersion,
    description: TDescription,
    build: (
      steps: MaterializationMigrationStepBuilder<TCurrentSchema, TEvents>,
    ) => TOperations,
  ): MaterializationMigration<TVersion, TDescription, TOperations>;
};

export type MaterializationHistory<
  TCurrentSchema extends AnyMaterializationSchema,
  TMigrations extends MaterializationMigrationList,
> = {
  readonly current: TCurrentSchema;
  readonly currentVersion: TCurrentSchema["version"];
  readonly migrations: TMigrations;
  readonly namespace: TCurrentSchema["namespace"];
};

export type AnyMaterializationHistory = MaterializationHistory<
  AnyMaterializationSchema,
  MaterializationMigrationList
>;

export type Materializations<
  THistory extends AnyMaterializationHistory,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
> = {
  readonly history: THistory;
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
};

export type MaterializationImplementationRegistration<
  TMaterializationSchema extends AnyMaterializationSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
> = ProjectionImplementationRegistration<
  TMaterializationSchema,
  TIndexerDefinitions,
  TQueryDefinitions,
  TEvents
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

export function defineMaterializationHistory<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const TCurrentSchema extends AnyMaterializationSchema,
  const TMigrations extends MaterializationMigrationList<
    TCurrentSchema,
    TEvents
  >,
>(
  shape: DefinedLedgerShape<TEvents, TQueues, TSignals, TSignalQueues>,
  current: TCurrentSchema &
    (Exclude<
      ProjectionSchemaEventName<TCurrentSchema>,
      Extract<keyof TEvents, string>
    > extends never
      ? unknown
      : never),
  build: (
    history: MaterializationHistoryBuilder<TCurrentSchema, TEvents>,
  ) => TMigrations,
): MaterializationHistory<TCurrentSchema, TMigrations> {
  validateMaterializationSchemaIdentity(current.namespace, current.version);
  const eventNames = new Set(Object.keys(shape.shape.events));

  validateMaterializationSchemaEventRefs(current, eventNames);
  const migrations = build(
    createMaterializationHistoryBuilder<TCurrentSchema, TEvents>(current),
  );
  validateMaterializationHistory(current, migrations);
  const history = {
    current,
    currentVersion: current.version,
    migrations,
    namespace: current.namespace,
  };

  validateMaterializationHistoryEventRefs(history, eventNames);

  return history;
}

export function defineMaterializations<
  const THistory extends AnyMaterializationHistory,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(input: {
  readonly history: THistory;
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
}): Materializations<THistory, TIndexerDefinitions, TQueryDefinitions> {
  validateMaterializationHistory(
    input.history.current,
    input.history.migrations,
  );

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
      TSignalQueues,
      {}
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
      TSignalQueues,
      TIndexerDefinitions
    > &
      ProjectionImplementationRegistration<
        TProjectionSchema,
        TIndexerDefinitions,
        TQueryDefinitions,
        TEvents
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
  const THistory extends AnyMaterializationHistory,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<
    Extract<keyof TEvents, string>
  >,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
>(
  shape: DefinedLedgerShape<TEvents, TQueues, TSignals, TSignalQueues>,
  materializations: Materializations<
    THistory,
    TIndexerDefinitions,
    TQueryDefinitions
  > &
    (Exclude<
      ProjectionSchemaEventName<THistory["current"]>,
      Extract<keyof TEvents, string>
    > extends never
      ? unknown
      : never),
): DefinedLedgerModel<
  TEvents,
  TQueues,
  THistory["current"],
  ProjectionIndexerSchemas<TIndexerDefinitions>,
  ProjectionQuerySchemas<TQueryDefinitions>,
  TSignals,
  TSignalQueues,
  TIndexerDefinitions,
  TQueryDefinitions
> {
  validateMaterializationEvents(shape.shape, materializations);
  const access = createProjectionAccess({
    projections: materializations.history.current,
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

function createMaterializationHistoryBuilder<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
>(
  current: TCurrentSchema,
): MaterializationHistoryBuilder<TCurrentSchema, TEvents> {
  return {
    migration: (version, description, build) => {
      const operations = build(
        createMaterializationMigrationStepBuilder<TCurrentSchema, TEvents>(
          current,
        ),
      );

      return {
        description,
        operations,
        version,
      };
    },
  };
}

function createMaterializationMigrationStepBuilder<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
>(
  current: TCurrentSchema,
): MaterializationMigrationStepBuilder<TCurrentSchema, TEvents> {
  return {
    addColumn: (tableName, columnName, build) => {
      readMaterializationTable(
        current,
        String(tableName),
        "materialization add column",
      );
      validateMaterializationColumnName(
        current,
        String(tableName),
        String(columnName),
        "materialization add column",
      );
      const column = build(
        createMaterializationMigrationColumnBuilder<
          ProjectionSchemaEventName<TCurrentSchema>
        >(),
      );
      const metadata = readMaterializationColumnMetadata(
        column,
        `materialization add column ${String(tableName)}.${String(columnName)}`,
      );

      if (!metadata.nullable) {
        throw new Error(
          `materialization add column ${String(tableName)}.${String(columnName)} cannot add a non-null column without a default`,
        );
      }

      return {
        column: metadata,
        columnName: String(columnName),
        kind: "add_column",
        tableName: String(tableName),
      };
    },
    addForeignKey: (name, build) => {
      validateMaterializationIdentifier(
        "materialization foreign key name",
        name,
      );
      const relationSchema =
        current as MaterializationSchemaWithRelations<TCurrentSchema>;
      const schemaWithRelation = relationSchema.relations((relations) => {
        return {
          [name]: build(relations),
        };
      });
      const foreignKey = schemaWithRelation.metadata.relations[name];

      if (foreignKey === undefined) {
        throw new Error(`materialization foreign key ${name} was not defined`);
      }

      return {
        foreignKey,
        kind: "add_foreign_key",
        name,
      };
    },
    createIndex: (name, tableName, columns) => {
      const table = readMaterializationTable(
        current,
        String(tableName),
        "materialization create index",
      );
      validateMaterializationIdentifier("materialization index name", name);
      validateMaterializationColumnNames(
        table,
        columns.map(String),
        "materialization create index",
      );

      return {
        index: {
          columns: columns.map(String),
          name,
          unique: false,
        },
        kind: "create_index",
        tableName: String(tableName),
      };
    },
    createTable: (tableName, build) => {
      readMaterializationTable(
        current,
        String(tableName),
        "materialization create table",
      );
      const schema = defineProjectionSchemaForEvents<
        ProjectionSchemaEventName<TCurrentSchema>
      >()({
        [tableName]: build,
      });
      const table = schema.metadata.tables[String(tableName)];

      if (table === undefined) {
        throw new Error(
          `materialization create table ${String(tableName)} was not defined`,
        );
      }

      return {
        kind: "create_table",
        table,
        tableName: String(tableName),
      };
    },
    createUniqueIndex: (name, tableName, columns) => {
      const table = readMaterializationTable(
        current,
        String(tableName),
        "materialization create unique index",
      );
      validateMaterializationIdentifier(
        "materialization unique index name",
        name,
      );
      validateMaterializationColumnNames(
        table,
        columns.map(String),
        "materialization create unique index",
      );

      return {
        index: {
          columns: columns.map(String),
          name,
          unique: true,
        },
        kind: "create_index",
        tableName: String(tableName),
      };
    },
    data: (description, run) => {
      validateMaterializationIdentifier(
        "materialization data migration description",
        description,
      );

      return {
        description,
        kind: "data",
        run,
      };
    },
  };
}

function createMaterializationMigrationColumnBuilder<
  TEventName extends string,
>(): MaterializationMigrationColumnBuilder<TEventName> {
  return {
    boolean: () => createMaterializationMigrationColumn("boolean", null, true),
    eventRef: (eventName) => {
      return createMaterializationMigrationColumn("event_ref", eventName, true);
    },
    integer: () => createMaterializationMigrationColumn("integer", null, true),
    json: <TValue>() => {
      return createMaterializationMigrationColumn<"json", TValue, true>(
        "json",
        null,
        true,
      );
    },
    text: () => createMaterializationMigrationColumn("text", null, true),
  };
}

function createMaterializationMigrationColumn<
  TKind extends ProjectionColumnKind,
  TValue,
  TNullable extends boolean,
>(
  kind: TKind,
  eventName: string | null,
  nullable: TNullable,
): ProjectionColumn<TKind, TValue, TNullable> {
  return {
    metadata: {
      eventName,
      kind,
      nullable,
    },
    notNull: () => {
      return createMaterializationMigrationColumn(kind, eventName, false);
    },
  };
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

function validateMaterializationIdentifier(
  context: string,
  value: string,
): void {
  if (value.length === 0) {
    throw new Error(`${context} must not be empty`);
  }
}

function readMaterializationTable(
  schema: AnyMaterializationSchema,
  tableName: string,
  context: string,
): ProjectionTableMetadata {
  const table = schema.metadata.tables[tableName];

  if (table === undefined) {
    throw new Error(`${context} references unknown table ${tableName}`);
  }

  return table;
}

function validateMaterializationColumnName(
  schema: AnyMaterializationSchema,
  tableName: string,
  columnName: string,
  context: string,
): void {
  const table = readMaterializationTable(schema, tableName, context);
  validateMaterializationColumnNames(table, [columnName], context);
}

function validateMaterializationColumnNames(
  table: ProjectionTableMetadata,
  columnNames: readonly string[],
  context: string,
): void {
  if (columnNames.length === 0) {
    throw new Error(`${context} must reference at least one column`);
  }

  for (const columnName of columnNames) {
    if (table.columns[columnName] === undefined) {
      throw new Error(`${context} references unknown column ${columnName}`);
    }
  }
}

function validateMaterializationTableMetadataMatch(
  context: string,
  expected: ProjectionTableMetadata,
  actual: ProjectionTableMetadata,
): void {
  if (
    !equalStringLists(
      Object.keys(expected.columns).sort(),
      Object.keys(actual.columns).sort(),
    )
  ) {
    throw new Error(`${context} must match current schema columns`);
  }

  for (const [columnName, expectedColumn] of Object.entries(expected.columns)) {
    const actualColumn = actual.columns[columnName];

    if (
      actualColumn === undefined ||
      !equalMaterializationColumnMetadata(expectedColumn, actualColumn)
    ) {
      throw new Error(
        `${context} must match current schema column ${columnName}`,
      );
    }
  }

  if (!equalStringLists(expected.primaryKey, actual.primaryKey)) {
    throw new Error(`${context} must match current schema primary key`);
  }

  if (!equalProjectionKeys(expected.keys, actual.keys)) {
    throw new Error(`${context} must match current schema keys`);
  }

  if (!equalProjectionIndexes(expected.indexes, actual.indexes)) {
    throw new Error(`${context} must match current schema indexes`);
  }
}

function validateMaterializationRelationsMetadataMatch(
  expected: Readonly<Record<string, ProjectionForeignKeyMetadata>>,
  actual: ReadonlyMap<string, ProjectionForeignKeyMetadata>,
): void {
  const expectedNames = Object.keys(expected).sort();
  const actualNames = [...actual.keys()].sort();

  if (!equalStringLists(expectedNames, actualNames)) {
    throw new Error(
      "materialization history must match current schema relations",
    );
  }

  for (const relationName of expectedNames) {
    const expectedRelation = expected[relationName];
    const actualRelation = actual.get(relationName);

    if (
      expectedRelation === undefined ||
      actualRelation === undefined ||
      !equalProjectionForeignKeyMetadata(expectedRelation, actualRelation)
    ) {
      throw new Error(
        `materialization history relation ${relationName} must match current schema`,
      );
    }
  }
}

function equalMaterializationColumnMetadata(
  left: ProjectionColumnMetadata,
  right: ProjectionColumnMetadata,
): boolean {
  return (
    left.kind === right.kind &&
    left.nullable === right.nullable &&
    left.eventName === right.eventName
  );
}

function equalStringLists(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function equalProjectionKeys(
  left: readonly ProjectionTableMetadata["keys"][number][],
  right: readonly ProjectionTableMetadata["keys"][number][],
): boolean {
  return equalSortedMetadataLists(left, right, projectionKeyIdentity);
}

function equalProjectionIndexes(
  left: readonly ProjectionIndexMetadata[],
  right: readonly ProjectionIndexMetadata[],
): boolean {
  return equalSortedMetadataLists(left, right, projectionIndexIdentity);
}

function equalSortedMetadataLists<T>(
  left: readonly T[],
  right: readonly T[],
  identity: (value: T) => string,
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftIdentities = left.map(identity).sort();
  const rightIdentities = right.map(identity).sort();

  return equalStringLists(leftIdentities, rightIdentities);
}

function projectionKeyIdentity(
  key: ProjectionTableMetadata["keys"][number],
): string {
  return `${key.kind}:${key.name ?? ""}:${key.columns.join(",")}`;
}

function projectionIndexIdentity(index: ProjectionIndexMetadata): string {
  return `${index.unique ? "unique" : "index"}:${index.name}:${index.columns.join(
    ",",
  )}`;
}

function equalProjectionForeignKeyMetadata(
  left: ProjectionForeignKeyMetadata,
  right: ProjectionForeignKeyMetadata,
): boolean {
  return (
    left.fromTable === right.fromTable &&
    left.toTable === right.toTable &&
    left.onDelete === right.onDelete &&
    equalStringLists(left.fromColumns, right.fromColumns) &&
    equalStringLists(left.toColumns, right.toColumns)
  );
}

function readMaterializationColumnMetadata(
  column: unknown,
  context: string,
): ProjectionColumnMetadata {
  if (typeof column !== "object" || column === null || Array.isArray(column)) {
    throw new Error(`${context} must return a materialization column`);
  }

  const metadata = (column as { readonly metadata?: unknown }).metadata;

  if (!isMaterializationColumnMetadata(metadata)) {
    throw new Error(`${context} must return a materialization column`);
  }

  return metadata;
}

function isMaterializationColumnMetadata(
  metadata: unknown,
): metadata is ProjectionColumnMetadata {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return false;
  }

  const maybeMetadata = metadata as {
    readonly eventName?: unknown;
    readonly kind?: unknown;
    readonly nullable?: unknown;
  };

  return (
    isMaterializationColumnKind(maybeMetadata.kind) &&
    (typeof maybeMetadata.eventName === "string" ||
      maybeMetadata.eventName === null) &&
    typeof maybeMetadata.nullable === "boolean"
  );
}

function isMaterializationColumnKind(
  kind: unknown,
): kind is ProjectionColumnKind {
  return (
    kind === "boolean" ||
    kind === "event_ref" ||
    kind === "integer" ||
    kind === "json" ||
    kind === "text"
  );
}

function validateMaterializationHistory(
  current: AnyMaterializationSchema,
  migrations: readonly MaterializationMigration[],
): void {
  validateMaterializationSchemaIdentity(current.namespace, current.version);

  if (migrations.length === 0) {
    throw new Error("materialization history must include migrations");
  }

  const versions = new Set<number>();
  let previousVersion = 0;

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(
        "materialization migration version must be a positive integer",
      );
    }

    if (migration.description.length === 0) {
      throw new Error(
        "materialization migration description must not be empty",
      );
    }

    if (migration.operations.length === 0) {
      throw new Error(
        "materialization migration must include at least one operation",
      );
    }

    for (const operation of migration.operations) {
      validateMaterializationMigrationOperation(migration.version, operation);
    }

    if (versions.has(migration.version)) {
      throw new Error(
        `duplicate materialization migration version ${migration.version}`,
      );
    }

    if (migration.version <= previousVersion) {
      throw new Error(
        "materialization history migrations must be in ascending version order",
      );
    }

    previousVersion = migration.version;
    versions.add(migration.version);
  }

  const sortedVersions = [...versions].sort((left, right) => left - right);
  const firstVersion = sortedVersions[0];
  const latestVersion = sortedVersions[sortedVersions.length - 1];

  if (firstVersion !== 1) {
    throw new Error("materialization history must start at version 1");
  }

  if (latestVersion !== current.version) {
    throw new Error(
      "materialization history latest migration must match current schema version",
    );
  }

  for (let index = 1; index < sortedVersions.length; index += 1) {
    const previousVersion = sortedVersions[index - 1];
    const version = sortedVersions[index];

    if (previousVersion === undefined || version === undefined) {
      throw new Error("materialization history versions must not be empty");
    }

    if (version !== previousVersion + 1) {
      throw new Error("materialization history versions must not have gaps");
    }
  }

  validateMaterializationHistoryResult(current, migrations);
}

function validateMaterializationHistoryResult(
  current: AnyMaterializationSchema,
  migrations: readonly MaterializationMigration[],
): void {
  const state: MaterializationHistoryReplayState = {
    indexNames: new Map(),
    relations: new Map(),
    tables: new Map(),
  };

  for (const migration of migrations) {
    for (const operation of migration.operations) {
      applyMaterializationMigrationOperation(current, state, operation);
    }
  }

  if (
    !equalStringLists(
      [...state.tables.keys()].sort(),
      Object.keys(current.metadata.tables).sort(),
    )
  ) {
    throw new Error("materialization history must match current schema tables");
  }

  for (const [tableName, expectedTable] of Object.entries(
    current.metadata.tables,
  )) {
    const actualTable = state.tables.get(tableName);

    if (actualTable === undefined) {
      throw new Error(
        `materialization history must create current schema table ${tableName}`,
      );
    }

    validateMaterializationTableMetadataMatch(
      `materialization history table ${tableName}`,
      expectedTable,
      actualTable,
    );
  }

  validateMaterializationRelationsMetadataMatch(
    current.metadata.relations,
    state.relations,
  );
}

type MaterializationHistoryReplayState = {
  readonly indexNames: Map<string, string>;
  readonly relations: Map<string, ProjectionForeignKeyMetadata>;
  readonly tables: Map<string, ProjectionTableMetadata>;
};

function applyMaterializationMigrationOperation(
  current: AnyMaterializationSchema,
  state: MaterializationHistoryReplayState,
  operation: MaterializationMigrationOperation,
): void {
  switch (operation.kind) {
    case "create_table":
      if (state.tables.has(operation.tableName)) {
        throw new Error(
          `materialization history creates duplicate table ${operation.tableName}`,
        );
      }

      for (const index of operation.table.indexes) {
        validateMaterializationReplayIndexName(state, index.name);
      }

      state.tables.set(operation.tableName, operation.table);
      return;
    case "add_column": {
      const table = state.tables.get(operation.tableName);

      if (table === undefined) {
        throw new Error(
          `materialization history adds column to unknown table ${operation.tableName}`,
        );
      }

      if (table.columns[operation.columnName] !== undefined) {
        throw new Error(
          `materialization history adds duplicate column ${operation.tableName}.${operation.columnName}`,
        );
      }

      state.tables.set(operation.tableName, {
        ...table,
        columns: {
          ...table.columns,
          [operation.columnName]: operation.column,
        },
      });
      return;
    }
    case "create_index": {
      const table = state.tables.get(operation.tableName);

      if (table === undefined) {
        throw new Error(
          `materialization history creates index on unknown table ${operation.tableName}`,
        );
      }

      validateMaterializationColumnNames(
        table,
        operation.index.columns,
        `materialization history index ${operation.index.name}`,
      );
      validateMaterializationReplayIndexName(state, operation.index.name);

      state.tables.set(operation.tableName, {
        ...table,
        indexes: [...table.indexes, operation.index],
        keys: operation.index.unique
          ? [
              ...table.keys,
              {
                columns: operation.index.columns,
                kind: "unique",
                name: operation.index.name,
              },
            ]
          : table.keys,
      });
      return;
    }
    case "add_foreign_key":
      validateMaterializationForeignKeyReplay(
        state.tables,
        operation.name,
        operation.foreignKey,
      );

      if (state.relations.has(operation.name)) {
        throw new Error(
          `materialization history adds duplicate relation ${operation.name}`,
        );
      }

      state.relations.set(operation.name, operation.foreignKey);
      return;
    case "data":
      validateMaterializationDataReplay(current, state);
      return;
  }
}

function validateMaterializationReplayIndexName(
  state: MaterializationHistoryReplayState,
  indexName: string,
): void {
  const normalized = normalizeMaterializationSqliteIdentifier(indexName);
  const existing = state.indexNames.get(normalized);

  if (existing !== undefined) {
    throw new Error(
      `materialization history index ${indexName} conflicts with ${existing}`,
    );
  }

  state.indexNames.set(normalized, indexName);
}

function validateMaterializationDataReplay(
  current: AnyMaterializationSchema,
  state: MaterializationHistoryReplayState,
): void {
  for (const [tableName, expectedTable] of Object.entries(
    current.metadata.tables,
  )) {
    const actualTable = state.tables.get(tableName);

    if (actualTable === undefined) {
      throw new Error(
        `materialization data operation requires current schema table ${tableName}`,
      );
    }

    if (
      !equalStringLists(
        Object.keys(expectedTable.columns).sort(),
        Object.keys(actualTable.columns).sort(),
      )
    ) {
      throw new Error(
        `materialization data operation requires current schema table ${tableName} columns`,
      );
    }

    for (const [columnName, expectedColumn] of Object.entries(
      expectedTable.columns,
    )) {
      const actualColumn = actualTable.columns[columnName];

      if (
        actualColumn === undefined ||
        !equalMaterializationColumnMetadata(expectedColumn, actualColumn)
      ) {
        throw new Error(
          `materialization data operation requires current schema column ${tableName}.${columnName}`,
        );
      }
    }

    if (!equalStringLists(expectedTable.primaryKey, actualTable.primaryKey)) {
      throw new Error(
        `materialization data operation requires current schema table ${tableName} primary key`,
      );
    }

    if (!equalProjectionKeys(expectedTable.keys, actualTable.keys)) {
      throw new Error(
        `materialization data operation requires current schema table ${tableName} keys`,
      );
    }

    if (!equalProjectionIndexes(expectedTable.indexes, actualTable.indexes)) {
      throw new Error(
        `materialization data operation requires current schema table ${tableName} indexes`,
      );
    }
  }

  validateMaterializationDataRelationsReplay(current, state);
}

function validateMaterializationDataRelationsReplay(
  current: AnyMaterializationSchema,
  state: MaterializationHistoryReplayState,
): void {
  const expectedNames = Object.keys(current.metadata.relations).sort();
  const actualNames = [...state.relations.keys()].sort();

  if (!equalStringLists(expectedNames, actualNames)) {
    throw new Error(
      "materialization data operation requires current schema relations",
    );
  }

  for (const relationName of expectedNames) {
    const expectedRelation = current.metadata.relations[relationName];
    const actualRelation = state.relations.get(relationName);

    if (
      expectedRelation === undefined ||
      actualRelation === undefined ||
      !equalProjectionForeignKeyMetadata(expectedRelation, actualRelation)
    ) {
      throw new Error(
        `materialization data operation requires current schema relation ${relationName}`,
      );
    }
  }
}

function validateMaterializationForeignKeyReplay(
  tables: ReadonlyMap<string, ProjectionTableMetadata>,
  name: string,
  foreignKey: ProjectionForeignKeyMetadata,
): void {
  const fromTable = tables.get(foreignKey.fromTable);

  if (fromTable === undefined) {
    throw new Error(
      `materialization history relation ${name} references unknown table ${foreignKey.fromTable}`,
    );
  }

  validateMaterializationColumnNames(
    fromTable,
    foreignKey.fromColumns,
    `materialization history relation ${name}`,
  );

  const toTable = tables.get(foreignKey.toTable);

  if (toTable === undefined) {
    throw new Error(
      `materialization history relation ${name} references unknown table ${foreignKey.toTable}`,
    );
  }

  validateMaterializationColumnNames(
    toTable,
    foreignKey.toColumns,
    `materialization history relation ${name}`,
  );

  const referencesKey = toTable.keys.some((key) => {
    return equalStringLists(key.columns, foreignKey.toColumns);
  });

  if (!referencesKey) {
    throw new Error(
      `materialization history relation ${name} must target a primary or unique key on ${foreignKey.toTable}`,
    );
  }
}

function normalizeMaterializationSqliteIdentifier(identifier: string): string {
  return identifier.toLocaleLowerCase("en-US");
}

function validateMaterializationMigrationOperation(
  version: number,
  operation: MaterializationMigrationOperation,
): void {
  switch (operation.kind) {
    case "add_column":
    case "add_foreign_key":
    case "create_index":
    case "create_table":
      return;
    case "data":
      validateMaterializationIdentifier(
        `materialization migration ${version} data operation description`,
        operation.description,
      );

      if (typeof operation.run !== "function") {
        throw new Error(
          `materialization migration ${version} data operation must provide a function`,
        );
      }

      return;
  }
}

function validateMaterializationEvents<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  THistory extends AnyMaterializationHistory,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
>(
  shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>,
  materializations: Materializations<
    THistory,
    TIndexerDefinitions,
    TQueryDefinitions
  >,
): void {
  const eventNames = new Set(Object.keys(shape.events));

  validateMaterializationSchemaEventRefs(
    materializations.history.current,
    eventNames,
  );
  validateMaterializationHistoryEventRefs(materializations.history, eventNames);

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

function validateMaterializationSchemaEventRefs(
  schema: AnyMaterializationSchema,
  eventNames: ReadonlySet<string>,
): void {
  for (const table of Object.values(schema.metadata.tables)) {
    for (const [columnName, column] of Object.entries(table.columns)) {
      validateMaterializationColumnEventRef(
        column,
        `materialization column ${table.name}.${columnName}`,
        eventNames,
      );
    }
  }
}

function validateMaterializationHistoryEventRefs(
  history: AnyMaterializationHistory,
  eventNames: ReadonlySet<string>,
): void {
  for (const migration of history.migrations) {
    for (const operation of migration.operations) {
      switch (operation.kind) {
        case "add_column":
          validateMaterializationColumnEventRef(
            operation.column,
            `materialization migration ${migration.version} column ${operation.tableName}.${operation.columnName}`,
            eventNames,
          );
          break;
        case "add_foreign_key":
        case "create_index":
          break;
        case "create_table":
          for (const [columnName, column] of Object.entries(
            operation.table.columns,
          )) {
            validateMaterializationColumnEventRef(
              column,
              `materialization migration ${migration.version} column ${operation.table.name}.${columnName}`,
              eventNames,
            );
          }
          break;
      }
    }
  }
}

function validateMaterializationColumnEventRef(
  column: ProjectionColumnMetadata,
  context: string,
  eventNames: ReadonlySet<string>,
): void {
  if (column.eventName === null) {
    return;
  }

  if (!eventNames.has(column.eventName)) {
    throw new Error(`${context} references unknown event ${column.eventName}`);
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
      const registeredModel: RegisteredLedgerModel<
        TEvents,
        TQueues,
        TIndexers,
        TQueries,
        TSignals,
        TSignalQueues,
        TProjectionSchema,
        TIndexerDefinitions,
        TQueryDefinitions
      > = {
        [registeredLedgerModelBrand]: true,
        model,
        projections: input.access.projections,
        register,
      };

      return attachLedgerImplementationFactory(registeredModel, (factory) => {
        return createProjectionImplementations({
          events: input.shape.events,
          statementCompiler: factory.statementCompiler,
          projections: input.access.projections,
          indexers: input.access.indexerDefinitions,
          queries: input.access.queryDefinitions,
          register,
        }) as LedgerImplementations<TIndexers, TQueries, TEvents>;
      });
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
    TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
    TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
    TQueryDefinitions extends ProjectionQueryDefinitions = {},
  >(input: {
    readonly model: RegisteredLedgerModel<
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
  const TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  const TQueryDefinitions extends ProjectionQueryDefinitions = {},
>(input: {
  readonly model: RegisteredLedgerModel<
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
  readonly engineFactory: LedgerEngineFactory;
  readonly timing: LedgerTiming;
}): Ledger<TEvents, TQueries, TSignals> {
  return input.engineFactory.openLedger({
    model: input.model,
    timing: input.timing,
  });
}
