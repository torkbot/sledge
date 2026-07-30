import type { Static, TSchema } from "typebox";

import type { RuntimeClock, RuntimeScheduler } from "../runtime/contracts.ts";
import { createEventRef, type EventRef } from "./event-ref.ts";
import type { LedgerImplementations } from "./internal-storage.ts";
import {
  attachLedgerImplementationFactory,
  attachLedgerProjectionCompilerFactory,
  attachLedgerProjectionSchemas,
  composedLedgerModulesBrand,
  readLedgerImplementations,
  registeredLedgerContractsBrand,
  registeredLedgerRuntimeBrand,
} from "./internal-storage.ts";
import {
  createProjectionAccess,
  createProjectionImplementations,
  type AnyProjectionSchema,
  type ProjectionAccess,
  type ProjectionDatabase,
  type ProjectionImplementationRegistration,
  type ProjectionIndexerDefinitions,
  type ProjectionIndexerSchemas,
  type ProjectionIndexerSchemasForEvent,
  type ProjectionInsertBuilder,
  type ProjectionEventScanBuilder,
  type ProjectionQueryDefinitions,
  type ProjectionQuerySchemas,
  type ProjectionReadDatabase,
  type ProjectionUpdateRow,
  type ProjectionWriteDatabase,
  type ProjectionWriteResult,
} from "./projection-access.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";
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
const composedLedgerModelBrand: unique symbol = Symbol(
  "sledge.composedLedgerModel",
);
const materializationMigrationChainStateBrand: unique symbol = Symbol(
  "sledge.materializationMigrationChainState",
);
declare const eventTokenTypeBrand: unique symbol;
declare const queryTokenTypeBrand: unique symbol;
declare const queueTokenTypeBrand: unique symbol;
declare const signalTokenTypeBrand: unique symbol;
declare const signalQueueTokenTypeBrand: unique symbol;
const ledgerContractTokenMetadata = new WeakMap<
  object,
  LedgerContractMetadata
>();
const physicalNameSeparator = "::";
const reservedMaterializationSqliteObjectNames = [
  "events",
  "idx_work_coalescing_pending",
  "idx_work_due",
  "idx_work_key",
  "idx_work_partition_order",
  "idx_work_ref",
  "sledge_materialization_versions",
  "sledge_storage_layout",
  "work",
] as const;
const sqliteInternalMaterializationNamePrefix = "sqlite_";

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

export type EventToken<
  TModuleId extends string = string,
  TName extends string = string,
  TPayloadSchema extends TSchema = TSchema,
> = {
  readonly [eventTokenTypeBrand]: {
    readonly moduleId: TModuleId;
    readonly name: TName;
    readonly schema: TPayloadSchema;
  };
};

export type QueryToken<
  TModuleId extends string = string,
  TName extends string = string,
  TParamsSchema extends TSchema = TSchema,
  TResultSchema extends TSchema = TSchema,
> = {
  readonly [queryTokenTypeBrand]: {
    readonly moduleId: TModuleId;
    readonly name: TName;
    readonly params: TParamsSchema;
    readonly result: TResultSchema;
  };
};

type QueueToken<
  TModuleId extends string = string,
  TName extends string = string,
  TPayloadSchema extends TSchema = TSchema,
> = {
  readonly [queueTokenTypeBrand]: {
    readonly moduleId: TModuleId;
    readonly name: TName;
    readonly schema: TPayloadSchema;
  };
};

export type SignalToken<
  TModuleId extends string = string,
  TName extends string = string,
  TPayloadSchema extends TSchema = TSchema,
> = {
  readonly [signalTokenTypeBrand]: {
    readonly moduleId: TModuleId;
    readonly name: TName;
    readonly schema: TPayloadSchema;
  };
};

type SignalQueueToken<
  TModuleId extends string = string,
  TName extends string = string,
  TPayloadSchema extends TSchema = TSchema,
> = {
  readonly [signalQueueTokenTypeBrand]: {
    readonly moduleId: TModuleId;
    readonly name: TName;
    readonly schema: TPayloadSchema;
  };
};

type AnyEventToken = EventToken<string, string, TSchema>;
type AnyQueryToken = QueryToken<string, string, TSchema, TSchema>;
type AnyQueueToken = QueueToken<string, string, TSchema>;
type AnySignalToken = SignalToken<string, string, TSchema>;
type AnySignalQueueToken = SignalQueueToken<string, string, TSchema>;

type LedgerContractKind =
  | "event"
  | "index"
  | "indexer"
  | "materialization"
  | "query"
  | "queue"
  | "signal"
  | "signal_queue"
  | "table";

type SchemaLedgerContractMetadata<
  TKind extends "event" | "queue" | "signal" | "signal_queue",
> = {
  readonly kind: TKind;
  readonly moduleId: string;
  readonly localName: string;
  readonly physicalName: string;
  readonly schema: TSchema;
};

type LedgerContractMetadata =
  | SchemaLedgerContractMetadata<"event">
  | SchemaLedgerContractMetadata<"queue">
  | SchemaLedgerContractMetadata<"signal">
  | SchemaLedgerContractMetadata<"signal_queue">
  | {
      readonly kind: "query";
      readonly moduleId: string;
      readonly localName: string;
      readonly physicalName: string;
      readonly params: TSchema;
      readonly result: TSchema;
    };

type EventDefinition = TSchema | AnyEventToken;

type PrivateSchemaDefinitions<TDefinitions> = {
  readonly [TName in keyof TDefinitions]: TDefinitions[TName] extends
    | AnyEventToken
    | AnyQueryToken
    | AnyQueueToken
    | AnySignalToken
    | AnySignalQueueToken
    ? never
    : TDefinitions[TName];
};

type EventSchemaFor<TDefinition> =
  TDefinition extends EventToken<
    infer _TModuleId,
    infer _TName,
    infer TSchemaToInfer
  >
    ? TSchemaToInfer
    : TDefinition extends TSchema
      ? TDefinition
      : never;

type EventSchemasFor<TDefinitions extends Record<string, EventDefinition>> = {
  readonly [TName in keyof TDefinitions]: EventSchemaFor<TDefinitions[TName]>;
};

type EventTokensFor<
  TModuleId extends string,
  TDefinitions extends Record<string, EventDefinition>,
> = {
  readonly [TName in keyof TDefinitions]: TDefinitions[TName] extends EventToken<
    infer _TReferencedModuleId,
    infer _TReferencedName,
    infer _TReferencedSchema
  >
    ? TDefinitions[TName]
    : EventToken<
        TModuleId,
        Extract<TName, string>,
        EventSchemaFor<TDefinitions[TName]>
      >;
};

type EventTokensForSchemas<
  TModuleId extends string,
  TEvents extends Record<string, TSchema>,
> = {
  readonly [TEventName in keyof TEvents]: EventToken<
    TModuleId,
    Extract<TEventName, string>,
    TEvents[TEventName]
  >;
};

type TokensForSchemas<
  TModuleId extends string,
  TSchemas extends Record<string, TSchema>,
  TKind extends "queue" | "signal" | "signal_queue",
> = {
  readonly [TName in keyof TSchemas]: TKind extends "queue"
    ? QueueToken<TModuleId, Extract<TName, string>, TSchemas[TName]>
    : TKind extends "signal"
      ? SignalToken<TModuleId, Extract<TName, string>, TSchemas[TName]>
      : SignalQueueToken<TModuleId, Extract<TName, string>, TSchemas[TName]>;
};

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
  /**
   * Serializes work in enqueue order with other work for the same queue and
   * partition. The partition remains blocked while its head is delayed,
   * leased, or retrying.
   */
  readonly partitionKey?: string;
} & (
  | {
      /**
       * Coalesces requests for the same physical queue and logical identity
       * while work remains live and unattempted. Repeated requests must have
       * the same decoded payload and partition, preserve the first request's
       * causation and WorkRef, and can only move availability earlier. Once
       * claimed, later requests create one independently coalesced successor.
       */
      readonly coalescingKey: string;
      readonly workKey?: never;
    }
  | {
      readonly coalescingKey?: never;
      readonly workKey?: string;
    }
);

/**
 * Optional knobs for signal->signal-queue materialization.
 */
