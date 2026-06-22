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
  type ProjectionWriteResult,
} from "./projection-access.ts";
import {
  createProjectionRelationBuilder,
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
  type ProjectionSchemaRelations,
  type ProjectionSchemaTables,
  type ProjectionTableDefinition,
  type ProjectionTableBuilder,
  type ProjectionTableColumnName,
  type ProjectionTableColumns,
  type ProjectionTableMetadata,
  type ProjectionTableName,
  type ProjectionTableWithColumn,
  type ProjectionTableWithUniqueKey,
} from "./projections.ts";

const registeredLedgerModelBrand: unique symbol = Symbol(
  "sledge.registeredLedgerModel",
);
const materializationMigrationChainStateBrand: unique symbol = Symbol(
  "sledge.materializationMigrationChainState",
);

export type {
  ProjectionAggregateBuilder,
  ProjectionExecutableSelect,
  ProjectionExecutableUnionSelect,
  ProjectionExecutableJoinedSelect,
  ProjectionExecutableWrite,
  ProjectionEventScanBuilder,
  ProjectionEventIdBounds,
  ProjectionLatestEventRefByPayload,
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
  TMaterializationHistory extends AnyMaterializationHistory<TEvents> | null =
    AnyMaterializationHistory<TEvents> | null,
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
  readonly materializationHistory: TMaterializationHistory;
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
      TEvents,
      TSignals
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

export type MaterializationDefinitionInput<TNamespace extends string> = {
  readonly namespace: TNamespace;
};

type MaterializationSchemaNamespace<TSchema extends AnyMaterializationSchema> =
  TSchema["namespace"];

type MaterializationSchemaVersion<TSchema extends AnyMaterializationSchema> =
  TSchema["version"];

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

type MaterializationTableDefinitionLike = {
  readonly metadata: ProjectionTableMetadata;
};

type MaterializationSchemaWithVersion<
  TSchema extends AnyMaterializationSchema,
  TVersion extends number,
> = MaterializationSchema<
  MaterializationSchemaNamespace<TSchema>,
  TVersion,
  ProjectionSchemaTables<TSchema>,
  ProjectionSchemaRelations<TSchema>,
  ProjectionSchemaEventName<TSchema>
>;

type MaterializationSchemaWithTable<
  TSchema extends AnyMaterializationSchema,
  TTableName extends string,
  TTable extends MaterializationTableDefinitionLike,
> = MaterializationSchema<
  MaterializationSchemaNamespace<TSchema>,
  MaterializationSchemaVersion<TSchema>,
  ProjectionSchemaTables<TSchema> & Record<TTableName, TTable>,
  ProjectionSchemaRelations<TSchema>,
  ProjectionSchemaEventName<TSchema>
>;

type MaterializationTablesWithColumn<
  TSchema extends AnyMaterializationSchema,
  TTableName extends MaterializationTableName<TSchema>,
  TColumnName extends string,
  TColumn extends ProjectionColumn<ProjectionColumnKind, unknown, boolean>,
> = {
  readonly [TName in keyof ProjectionSchemaTables<TSchema>]: TName extends TTableName
    ? ProjectionTableWithColumn<
        ProjectionSchemaTables<TSchema>[TName],
        TColumnName,
        TColumn
      >
    : ProjectionSchemaTables<TSchema>[TName];
};

type MaterializationSchemaWithColumn<
  TSchema extends AnyMaterializationSchema,
  TTableName extends MaterializationTableName<TSchema>,
  TColumnName extends string,
  TColumn extends ProjectionColumn<ProjectionColumnKind, unknown, boolean>,
> = MaterializationSchema<
  MaterializationSchemaNamespace<TSchema>,
  MaterializationSchemaVersion<TSchema>,
  MaterializationTablesWithColumn<TSchema, TTableName, TColumnName, TColumn>,
  ProjectionSchemaRelations<TSchema>,
  ProjectionSchemaEventName<TSchema>
>;

type MaterializationTablesWithUniqueKey<
  TSchema extends AnyMaterializationSchema,
  TTableName extends MaterializationTableName<TSchema>,
  TColumns extends readonly string[],
> = {
  readonly [TName in keyof ProjectionSchemaTables<TSchema>]: TName extends TTableName
    ? ProjectionTableWithUniqueKey<
        ProjectionSchemaTables<TSchema>[TName],
        TColumns
      >
    : ProjectionSchemaTables<TSchema>[TName];
};

type MaterializationSchemaWithUniqueKey<
  TSchema extends AnyMaterializationSchema,
  TTableName extends MaterializationTableName<TSchema>,
  TColumns extends readonly string[],
> = MaterializationSchema<
  MaterializationSchemaNamespace<TSchema>,
  MaterializationSchemaVersion<TSchema>,
  MaterializationTablesWithUniqueKey<TSchema, TTableName, TColumns>,
  ProjectionSchemaRelations<TSchema>,
  ProjectionSchemaEventName<TSchema>
>;

type MaterializationSchemaWithRelation<
  TSchema extends AnyMaterializationSchema,
  TName extends string,
  TRelation extends ProjectionRelationDefinition,
> = MaterializationSchema<
  MaterializationSchemaNamespace<TSchema>,
  MaterializationSchemaVersion<TSchema>,
  ProjectionSchemaTables<TSchema>,
  ProjectionSchemaRelations<TSchema> & Record<TName, TRelation>,
  ProjectionSchemaEventName<TSchema>
>;

type NewMaterializationTableName<
  TSchema extends AnyMaterializationSchema,
  TTableName extends string,
> = TTableName extends MaterializationTableName<TSchema> ? never : TTableName;

type NewMaterializationColumnName<
  TSchema extends AnyMaterializationSchema,
  TTableName extends MaterializationTableName<TSchema>,
  TColumnName extends string,
> =
  TColumnName extends MaterializationColumnName<TSchema, TTableName>
    ? never
    : TColumnName;

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
  execute(): Promise<ProjectionWriteResult>;
  where<const TColumnName extends ProjectionTableColumnName<TTable>>(
    columnName: TColumnName,
    operator: "=",
    value: MaterializationMigrationWhereValue<TTable, TColumnName>,
  ): MaterializationMigrationUpdateWhereBuilder<TTable>;
};