export type SignalEnqueueOptions = {
  readonly availableAtMs?: number;
  readonly partitionKey?: string;
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

type LedgerQueryDefinitions = Readonly<
  Record<string, AnyQuerySchema | AnyQueryToken>
>;

type QuerySchemaForDefinition<TDefinition> =
  TDefinition extends QueryToken<
    infer _TModuleId,
    infer _TName,
    infer TParamsSchema,
    infer TResultSchema
  >
    ? QuerySchema<TParamsSchema, TResultSchema>
    : TDefinition extends AnyQuerySchema
      ? TDefinition
      : never;

type NormalizedQueryDefinitions<TDefinitions extends LedgerQueryDefinitions> = {
  readonly [TName in keyof TDefinitions]: QuerySchemaForDefinition<
    TDefinitions[TName]
  >;
};

type OwnedQueryDefinitions<TDefinitions extends LedgerQueryDefinitions> = {
  readonly [TName in keyof TDefinitions as TDefinitions[TName] extends QueryToken<
    infer _TModuleId,
    infer _TName,
    infer _TParamsSchema,
    infer _TResultSchema
  >
    ? never
    : TName]: TDefinitions[TName] extends AnyQuerySchema
    ? TDefinitions[TName]
    : never;
};

type QueryTokensFor<
  TModuleId extends string,
  TDefinitions extends LedgerQueryDefinitions,
> = {
  readonly [TName in keyof TDefinitions]: TDefinitions[TName] extends QueryToken<
    infer _TReferencedModuleId,
    infer _TReferencedName,
    infer _TReferencedParamsSchema,
    infer _TReferencedResultSchema
  >
    ? TDefinitions[TName]
    : TDefinitions[TName] extends QuerySchema<
          infer TParamsSchema,
          infer TResultSchema
        >
      ? QueryToken<
          TModuleId,
          Extract<TName, string>,
          TParamsSchema,
          TResultSchema
        >
      : never;
};

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

type EventTokenSchema<TToken> =
  TToken extends EventToken<string, string, infer TSchemaToInfer>
    ? TSchemaToInfer
    : never;

type QueryTokenParamsSchema<TToken> =
  TToken extends QueryToken<string, string, infer TParamsSchema, TSchema>
    ? TParamsSchema
    : never;

type QueryTokenResultSchema<TToken> =
  TToken extends QueryToken<string, string, TSchema, infer TResultSchema>
    ? TResultSchema
    : never;

type SignalTokenSchema<TToken> =
  TToken extends SignalToken<string, string, infer TSchemaToInfer>
    ? TSchemaToInfer
    : never;

type LedgerEnvelopeSchema<TContract> = TContract extends AnyEventToken
  ? EventTokenSchema<TContract>
  : TContract extends AnySignalToken
    ? SignalTokenSchema<TContract>
    : never;

export type LedgerEventEnvelope<TEvent extends AnyEventToken | AnySignalToken> =
  {
    readonly eventId: number;
    readonly event: TEvent;
    readonly ref: EventRef<TEvent>;
    readonly tsMs: number;
    readonly payload: Static<LedgerEnvelopeSchema<TEvent>>;
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
 * Raised when a queue operation exceeds its engine-scheduled timeout.
 *
 * The same error instance is used as the operation signal's abort reason and
 * as the rejection from `withTimeout`.
 */
export class WorkOperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`work operation timed out after ${timeoutMs}ms`);
    this.name = "WorkOperationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

interface WorkHandlerControl {
  /**
   * Runs an asynchronous operation under a timeout scheduled by the active
   * worker runtime.
   *
   * The operation receives a child of the active work lease signal. Timeout
   * and lease cancellation both abort that exact signal before this promise
   * rejects. A timeout does not choose a work disposition: an uncaught timeout
   * follows normal thrown-handler retry semantics, while a handler may catch
   * it and choose another outcome.
   *
   * `timeoutMs` must be a positive integer no greater than 2,147,483,647.
   *
   * Aborting cannot forcibly stop JavaScript. An operation that ignores its
   * signal may continue after this promise rejects. This method is a timing
   * primitive, not an execution sandbox: the operation retains access to
   * anything its closure captures. Pass only the capabilities it should retain,
   * and use application-level idempotency for external side effects.
   */
  withTimeout<TResult>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<TResult>;
}

/**
 * Explicit queue control methods for non-default outcomes.
 */
export interface QueueHandlerControl extends WorkHandlerControl {
  retry(error: unknown, options?: QueueHandlerRetryOptions): never;
  deadLetter(error: unknown): never;
}

/**
 * Explicit signal queue control methods for non-default outcomes.
 */
export interface SignalQueueHandlerControl extends WorkHandlerControl {
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
      options?: SignalEnqueueOptions,
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

/**
 * Opaque durable identity for keyed work. Persist and round-trip this value;
 * its representation is owned by Sledge.
 */
declare const workRefBrand: unique symbol;
export type WorkRef = string & {
  readonly [workRefBrand]: true;
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

export type LedgerStreamEvent<TEvents extends AnyEventToken> = {
  readonly event: LedgerEventEnvelope<TEvents>;
  readonly cursor: LedgerCursor;
};

export interface Ledger<
  TEvents extends AnyEventToken,
  TQueries extends AnyQueryToken,
  TSignals extends AnySignalToken = never,
> extends AsyncDisposable {
  emit<const TEvent extends TEvents>(
    event: TEvent,
    payload: Static<EventTokenSchema<TEvent>>,
    options?: EmitOptions,
  ): Promise<LedgerEventEnvelope<TEvent>>;

  query<const TQuery extends TQueries>(
    query: TQuery,
    params: Static<QueryTokenParamsSchema<TQuery>>,
  ): Promise<Static<QueryTokenResultSchema<TQuery>>>;

  cancelWork(input: CancelWorkInput): Promise<CancelWorkResult>;

  queryWork(input: QueryWorkInput): Promise<WorkSnapshot | null>;

  listWork(input?: ListWorkInput): Promise<readonly WorkSnapshot[]>;

  onSignal<const TSignal extends TSignals>(
    signal: TSignal,
    observer: (signal: LedgerEventEnvelope<TSignal>) => void | Promise<void>,
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
  /**
   * Resolves when this worker handle has no pending, delayed, leased, or
   * executing work, including work blocked behind a partition head.
   *
   * Retained dead and cancelled work is terminal and does not prevent idle.
   * The result describes one instant: work emitted after resolution can make
   * the workers active again. The wait rejects if its signal aborts or this
   * worker runtime closes or fails.
   */
  waitForIdle(input: { readonly signal: AbortSignal }): Promise<void>;

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
  TModuleId extends string = string,
  TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  } = EventTokensForSchemas<TModuleId, TEvents>,
  TQueryTokens extends {
    readonly [TQueryName in keyof TQueries]: AnyQueryToken;
  } = QueryTokensFor<TModuleId, TQueries>,
> = {
  readonly [registeredLedgerModelBrand]: true;
  readonly moduleId: TModuleId;
  readonly events: TEventTokens;
  readonly queries: TQueryTokens;
  readonly signals: TokensForSchemas<TModuleId, TSignals, "signal">;
  readonly [registeredLedgerContractsBrand]: {
    readonly events: TEventTokens;
    readonly queries: TQueryTokens;
    readonly queues: TokensForSchemas<TModuleId, TQueues, "queue">;
    readonly signals: TokensForSchemas<TModuleId, TSignals, "signal">;
    readonly signalQueues: TokensForSchemas<
      TModuleId,
      TSignalQueues,
      "signal_queue"
    >;
  };
  readonly [registeredLedgerRuntimeBrand]: {
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
    readonly register: RegisterFunction<
      TEvents,
      TQueues,
      TIndexers,
      TQueries,
      TSignals,
      TSignalQueues,
      TIndexerDefinitions
    >;
  };
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
  TMigrations extends readonly MaterializationMigration[] = readonly [],
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
    readonly [...TMigrations, MaterializationMigration<TVersion, TDescription>]
  >;
  define<
    const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
    const TQueryDefinitions extends LedgerQueryDefinitions,
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
  TQueryDefinitions extends LedgerQueryDefinitions,
> = {
  readonly history: THistory;
  readonly indexers: TIndexerDefinitions;
  readonly queries: TQueryDefinitions;
};

export type MaterializationHistoryFor<TMaterializations> =
  TMaterializations extends Materializations<
    infer THistory,
    ProjectionIndexerDefinitions<string>,
    LedgerQueryDefinitions
  >
    ? THistory
    : never;

export type MaterializationSchemaFor<TMaterializations> =
  MaterializationHistoryFor<TMaterializations> extends MaterializationHistory<
    infer TCurrentSchema,
    readonly MaterializationMigration[]
  >
    ? TCurrentSchema
    : never;

export type MaterializationIndexerDefinitionsFor<TMaterializations> =
  TMaterializations extends Materializations<
    AnyMaterializationHistory,
    infer TIndexerDefinitions,
    LedgerQueryDefinitions
  >
    ? TIndexerDefinitions
    : never;

export type MaterializationQueryDefinitionsFor<TMaterializations> =
  TMaterializations extends Materializations<
    AnyMaterializationHistory,
    ProjectionIndexerDefinitions<string>,
    infer TQueryDefinitions
  >
    ? TQueryDefinitions
    : never;

export type MaterializationReadDatabaseFor<
  TMaterializations,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
  TSignals extends Record<string, TSchema> = {},
> =
  MaterializationSchemaFor<TMaterializations> extends AnyMaterializationSchema
    ? ProjectionReadDatabase<
        MaterializationSchemaFor<TMaterializations>,
        TEvents,
        TSignals
      >
    : never;

export type MaterializationWriteDatabaseFor<TMaterializations> =
  MaterializationSchemaFor<TMaterializations> extends AnyMaterializationSchema
    ? ProjectionWriteDatabase<MaterializationSchemaFor<TMaterializations>>
    : never;

export type MaterializationDatabaseFor<
  TMaterializations,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
  TSignals extends Record<string, TSchema> = {},
> =
  MaterializationSchemaFor<TMaterializations> extends AnyMaterializationSchema
    ? ProjectionDatabase<
        MaterializationSchemaFor<TMaterializations>,
        TEvents,
        TSignals
      >
    : never;

export type MaterializationMigrationDatabaseFor<
  TMaterializations,
  TEvents extends Record<string, TSchema>,
> =
  MaterializationSchemaFor<TMaterializations> extends AnyMaterializationSchema
    ? MaterializationMigrationDatabase<
        MaterializationSchemaFor<TMaterializations>,
        TEvents
      >
    : never;

export type MaterializationImplementationRegistrationFor<
  TMaterializations,
  TEvents extends Record<string, TSchema> = Record<string, TSchema>,
  TSignals extends Record<string, TSchema> = {},
> =
  TMaterializations extends Materializations<
    infer THistory,
    infer TIndexerDefinitions,
    infer TQueryDefinitions
  >
    ? MaterializationImplementationRegistration<
        THistory["current"],
        TIndexerDefinitions,
        OwnedQueryDefinitions<TQueryDefinitions>,
        TEvents,
        TSignals
      >
    : never;

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
  const TModuleId extends string,
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const TNamespace extends string,
  const TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  },
>(
  shape: DefinedLedgerShape<
    TEvents,
    TQueues,
    TSignals,
    TSignalQueues,
    TModuleId,
    TEventTokens
  >,
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
  TModuleId extends string = string,
  TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  } = EventTokensForSchemas<TModuleId, TEvents>,
> = {
  readonly moduleId: TModuleId;
  readonly events: TEventTokens;
  readonly signals: TokensForSchemas<TModuleId, TSignals, "signal">;
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
    null,
    TModuleId,
    TEventTokens
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
  TModuleId extends string = string,
  TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  } = EventTokensForSchemas<TModuleId, TEvents>,
  TQueryTokens extends {
    readonly [TQueryName in keyof TQueries]: AnyQueryToken;
  } = QueryTokensFor<TModuleId, TQueries>,
> = {
  readonly moduleId: TModuleId;
  readonly events: TEventTokens;
  readonly queries: TQueryTokens;
  readonly signals: TokensForSchemas<TModuleId, TSignals, "signal">;
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
    TMaterializationHistory,
    TModuleId,
    TEventTokens,
    TQueryTokens
  >;
};

export function defineLedgerShape<
  const TModuleId extends string,
  const TEventDefinitions extends Record<string, EventDefinition>,
  const TQueues extends Record<string, TSchema> = {},
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
>(input: {
  readonly moduleId: TModuleId;
  readonly events: TEventDefinitions;
  readonly queues?: TQueues & PrivateSchemaDefinitions<TQueues>;
  readonly signals?: TSignals & PrivateSchemaDefinitions<TSignals>;
  readonly signalQueues?: TSignalQueues &
    PrivateSchemaDefinitions<TSignalQueues>;
}): DefinedLedgerShape<
  EventSchemasFor<TEventDefinitions>,
  TQueues,
  TSignals,
  TSignalQueues,
  TModuleId,
  EventTokensFor<TModuleId, TEventDefinitions>
> {
  validateModuleId(input.moduleId);
  const queueDefinitions = (input.queues ?? {}) as TQueues;
  const signalDefinitions = (input.signals ?? {}) as TSignals;
  const signalQueueDefinitions = (input.signalQueues ?? {}) as TSignalQueues;
  validatePrivateSchemaDefinitions("queue", queueDefinitions);
  validatePrivateSchemaDefinitions("signal", signalDefinitions);
  validatePrivateSchemaDefinitions("signal queue", signalQueueDefinitions);
  const events = createEventTokens(input.moduleId, input.events);
  const queues = createSchemaTokens(input.moduleId, "queue", queueDefinitions);
  const signals = createSchemaTokens(
    input.moduleId,
    "signal",
    signalDefinitions,
  );
  const signalQueues = createSchemaTokens(
    input.moduleId,
    "signal_queue",
    signalQueueDefinitions,
  );
  const eventSchemas = readEventSchemas(input.events);
  const shape: LedgerShape<
    EventSchemasFor<TEventDefinitions>,
    TQueues,
    TSignals,
    TSignalQueues
  > = {
    events: eventSchemas,
    queues: queueDefinitions,
    signals: signalDefinitions,
    signalQueues: signalQueueDefinitions,
  };

  return {
    moduleId: input.moduleId,
    events,
    signals,
    shape,
    register: (register) => {
      return createDefinedLedgerModel({
        moduleId: input.moduleId,
        contracts: {
          events,
          queries: {},
          queues,
          signals,
          signalQueues,
        },
        shape: shape as LedgerShape<
          EventSchemasFor<TEventDefinitions>,
          TQueues,
          TSignals,
          TSignalQueues
        >,
        access:
          createEmptyProjectionAccess<
            Extract<keyof TEventDefinitions, string>
          >(),
        materializationHistory: null,
      }).register(register);
    },
  };
}

export function withMaterializations<
  const TModuleId extends string,
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const THistory extends AnyMaterializationHistory<TEvents>,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<
    Extract<keyof TEvents, string>
  >,
  const TQueryDefinitions extends LedgerQueryDefinitions,
  const TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  },
>(
  shape: DefinedLedgerShape<
    TEvents,
    TQueues,
    TSignals,
    TSignalQueues,
    TModuleId,
    TEventTokens
  >,
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
  ProjectionQuerySchemas<NormalizedQueryDefinitions<TQueryDefinitions>>,
  TSignals,
  TSignalQueues,
  TIndexerDefinitions,
  OwnedQueryDefinitions<TQueryDefinitions>,
  THistory,
  TModuleId,
  TEventTokens,
  QueryTokensFor<TModuleId, TQueryDefinitions>
> {
  validateMaterializationEvents(shape.shape, materializations);
  const queryDefinitions = normalizeQueryDefinitions(materializations.queries);
  const ownedQueryDefinitions = readOwnedQueryDefinitions(
    materializations.queries,
  );
  const queryTokens = createQueryTokens(
    shape.moduleId,
    materializations.queries,
  );
  const queues = createSchemaTokens(
    shape.moduleId,
    "queue",
    shape.shape.queues,
  );
  const signalQueues = createSchemaTokens(
    shape.moduleId,
    "signal_queue",
    shape.shape.signalQueues,
  );
  const access = createProjectionAccess({
    projections: materializations.history.current,
    indexers: materializations.indexers,
    queries: queryDefinitions,
    ownedQueries: ownedQueryDefinitions,
  });

  return createDefinedLedgerModel({
    moduleId: shape.moduleId,
    contracts: {
      events: shape.events,
      queries: queryTokens,
      queues,
      signals: shape.signals,
      signalQueues,
    },
    shape: shape.shape,
    access,
    materializationHistory: materializations.history,
  });
}

type RegisteredLedgerModelRuntime = {
  readonly [registeredLedgerModelBrand]: true;
  readonly moduleId: string;
  readonly events: Readonly<Record<string, AnyEventToken>>;
  readonly queries: Readonly<Record<string, AnyQueryToken>>;
  readonly signals: Readonly<Record<string, AnySignalToken>>;
  readonly [registeredLedgerContractsBrand]: {
    readonly events: Readonly<Record<string, AnyEventToken>>;
    readonly queries: Readonly<Record<string, AnyQueryToken>>;
    readonly queues: Readonly<Record<string, AnyQueueToken>>;
    readonly signals: Readonly<Record<string, AnySignalToken>>;
    readonly signalQueues: Readonly<Record<string, AnySignalQueueToken>>;
  };
  readonly [registeredLedgerRuntimeBrand]: {
    readonly materializationHistory: AnyMaterializationHistory | null;
    readonly model: {
      readonly events: Readonly<Record<string, TSchema>>;
      readonly queues: Readonly<Record<string, TSchema>>;
      readonly signals: Readonly<Record<string, TSchema>>;
      readonly signalQueues: Readonly<Record<string, TSchema>>;
      readonly indexers: Readonly<Record<string, TSchema>>;
      readonly queries: Readonly<Record<string, AnyQuerySchema>>;
    };
    readonly projections: AnyProjectionSchema;
    readonly register: object;
  };
  readonly model: {
    readonly events: Readonly<Record<string, TSchema>>;
    readonly queues: Readonly<Record<string, TSchema>>;
    readonly signals: Readonly<Record<string, TSchema>>;
    readonly signalQueues: Readonly<Record<string, TSchema>>;
    readonly indexers: Readonly<Record<string, TSchema>>;
    readonly queries: Readonly<Record<string, AnyQuerySchema>>;
  };
  readonly register: object;
  readonly materializationHistory: AnyMaterializationHistory | null;
  readonly projections: AnyProjectionSchema;
};

type ContractValues<TContracts extends Readonly<Record<string, object>>> =
  TContracts[keyof TContracts];

type ModuleEventTokens<TModule> = TModule extends RegisteredLedgerModelRuntime
  ? ContractValues<TModule[typeof registeredLedgerContractsBrand]["events"]>
  : never;

type ModuleSignalTokens<TModule> = TModule extends RegisteredLedgerModelRuntime
  ? ContractValues<TModule[typeof registeredLedgerContractsBrand]["signals"]>
  : never;

type ModuleQueryTokens<TModule> = TModule extends RegisteredLedgerModelRuntime
  ? ContractValues<TModule[typeof registeredLedgerContractsBrand]["queries"]>
  : never;

export type ComposedLedgerModel<
  TModules extends readonly RegisteredLedgerModelRuntime[],
> = {
  readonly [composedLedgerModelBrand]: true;
  readonly [composedLedgerModulesBrand]: TModules;
  readonly [registeredLedgerContractsBrand]: RegisteredLedgerModelRuntime[typeof registeredLedgerContractsBrand];
  readonly [registeredLedgerRuntimeBrand]: RegisteredLedgerModelRuntime[typeof registeredLedgerRuntimeBrand];
};

export type AnyComposedLedgerModel = ComposedLedgerModel<
  readonly RegisteredLedgerModelRuntime[]
>;

export type ComposedLedgerEventTokens<TModel extends AnyComposedLedgerModel> =
  ModuleEventTokens<TModel[typeof composedLedgerModulesBrand][number]>;

export type ComposedLedgerSignalTokens<TModel extends AnyComposedLedgerModel> =
  ModuleSignalTokens<TModel[typeof composedLedgerModulesBrand][number]>;

export type ComposedLedgerQueryTokens<TModel extends AnyComposedLedgerModel> =
  ModuleQueryTokens<TModel[typeof composedLedgerModulesBrand][number]>;

export function composeLedgerModels<
  const TFirst extends RegisteredLedgerModelRuntime,
  const TRest extends readonly RegisteredLedgerModelRuntime[],
>(
  first: TFirst,
  ...rest: TRest
): ComposedLedgerModel<readonly [TFirst, ...TRest]> {
  const modules: readonly [TFirst, ...TRest] = [first, ...rest];
  const moduleIds = new Set<string>();

  for (const module of modules) {
    const normalizedModuleId = module.moduleId.toLowerCase();

    if (moduleIds.has(normalizedModuleId)) {
      throw new Error(`duplicate ledger module id ${module.moduleId}`);
    }

    moduleIds.add(normalizedModuleId);
  }

  for (const module of modules) {
    const moduleContracts = module[registeredLedgerContractsBrand];

    for (const token of Object.values(moduleContracts.events)) {
      const metadata = readLedgerContractToken(token, "event");
      const owner = modules.find(
        (candidate) => candidate.moduleId === metadata.moduleId,
      );

      if (
        owner === undefined ||
        !Object.values(owner[registeredLedgerContractsBrand].events).includes(
          token,
        )
      ) {
        throw new Error(
          `ledger module ${module.moduleId} references unavailable event ${metadata.moduleId}.${metadata.localName}`,
        );
      }
    }

    for (const token of Object.values(moduleContracts.queries)) {
      const metadata = readLedgerContractToken(token, "query");
      const owner = modules.find(
        (candidate) => candidate.moduleId === metadata.moduleId,
      );

      if (
        owner === undefined ||
        !Object.values(owner[registeredLedgerContractsBrand].queries).includes(
          token,
        )
      ) {
        throw new Error(
          `ledger module ${module.moduleId} references unavailable query ${metadata.moduleId}.${metadata.localName}`,
        );
      }
    }
  }

  const model = {
    events: mergeModelSchemas(modules, "events"),
    queues: mergeModelSchemas(modules, "queues"),
    signals: mergeModelSchemas(modules, "signals"),
    signalQueues: mergeModelSchemas(modules, "signalQueues"),
    indexers: mergeModelSchemas(modules, "indexers"),
    queries: mergeModelSchemas(modules, "queries"),
  };
  const registration = {
    events: mergeContributionHandlers(modules, "events"),
    queues: mergeExclusiveHandlers(modules, "queues"),
    signals: mergeContributionHandlers(modules, "signals"),
    signalQueues: mergeExclusiveHandlers(modules, "signalQueues"),
  };
  const firstMaterializedRuntime = modules
    .map((module) => module[registeredLedgerRuntimeBrand])
    .find((runtime) => runtime.materializationHistory !== null);
  const materializationHistory =
    firstMaterializedRuntime?.materializationHistory ?? null;
  const projections =
    firstMaterializedRuntime?.projections ??
    first[registeredLedgerRuntimeBrand].projections;
  const contracts = mergeRootContracts(modules);
  const runtime = {
    materializationHistory,
    model,
    projections,
    register: registration,
  };
  const composed = {
    [composedLedgerModelBrand]: true,
    [composedLedgerModulesBrand]: modules,
    [registeredLedgerContractsBrand]: contracts,
    [registeredLedgerRuntimeBrand]: runtime,
  } as unknown as ComposedLedgerModel<readonly [TFirst, ...TRest]>;

  return attachLedgerImplementationFactory(composed, (factory) => {
    const indexers: Record<string, unknown> = {};
    const queries: Record<string, unknown> = {};

    for (const module of modules) {
      const implementations = readLedgerImplementations(module, factory);
      Object.assign(indexers, implementations.indexers);
      Object.assign(queries, implementations.queries);
    }

    return {
      indexers,
      queries,
    } as LedgerImplementations<
      Record<string, TSchema>,
      Record<string, AnyQuerySchema>,
      Record<string, TSchema>
    >;
  });
}

function mergeModelSchemas(
  modules: readonly RegisteredLedgerModelRuntime[],
  key: keyof RegisteredLedgerModelRuntime[typeof registeredLedgerRuntimeBrand]["model"],
): Record<string, TSchema | AnyQuerySchema> {
  const merged: Record<string, TSchema | AnyQuerySchema> = {};

  for (const module of modules) {
    Object.assign(merged, module[registeredLedgerRuntimeBrand].model[key]);
  }

  return merged;
}

function mergeContributionHandlers(
  modules: readonly RegisteredLedgerModelRuntime[],
  key: "events" | "signals",
): Readonly<Record<string, (input: unknown) => Promise<void>>> {
  const contributions = new Map<
    string,
    readonly ((input: unknown) => void | Promise<void>)[]
  >();

  for (const module of modules) {
    const handlers = (
      module[registeredLedgerRuntimeBrand].register as RuntimeRegister
    )[key] as
      | Readonly<Record<string, (input: unknown) => void | Promise<void>>>
      | undefined;

    for (const [physicalName, handler] of Object.entries(handlers ?? {})) {
      contributions.set(physicalName, [
        ...(contributions.get(physicalName) ?? []),
        handler,
      ]);
    }
  }

  return Object.fromEntries(
    [...contributions].map(([physicalName, handlers]) => {
      return [
        physicalName,
        async (input: unknown) => {
          for (const handler of handlers) {
            await handler(input);
          }
        },
      ];
    }),
  );
}

function mergeExclusiveHandlers(
  modules: readonly RegisteredLedgerModelRuntime[],
  key: "queues" | "signalQueues",
): Readonly<Record<string, (input: unknown) => void | Promise<void>>> {
  const merged: Record<string, (input: unknown) => void | Promise<void>> = {};

  for (const module of modules) {
    const handlers = (
      module[registeredLedgerRuntimeBrand].register as RuntimeRegister
    )[key] as
      | Readonly<Record<string, (input: unknown) => void | Promise<void>>>
      | undefined;

    for (const [physicalName, handler] of Object.entries(handlers ?? {})) {
      if (merged[physicalName] !== undefined) {
        throw new Error(`duplicate ${key} handler ${physicalName}`);
      }

      merged[physicalName] = handler;
    }
  }

  return merged;
}

function mergeRootContracts(
  modules: readonly RegisteredLedgerModelRuntime[],
): RegisteredLedgerModelRuntime[typeof registeredLedgerContractsBrand] {
  const events: Record<string, AnyEventToken> = {};
  const queries: Record<string, AnyQueryToken> = {};
  const queues: Record<string, AnyQueueToken> = {};
  const signals: Record<string, AnySignalToken> = {};
  const signalQueues: Record<string, AnySignalQueueToken> = {};

  for (const module of modules) {
    const moduleContracts = module[registeredLedgerContractsBrand];

    for (const token of Object.values(moduleContracts.events)) {
      events[readLedgerContractToken(token, "event").physicalName] = token;
    }

    for (const token of Object.values(moduleContracts.queues)) {
      queues[readLedgerContractToken(token, "queue").physicalName] = token;
    }

    for (const token of Object.values(moduleContracts.queries)) {
      queries[readLedgerContractToken(token, "query").physicalName] = token;
    }

    for (const token of Object.values(moduleContracts.signals)) {
      signals[readLedgerContractToken(token, "signal").physicalName] = token;
    }

    for (const token of Object.values(moduleContracts.signalQueues)) {
      signalQueues[
        readLedgerContractToken(token, "signal_queue").physicalName
      ] = token;
    }
  }

  return {
    events,
    queries,
    queues,
    signals,
    signalQueues,
  };
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
      } as MaterializationMigration<typeof version, typeof description>;

      return createMaterializationDefinitionBuilder({
        current,
        events: input.events,
        migrations: [...input.migrations, migration] as readonly [
          ...TMigrations,
          MaterializationMigration<typeof version, typeof description>,
        ],
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
      const table = readMaterializationTable(
        input.current,
        String(tableName),
        "materialization add column",
      );
      validateNewMaterializationColumnName(
        table,
        String(columnName),
        `materialization add column ${String(tableName)}.${String(columnName)}`,
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
      validateNewMaterializationTableName(
        input.current,
        String(tableName),
        `materialization create table ${String(tableName)}`,
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
    sqliteObjectNames: createMaterializationReplaySqliteObjectNames(),
    relations: new Map(Object.entries(schema.metadata.relations)),
    tables: new Map(Object.entries(schema.metadata.tables)),
  };

  for (const table of Object.values(schema.metadata.tables)) {
    validateMaterializationReplayTableName(state, table.name);

    for (const index of table.indexes) {
      validateMaterializationReplayIndexName(state, index.name);
    }
  }

  return state;
}

function createMaterializationReplaySqliteObjectNames(): Map<string, string> {
  const objectNames = new Map<string, string>();

  for (const reservedName of reservedMaterializationSqliteObjectNames) {
    objectNames.set(
      normalizeMaterializationSqliteIdentifier(reservedName),
      reservedName,
    );
  }

  return objectNames;
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

function validateNewMaterializationTableName(
  schema: AnyMaterializationSchema,
  tableName: string,
  context: string,
): void {
  validateMaterializationIdentifier("materialization table name", tableName);

  const existing = findCaseFoldedKey(schema.metadata.tables, tableName);

  if (existing !== null) {
    throw new Error(`${context} conflicts with existing table ${existing}`);
  }
}

function validateNewMaterializationColumnName(
  table: ProjectionTableMetadata,
  columnName: string,
  context: string,
): void {
  validateMaterializationIdentifier("materialization column name", columnName);

  const existing = findCaseFoldedKey(table.columns, columnName);

  if (existing !== null) {
    throw new Error(`${context} conflicts with existing column ${existing}`);
  }
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
    sqliteObjectNames: createMaterializationReplaySqliteObjectNames(),
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
  readonly sqliteObjectNames: Map<string, string>;
  readonly relations: Map<string, ProjectionForeignKeyMetadata>;
  readonly tables: Map<string, ProjectionTableMetadata>;
};

function applyMaterializationMigrationOperation(
  state: MaterializationHistoryReplayState,
  operation: MaterializationMigrationOperation,
): void {
  switch (operation.kind) {
    case "create_table":
      validateMaterializationReplayTableName(state, operation.tableName);

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

      const existingColumnName = findCaseFoldedKey(
        table.columns,
        operation.columnName,
      );

      if (existingColumnName !== null) {
        throw new Error(
          `materialization history adds duplicate column ${operation.tableName}.${operation.columnName} conflicts with existing column ${existingColumnName}`,
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

function validateMaterializationReplayTableName(
  state: MaterializationHistoryReplayState,
  tableName: string,
): void {
  validateMaterializationReplaySqliteObjectName(
    state,
    `materialization history table ${tableName}`,
    tableName,
  );
}

function validateMaterializationReplayIndexName(
  state: MaterializationHistoryReplayState,
  indexName: string,
): void {
  validateMaterializationReplaySqliteObjectName(
    state,
    `materialization history index ${indexName}`,
    indexName,
  );
}

function validateMaterializationReplaySqliteObjectName(
  state: MaterializationHistoryReplayState,
  context: string,
  objectName: string,
): void {
  const normalized = normalizeMaterializationSqliteIdentifier(objectName);

  if (normalized.startsWith(sqliteInternalMaterializationNamePrefix)) {
    throw new Error(`${context} is reserved for ledger storage`);
  }

  const existing = state.sqliteObjectNames.get(normalized);

  if (existing !== undefined) {
    throw new Error(`${context} conflicts with ${existing}`);
  }

  state.sqliteObjectNames.set(normalized, objectName);
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

function findCaseFoldedKey(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const normalized = normalizeMaterializationSqliteIdentifier(key);

  for (const existing of Object.keys(record)) {
    if (normalizeMaterializationSqliteIdentifier(existing) === normalized) {
      return existing;
    }
  }

  return null;
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
  TQueryDefinitions extends LedgerQueryDefinitions,
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
    ownedQueryDefinitions: {},
  };
}

type RuntimeEventHandlerInput = {
  readonly event: {
    readonly eventId: number;
    readonly ref: EventRef<string>;
    readonly tsMs: number;
    readonly eventName: string;
    readonly payload: unknown;
    readonly causationEventId: number | null;
    readonly dedupeKey: string | null;
  };
  readonly actions: {
    index(indexName: string, input: unknown): Promise<void>;
    enqueue(
      queueName: string,
      payload: unknown,
      options?: EnqueueOptions,
    ): void;
    query(queryName: string, params: unknown): Promise<unknown>;
  };
};

type RuntimeSignalHandlerInput = {
  readonly event: RuntimeEventHandlerInput["event"];
  readonly actions: {
    enqueueSignal(
      queueName: string,
      payload: unknown,
      options?: SignalEnqueueOptions,
    ): void;
  };
};

type RuntimeQueueHandlerInput = {
  readonly work: {
    readonly workId: number;
    readonly queueName: string;
    readonly payload: unknown;
    readonly attempt: number;
    readonly sourceEventId: number;
  };
  readonly lease: {
    readonly workId: number;
    readonly queueName: string;
    readonly sourceEventId: number;
    readonly attempt: number;
    readonly leaseId: string;
    readonly leaseAcquiredAtMs: number;
    readonly leaseExpiresAtMs: number;
    readonly signal: AbortSignal;
  };
  readonly actions: {
    emit(eventName: string, event: unknown, options?: EmitOptions): void;
    emitSignal(
      signalName: string,
      signal: unknown,
      options?: EmitOptions,
    ): Promise<void>;
    query(queryName: string, params: unknown): Promise<unknown>;
  };
  readonly control: QueueHandlerControl;
};

type RuntimeSignalQueueHandlerInput = {
  readonly work: RuntimeQueueHandlerInput["work"];
  readonly lease: RuntimeQueueHandlerInput["lease"];
  readonly actions: {
    query(queryName: string, params: unknown): Promise<unknown>;
  };
  readonly control: SignalQueueHandlerControl;
};

type RuntimeRegister = {
  readonly events?: Readonly<
    Record<string, (input: RuntimeEventHandlerInput) => void | Promise<void>>
  >;
  readonly signals?: Readonly<
    Record<string, (input: RuntimeSignalHandlerInput) => void | Promise<void>>
  >;
  readonly queues?: Readonly<
    Record<string, (input: RuntimeQueueHandlerInput) => void | Promise<void>>
  >;
  readonly signalQueues?: Readonly<
    Record<
      string,
      (input: RuntimeSignalQueueHandlerInput) => void | Promise<void>
    >
  >;
  readonly indexers?: Readonly<Record<string, unknown>>;
  readonly queries?: Readonly<Record<string, unknown>>;
};

function createPhysicalRegisteredModule<
  TModuleId extends string,
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  },
  TQueryTokens extends {
    readonly [TQueryName in keyof TQueries]: AnyQueryToken;
  },
>(input: {
  readonly moduleId: TModuleId;
  readonly contracts: {
    readonly events: TEventTokens;
    readonly queries: TQueryTokens;
    readonly queues: TokensForSchemas<TModuleId, TQueues, "queue">;
    readonly signals: TokensForSchemas<TModuleId, TSignals, "signal">;
    readonly signalQueues: TokensForSchemas<
      TModuleId,
      TSignalQueues,
      "signal_queue"
    >;
  };
  readonly localModel: LedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly access: {
    readonly indexers: TIndexers;
    readonly queries: TQueries;
  };
  readonly register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues,
    TIndexerDefinitions
  >;
}): {
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
    TSignalQueues,
    TIndexerDefinitions
  >;
} {
  const runtimeRegister = input.register as RuntimeRegister;
  const model = {
    events: createPhysicalSchemaMap(
      input.contracts.events,
      input.localModel.events,
      "event",
    ),
    queues: createPhysicalSchemaMap(
      input.contracts.queues,
      input.localModel.queues,
      "queue",
    ),
    signals: createPhysicalSchemaMap(
      input.contracts.signals,
      input.localModel.signals,
      "signal",
    ),
    signalQueues: createPhysicalSchemaMap(
      input.contracts.signalQueues,
      input.localModel.signalQueues,
      "signal_queue",
    ),
    indexers: createPrivatePhysicalSchemaMap(
      input.moduleId,
      "indexer",
      input.access.indexers,
    ),
    queries: createPhysicalQuerySchemaMap(
      input.contracts.queries,
      input.access.queries,
    ),
  };
  const events: Record<
    string,
    (input: RuntimeEventHandlerInput) => Promise<void>
  > = {};

  for (const [localName, handler] of Object.entries(
    runtimeRegister.events ?? {},
  )) {
    const token = input.contracts.events[localName];

    if (token === undefined) {
      throw new Error(`unknown event registration ${localName}`);
    }

    const physicalName = readLedgerContractToken(token, "event").physicalName;
    const previous = events[physicalName];
    events[physicalName] = async (physicalInput) => {
      if (previous !== undefined) {
        await previous(physicalInput);
      }

      await runEventContribution(handler, localName, physicalInput, {
        indexerName: (name) =>
          createPhysicalName(input.moduleId, "indexer", name),
        queryName: (name) =>
          readTokenPhysicalName(input.contracts.queries[name], "query", name),
        queueName: (name) =>
          readTokenPhysicalName(input.contracts.queues[name], "queue", name),
      });
    };
  }

  const signals: Record<
    string,
    (input: RuntimeSignalHandlerInput) => void | Promise<void>
  > = {};

  for (const [localName, handler] of Object.entries(
    runtimeRegister.signals ?? {},
  )) {
    const physicalName = readTokenPhysicalName(
      input.contracts.signals[localName],
      "signal",
      localName,
    );
    signals[physicalName] = (physicalInput) => {
      return handler({
        event: localizeRuntimeEvent(physicalInput.event, localName),
        actions: {
          enqueueSignal: (queueName, payload, options) => {
            physicalInput.actions.enqueueSignal(
              readTokenPhysicalName(
                input.contracts.signalQueues[queueName],
                "signal_queue",
                queueName,
              ),
              payload,
              options,
            );
          },
        },
      });
    };
  }

  const queues: Record<
    string,
    (input: RuntimeQueueHandlerInput) => void | Promise<void>
  > = {};

  for (const [localName, handler] of Object.entries(
    runtimeRegister.queues ?? {},
  )) {
    const physicalName = readTokenPhysicalName(
      input.contracts.queues[localName],
      "queue",
      localName,
    );
    queues[physicalName] = (physicalInput) => {
      return handler({
        ...physicalInput,
        work: {
          ...physicalInput.work,
          queueName: localName,
        },
        lease: {
          ...physicalInput.lease,
          queueName: localName,
        },
        actions: {
          emit: (eventName, event, options) => {
            physicalInput.actions.emit(
              readTokenPhysicalName(
                input.contracts.events[eventName],
                "event",
                eventName,
              ),
              event,
              options,
            );
          },
          emitSignal: (signalName, signal, options) => {
            return physicalInput.actions.emitSignal(
              readTokenPhysicalName(
                input.contracts.signals[signalName],
                "signal",
                signalName,
              ),
              signal,
              options,
            );
          },
          query: (queryName, params) => {
            return physicalInput.actions.query(
              readTokenPhysicalName(
                input.contracts.queries[queryName],
                "query",
                queryName,
              ),
              params,
            );
          },
        },
      });
    };
  }

  const signalQueues: Record<
    string,
    (input: RuntimeSignalQueueHandlerInput) => void | Promise<void>
  > = {};

  for (const [localName, handler] of Object.entries(
    runtimeRegister.signalQueues ?? {},
  )) {
    const physicalName = readTokenPhysicalName(
      input.contracts.signalQueues[localName],
      "signal_queue",
      localName,
    );
    signalQueues[physicalName] = (physicalInput) => {
      return handler({
        ...physicalInput,
        work: {
          ...physicalInput.work,
          queueName: localName,
        },
        lease: {
          ...physicalInput.lease,
          queueName: localName,
        },
        actions: {
          query: (queryName, params) => {
            return physicalInput.actions.query(
              readTokenPhysicalName(
                input.contracts.queries[queryName],
                "query",
                queryName,
              ),
              params,
            );
          },
        },
      });
    };
  }

  return {
    model: model as LedgerModel<
      TEvents,
      TQueues,
      TIndexers,
      TQueries,
      TSignals,
      TSignalQueues
    >,
    register: {
      events,
      indexers: runtimeRegister.indexers,
      queries: runtimeRegister.queries,
      queues,
      signals,
      signalQueues,
    } as RegisterFunction<
      TEvents,
      TQueues,
      TIndexers,
      TQueries,
      TSignals,
      TSignalQueues,
      TIndexerDefinitions
    >,
  };
}

async function runEventContribution(
  handler: (input: RuntimeEventHandlerInput) => void | Promise<void>,
  localName: string,
  physicalInput: RuntimeEventHandlerInput,
  names: {
    readonly indexerName: (name: string) => string;
    readonly queryName: (name: string) => string;
    readonly queueName: (name: string) => string;
  },
): Promise<void> {
  const pendingActions = new Set<Promise<unknown>>();
  let open = true;
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    if (!open) {
      return Promise.reject(
        new Error("event actions are only valid during event handling"),
      );
    }

    let tracked: Promise<T>;
    tracked = run().finally(() => {
      pendingActions.delete(tracked);
    });
    pendingActions.add(tracked);
    return tracked;
  };

  await handler({
    event: localizeRuntimeEvent(physicalInput.event, localName),
    actions: {
      index: (indexName, indexInput) => {
        return track(async () => {
          await physicalInput.actions.index(
            names.indexerName(indexName),
            indexInput,
          );
        });
      },
      enqueue: (queueName, payload, options) => {
        if (!open) {
          throw new Error("event actions are only valid during event handling");
        }

        physicalInput.actions.enqueue(
          names.queueName(queueName),
          payload,
          options,
        );
      },
      query: (queryName, params) => {
        return track(async () => {
          return await physicalInput.actions.query(
            names.queryName(queryName),
            params,
          );
        });
      },
    },
  });

  open = false;

  if (pendingActions.size === 0) {
    return;
  }

  await Promise.allSettled([...pendingActions]);
  throw new Error("event actions must be awaited before the handler returns");
}

function localizeRuntimeEvent(
  event: RuntimeEventHandlerInput["event"],
  localName: string,
): RuntimeEventHandlerInput["event"] {
  return {
    ...event,
    eventName: localName,
    ref: createEventRef(localName, event.eventId),
  };
}

function createPhysicalSchemaMap(
  tokens: Readonly<Record<string, object>>,
  schemas: Readonly<Record<string, TSchema>>,
  kind: "event" | "queue" | "signal" | "signal_queue",
): Record<string, TSchema> {
  const physical: Record<string, TSchema> = {};

  for (const [localName, schema] of Object.entries(schemas)) {
    const token = tokens[localName];
    physical[readTokenPhysicalName(token, kind, localName)] = schema;
  }

  return physical;
}

function createPrivatePhysicalSchemaMap<TValue>(
  moduleId: string,
  kind: "indexer",
  schemas: Readonly<Record<string, TValue>>,
): Record<string, TValue> {
  const physical: Record<string, TValue> = {};

  for (const [localName, schema] of Object.entries(schemas)) {
    physical[createPhysicalName(moduleId, kind, localName)] = schema;
  }

  return physical;
}

function createPhysicalQuerySchemaMap(
  tokens: Readonly<Record<string, object>>,
  schemas: Readonly<Record<string, AnyQuerySchema>>,
): Record<string, AnyQuerySchema> {
  const physical: Record<string, AnyQuerySchema> = {};

  for (const [localName, schema] of Object.entries(schemas)) {
    physical[readTokenPhysicalName(tokens[localName], "query", localName)] =
      schema;
  }

  return physical;
}

function namespaceLedgerImplementations(
  moduleId: string,
  queryTokens: Readonly<Record<string, object>>,
  indexerDefinitions: ProjectionIndexerDefinitions<string>,
  implementations: LedgerImplementations<
    Record<string, TSchema>,
    Record<string, AnyQuerySchema>,
    Record<string, TSchema>
  >,
): LedgerImplementations<
  Record<string, TSchema>,
  Record<string, AnyQuerySchema>,
  Record<string, TSchema>
> {
  const indexers: Record<
    string,
    NonNullable<typeof implementations.indexers>[string]
  > = {};
  const queries: Record<
    string,
    NonNullable<typeof implementations.queries>[string]
  > = {};

  for (const [localName, implementation] of Object.entries(
    implementations.indexers ?? {},
  )) {
    const definition = indexerDefinitions[localName];

    if (definition === undefined) {
      throw new Error(`unknown indexer implementation ${localName}`);
    }

    indexers[createPhysicalName(moduleId, "indexer", localName)] = (
      scope,
      indexInput,
      context,
    ) => {
      return implementation(scope, indexInput, {
        event: localizeRuntimeEvent(context.event, definition.sourceEvent),
      });
    };
  }

  for (const [localName, implementation] of Object.entries(
    implementations.queries ?? {},
  )) {
    queries[readTokenPhysicalName(queryTokens[localName], "query", localName)] =
      implementation;
  }

  return {
    indexers,
    queries,
  };
}

function validateModuleId(moduleId: string): void {
  validatePhysicalNamePart("ledger module id", moduleId);
}

function validatePrivateSchemaDefinitions(
  kind: string,
  definitions: Readonly<Record<string, unknown>>,
): void {
  for (const [name, definition] of Object.entries(definitions)) {
    if (isLedgerContractToken(definition)) {
      throw new Error(`${kind} ${name} must be defined by its owning module`);
    }
  }
}

function validatePhysicalNamePart(context: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${context} must not be empty`);
  }

  if (value.includes(physicalNameSeparator)) {
    throw new Error(
      `${context} must not contain reserved separator ${physicalNameSeparator}`,
    );
  }
}

function createPhysicalName(
  moduleId: string,
  kind: LedgerContractKind,
  localName: string,
): string {
  validateModuleId(moduleId);
  validatePhysicalNamePart(`${kind} name`, localName);
  return `sledge${physicalNameSeparator}${moduleId}${physicalNameSeparator}${kind}${physicalNameSeparator}${localName}`;
}

function createEventTokens<
  TModuleId extends string,
  TDefinitions extends Record<string, EventDefinition>,
>(
  moduleId: TModuleId,
  definitions: TDefinitions,
): EventTokensFor<TModuleId, TDefinitions> {
  const tokens: Record<string, AnyEventToken> = {};

  for (const [localName, definition] of Object.entries(definitions)) {
    if (isLedgerContractToken(definition)) {
      const metadata = readLedgerContractToken(definition, "event");
      defineRecordEntry(tokens, localName, definition as AnyEventToken);

      if (metadata.kind !== "event") {
        throw new Error(`${localName} must reference an event token`);
      }

      continue;
    }

    defineRecordEntry(
      tokens,
      localName,
      createSchemaToken(
        moduleId,
        "event",
        localName,
        definition,
      ) as AnyEventToken,
    );
  }

  return tokens as EventTokensFor<TModuleId, TDefinitions>;
}

function readEventSchemas<TDefinitions extends Record<string, EventDefinition>>(
  definitions: TDefinitions,
): EventSchemasFor<TDefinitions> {
  const schemas: Record<string, TSchema> = {};

  for (const [localName, definition] of Object.entries(definitions)) {
    defineRecordEntry(
      schemas,
      localName,
      isLedgerContractToken(definition)
        ? readLedgerContractToken(definition, "event").schema
        : definition,
    );
  }

  return schemas as EventSchemasFor<TDefinitions>;
}

function normalizeQueryDefinitions<TDefinitions extends LedgerQueryDefinitions>(
  definitions: TDefinitions,
): NormalizedQueryDefinitions<TDefinitions> {
  const normalized: Record<string, AnyQuerySchema> = {};

  for (const [localName, definition] of Object.entries(definitions)) {
    if (isLedgerContractToken(definition)) {
      const metadata = readLedgerContractToken(definition, "query");
      defineRecordEntry(normalized, localName, {
        params: metadata.params,
        result: metadata.result,
      });
      continue;
    }

    defineRecordEntry(normalized, localName, definition as AnyQuerySchema);
  }

  return normalized as NormalizedQueryDefinitions<TDefinitions>;
}

function readOwnedQueryDefinitions<TDefinitions extends LedgerQueryDefinitions>(
  definitions: TDefinitions,
): OwnedQueryDefinitions<TDefinitions> {
  const owned: Record<string, AnyQuerySchema> = {};

  for (const [localName, definition] of Object.entries(definitions)) {
    if (!isLedgerContractToken(definition)) {
      defineRecordEntry(owned, localName, definition as AnyQuerySchema);
    }
  }

  return owned as OwnedQueryDefinitions<TDefinitions>;
}

function createQueryTokens<
  TModuleId extends string,
  TDefinitions extends LedgerQueryDefinitions,
>(
  moduleId: TModuleId,
  definitions: TDefinitions,
): QueryTokensFor<TModuleId, TDefinitions> {
  const tokens: Record<string, AnyQueryToken> = {};

  for (const [localName, definition] of Object.entries(definitions)) {
    if (isLedgerContractToken(definition)) {
      readLedgerContractToken(definition, "query");
      defineRecordEntry(tokens, localName, definition as AnyQueryToken);
      continue;
    }

    const queryDefinition = definition as AnyQuerySchema;
    const token = Object.freeze({});
    ledgerContractTokenMetadata.set(token, {
      kind: "query",
      localName,
      moduleId,
      params: queryDefinition.params,
      physicalName: createPhysicalName(moduleId, "query", localName),
      result: queryDefinition.result,
    });
    defineRecordEntry(tokens, localName, token as AnyQueryToken);
  }

  return tokens as QueryTokensFor<TModuleId, TDefinitions>;
}

function createSchemaTokens<
  TModuleId extends string,
  TSchemas extends Record<string, TSchema>,
  TKind extends "queue" | "signal" | "signal_queue",
>(
  moduleId: TModuleId,
  kind: TKind,
  schemas: TSchemas,
): TokensForSchemas<TModuleId, TSchemas, TKind> {
  const tokens: Record<
    string,
    AnyQueueToken | AnySignalToken | AnySignalQueueToken
  > = {};

  for (const [localName, schema] of Object.entries(schemas)) {
    defineRecordEntry(
      tokens,
      localName,
      createSchemaToken(moduleId, kind, localName, schema) as
        | AnyQueueToken
        | AnySignalToken
        | AnySignalQueueToken,
    );
  }

  return tokens as TokensForSchemas<TModuleId, TSchemas, TKind>;
}

function createSchemaToken(
  moduleId: string,
  kind: "event" | "queue" | "signal" | "signal_queue",
  localName: string,
  schema: TSchema,
): object {
  const token = Object.freeze({});
  ledgerContractTokenMetadata.set(token, {
    kind,
    localName,
    moduleId,
    physicalName: createPhysicalName(moduleId, kind, localName),
    schema,
  });
  return token;
}

function defineRecordEntry<TValue>(
  record: Record<string, TValue>,
  name: string,
  value: TValue,
): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isLedgerContractToken(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    ledgerContractTokenMetadata.has(value)
  );
}

function readLedgerContractToken<TKind extends LedgerContractMetadata["kind"]>(
  token: object,
  expectedKind: TKind,
): Extract<LedgerContractMetadata, { readonly kind: TKind }> {
  const metadata = ledgerContractTokenMetadata.get(token);

  if (metadata === undefined || metadata.kind !== expectedKind) {
    throw new Error(`expected Sledge ${expectedKind} token`);
  }

  return metadata as Extract<LedgerContractMetadata, { readonly kind: TKind }>;
}

function readTokenPhysicalName(
  token: object | undefined,
  expectedKind: LedgerContractMetadata["kind"],
  localName: string,
): string {
  if (token === undefined) {
    throw new Error(`unknown ${expectedKind}: ${localName}`);
  }

  return readLedgerContractToken(token, expectedKind).physicalName;
}

function namespaceProjectionSchema<
  TProjectionSchema extends AnyProjectionSchema,
>(moduleId: string, schema: TProjectionSchema): TProjectionSchema {
  const tables: Record<string, ProjectionTableMetadata> = {};

  for (const [localName, table] of Object.entries(schema.metadata.tables)) {
    tables[localName] = namespaceProjectionTable(moduleId, localName, table);
  }

  const relations: Record<string, ProjectionForeignKeyMetadata> = {};

  for (const [name, relation] of Object.entries(schema.metadata.relations)) {
    relations[name] = namespaceProjectionForeignKey(moduleId, relation);
  }

  return {
    ...schema,
    metadata: {
      relations,
      tables,
    },
  } as TProjectionSchema;
}

function namespaceProjectionTable(
  moduleId: string,
  localName: string,
  table: ProjectionTableMetadata,
): ProjectionTableMetadata {
  return {
    ...table,
    indexes: table.indexes.map((index) => {
      return namespaceProjectionIndex(moduleId, index);
    }),
    name: createPhysicalName(moduleId, "table", localName),
  };
}

function namespaceProjectionIndex(
  moduleId: string,
  index: ProjectionIndexMetadata,
): ProjectionIndexMetadata {
  return {
    ...index,
    name: createPhysicalName(moduleId, "index", index.name),
  };
}

function namespaceProjectionForeignKey(
  moduleId: string,
  foreignKey: ProjectionForeignKeyMetadata,
): ProjectionForeignKeyMetadata {
  return {
    ...foreignKey,
    fromTable: createPhysicalName(moduleId, "table", foreignKey.fromTable),
    toTable: createPhysicalName(moduleId, "table", foreignKey.toTable),
  };
}

function namespaceMaterializationHistory<
  THistory extends AnyMaterializationHistory,
>(moduleId: string, history: THistory): THistory {
  const namespace = createPhysicalName(
    moduleId,
    "materialization",
    history.namespace,
  );

  return {
    ...history,
    current: {
      ...namespaceProjectionSchema(moduleId, history.current),
      namespace,
    },
    migrations: history.migrations.map((migration) => {
      return {
        ...migration,
        operations: migration.operations.map((operation) => {
          return namespaceMaterializationOperation(moduleId, operation);
        }),
      };
    }),
    namespace,
  } as THistory;
}

function namespaceMaterializationOperation(
  moduleId: string,
  operation: MaterializationMigrationOperation,
): MaterializationMigrationOperation {
  switch (operation.kind) {
    case "create_table":
      return {
        ...operation,
        table: namespaceProjectionTable(
          moduleId,
          operation.tableName,
          operation.table,
        ),
      };
    case "create_index":
      return {
        ...operation,
        index: namespaceProjectionIndex(moduleId, operation.index),
      };
    case "add_foreign_key":
      return {
        ...operation,
        foreignKey: namespaceProjectionForeignKey(
          moduleId,
          operation.foreignKey,
        ),
      };
    case "add_column":
    case "data":
      return operation;
  }
}

function createModuleProjectionStatementCompiler(
  compiler: ProjectionStatementCompiler,
  moduleId: string,
  contracts: {
    readonly events: Readonly<Record<string, AnyEventToken>>;
    readonly signals: Readonly<Record<string, AnySignalToken>>;
  },
): ProjectionStatementCompiler {
  const physicalStreamName = (
    streamKind: "event" | "signal",
    localName: string,
  ): string => {
    const tokens =
      streamKind === "event" ? contracts.events : contracts.signals;
    return readTokenPhysicalName(tokens[localName], streamKind, localName);
  };

  return {
    resolveStorageStreamName: ({ eventName, streamKind }) =>
      compiler.resolveStorageStreamName({
        eventName: physicalStreamName(streamKind, eventName),
        streamKind,
      }),
    compileAddColumn: (statement) => compiler.compileAddColumn(statement),
    compileAggregate: (statement) =>
      compiler.compileAggregate(
        namespaceProjectionStatementTables(moduleId, statement),
      ),
    compileCreateIndex: (statement) => compiler.compileCreateIndex(statement),
    compileCreateTable: (statement) => compiler.compileCreateTable(statement),
    compileDelete: (statement) =>
      compiler.compileDelete(
        namespaceProjectionStatementTables(moduleId, statement),
      ),
    compileEventRead: (statement) =>
      compiler.compileEventRead({
        ...statement,
        eventName: physicalStreamName("event", statement.eventName),
      }),
    compileEventIdBounds: (statement) =>
      compiler.compileEventIdBounds({
        ...statement,
        eventName: physicalStreamName(
          statement.streamKind,
          statement.eventName,
        ),
      }),
    compileEventScan: (statement) =>
      compiler.compileEventScan({
        ...statement,
        eventName: physicalStreamName(
          statement.streamKind,
          statement.eventName,
        ),
      }),
    compileLatestEventRefsByPayload: (statement) =>
      compiler.compileLatestEventRefsByPayload({
        ...statement,
        eventName: physicalStreamName(
          statement.streamKind,
          statement.eventName,
        ),
      }),
    compileInsert: (statement) =>
      compiler.compileInsert(
        namespaceProjectionStatementTables(moduleId, statement),
      ),
    compileSelect: (statement) =>
      compiler.compileSelect(
        namespaceProjectionStatementTables(moduleId, statement),
      ),
    compileUnionSelect: (statement) =>
      compiler.compileUnionSelect(
        namespaceProjectionStatementTables(moduleId, statement),
      ),
    compileUpdate: (statement) =>
      compiler.compileUpdate(
        namespaceProjectionStatementTables(moduleId, statement),
      ),
  };
}

function namespaceProjectionStatementTables<T>(moduleId: string, value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return namespaceProjectionStatementTables(moduleId, item);
    }) as T;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const namespaced: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (key === "value" || key === "values") {
      namespaced[key] = child;
      continue;
    }

    if (
      (key === "tableName" || key === "fromTableName") &&
      typeof child === "string"
    ) {
      namespaced[key] = namespaceProjectionStatementTableName(moduleId, child);
      continue;
    }

    namespaced[key] = namespaceProjectionStatementTables(moduleId, child);
  }

  return namespaced as T;
}

function namespaceProjectionStatementTableName(
  moduleId: string,
  tableName: string,
): string {
  const moduleTablePrefix = `sledge::${moduleId}::table::`;

  if (tableName.startsWith(moduleTablePrefix)) {
    return tableName;
  }

  return createPhysicalName(moduleId, "table", tableName);
}

function createDefinedLedgerModel<
  TModuleId extends string,
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexers extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQuerySchema>,
  TSignals extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
  TAllQueryDefinitions extends ProjectionQueryDefinitions,
  TMaterializationHistory extends AnyMaterializationHistory<TEvents> | null,
  TEventTokens extends {
    readonly [TEventName in keyof TEvents]: AnyEventToken;
  },
  TQueryTokens extends {
    readonly [TQueryName in keyof TQueries]: AnyQueryToken;
  },
>(input: {
  readonly moduleId: TModuleId;
  readonly contracts: {
    readonly events: TEventTokens;
    readonly queries: TQueryTokens;
    readonly queues: TokensForSchemas<TModuleId, TQueues, "queue">;
    readonly signals: TokensForSchemas<TModuleId, TSignals, "signal">;
    readonly signalQueues: TokensForSchemas<
      TModuleId,
      TSignalQueues,
      "signal_queue"
    >;
  };
  readonly shape: LedgerShape<TEvents, TQueues, TSignals, TSignalQueues>;
  readonly materializationHistory: TMaterializationHistory;
  readonly access: ProjectionAccess<
    TProjectionSchema,
    TIndexers,
    TQueries,
    TIndexerDefinitions,
    TAllQueryDefinitions,
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
  TMaterializationHistory,
  TModuleId,
  TEventTokens,
  TQueryTokens
> {
  const localModel: LedgerModel<
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
  const physicalProjections = namespaceProjectionSchema(
    input.moduleId,
    input.access.projections,
  );
  const physicalMaterializationHistory =
    input.materializationHistory === null
      ? null
      : namespaceMaterializationHistory(
          input.moduleId,
          input.materializationHistory,
        );

  return {
    moduleId: input.moduleId,
    events: input.contracts.events,
    queries: input.contracts.queries,
    signals: input.contracts.signals,
    materializationHistory: input.materializationHistory,
    model: localModel,
    projections: input.access.projections,
    register: (register) => {
      const physical = createPhysicalRegisteredModule({
        access: input.access,
        contracts: input.contracts,
        localModel,
        moduleId: input.moduleId,
        register,
      });
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
        TMaterializationHistory,
        TModuleId,
        TEventTokens,
        TQueryTokens
      > = {
        [registeredLedgerModelBrand]: true,
        [registeredLedgerContractsBrand]: input.contracts,
        [registeredLedgerRuntimeBrand]: {
          materializationHistory:
            physicalMaterializationHistory as TMaterializationHistory,
          model: physical.model,
          projections: physicalProjections,
          register: physical.register as typeof register,
        },
        moduleId: input.moduleId,
        events: input.contracts.events,
        queries: input.contracts.queries,
        signals: input.contracts.signals,
        materializationHistory: input.materializationHistory,
        model: localModel,
        projections: input.access.projections,
        register,
      };

      const registeredWithSchemas = attachLedgerProjectionSchemas(
        registeredModel,
        {
          events: input.shape.events,
          signals: input.shape.signals,
        },
      );
      const registeredWithCompiler = attachLedgerProjectionCompilerFactory(
        registeredWithSchemas,
        (compiler) => {
          return createModuleProjectionStatementCompiler(
            compiler,
            input.moduleId,
            input.contracts,
          );
        },
      );

      return attachLedgerImplementationFactory(
        registeredWithCompiler,
        (factory) => {
          const statementCompiler = createModuleProjectionStatementCompiler(
            factory.statementCompiler,
            input.moduleId,
            input.contracts,
          );
          const implementations = createProjectionImplementations({
            events: input.shape.events,
            signals: input.shape.signals,
            statementCompiler,
            projections: input.access.projections,
            indexers: input.access.indexerDefinitions,
            queries: input.access.ownedQueryDefinitions,
            register,
          }) as LedgerImplementations<TIndexers, TQueries, TEvents>;

          return namespaceLedgerImplementations(
            input.moduleId,
            input.contracts.queries,
            input.access.indexerDefinitions,
            implementations,
          ) as LedgerImplementations<TIndexers, TQueries, TEvents>;
        },
      );
    },
  };
}