export type MaterializationMigrationDeleteBuilder<TTable> = {
  execute(): Promise<ProjectionWriteResult>;
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

export type MaterializationMigrationChain<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
  TOperations extends readonly MaterializationMigrationOperation[],
> = {
  addColumn<
    const TTableName extends MaterializationTableName<TCurrentSchema>,
    const TColumnName extends string,
    const TColumn extends ProjectionColumn<
      ProjectionColumnKind,
      unknown,
      boolean
    >,
  >(
    tableName: TTableName,
    columnName: NewMaterializationColumnName<
      TCurrentSchema,
      TTableName,
      TColumnName
    >,
    build: (
      columns: MaterializationMigrationColumnBuilder<
        ProjectionSchemaEventName<TCurrentSchema>
      >,
    ) => TColumn,
  ): MaterializationMigrationChain<
    MaterializationSchemaWithColumn<
      TCurrentSchema,
      TTableName,
      TColumnName,
      TColumn
    >,
    TEvents,
    readonly [
      ...TOperations,
      MaterializationMigrationOperation<TCurrentSchema, TEvents>,
    ]
  >;

  addForeignKey<
    const TName extends string,
    const TRelation extends ProjectionRelationDefinition,
  >(
    name: TName,
    build: (
      relations: ProjectionRelationBuilder<
        ProjectionSchemaTables<TCurrentSchema>
      >,
    ) => TRelation,
  ): MaterializationMigrationChain<
    MaterializationSchemaWithRelation<TCurrentSchema, TName, TRelation>,
    TEvents,
    readonly [
      ...TOperations,
      MaterializationMigrationOperation<TCurrentSchema, TEvents>,
    ]
  >;

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
  ): MaterializationMigrationChain<
    TCurrentSchema,
    TEvents,
    readonly [
      ...TOperations,
      MaterializationMigrationOperation<TCurrentSchema, TEvents>,
    ]
  >;

  createTable<
    const TTableName extends string,
    const TTable extends MaterializationTableDefinitionLike,
  >(
    tableName: NewMaterializationTableName<TCurrentSchema, TTableName>,
    build: (
      table: ProjectionTableBuilder<ProjectionSchemaEventName<TCurrentSchema>>,
    ) => TTable,
  ): MaterializationMigrationChain<
    MaterializationSchemaWithTable<TCurrentSchema, TTableName, TTable>,
    TEvents,
    readonly [
      ...TOperations,
      MaterializationMigrationOperation<TCurrentSchema, TEvents>,
    ]
  >;

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
  ): MaterializationMigrationChain<
    MaterializationSchemaWithUniqueKey<
      TCurrentSchema,
      TTableName,
      TColumnNames
    >,
    TEvents,
    readonly [
      ...TOperations,
      MaterializationMigrationOperation<TCurrentSchema, TEvents>,
    ]
  >;

  data<const TDescription extends string>(
    description: TDescription,
    run: MaterializationMigrationDataFunction<TCurrentSchema, TEvents>,
  ): MaterializationMigrationChain<
    TCurrentSchema,
    TEvents,
    readonly [
      ...TOperations,
      MaterializationMigrationOperation<TCurrentSchema, TEvents>,
    ]
  >;
};

export type MaterializationDefinitionBuilder<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
  TMigrations extends readonly MaterializationMigration[] =
    readonly MaterializationMigration[],
> = {
  version<
    const TVersion extends number,
    const TDescription extends string,
    TNextSchema extends AnyMaterializationSchema,
    const TOperations extends MaterializationMigrationOperations,
  >(
    version: TVersion,
    description: TDescription,
    build: (
      steps: MaterializationMigrationChain<
        TCurrentSchema,
        TEvents,
        readonly []
      >,
    ) => MaterializationMigrationChain<TNextSchema, TEvents, TOperations>,
  ): MaterializationDefinitionBuilder<
    MaterializationSchemaWithVersion<TNextSchema, TVersion>,
    TEvents,
    readonly MaterializationMigration[]
  >;
  define<
    const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
    const TQueryDefinitions extends ProjectionQueryDefinitions,
  >(input: {
    readonly indexers: TIndexerDefinitions;
    readonly queries: TQueryDefinitions;
  }): Materializations<
    MaterializationHistory<TCurrentSchema, TMigrations>,
    TIndexerDefinitions,
    TQueryDefinitions
  >;
};

export type MaterializationHistory<
  TCurrentSchema extends AnyMaterializationSchema,
  TMigrations extends readonly MaterializationMigration[],
> = {
  readonly current: TCurrentSchema;
  readonly currentVersion: TCurrentSchema["version"];
  readonly migrations: TMigrations;
  readonly namespace: TCurrentSchema["namespace"];
};

export type AnyMaterializationHistory<
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
  TCurrentSchema extends AnyMaterializationSchema = AnyMaterializationSchema,
> = MaterializationHistory<
  TCurrentSchema,
  readonly MaterializationMigration<
    number,
    string,
    MaterializationMigrationOperations<TCurrentSchema, TEvents>
  >[]
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
  TSignals extends Record<string, TSchema> = {},
> = ProjectionImplementationRegistration<
  TMaterializationSchema,
  TIndexerDefinitions,
  TQueryDefinitions,
  TEvents,
  TSignals
>;

export function defineMaterialization<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const TNamespace extends string,
>(
  shape: DefinedLedgerShape<TEvents, TQueues, TSignals, TSignalQueues>,
  input: MaterializationDefinitionInput<TNamespace>,
): MaterializationDefinitionBuilder<
  MaterializationSchema<TNamespace, 0, {}, {}, Extract<keyof TEvents, string>>,
  TEvents,
  readonly []
> {
  validateMaterializationNamespace(input.namespace);

  return createMaterializationDefinitionBuilder({
    current: createMaterializationSchemaFromMetadata({
      metadata: {
        relations: {},
        tables: {},
      },
      namespace: input.namespace,
      version: 0,
    }) as MaterializationSchema<
      TNamespace,
      0,
      {},
      {},
      Extract<keyof TEvents, string>
    >,
    events: shape.shape.events,
    migrations: [],
  });
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
    ProjectionSchema<{}, {}, Extract<keyof TEvents, string>>,
    {},
    {},
    null
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
  TMaterializationHistory extends AnyMaterializationHistory<TEvents> | null =
    AnyMaterializationHistory<TEvents> | null,
> = {
  readonly materializationHistory: TMaterializationHistory;
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
        TEvents,
        TSignals
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
    TQueryDefinitions,
    TMaterializationHistory
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
        materializationHistory: null,
      }).register(register);
    },
  };
}

export function withMaterializations<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const THistory extends AnyMaterializationHistory<TEvents>,
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
  TQueryDefinitions,
  THistory
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
    materializationHistory: materializations.history,
  });
}

type MaterializationMigrationChainState<
  TCurrentSchema extends AnyMaterializationSchema,
> = {
  readonly current: TCurrentSchema;
  readonly operations: readonly MaterializationMigrationOperation[];
};

type MaterializationMigrationChainRuntime<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
  TOperations extends readonly MaterializationMigrationOperation[],
> = MaterializationMigrationChain<TCurrentSchema, TEvents, TOperations> & {
  readonly [materializationMigrationChainStateBrand]: MaterializationMigrationChainState<TCurrentSchema>;
};

function createMaterializationDefinitionBuilder<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
  TMigrations extends readonly MaterializationMigration[],
>(input: {
  readonly current: TCurrentSchema;
  readonly events: TEvents;
  readonly migrations: TMigrations;
}): MaterializationDefinitionBuilder<TCurrentSchema, TEvents, TMigrations> {
  return {
    version: (version, description, build) => {
      const chain = build(
        createMaterializationMigrationChain<
          TCurrentSchema,
          TEvents,
          readonly []
        >({
          current: input.current,
          operations: [],
        }),
      );
      const state = readMaterializationMigrationChainState(chain);
      const current = withMaterializationSchemaVersion(state.current, version);
      const migration = {
        description,
        operations: state.operations as MaterializationMigrationOperations,
        version,
      } as MaterializationMigration;

      return createMaterializationDefinitionBuilder({
        current,
        events: input.events,
        migrations: [
          ...input.migrations,
          migration,
        ] as readonly MaterializationMigration[],
      });
    },
    define: (definition) => {
      if (input.migrations.length === 0) {
        throw new Error("materialization must include at least one version");
      }

      const history = {
        current: input.current,
        currentVersion: input.current.version,
        migrations: input.migrations,
        namespace: input.current.namespace,
      };
      const eventNames = new Set(Object.keys(input.events));

      validateMaterializationHistory(input.current, input.migrations);
      validateMaterializationSchemaEventRefs(input.current, eventNames);
      validateMaterializationHistoryEventRefs(history, eventNames);

      return {
        history,
        indexers: definition.indexers,
        queries: definition.queries,
      } as Materializations<
        MaterializationHistory<TCurrentSchema, TMigrations>,
        typeof definition.indexers,
        typeof definition.queries
      >;
    },
  };
}

function createMaterializationMigrationChain<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
  TOperations extends readonly MaterializationMigrationOperation[],
>(input: {
  readonly current: TCurrentSchema;
  readonly operations: TOperations;
}): MaterializationMigrationChainRuntime<TCurrentSchema, TEvents, TOperations> {
  const chain = {
    [materializationMigrationChainStateBrand]: input,
    addColumn: (tableName, columnName, build) => {
      readMaterializationTable(
        input.current,
        String(tableName),
        "materialization add column",
      );
      validateMaterializationIdentifier(
        "materialization column name",
        String(columnName),
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

      return advanceMaterializationMigrationChain(input, {
        column: metadata,
        columnName: String(columnName),
        kind: "add_column",
        tableName: String(tableName),
      });
    },
    addForeignKey: (name, build) => {
      validateMaterializationIdentifier(
        "materialization foreign key name",
        name,
      );
      const relation = build(
        createProjectionRelationBuilder<ProjectionSchemaTables<TCurrentSchema>>(
          input.current.metadata.tables,
        ),
      );
      const foreignKey = relation.metadata;

      if (foreignKey === undefined || typeof foreignKey !== "object") {
        throw new Error(`materialization foreign key ${name} was not defined`);
      }

      return advanceMaterializationMigrationChain(input, {
        foreignKey,
        kind: "add_foreign_key",
        name,
      });
    },
    createIndex: (name, tableName, columns) => {
      const table = readMaterializationTable(
        input.current,
        String(tableName),
        "materialization create index",
      );
      validateMaterializationIdentifier("materialization index name", name);
      validateMaterializationColumnNames(
        table,
        columns.map(String),
        "materialization create index",
      );

      return advanceMaterializationMigrationChain(input, {
        index: {
          columns: columns.map(String),
          name,
          unique: false,
        },
        kind: "create_index",
        tableName: String(tableName),
      });
    },
    createTable: (tableName, build) => {
      validateMaterializationIdentifier(
        "materialization table name",
        String(tableName),
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

      return advanceMaterializationMigrationChain(input, {
        kind: "create_table",
        table,
        tableName: String(tableName),
      });
    },
    createUniqueIndex: (name, tableName, columns) => {
      const table = readMaterializationTable(
        input.current,
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

      return advanceMaterializationMigrationChain(input, {
        index: {
          columns: columns.map(String),
          name,
          unique: true,
        },
        kind: "create_index",
        tableName: String(tableName),
      });
    },
    data: (description, run) => {
      validateMaterializationIdentifier(
        "materialization data migration description",
        description,
      );

      return advanceMaterializationMigrationChain(input, {
        description,
        kind: "data",
        run,
      });
    },
  } satisfies MaterializationMigrationChainRuntime<
    TCurrentSchema,
    TEvents,
    TOperations
  >;

  return chain;
}

function advanceMaterializationMigrationChain<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
  TOperations extends readonly MaterializationMigrationOperation[],
>(
  input: {
    readonly current: TCurrentSchema;
    readonly operations: TOperations;
  },
  operation: MaterializationMigrationOperation<TCurrentSchema, TEvents>,
): MaterializationMigrationChainRuntime<
  AnyMaterializationSchema,
  TEvents,
  readonly [
    ...TOperations,
    MaterializationMigrationOperation<TCurrentSchema, TEvents>,
  ]
> {
  const current = applyMaterializationOperationToSchema(
    input.current,
    operation,
  );

  return createMaterializationMigrationChain({
    current,
    operations: [...input.operations, operation],
  });
}

function readMaterializationMigrationChainState<
  TCurrentSchema extends AnyMaterializationSchema,
  TEvents extends Record<string, TSchema>,
>(
  chain: MaterializationMigrationChain<
    TCurrentSchema,
    TEvents,
    readonly MaterializationMigrationOperation[]
  >,
): MaterializationMigrationChainState<TCurrentSchema> {
  const state = (
    chain as {
      readonly [materializationMigrationChainStateBrand]?: unknown;
    }
  )[materializationMigrationChainStateBrand];

  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error(
      "materialization migration must return the migration chain",
    );
  }

  return state as MaterializationMigrationChainState<TCurrentSchema>;
}

function withMaterializationSchemaVersion<
  TCurrentSchema extends AnyMaterializationSchema,
  TVersion extends number,
>(
  current: TCurrentSchema,
  version: TVersion,
): MaterializationSchemaWithVersion<TCurrentSchema, TVersion> {
  return createMaterializationSchemaFromMetadata({
    metadata: current.metadata,
    namespace: current.namespace,
    version,
  }) as MaterializationSchemaWithVersion<TCurrentSchema, TVersion>;
}

function applyMaterializationOperationToSchema(
  schema: AnyMaterializationSchema,
  operation: MaterializationMigrationOperation,
): AnyMaterializationSchema {
  const state = createMaterializationReplayStateFromSchema(schema);

  applyMaterializationMigrationOperation(state, operation);

  return createMaterializationSchemaFromMetadata({
    metadata: {
      relations: Object.fromEntries(state.relations),
      tables: Object.fromEntries(state.tables),
    },
    namespace: schema.namespace,
    version: schema.version,
  });
}

function createMaterializationReplayStateFromSchema(
  schema: AnyMaterializationSchema,
): MaterializationHistoryReplayState {
  const state: MaterializationHistoryReplayState = {
    indexNames: new Map(),
    relations: new Map(Object.entries(schema.metadata.relations)),
    tables: new Map(Object.entries(schema.metadata.tables)),
  };

  for (const table of Object.values(schema.metadata.tables)) {
    for (const index of table.indexes) {
      state.indexNames.set(
        normalizeMaterializationSqliteIdentifier(index.name),
        index.name,
      );
    }
  }

  return state;
}

function createMaterializationSchemaFromMetadata(input: {
  readonly metadata: {
    readonly relations: Readonly<Record<string, ProjectionForeignKeyMetadata>>;
    readonly tables: Readonly<Record<string, ProjectionTableMetadata>>;
  };
  readonly namespace: string;
  readonly version: number;
}): AnyMaterializationSchema {
  return {
    metadata: input.metadata,
    namespace: input.namespace,
    relations: <const TNextRelations extends ProjectionRelations>(
      build: (
        relations: ProjectionRelationBuilder<Record<string, never>>,
      ) => TNextRelations,
    ) => {
      const definitions = build(
        createProjectionRelationBuilder(input.metadata.tables),
      );
      const relations: Record<string, ProjectionForeignKeyMetadata> = {};

      for (const [name, definition] of Object.entries(definitions)) {
        relations[name] = definition.metadata;
      }

      return createMaterializationSchemaFromMetadata({
        metadata: {
          relations,
          tables: input.metadata.tables,
        },
        namespace: input.namespace,
        version: input.version,
      });
    },
    version: input.version,
  } as AnyMaterializationSchema;
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
  validateMaterializationNamespace(namespace);

  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(
      "materialization schema version must be a positive integer",
    );
  }
}

function validateMaterializationNamespace(namespace: string): void {
  if (namespace.length === 0) {
    throw new Error("materialization namespace must not be empty");
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
      applyMaterializationMigrationOperation(state, operation);
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
      validateMaterializationDataReplay(state);
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
  state: MaterializationHistoryReplayState,
): void {
  for (const [relationName, foreignKey] of state.relations) {
    validateMaterializationForeignKeyReplay(
      state.tables,
      relationName,
      foreignKey,
    );
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
  THistory extends AnyMaterializationHistory<TEvents>,
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
  TMaterializationHistory extends AnyMaterializationHistory<TEvents> | null,
>(input: {
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  readonly materializationHistory: TMaterializationHistory;
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
  TQueryDefinitions,
  TMaterializationHistory
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
    materializationHistory: input.materializationHistory,
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
        TQueryDefinitions,
        TMaterializationHistory
      > = {
        [registeredLedgerModelBrand]: true,
        materializationHistory: input.materializationHistory,
        model,
        projections: input.access.projections,
        register,
      };

      return attachLedgerImplementationFactory(registeredModel, (factory) => {
        return createProjectionImplementations({
          events: input.shape.events,
          signals: input.shape.signals,
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
