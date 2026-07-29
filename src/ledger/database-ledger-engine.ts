import { randomUUID } from "node:crypto";

import { Type, type Static, type TSchema } from "typebox";

import Sqids from "sqids";
import { Value } from "typebox/value";

import type { RuntimeScheduler } from "../runtime/contracts.ts";
import { ChangeSignal, raceWithSignal } from "../runtime/async-signals.ts";
import { createEventRef } from "./event-ref.ts";
import {
  composedLedgerModulesBrand,
  readLedgerProjectionCompiler,
  readLedgerProjectionSchemas,
  readLedgerImplementations,
  registeredLedgerContractsBrand,
  registeredLedgerRuntimeBrand,
  storageRuntimeIdentityBrand,
  type LedgerStorageRow,
  type LedgerStorageScope,
  type LedgerStorageStatement,
} from "./internal-storage.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";
import type {
  AnyComposedLedgerModel,
  AnyMaterializationHistory,
  ComposedLedgerEventTokens,
  ComposedLedgerQueryTokens,
  ComposedLedgerSignalTokens,
  RegisteredLedgerModel,
  EmitOptions,
  EventEnvelope,
  Ledger,
  LedgerCursor,
  LedgerTiming,
  LedgerIndexerContext,
  ListWorkInput,
  LedgerWorkerOptions,
  LedgerWorkers,
  QuerySchema,
  QueueActions,
  QueueHandlerControl,
  QueueHandlerFunction,
  QueueOperationHandler,
  QueueOperationSettlementFunction,
  QueueWorkItem,
  SignalObserverFunction,
  SignalQueueActions,
  SignalQueueHandlerControl,
  SignalQueueHandlerFunction,
  CancelWorkInput,
  CancelWorkResult,
  WorkLease,
  WorkRef,
  WorkSnapshot,
  WorkState,
  MaterializationMigrationOperation,
  QueryWorkInput,
  SignalSubscription,
} from "./ledger.ts";
import { QueueOperationTimeoutError } from "./ledger.ts";
import type {
  AnyProjectionSchema,
  ProjectionIndexerDefinitions,
  ProjectionQueryDefinitions,
} from "./projection-access.ts";
import { runProjectionDatabaseScope } from "./projection-access.ts";
import type {
  ProjectionForeignKeyMetadata,
  ProjectionSchemaMetadata,
  ProjectionTableMetadata,
} from "./projections.ts";

type AnyIndexerDef = TSchema;
type AnyQueryDef = QuerySchema<TSchema, TSchema>;

type DatabaseLedgerStreamEvent<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents = keyof TEvents,
> = {
  readonly event: EventEnvelope<TEvents, TEventName>;
  readonly cursor: LedgerCursor;
};

export interface DatabaseLedger<
  TEvents extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQueryDef>,
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

  onSignal<const TSignalName extends keyof TSignals>(
    signalName: TSignalName,
    observer: SignalObserverFunction<TSignals, TSignalName>,
  ): SignalSubscription;

  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<DatabaseLedgerStreamEvent<TEvents>>;

  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<DatabaseLedgerStreamEvent<TEvents>>;

  startWorkers(options: LedgerWorkerOptions): Promise<LedgerWorkers>;

  close(): Promise<void>;
}

type PersistedWorkLease = {
  readonly workId: number;
  readonly queueName: string;
  readonly workKey: string | null;
  readonly payloadJson: string;
  readonly sourceEventId: number;
  readonly attempt: number;
  readonly signal: boolean;
  readonly leaseId: string;
  readonly leaseAcquiredAtMs: number;
  readonly leaseExpiresAtMs: number;
};

type AppendEventInput = {
  readonly eventName: string;
  readonly payload: unknown;
  readonly nowMs: number;
  readonly dedupeKey?: string;
  readonly causationEventId: number | null;
};

type AppendSignalInput = {
  readonly signalName: string;
  readonly payload: unknown;
  readonly nowMs: number;
  readonly dedupeKey?: string;
  readonly causationEventId: number | null;
};

type MaterializationReplayState = {
  readonly relations: Map<string, ProjectionForeignKeyMetadata>;
  readonly tables: Map<string, ProjectionTableMetadata>;
};

type MaterializationRuntimeContext = {
  readonly compiler: ProjectionStatementCompiler;
  readonly events: Readonly<Record<string, TSchema>>;
  readonly projections: AnyProjectionSchema;
  readonly signals: Readonly<Record<string, TSchema>>;
};

type RuntimeMaterializationState = {
  readonly materializationHistory: AnyMaterializationHistory | null;
  readonly model: {
    readonly events: Readonly<Record<string, TSchema>>;
    readonly signals: Readonly<Record<string, TSchema>>;
  };
  readonly projections: AnyProjectionSchema;
};

type RuntimeMaterializationModule = RuntimeMaterializationState & {
  readonly moduleId: string;
  readonly [registeredLedgerContractsBrand]?: object;
  readonly [registeredLedgerRuntimeBrand]?: RuntimeMaterializationState;
};

type StorageRow = LedgerStorageRow;

const materializationVersionTableName = "sledge_materialization_versions";
const storageLayoutTableName = "sledge_storage_layout";
const storageLayoutVersion = 1;
const MaterializationVersionRowSchema = Type.Object({
  version: Type.Number(),
});
const StorageLayoutRowSchema = Type.Object({
  module_ids_json: Type.String(),
  version: Type.Number(),
});
const ComposedModuleIdsSchema = Type.Array(Type.String(), { minItems: 1 });
const databaseInitializationTails = new Map<string, Promise<void>>();

async function serializeDatabaseInitialization<T>(
  databaseIdentity: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous =
    databaseInitializationTails.get(databaseIdentity) ?? Promise.resolve();
  const gate = Promise.withResolvers<void>();
  databaseInitializationTails.set(databaseIdentity, gate.promise);

  await previous;

  try {
    return await run();
  } finally {
    gate.resolve();

    if (databaseInitializationTails.get(databaseIdentity) === gate.promise) {
      databaseInitializationTails.delete(databaseIdentity);
    }
  }
}

export type StorageStatement = LedgerStorageStatement;

export type StorageDatabase = LedgerStorageScope;

export interface StorageRuntime {
  readonly [storageRuntimeIdentityBrand]: string;

  read<T>(run: (scope: LedgerStorageScope) => Promise<T>): Promise<T>;

  write<T>(run: (scope: LedgerStorageScope) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

type OpenDatabaseLedgerEngineInput<
  TEvents extends Record<string, TSchema>,
  TSignals extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TSignalQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
  TProjectionSchema extends AnyProjectionSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  TQueryDefinitions extends ProjectionQueryDefinitions,
  TMaterializationHistory extends AnyMaterializationHistory<TEvents> | null,
> = {
  readonly model: RegisteredLedgerModel<
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
  readonly projectionCompiler: ProjectionStatementCompiler;
  readonly timing: LedgerTiming;
  readonly storage: StorageRuntime;
};

export type CreateDatabaseLedgerInput<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
  TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  TQueryDefinitions extends ProjectionQueryDefinitions = {},
  TMaterializationHistory extends AnyMaterializationHistory<TEvents> | null =
    AnyMaterializationHistory<TEvents> | null,
> = {
  readonly storage: StorageRuntime;
  readonly model: RegisteredLedgerModel<
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
  readonly projectionCompiler: ProjectionStatementCompiler;
  readonly timing: LedgerTiming;
};

export function createDatabaseLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef>,
  const TQueries extends Record<string, AnyQueryDef>,
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
  const TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  const TQueryDefinitions extends ProjectionQueryDefinitions = {},
  const TMaterializationHistory extends
    AnyMaterializationHistory<TEvents> | null =
    AnyMaterializationHistory<TEvents> | null,
>(
  input: CreateDatabaseLedgerInput<
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
  >,
): DatabaseLedger<TEvents, TQueries, TSignals> {
  return openDatabaseLedgerEngine({
    model: input.model,
    projectionCompiler: input.projectionCompiler,
    timing: input.timing,
    storage: input.storage,
  });
}

export function createComposedDatabaseLedger<
  const TModel extends AnyComposedLedgerModel,
>(input: {
  readonly storage: StorageRuntime;
  readonly model: TModel;
  readonly projectionCompiler: ProjectionStatementCompiler;
  readonly timing: LedgerTiming;
}): Ledger<
  ComposedLedgerEventTokens<TModel>,
  ComposedLedgerQueryTokens<TModel>,
  ComposedLedgerSignalTokens<TModel>
> {
  const rawInput = input as unknown as CreateDatabaseLedgerInput<
    Record<string, TSchema>,
    Record<string, TSchema>,
    Record<string, TSchema>,
    Record<string, AnyQueryDef>,
    Record<string, TSchema>,
    Record<string, TSchema>
  >;
  const ledger = createDatabaseLedger(rawInput);

  return createLedgerContractFacade(ledger, input.model) as unknown as Ledger<
    ComposedLedgerEventTokens<TModel>,
    ComposedLedgerQueryTokens<TModel>,
    ComposedLedgerSignalTokens<TModel>
  >;
}

function createLedgerContractFacade<
  TEvents extends Record<string, TSchema>,
  TQueries extends Record<string, AnyQueryDef>,
  TSignals extends Record<string, TSchema>,
>(
  ledger: DatabaseLedger<TEvents, TQueries, TSignals>,
  model: {
    readonly [registeredLedgerContractsBrand]: {
      readonly events: Readonly<Record<string, object>>;
      readonly queries: Readonly<Record<string, object>>;
      readonly queues: Readonly<Record<string, object>>;
      readonly signals: Readonly<Record<string, object>>;
      readonly signalQueues: Readonly<Record<string, object>>;
    };
    readonly [composedLedgerModulesBrand]: readonly {
      readonly [registeredLedgerContractsBrand]: {
        readonly queues: Readonly<Record<string, object>>;
        readonly signalQueues: Readonly<Record<string, object>>;
      };
    }[];
  },
): object {
  const contracts = model[registeredLedgerContractsBrand];
  const workQueueNames = createWorkQueueNameMaps(model);

  return new Proxy(ledger, {
    get: (target, property, receiver) => {
      if (property === "emit") {
        return async (
          token: object,
          payload: unknown,
          options?: {
            readonly dedupeKey?: string;
          },
        ) => {
          const physicalName = findPhysicalContractName(
            contracts.events,
            token,
            "event",
          );
          const event = await target.emit(
            physicalName as keyof TEvents,
            payload as Static<TEvents[keyof TEvents]>,
            options,
          );

          return createContractEnvelope(event, token);
        };
      }

      if (property === "cancelWork") {
        return async (input: CancelWorkInput) => {
          const result = await target.cancelWork(input);
          return localizeCancelWorkResult(result, workQueueNames);
        };
      }

      if (property === "queryWork") {
        return async (input: QueryWorkInput) => {
          const work = await target.queryWork(input);
          return work === null
            ? null
            : localizeWorkSnapshot(work, workQueueNames);
        };
      }

      if (property === "listWork") {
        return async (input: ListWorkInput = {}) => {
          if (input.queueName === undefined) {
            const work = await target.listWork(input);
            return work.map((item) =>
              localizeWorkSnapshot(item, workQueueNames),
            );
          }

          const physicalNames = [
            ...(workQueueNames.queues.localToPhysical.get(input.queueName) ??
              []),
            ...(workQueueNames.signalQueues.localToPhysical.get(
              input.queueName,
            ) ?? []),
          ];

          if (physicalNames.length === 0) {
            return await target.listWork({
              ...input,
              queueName: unavailablePhysicalQueueName,
            });
          }

          const limit = input.limit ?? 100;
          const work = (
            await Promise.all(
              physicalNames.map(async (physicalName) => {
                return await target.listWork({
                  ...input,
                  limit,
                  queueName: physicalName,
                });
              }),
            )
          )
            .flat()
            .sort((left, right) => left.workId - right.workId)
            .slice(0, limit);

          return work.map((item) => localizeWorkSnapshot(item, workQueueNames));
        };
      }

      if (property === "query") {
        return async (token: object, params: unknown) => {
          const physicalName = findPhysicalContractName(
            contracts.queries,
            token,
            "query",
          );

          return await target.query(
            physicalName as keyof TQueries,
            params as Static<TQueries[keyof TQueries]["params"]>,
          );
        };
      }

      if (property === "onSignal") {
        return (
          token: object,
          observer: (signal: object) => void | Promise<void>,
        ) => {
          const physicalName = findPhysicalContractName(
            contracts.signals,
            token,
            "signal",
          );

          return target.onSignal(
            physicalName as keyof TSignals,
            async (signal) => {
              await observer(createContractEnvelope(signal, token));
            },
          );
        };
      }

      if (property === "tailEvents" || property === "resumeEvents") {
        return (input: {
          readonly last?: number;
          readonly cursor?: LedgerCursor;
          readonly signal: AbortSignal;
        }) => {
          const source =
            property === "tailEvents"
              ? target.tailEvents(
                  input as {
                    readonly last: number;
                    readonly signal: AbortSignal;
                  },
                )
              : target.resumeEvents(
                  input as {
                    readonly cursor: LedgerCursor;
                    readonly signal: AbortSignal;
                  },
                );

          return mapContractEventStream(source, contracts.events);
        };
      }

      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

type WorkQueueNameMap = {
  readonly localToPhysical: ReadonlyMap<string, readonly string[]>;
  readonly physicalToLocal: ReadonlyMap<string, string>;
};

type WorkQueueNameMaps = {
  readonly queues: WorkQueueNameMap;
  readonly signalQueues: WorkQueueNameMap;
};

const unavailablePhysicalQueueName = "\u0000";

function createWorkQueueNameMaps(model: {
  readonly [registeredLedgerContractsBrand]: {
    readonly queues: Readonly<Record<string, object>>;
    readonly signalQueues: Readonly<Record<string, object>>;
  };
  readonly [composedLedgerModulesBrand]: readonly {
    readonly [registeredLedgerContractsBrand]: {
      readonly queues: Readonly<Record<string, object>>;
      readonly signalQueues: Readonly<Record<string, object>>;
    };
  }[];
}): WorkQueueNameMaps {
  const rootContracts = model[registeredLedgerContractsBrand];
  const queues = createWorkQueueNameMap(
    model,
    "queue",
    rootContracts.queues,
    "queues",
  );
  const signalQueues = createWorkQueueNameMap(
    model,
    "signal queue",
    rootContracts.signalQueues,
    "signalQueues",
  );

  return {
    queues,
    signalQueues,
  };
}

function createWorkQueueNameMap(
  model: {
    readonly [composedLedgerModulesBrand]: readonly {
      readonly [registeredLedgerContractsBrand]: {
        readonly queues: Readonly<Record<string, object>>;
        readonly signalQueues: Readonly<Record<string, object>>;
      };
    }[];
  },
  kind: string,
  rootContracts: Readonly<Record<string, object>>,
  key: "queues" | "signalQueues",
): WorkQueueNameMap {
  const localToPhysical = new Map<string, string[]>();
  const physicalToLocal = new Map<string, string>();

  for (const module of model[composedLedgerModulesBrand]) {
    const moduleContracts = module[registeredLedgerContractsBrand][key];

    for (const [localName, token] of Object.entries(moduleContracts)) {
      const physicalName = findPhysicalContractName(rootContracts, token, kind);
      const physicalNames = localToPhysical.get(localName) ?? [];

      physicalNames.push(physicalName);
      localToPhysical.set(localName, physicalNames);
      physicalToLocal.set(physicalName, localName);
    }
  }

  return {
    localToPhysical,
    physicalToLocal,
  };
}

function localizeCancelWorkResult(
  result: CancelWorkResult,
  names: WorkQueueNameMaps,
): CancelWorkResult {
  switch (result.status) {
    case "cancelled":
      return {
        status: "cancelled",
        work: localizeWorkSnapshot(result.work, names),
      };
    case "already_terminal":
      return {
        status: "already_terminal",
        ref: result.ref,
        work: localizeWorkSnapshot(result.work, names),
      };
    case "not_found":
      return {
        status: "not_found",
        ref: result.ref,
      };
  }
}

function localizeWorkSnapshot(
  work: WorkSnapshot,
  names: WorkQueueNameMaps,
): WorkSnapshot {
  const queueName = localizeStoredQueueName(work.queueName, work.signal, names);

  return {
    ...work,
    queueName,
    ref: work.ref,
  };
}

function localizeStoredQueueName(
  physicalName: string,
  signal: boolean,
  names: WorkQueueNameMaps,
): string {
  const queueNames = signal ? names.signalQueues : names.queues;
  const localName = queueNames.physicalToLocal.get(physicalName);

  if (localName === undefined) {
    throw new Error(`unknown persisted queue ${physicalName}`);
  }

  return localName;
}

function createContractEnvelope(
  event: {
    readonly causationEventId: number | null;
    readonly eventId: number;
    readonly payload: unknown;
    readonly tsMs: number;
    readonly dedupeKey: string | null;
  },
  token: object,
): object {
  return {
    eventId: event.eventId,
    event: token,
    payload: event.payload,
    tsMs: event.tsMs,
    ref: createEventRef(token, event.eventId),
    causationEventId: event.causationEventId,
    dedupeKey: event.dedupeKey,
  };
}

async function* mapContractEventStream<TEvents extends Record<string, TSchema>>(
  source: AsyncIterable<DatabaseLedgerStreamEvent<TEvents>>,
  contracts: Readonly<Record<string, object>>,
): AsyncIterable<{
  readonly event: object;
  readonly cursor: LedgerCursor;
}> {
  for await (const item of source) {
    const token = contracts[String(item.event.eventName)];

    if (token === undefined) {
      throw new Error(
        `unknown persisted event ${String(item.event.eventName)}`,
      );
    }

    yield {
      event: createContractEnvelope(item.event, token),
      cursor: item.cursor,
    };
  }
}

function findPhysicalContractName(
  contracts: Readonly<Record<string, object>>,
  token: object,
  kind: string,
): string {
  for (const [physicalName, candidate] of Object.entries(contracts)) {
    if (candidate === token) {
      return physicalName;
    }
  }

  throw new Error(`unknown ${kind} token`);
}

function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error: unknown) {
    throw new Error(`invalid JSON at ${context}`, {
      cause: error,
    });
  }
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

class RetryRequested {
  readonly error: string;
  readonly retryAtMs?: number;

  constructor(error: unknown, retryAtMs?: number) {
    this.error = describeUnknownError(error);
    this.retryAtMs = retryAtMs;
  }
}

class DeadLetterRequested {
  readonly error: string;

  constructor(error: unknown) {
    this.error = describeUnknownError(error);
  }
}

type RuntimeQueueOperationSettlement = QueueOperationSettlementFunction<
  Record<string, TSchema>,
  Record<string, QuerySchema<TSchema, TSchema>>,
  Record<string, TSchema>
>;

type QueueOperationPreparation =
  | {
      readonly status: "settle";
      readonly settlement: RuntimeQueueOperationSettlement;
    }
  | {
      readonly status: "lease_lost";
    };

type PreparedQueueExecution =
  | {
      readonly kind: "handler";
    }
  | {
      readonly kind: "settlement";
      readonly settlement: RuntimeQueueOperationSettlement;
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
    };

async function prepareQueueOperationSettlement(input: {
  readonly handler: QueueOperationHandler<
    Record<string, TSchema>,
    Record<string, TSchema>,
    string,
    Record<string, QuerySchema<TSchema, TSchema>>,
    Record<string, TSchema>
  >;
  readonly leaseSignal: AbortSignal;
  readonly scheduler: RuntimeScheduler;
  readonly work: QueueWorkItem<Record<string, TSchema>, string>;
}): Promise<QueueOperationPreparation> {
  if (input.leaseSignal.aborted) {
    return {
      status: "lease_lost",
    };
  }

  const operationAbortController = new AbortController();
  const abortForLease = (): void => {
    operationAbortController.abort(input.leaseSignal.reason);
  };

  input.leaseSignal.addEventListener("abort", abortForLease, {
    once: true,
  });

  try {
    const timeoutError = new QueueOperationTimeoutError(
      input.handler.timeoutMs,
    );
    const timeoutTask = input.scheduler.scheduleOnce(
      input.handler.timeoutMs,
      () => {
        operationAbortController.abort(timeoutError);
      },
    );

    try {
      if (input.leaseSignal.aborted) {
        abortForLease();
      }

      if (operationAbortController.signal.aborted) {
        return {
          status: "lease_lost",
        };
      }

      const operation = Promise.resolve().then(async () => {
        return await input.handler.execute({
          work: input.work,
          signal: operationAbortController.signal,
        });
      });
      let result:
        | {
            readonly status: "completed";
            readonly value: RuntimeQueueOperationSettlement;
          }
        | {
            readonly status: "aborted";
          };

      try {
        result = await raceWithSignal(
          operation,
          operationAbortController.signal,
        );
      } catch (error: unknown) {
        if (input.leaseSignal.aborted) {
          return {
            status: "lease_lost",
          };
        }

        const failure =
          operationAbortController.signal.reason === timeoutError
            ? {
                kind: "timeout" as const,
                error: timeoutError,
              }
            : {
                kind: "error" as const,
                error,
              };

        return {
          status: "settle",
          settlement: input.handler.onFailure({
            work: input.work,
            failure,
          }),
        };
      }

      if (result.status === "completed") {
        if (input.leaseSignal.aborted) {
          return {
            status: "lease_lost",
          };
        }

        return {
          status: "settle",
          settlement: result.value,
        };
      }

      if (input.leaseSignal.aborted) {
        return {
          status: "lease_lost",
        };
      }

      return {
        status: "settle",
        settlement: input.handler.onFailure({
          work: input.work,
          failure: {
            kind: "timeout",
            error: timeoutError,
          },
        }),
      };
    } finally {
      timeoutTask.cancel();
    }
  } finally {
    input.leaseSignal.removeEventListener("abort", abortForLease);
  }
}

type HandlerDisposition =
  | { readonly kind: "ack" }
  | {
      readonly kind: "retry";
      readonly error: string;
      readonly retryAtMs?: number;
    }
  | { readonly kind: "dead_letter"; readonly error: string };

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("duplicate column");
}

const CURSOR_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const cursorSqids = new Sqids({
  alphabet: CURSOR_ALPHABET,
  minLength: 6,
  blocklist: new Set(),
});

function encodeCursor(afterEventId: number): LedgerCursor {
  return `v1:${cursorSqids.encode([afterEventId])}`;
}

function decodeCursor(cursor: LedgerCursor): number {
  if (!cursor.startsWith("v1:")) {
    throw new Error("invalid cursor format");
  }

  const token = cursor.slice(3);
  const decoded = cursorSqids.decode(token);

  if (decoded.length !== 1) {
    throw new Error("invalid cursor payload");
  }

  const afterEventId = decoded[0];

  if (afterEventId === undefined) {
    throw new Error("invalid cursor payload");
  }

  if (!Number.isInteger(afterEventId) || afterEventId < 0) {
    throw new Error("invalid cursor payload");
  }

  return afterEventId;
}

const EventEnvelopeRowSchema = Type.Object({
  event_id: Type.Number(),
  ts_ms: Type.Number(),
  event_name: Type.String(),
  payload_json: Type.String(),
  causation_event_id: Type.Union([Type.Null(), Type.Number()]),
  dedupe_key: Type.Union([Type.Null(), Type.String()]),
});

const EventIdRowSchema = Type.Object({
  event_id: Type.Number(),
});

const TableInfoRowSchema = Type.Object({
  name: Type.String(),
});

const AvailableAtRowSchema = Type.Object({
  available_at_ms: Type.Number(),
});

const WorkIdRowSchema = Type.Object({
  work_id: Type.Number(),
});

const PartitionKeySchema = Type.String({ minLength: 1 });
const WorkRefSchema = Type.String({
  pattern:
    "^work:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

const WorkSnapshotRowSchema = Type.Object({
  work_id: Type.Number(),
  work_ref: Type.Union([Type.Null(), Type.String()]),
  queue_name: Type.String(),
  source_event_id: Type.Number(),
  signal: Type.Number(),
  attempt: Type.Number(),
  available_at_ms: Type.Number(),
  dead: Type.Number(),
  lease_id: Type.Union([Type.Null(), Type.String()]),
  lease_acquired_at_ms: Type.Union([Type.Null(), Type.Number()]),
  lease_expires_at_ms: Type.Union([Type.Null(), Type.Number()]),
  last_error: Type.Union([Type.Null(), Type.String()]),
  cancelled: Type.Number(),
  cancel_requested_at_ms: Type.Union([Type.Null(), Type.Number()]),
  cancel_reason: Type.Union([Type.Null(), Type.String()]),
});

const ClaimedWorkRowSchema = Type.Object({
  work_id: Type.Number(),
  queue_name: Type.String(),
  work_key: Type.Union([Type.Null(), Type.String()]),
  payload_json: Type.String(),
  source_event_id: Type.Number(),
  signal: Type.Number(),
  attempt: Type.Number(),
  lease_id: Type.Union([Type.Null(), Type.String()]),
  lease_acquired_at_ms: Type.Union([Type.Null(), Type.Number()]),
  lease_expires_at_ms: Type.Union([Type.Null(), Type.Number()]),
});

function decodeRow<const TSchemaDef extends TSchema>(
  row: StorageRow,
  schema: TSchemaDef,
): Static<TSchemaDef> {
  return decodeValue(schema, row);
}

function decodeValue<const TSchemaDef extends TSchema>(
  schema: TSchemaDef,
  value: unknown,
): Static<TSchemaDef> {
  // Sledge schemas are JSON-compatible. TypeBox v1's Static is the encoded
  // side for codec schemas, but distinct codec domains are intentionally not
  // part of this API contract.
  return Value.Decode(schema, value) as Static<TSchemaDef>;
}

function readEventEnvelopeFromRow<
  TEvents extends Record<string, TSchema>,
  TEventName extends keyof TEvents,
>(
  row: StorageRow,
  model: {
    readonly events: TEvents;
  },
): EventEnvelope<TEvents, TEventName> {
  const decodedRow = decodeRow(row, EventEnvelopeRowSchema);
  const eventName = decodedRow.event_name as TEventName;
  const eventSchema = model.events[eventName];

  if (eventSchema === undefined) {
    throw new Error(`unknown event name in event row: ${String(eventName)}`);
  }

  const payload = decodeValue(
    eventSchema,
    parseJson(decodedRow.payload_json, "events.payload_json"),
  );

  return {
    eventId: decodedRow.event_id,
    ref: createEventRef(
      String(eventName) as Extract<TEventName, string>,
      decodedRow.event_id,
    ),
    tsMs: decodedRow.ts_ms,
    eventName,
    payload,
    causationEventId: decodedRow.causation_event_id,
    dedupeKey: decodedRow.dedupe_key,
  };
}

function openDatabaseLedgerEngine<
  const TEvents extends Record<string, TSchema>,
  const TSignals extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TSignalQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef>,
  const TQueries extends Record<string, AnyQueryDef>,
  const TProjectionSchema extends AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string>,
  const TQueryDefinitions extends ProjectionQueryDefinitions,
  const TMaterializationHistory extends
    AnyMaterializationHistory<TEvents> | null,
>(
  input: OpenDatabaseLedgerEngineInput<
    TEvents,
    TSignals,
    TQueues,
    TSignalQueues,
    TIndexers,
    TQueries,
    TProjectionSchema,
    TIndexerDefinitions,
    TQueryDefinitions,
    TMaterializationHistory
  >,
): DatabaseLedger<TEvents, TQueries, TSignals> {
  const clock = input.timing.clock;
  const storage = input.storage;
  const runtimeCarrier = input.model as typeof input.model & {
    readonly [registeredLedgerRuntimeBrand]?: typeof input.model;
  };
  const registeredRuntime =
    runtimeCarrier[registeredLedgerRuntimeBrand] ?? input.model;
  const model = registeredRuntime.model;
  const implementations = readLedgerImplementations<
    TIndexers,
    TQueries,
    TEvents
  >(input.model, {
    statementCompiler: input.projectionCompiler,
  });
  const registration = registeredRuntime.register;
  const rootModule = input.model as unknown as RuntimeMaterializationModule & {
    readonly [composedLedgerModulesBrand]?: readonly RuntimeMaterializationModule[];
  };
  const modules = rootModule[composedLedgerModulesBrand] ?? [rootModule];
  const moduleIds = modules.map((module) => module.moduleId);

  let closed = false;
  let activeWorker: WorkerRuntimeState | null = null;
  const eventChanges = new ChangeSignal();
  type SignalObserver = SignalObserverFunction<TSignals, keyof TSignals>;
  const signalObserversByName = new Map<string, Set<SignalObserver>>();

  type TransactionScope = {
    readonly query: <const TQueryName extends keyof TQueries>(
      queryName: TQueryName,
      params: Static<TQueries[TQueryName]["params"]>,
    ) => Promise<Static<TQueries[TQueryName]["result"]>>;
    readonly index: <const TIndexName extends keyof TIndexers>(
      indexName: TIndexName,
      input: Static<TIndexers[TIndexName]>,
      context: LedgerIndexerContext<TEvents>,
    ) => Promise<void>;
  };

  type WorkerFailure = {
    readonly reason: unknown;
  };

  /**
   * Per-worker-handle runtime state.
   *
   * A ledger may have at most one active worker handle. The handle owns this
   * runtime state until closed, then the ledger may start workers again.
   */
  type WorkerRuntimeState = {
    /**
     * Scheduler instance bound to this worker handle. All dispatch wakeups,
     * lease expiry timers, and lease heartbeats for this handle use this
     * scheduler.
     */
    readonly scheduler: LedgerWorkerOptions["scheduler"];
    /**
     * Lease duration for newly claimed work by this handle.
     */
    readonly leaseMs: number;
    /**
     * Fallback retry delay used when a handler requests retry without an
     * explicit `retryAtMs`.
     */
    readonly defaultRetryDelayMs: number;
    /**
     * How long terminal retained work remains queryable before worker-driven
     * pruning deletes it from the durable work table.
     */
    readonly terminalWorkRetentionMs: number;
    /**
     * Fallback cadence for re-checking durable work when no local append woke
     * this worker. SQLite gives us cross-connection visibility, not
     * cross-connection notifications.
     */
    readonly storePollMs: number;
    /**
     * Maximum number of concurrently executing handlers for this handle.
     */
    readonly maxInFlight: number;
    /**
     * Currently executing handler promises claimed by this handle.
     */
    readonly inFlight: Set<Promise<void>>;
    /**
     * Abort controllers keyed by lease id for claims currently owned by this
     * handle. Shutdown and lease-expiry paths abort through these controllers.
     */
    readonly leaseAbortControllers: Map<string, AbortController>;
    /**
     * One-shot timers keyed by lease id that abort work when a lease expires.
     */
    readonly leaseExpiryTasks: Map<string, { cancel(): void }>;
    /**
     * Repeating timers keyed by lease id that periodically renew active leases.
     */
    readonly leaseHeartbeatTasks: Map<string, { cancel(): void }>;
    /**
     * Wakes state consumers after worker execution or durable work changes.
     * Callers still read authoritative runtime and storage state after waking.
     */
    readonly stateChanges: ChangeSignal;
    /**
     * Interrupts idle-wait operations when this worker closes or fails. Storage
     * operations remain safely observed because their drivers may not support
     * physical cancellation.
     */
    readonly lifecycleAbortController: AbortController;
    /**
     * Set once this worker handle has begun shutdown. Dispatching and new
     * scheduling bail out when true.
     */
    closed: boolean;
    /**
     * True while a dispatch loop invocation is actively running.
     */
    dispatchLoopActive: boolean;
    /**
     * Latch set when dispatch is requested during an active loop; consumed in
     * loop-finally to trigger one follow-up pass.
     */
    dispatchLoopQueued: boolean;
    /**
     * Promise for the currently running dispatch loop, or null when idle.
     * Shutdown awaits this to stop new claims before aborting in-flight leases.
     */
    dispatchLoopSettled: Promise<void> | null;
    /**
     * First background failure observed for this worker. The wrapper preserves
     * arbitrary JavaScript rejection reasons, including null and undefined.
     */
    failure: WorkerFailure | null;
    /**
     * Next scheduled dispatch wakeup for this handle, if any.
     */
    scheduledDispatch: { dueAtMs: number; cancel(): void } | null;
  };

  const defaultTerminalWorkRetentionMs = 7 * 24 * 60 * 60 * 1_000;
  const defaultStorePollMs = 1_000;

  let committedEventId = 0;
  let activeWriteTransactions = 0;

  const startup = (async () => {
    // The SQLite drivers fail fast when concurrent handles overlap startup DDL.
    // Serialize only the one-time initialization path; normal ledger reads and
    // writes remain concurrent after each handle has started.
    await serializeDatabaseInitialization(
      storage[storageRuntimeIdentityBrand],
      async () => {
        await storage.write(async (database) => {
          await ensureStorageLayout(database, moduleIds);
        });
        await storage.write(async (database) => {
          await database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        causation_event_id INTEGER,
        dedupe_key TEXT UNIQUE,
        signal INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS work (
        work_id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_ref TEXT,
        queue_name TEXT NOT NULL,
        work_key TEXT,
        partition_key TEXT,
        payload_json TEXT NOT NULL,
        source_event_id INTEGER NOT NULL,
        signal INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at_ms INTEGER NOT NULL,
        dead INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT,
        lease_acquired_at_ms INTEGER,
        lease_expires_at_ms INTEGER,
        last_error TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at_ms INTEGER,
        cancel_reason TEXT,
        terminal_at_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_work_due
        ON work(dead, lease_id, available_at_ms, work_id);
    `);
        });

        await ensureColumn("events", "signal", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("work", "signal", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("work", "work_ref", "TEXT");
        await ensureColumn("work", "work_key", "TEXT");
        await ensureColumn("work", "partition_key", "TEXT");
        await ensureColumn("work", "cancelled", "INTEGER NOT NULL DEFAULT 0");
        await ensureColumn("work", "cancel_requested_at_ms", "INTEGER");
        await ensureColumn("work", "cancel_reason", "TEXT");
        await ensureColumn("work", "terminal_at_ms", "INTEGER");
        await storage.write(async (database) => {
          await database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_key
          ON work(source_event_id, signal, queue_name, work_key)
          WHERE work_key IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_ref
          ON work(work_ref)
          WHERE work_ref IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_work_partition_order
          ON work(signal, queue_name, partition_key, work_id)
          WHERE partition_key IS NOT NULL
            AND dead = 0
            AND cancelled = 0;
      `);
        });
        for (const module of modules) {
          const moduleRuntime = module[registeredLedgerRuntimeBrand] ?? module;
          let context: MaterializationRuntimeContext;

          if (module[registeredLedgerContractsBrand] === undefined) {
            context = {
              compiler: input.projectionCompiler,
              events: moduleRuntime.model.events,
              projections: moduleRuntime.projections,
              signals: moduleRuntime.model.signals,
            };
          } else {
            const schemas = readLedgerProjectionSchemas(module);
            context = {
              compiler: readLedgerProjectionCompiler(
                module,
                input.projectionCompiler,
              ),
              events: schemas.events,
              projections: moduleRuntime.projections,
              signals: schemas.signals,
            };
          }

          await storage.write(async (database) => {
            await ensureMaterializationHygiene(
              database,
              moduleRuntime.materializationHistory,
              context,
            );
          });
        }
      },
    );
    committedEventId = await storage.read(async (database) => {
      return await readStoredLatestEventId(database);
    });
  })();

  function workStateFromRow(
    row: Static<typeof WorkSnapshotRowSchema>,
  ): WorkState {
    if (row.cancelled !== 0) {
      return "cancelled";
    }

    if (row.dead !== 0) {
      return "dead";
    }

    if (row.lease_id !== null) {
      return "leased";
    }

    if (row.available_at_ms > clock.nowMs()) {
      return "delayed";
    }

    return "pending";
  }

  function workSnapshotFromRow(row: StorageRow): WorkSnapshot {
    const decoded = decodeRow(row, WorkSnapshotRowSchema);
    const lease =
      decoded.lease_id === null ||
      decoded.lease_acquired_at_ms === null ||
      decoded.lease_expires_at_ms === null
        ? null
        : {
            leaseId: decoded.lease_id,
            acquiredAtMs: decoded.lease_acquired_at_ms,
            expiresAtMs: decoded.lease_expires_at_ms,
          };

    return {
      workId: decoded.work_id,
      ref: decoded.work_ref === null ? null : decodeWorkRef(decoded.work_ref),
      queueName: decoded.queue_name,
      sourceEventId: decoded.source_event_id,
      attempt: decoded.attempt,
      availableAtMs: decoded.available_at_ms,
      state: workStateFromRow(decoded),
      lease,
      cancellation:
        decoded.cancel_requested_at_ms === null
          ? null
          : {
              requestedAtMs: decoded.cancel_requested_at_ms,
              reason: decoded.cancel_reason,
            },
      lastError: decoded.last_error,
      signal: decoded.signal !== 0,
    };
  }

  async function readWorkSnapshot(
    database: StorageDatabase,
    workId: number,
  ): Promise<WorkSnapshot | null> {
    const row = await database
      .prepare(
        `SELECT
           work_id,
           work_ref,
           queue_name,
           source_event_id,
           signal,
           attempt,
           available_at_ms,
           dead,
           lease_id,
           lease_acquired_at_ms,
           lease_expires_at_ms,
           last_error,
           cancelled,
           cancel_requested_at_ms,
           cancel_reason
         FROM work
         WHERE work_id = ?`,
      )
      .get(workId);

    return row === undefined ? null : workSnapshotFromRow(row);
  }

  function validateWorkKey(workKey: string): void {
    if (workKey.length === 0) {
      throw new Error("workKey must be non-empty");
    }
  }

  function validatePartitionKey(partitionKey: string): void {
    decodeValue(PartitionKeySchema, partitionKey);
  }

  function createWorkRef(): WorkRef {
    return decodeWorkRef(`work:v1:${randomUUID()}`);
  }

  function decodeWorkRef(ref: unknown): WorkRef {
    return decodeValue(WorkRefSchema, ref) as WorkRef;
  }

  async function readWorkSnapshotByRef(
    database: StorageDatabase,
    ref: WorkRef,
  ): Promise<WorkSnapshot | null> {
    const row = await database
      .prepare(
        `SELECT
           work_id,
           work_ref,
           queue_name,
           source_event_id,
           signal,
           attempt,
           available_at_ms,
           dead,
           lease_id,
           lease_acquired_at_ms,
           lease_expires_at_ms,
           last_error,
           cancelled,
           cancel_requested_at_ms,
           cancel_reason
         FROM work
         WHERE work_ref = ?`,
      )
      .get(ref);

    return row === undefined ? null : workSnapshotFromRow(row);
  }

  async function pruneTerminalWork(retentionMs: number): Promise<void> {
    if (retentionMs < 0) {
      return;
    }

    await runInTransaction(async (database) => {
      await database
        .prepare(
          `DELETE FROM work
           WHERE terminal_at_ms IS NOT NULL
             AND terminal_at_ms <= ?`,
        )
        .run(clock.nowMs() - retentionMs);
    });
  }

  async function ensureStorageLayout(
    database: StorageDatabase,
    moduleIds: readonly string[],
  ): Promise<void> {
    await database.exec("BEGIN IMMEDIATE");

    try {
      const layoutTable = await database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'table'
             AND name = ?`,
        )
        .get(storageLayoutTableName);

      if (layoutTable === undefined) {
        const legacyTable = await database
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (?, ?, ?)
             LIMIT 1`,
          )
          .get("events", "work", materializationVersionTableName);

        if (legacyTable !== undefined) {
          throw new Error(
            "database uses the pre-composition Sledge storage layout; reset the database before opening it with composable ledger models",
          );
        }

        await database.exec(`
          CREATE TABLE ${storageLayoutTableName} (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            version INTEGER NOT NULL,
            module_ids_json TEXT NOT NULL
          );
        `);
        await database
          .prepare(
            `INSERT INTO ${storageLayoutTableName} (
               singleton,
               version,
               module_ids_json
             ) VALUES (1, ?, ?)`,
          )
          .run(storageLayoutVersion, JSON.stringify(moduleIds));
      } else {
        const row = await database
          .prepare(
            `SELECT version, module_ids_json
             FROM ${storageLayoutTableName}
             WHERE singleton = 1`,
          )
          .get();

        if (row === undefined) {
          throw new Error("Sledge storage layout marker is missing");
        }

        const decoded = Value.Decode(StorageLayoutRowSchema, row);

        if (decoded.version !== storageLayoutVersion) {
          throw new Error(
            `unsupported Sledge storage layout version ${decoded.version}`,
          );
        }

        const storedModuleIds = decodeValue(
          ComposedModuleIdsSchema,
          parseJson<unknown>(
            decoded.module_ids_json,
            "composed ledger root identity",
          ),
        );

        if (
          storedModuleIds.length !== moduleIds.length ||
          storedModuleIds.some(
            (moduleId, index) => moduleId !== moduleIds[index],
          )
        ) {
          throw new Error(
            `database belongs to composed ledger root ${JSON.stringify(storedModuleIds)}; received ${JSON.stringify(moduleIds)}`,
          );
        }
      }

      await database.exec("COMMIT");
    } catch (error: unknown) {
      await database.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async function ensureColumn(
    tableName: "events" | "work",
    columnName: string,
    definition: string,
  ): Promise<void> {
    let rows: readonly StorageRow[] = [];
    await storage.read(async (database) => {
      rows = await database.prepare(`PRAGMA table_info(${tableName})`).all();
    });

    const hasColumn = rows.some((row) => {
      return decodeRow(row, TableInfoRowSchema).name === columnName;
    });

    if (hasColumn) {
      return;
    }

    try {
      await storage.write(async (database) => {
        await database.exec(
          `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
        );
      });
    } catch (error: unknown) {
      if (isDuplicateColumnError(error)) {
        return;
      }

      throw error;
    }
  }

  async function createProjectionSchema(
    database: StorageDatabase,
    metadata: ProjectionSchemaMetadata,
    compiler: ProjectionStatementCompiler,
  ): Promise<void> {
    for (const table of Object.values(metadata.tables)) {
      const sql = compiler.compileCreateTable({
        metadata,
        table,
      });
      await database.exec(sql.text);
    }

    for (const table of Object.values(metadata.tables)) {
      for (const index of table.indexes) {
        const sql = compiler.compileCreateIndex({
          index,
          tableName: table.name,
        });
        await database.exec(sql.text);
      }
    }
  }

  async function ensureMaterializationHygiene<
    const THistory extends AnyMaterializationHistory | null,
  >(
    database: StorageDatabase,
    history: THistory,
    context: MaterializationRuntimeContext,
  ): Promise<void> {
    if (history === null) {
      await createProjectionSchema(
        database,
        context.projections.metadata,
        context.compiler,
      );
      return;
    }

    await database.exec(`
      CREATE TABLE IF NOT EXISTS ${materializationVersionTableName} (
        namespace TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);

    const observedVersion = await readMaterializationVersion(
      database,
      history.namespace,
    );

    if (observedVersion > history.currentVersion) {
      throw new Error(
        `materialization ${history.namespace} is at version ${observedVersion}, newer than model version ${history.currentVersion}`,
      );
    }

    if (observedVersion === history.currentVersion) {
      return;
    }

    await database.exec("BEGIN IMMEDIATE");

    try {
      const currentVersion = await readMaterializationVersion(
        database,
        history.namespace,
      );

      if (currentVersion > history.currentVersion) {
        throw new Error(
          `materialization ${history.namespace} is at version ${currentVersion}, newer than model version ${history.currentVersion}`,
        );
      }

      if (currentVersion === history.currentVersion) {
        await database.exec("COMMIT");
        return;
      }

      const replayState = createMaterializationReplayState(
        history,
        currentVersion,
      );

      for (const migration of history.migrations) {
        if (migration.version <= currentVersion) {
          continue;
        }

        await applyMaterializationMigration(
          database,
          history,
          migration,
          replayState,
          context,
        );
        await recordMaterializationVersion(
          database,
          history.namespace,
          migration.version,
        );
      }

      await database.exec("COMMIT");
    } catch (error: unknown) {
      await database.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async function readMaterializationVersion(
    database: StorageDatabase,
    namespace: string,
  ): Promise<number> {
    const row = await database
      .prepare(
        `SELECT version FROM ${materializationVersionTableName} WHERE namespace = ?`,
      )
      .get(namespace);

    if (row === undefined) {
      return 0;
    }

    const decoded = Value.Decode(MaterializationVersionRowSchema, row);

    if (!Number.isSafeInteger(decoded.version) || decoded.version < 0) {
      throw new Error(
        `materialization ${namespace} stored invalid version ${decoded.version}`,
      );
    }

    return decoded.version;
  }

  async function recordMaterializationVersion(
    database: StorageDatabase,
    namespace: string,
    version: number,
  ): Promise<void> {
    await database
      .prepare(
        `INSERT INTO ${materializationVersionTableName} (
          namespace,
          version,
          updated_at_ms
        ) VALUES (?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          version = excluded.version,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run(namespace, version, clock.nowMs());
  }

  async function applyMaterializationMigration<
    const THistory extends AnyMaterializationHistory,
  >(
    database: StorageDatabase,
    history: THistory,
    migration: THistory["migrations"][number],
    replayState: MaterializationReplayState,
    context: MaterializationRuntimeContext,
  ): Promise<void> {
    const relationsForCreatedTables =
      readMaterializationMigrationRelationsForCreatedTables(migration);

    for (const operation of migration.operations) {
      await applyMaterializationMigrationOperation(
        database,
        history,
        operation,
        replayState,
        relationsForCreatedTables,
        context,
      );
    }
  }

  async function applyMaterializationMigrationOperation<
    const THistory extends AnyMaterializationHistory,
  >(
    database: StorageDatabase,
    history: THistory,
    operation: THistory["migrations"][number]["operations"][number],
    replayState: MaterializationReplayState,
    relationsForCreatedTables: ReadonlyMap<
      string,
      Readonly<Record<string, ProjectionForeignKeyMetadata>>
    >,
    context: MaterializationRuntimeContext,
  ): Promise<void> {
    switch (operation.kind) {
      case "create_table":
        await createMaterializationTable(
          database,
          operation,
          relationsForCreatedTables.get(operation.tableName) ?? {},
          context.compiler,
        );
        await createMaterializationTableIndexes(
          database,
          operation,
          context.compiler,
        );

        replayState.tables.set(operation.tableName, operation.table);
        return;
      case "create_index":
        await createMaterializationIndex(
          database,
          operation,
          replayState,
          context.compiler,
        );

        addMaterializationReplayIndex(replayState, operation);
        return;
      case "add_column":
        await addMaterializationColumn(
          database,
          operation,
          replayState,
          context.compiler,
        );

        addMaterializationReplayColumn(replayState, operation);
        return;
      case "add_foreign_key":
        const sourceTableName = findMaterializationTableName(
          replayState,
          operation.foreignKey.fromTable,
        );
        const relations = relationsForCreatedTables.get(sourceTableName);

        if (relations?.[operation.name] === undefined) {
          throw new Error(
            `materialization ${history.namespace} migration cannot add foreign key ${operation.name} incrementally on SQLite`,
          );
        }

        replayState.relations.set(operation.name, operation.foreignKey);
        return;
      case "data":
        await runProjectionDatabaseScope({
          events: context.events,
          signals: context.signals,
          projections: createMaterializationReplaySchema(replayState),
          scope: database,
          statementCompiler: context.compiler,
          run: async (db) => {
            await operation.run({
              db,
            });
          },
        });
        return;
    }
  }

  function createMaterializationReplayState<
    const THistory extends AnyMaterializationHistory<TEvents>,
  >(history: THistory, version: number): MaterializationReplayState {
    const replayState: MaterializationReplayState = {
      relations: new Map(),
      tables: new Map(),
    };

    for (const migration of history.migrations) {
      if (migration.version > version) {
        break;
      }

      for (const operation of migration.operations) {
        applyMaterializationReplayOperation(replayState, operation);
      }
    }

    return replayState;
  }

  function applyMaterializationReplayOperation(
    replayState: MaterializationReplayState,
    operation: MaterializationMigrationOperation,
  ): void {
    switch (operation.kind) {
      case "create_table":
        replayState.tables.set(operation.tableName, operation.table);
        return;
      case "create_index":
        addMaterializationReplayIndex(replayState, operation);
        return;
      case "add_column":
        addMaterializationReplayColumn(replayState, operation);
        return;
      case "add_foreign_key":
        replayState.relations.set(operation.name, operation.foreignKey);
        return;
      case "data":
        return;
    }
  }

  function addMaterializationReplayColumn(
    replayState: MaterializationReplayState,
    operation: Extract<
      MaterializationMigrationOperation,
      { kind: "add_column" }
    >,
  ): void {
    const table = replayState.tables.get(operation.tableName);

    if (table === undefined) {
      throw new Error(
        `materialization replay cannot add column to unknown table ${operation.tableName}`,
      );
    }

    replayState.tables.set(operation.tableName, {
      ...table,
      columns: {
        ...table.columns,
        [operation.columnName]: operation.column,
      },
    });
  }

  function addMaterializationReplayIndex(
    replayState: MaterializationReplayState,
    operation: Extract<
      MaterializationMigrationOperation,
      { kind: "create_index" }
    >,
  ): void {
    const table = replayState.tables.get(operation.tableName);

    if (table === undefined) {
      throw new Error(
        `materialization replay cannot create index on unknown table ${operation.tableName}`,
      );
    }

    const keys = operation.index.unique
      ? [
          ...table.keys,
          {
            columns: operation.index.columns,
            kind: "unique" as const,
            name: operation.index.name,
          },
        ]
      : table.keys;

    replayState.tables.set(operation.tableName, {
      ...table,
      indexes: [...table.indexes, operation.index],
      keys,
    });
  }

  function createMaterializationReplaySchema(
    replayState: MaterializationReplayState,
  ): AnyProjectionSchema {
    return {
      metadata: {
        relations: Object.fromEntries(replayState.relations),
        tables: Object.fromEntries(replayState.tables),
      },
    };
  }

  function findMaterializationTableName(
    replayState: MaterializationReplayState,
    physicalName: string,
  ): string {
    for (const [localName, table] of replayState.tables) {
      if (table.name === physicalName) {
        return localName;
      }
    }

    throw new Error(
      `materialization replay cannot find physical table ${physicalName}`,
    );
  }

  function readMaterializationMigrationRelationsForCreatedTables(migration: {
    readonly operations: readonly MaterializationMigrationOperation[];
  }): ReadonlyMap<
    string,
    Readonly<Record<string, ProjectionForeignKeyMetadata>>
  > {
    const openCreatedTables = new Map<string, ProjectionTableMetadata>();
    const relationsByTable = new Map<
      string,
      Record<string, ProjectionForeignKeyMetadata>
    >();

    for (const operation of migration.operations) {
      if (operation.kind === "create_table") {
        openCreatedTables.set(operation.tableName, operation.table);
        continue;
      }

      if (operation.kind === "data") {
        openCreatedTables.clear();
        continue;
      }

      if (operation.kind === "add_foreign_key") {
        const sourceEntry = [...openCreatedTables].find(
          ([, table]) => table.name === operation.foreignKey.fromTable,
        );
        if (sourceEntry === undefined) {
          continue;
        }

        const [sourceTableName, createdTable] = sourceEntry;
        const sourceColumnsExistInCreateTable =
          operation.foreignKey.fromColumns.every((columnName) => {
            return createdTable.columns[columnName] !== undefined;
          });

        if (!sourceColumnsExistInCreateTable) {
          continue;
        }

        let relations = relationsByTable.get(sourceTableName);

        if (relations === undefined) {
          relations = {};
          relationsByTable.set(sourceTableName, relations);
        }

        relations[operation.name] = operation.foreignKey;
      }
    }

    return relationsByTable;
  }

  async function createMaterializationTable(
    database: StorageDatabase,
    operation: Extract<
      MaterializationMigrationOperation,
      { kind: "create_table" }
    >,
    relations: Readonly<Record<string, ProjectionForeignKeyMetadata>>,
    compiler: ProjectionStatementCompiler,
  ): Promise<void> {
    const sql = compiler.compileCreateTable({
      metadata: {
        relations,
        tables: {
          [operation.tableName]: operation.table,
        },
      },
      table: operation.table,
    });

    await database.exec(sql.text);
  }

  async function createMaterializationTableIndexes(
    database: StorageDatabase,
    operation: Extract<
      MaterializationMigrationOperation,
      { kind: "create_table" }
    >,
    compiler: ProjectionStatementCompiler,
  ): Promise<void> {
    for (const index of operation.table.indexes) {
      const sql = compiler.compileCreateIndex({
        index,
        tableName: operation.table.name,
      });
      await database.exec(sql.text);
    }
  }

  async function createMaterializationIndex(
    database: StorageDatabase,
    operation: Extract<
      MaterializationMigrationOperation,
      { kind: "create_index" }
    >,
    replayState: MaterializationReplayState,
    compiler: ProjectionStatementCompiler,
  ): Promise<void> {
    const table = replayState.tables.get(operation.tableName);

    if (table === undefined) {
      throw new Error(
        `materialization migration cannot create index on unknown table ${operation.tableName}`,
      );
    }

    const sql = compiler.compileCreateIndex({
      index: operation.index,
      tableName: table.name,
    });

    await database.exec(sql.text);
  }

  async function addMaterializationColumn(
    database: StorageDatabase,
    operation: Extract<
      MaterializationMigrationOperation,
      { kind: "add_column" }
    >,
    replayState: MaterializationReplayState,
    compiler: ProjectionStatementCompiler,
  ): Promise<void> {
    const table = replayState.tables.get(operation.tableName);

    if (table === undefined) {
      throw new Error(
        `materialization migration cannot add column to unknown table ${operation.tableName}`,
      );
    }

    const sql = compiler.compileAddColumn({
      column: operation.column,
      columnName: operation.columnName,
      tableName: table.name,
    });

    try {
      await database.exec(sql.text);
    } catch (error: unknown) {
      if (isDuplicateColumnError(error)) {
        return;
      }

      throw error;
    }
  }

  async function runInTransaction<T>(
    run: (database: StorageDatabase, tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    return await storage.write(async (database) => {
      let began = false;

      try {
        await database.exec("BEGIN IMMEDIATE");
        began = true;
        activeWriteTransactions += 1;

        const result = await run(database, createTransactionScope(database));
        await database.exec("COMMIT");
        activeWriteTransactions -= 1;
        began = false;

        return result;
      } catch (error: unknown) {
        if (began) {
          try {
            await database.exec("ROLLBACK");
          } catch {
            // Suppress rollback failures to preserve the root cause.
          } finally {
            activeWriteTransactions -= 1;
          }
        }

        throw error;
      }
    });
  }

  function decodeEventPayload<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    payload: unknown,
  ): Static<TEvents[TEventName]> {
    const schema = model.events[eventName];

    if (schema === undefined) {
      throw new Error(`unknown event name: ${String(eventName)}`);
    }

    return decodeValue(schema, payload);
  }

  function decodeSignalPayload<const TSignalName extends keyof TSignals>(
    signalName: TSignalName,
    payload: unknown,
  ): Static<TSignals[TSignalName]> {
    const schema = model.signals[signalName];

    if (schema === undefined) {
      throw new Error(`unknown signal name: ${String(signalName)}`);
    }

    return decodeValue(schema, payload);
  }

  async function runQueryImplementation<
    const TQueryName extends keyof TQueries,
  >(
    database: StorageDatabase,
    queryName: TQueryName,
    params: Static<TQueries[TQueryName]["params"]>,
  ): Promise<Static<TQueries[TQueryName]["result"]>> {
    const schema = model.queries[queryName];

    if (schema === undefined) {
      throw new Error(`unknown query: ${String(queryName)}`);
    }

    const implementation = implementations.queries?.[queryName];

    if (implementation === undefined) {
      throw new Error(`missing query implementation: ${String(queryName)}`);
    }

    const decodedParams = decodeValue(schema.params, params);

    const rawResult = await implementation(database, decodedParams as never);
    const decodedResult = decodeValue(schema.result, rawResult);

    return decodedResult as never;
  }

  async function runLedgerQuery<const TQueryName extends keyof TQueries>(
    queryName: TQueryName,
    params: Static<TQueries[TQueryName]["params"]>,
  ): Promise<Static<TQueries[TQueryName]["result"]>> {
    return await storage.read(async (database) => {
      return await runQueryImplementation(database, queryName, params);
    });
  }

  async function runIndexerImplementation<
    const TIndexName extends keyof TIndexers,
  >(
    database: StorageDatabase,
    indexName: TIndexName,
    indexInput: Static<TIndexers[TIndexName]>,
    context: LedgerIndexerContext<TEvents>,
  ) {
    const schema = model.indexers[indexName];

    if (schema === undefined) {
      throw new Error(`unknown indexer: ${String(indexName)}`);
    }

    const implementation = implementations.indexers?.[indexName];

    if (implementation === undefined) {
      throw new Error(`missing indexer implementation: ${String(indexName)}`);
    }

    const decodedInput = decodeValue(schema, indexInput);

    await implementation(database, decodedInput as never, context);
  }

  function createTransactionScope(database: StorageDatabase): TransactionScope {
    return {
      query: async (queryName, params) => {
        return await runQueryImplementation(database, queryName, params);
      },
      index: async (indexName, input, context) => {
        await runIndexerImplementation(database, indexName, input, context);
      },
    };
  }

  async function appendEventInTransaction(
    database: StorageDatabase,
    tx: TransactionScope,
    eventInput: AppendEventInput,
  ): Promise<{
    envelope: EventEnvelope<TEvents, keyof TEvents>;
    created: boolean;
  }> {
    const eventName = eventInput.eventName as keyof TEvents;
    const decodedPayload = decodeEventPayload(eventName, eventInput.payload);

    const payloadJson = JSON.stringify(decodedPayload);

    let created = false;
    let eventId = 0;
    let envelope: EventEnvelope<TEvents, keyof TEvents> | null = null;

    if (eventInput.dedupeKey === undefined) {
      const eventInsert = await database
        .prepare(
          `INSERT INTO events (ts_ms, event_name, payload_json, causation_event_id, dedupe_key, signal)
           VALUES (?, ?, ?, ?, NULL, 0)`,
        )
        .run(
          eventInput.nowMs,
          eventInput.eventName,
          payloadJson,
          eventInput.causationEventId,
        );

      created = true;
      eventId = Number(eventInsert.lastInsertRowid);
    } else {
      const eventInsert = await database
        .prepare(
          `INSERT INTO events (ts_ms, event_name, payload_json, causation_event_id, dedupe_key, signal)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(dedupe_key) DO NOTHING`,
        )
        .run(
          eventInput.nowMs,
          eventInput.eventName,
          payloadJson,
          eventInput.causationEventId,
          eventInput.dedupeKey,
        );

      if (eventInsert.changes > 0) {
        created = true;
        eventId = Number(eventInsert.lastInsertRowid);
      } else {
        const existing = await database
          .prepare(
            `SELECT event_id, ts_ms, event_name, payload_json, causation_event_id, dedupe_key
             FROM events
             WHERE dedupe_key = ?
               AND signal = 0`,
          )
          .get(eventInput.dedupeKey);

        if (existing === undefined) {
          throw new Error(
            `dedupe conflict resolved without durable winner for key ${eventInput.dedupeKey}`,
          );
        }

        const existingRow = decodeRow(existing, EventEnvelopeRowSchema);

        if (existingRow.event_name !== eventInput.eventName) {
          throw new Error(
            `dedupe key ${eventInput.dedupeKey} already belongs to another event contract`,
          );
        }

        envelope = readEventEnvelopeFromRow(existing, {
          events: model.events,
        });
        eventId = envelope.eventId;
      }
    }

    envelope ??= {
      eventId,
      ref: createEventRef(
        String(eventName) as Extract<keyof TEvents, string>,
        eventId,
      ),
      tsMs: eventInput.nowMs,
      eventName,
      payload: decodedPayload,
      causationEventId: eventInput.causationEventId,
      dedupeKey: eventInput.dedupeKey ?? null,
    };

    if (!created) {
      return {
        envelope,
        created: false,
      };
    }

    const eventHandler = registration.events?.[eventName];
    const queued: {
      queueName: string;
      workKey: string | null;
      partitionKey: string | null;
      payload: unknown;
      availableAtMs: number;
    }[] = [];

    if (eventHandler !== undefined) {
      let actionScopeOpen = true;
      const pendingActions = new Set<Promise<unknown>>();

      const assertActionScopeOpen = () => {
        if (!actionScopeOpen) {
          throw new Error("event actions are only valid during event handling");
        }
      };

      const trackAction = <T>(run: () => Promise<T>): Promise<T> => {
        assertActionScopeOpen();

        let tracked: Promise<T>;
        tracked = run().finally(() => {
          pendingActions.delete(tracked);
        });
        pendingActions.add(tracked);

        return tracked;
      };

      const closeActionScope = async (): Promise<void> => {
        actionScopeOpen = false;

        if (pendingActions.size === 0) {
          return;
        }

        const pending = [...pendingActions];
        await Promise.allSettled(pending);

        throw new Error(
          "event actions must be awaited before the handler returns",
        );
      };

      let handlerFailed = false;
      let handlerError: unknown;

      try {
        await eventHandler({
          event: envelope,
          actions: {
            index: (indexName, indexInput) => {
              return trackAction(async () => {
                await tx.index(
                  String(indexName) as keyof TIndexers,
                  indexInput as Static<TIndexers[keyof TIndexers]>,
                  {
                    event: envelope,
                  },
                );
              });
            },
            enqueue: (queueName, payload, options) => {
              assertActionScopeOpen();
              const queueSchema = model.queues[queueName as keyof TQueues];

              if (queueSchema === undefined) {
                throw new Error(`unknown queue: ${String(queueName)}`);
              }

              const decodedQueuePayload = decodeValue(queueSchema, payload);

              if (options?.workKey !== undefined) {
                validateWorkKey(options.workKey);
              }

              if (options?.partitionKey !== undefined) {
                validatePartitionKey(options.partitionKey);
              }

              queued.push({
                queueName: String(queueName),
                workKey: options?.workKey ?? null,
                partitionKey: options?.partitionKey ?? null,
                payload: decodedQueuePayload,
                availableAtMs: options?.availableAtMs ?? eventInput.nowMs,
              });
            },
            query: (queryName, params) => {
              return trackAction(async () => {
                return await tx.query(queryName, params);
              });
            },
          },
        });
      } catch (error: unknown) {
        handlerFailed = true;
        handlerError = error;
      }

      const actionScopeError = await closeActionScope().then(
        () => null,
        (error: unknown) => error,
      );

      if (handlerFailed) {
        throw handlerError;
      }

      if (actionScopeError !== null) {
        throw actionScopeError;
      }
    }

    for (const work of queued) {
      await database
        .prepare(
          `INSERT INTO work (
              work_ref,
              queue_name,
              work_key,
              partition_key,
              payload_json,
              source_event_id,
              signal,
              attempt,
              available_at_ms,
              dead,
              lease_id,
              lease_acquired_at_ms,
              lease_expires_at_ms,
              last_error
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, NULL, NULL, NULL, NULL)`,
        )
        .run(
          work.workKey === null ? null : createWorkRef(),
          work.queueName,
          work.workKey,
          work.partitionKey,
          JSON.stringify(work.payload),
          eventId,
          work.availableAtMs,
        );
    }

    return {
      envelope,
      created,
    };
  }

  async function appendSignalInTransaction(
    database: StorageDatabase,
    signalInput: AppendSignalInput,
  ): Promise<{
    eventId: number;
    created: boolean;
    event: EventEnvelope<TSignals, keyof TSignals> | null;
  }> {
    const signalName = signalInput.signalName as keyof TSignals;
    const decodedPayload = decodeSignalPayload(signalName, signalInput.payload);
    const payloadJson = JSON.stringify(decodedPayload);

    let created = false;
    let eventId = 0;

    if (signalInput.dedupeKey === undefined) {
      const eventInsert = await database
        .prepare(
          `INSERT INTO events (ts_ms, event_name, payload_json, causation_event_id, dedupe_key, signal)
           VALUES (?, ?, ?, ?, NULL, 1)`,
        )
        .run(
          signalInput.nowMs,
          signalInput.signalName,
          payloadJson,
          signalInput.causationEventId,
        );

      created = true;
      eventId = Number(eventInsert.lastInsertRowid);
    } else {
      const eventInsert = await database
        .prepare(
          `INSERT INTO events (ts_ms, event_name, payload_json, causation_event_id, dedupe_key, signal)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(dedupe_key) DO NOTHING`,
        )
        .run(
          signalInput.nowMs,
          signalInput.signalName,
          payloadJson,
          signalInput.causationEventId,
          signalInput.dedupeKey,
        );

      if (eventInsert.changes > 0) {
        created = true;
        eventId = Number(eventInsert.lastInsertRowid);
      } else {
        const existing = await database
          .prepare(`SELECT event_id FROM events WHERE dedupe_key = ?`)
          .get(signalInput.dedupeKey);

        if (existing === undefined) {
          throw new Error(
            `dedupe conflict resolved without existing winner for key ${signalInput.dedupeKey}`,
          );
        }

        eventId = decodeRow(existing, EventIdRowSchema).event_id;
      }
    }

    if (!created) {
      return {
        eventId,
        created: false,
        event: null,
      };
    }

    const envelope: EventEnvelope<TSignals, keyof TSignals> = {
      eventId,
      ref: createEventRef(
        String(signalName) as Extract<keyof TSignals, string>,
        eventId,
      ),
      tsMs: signalInput.nowMs,
      eventName: signalName,
      payload: decodedPayload,
      causationEventId: signalInput.causationEventId,
      dedupeKey: signalInput.dedupeKey ?? null,
    };

    const signalHandler = registration.signals?.[signalName];
    const queued: {
      queueName: string;
      workKey: string | null;
      partitionKey: string | null;
      payload: unknown;
      availableAtMs: number;
    }[] = [];

    if (signalHandler !== undefined) {
      await signalHandler({
        event: envelope,
        actions: {
          enqueueSignal: (queueName, payload, options) => {
            const queueSchema =
              model.signalQueues[queueName as keyof TSignalQueues];

            if (queueSchema === undefined) {
              throw new Error(`unknown signal queue: ${String(queueName)}`);
            }

            const decodedQueuePayload = decodeValue(queueSchema, payload);

            if (options?.workKey !== undefined) {
              validateWorkKey(options.workKey);
            }

            if (options?.partitionKey !== undefined) {
              validatePartitionKey(options.partitionKey);
            }

            queued.push({
              queueName: String(queueName),
              workKey: options?.workKey ?? null,
              partitionKey: options?.partitionKey ?? null,
              payload: decodedQueuePayload,
              availableAtMs: options?.availableAtMs ?? signalInput.nowMs,
            });
          },
        },
      });
    }

    for (const work of queued) {
      await database
        .prepare(
          `INSERT INTO work (
              work_ref,
              queue_name,
              work_key,
              partition_key,
              payload_json,
              source_event_id,
              signal,
              attempt,
              available_at_ms,
              dead,
              lease_id,
              lease_acquired_at_ms,
              lease_expires_at_ms,
              last_error
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, 0, NULL, NULL, NULL, NULL)`,
        )
        .run(
          work.workKey === null ? null : createWorkRef(),
          work.queueName,
          work.workKey,
          work.partitionKey,
          JSON.stringify(work.payload),
          eventId,
          work.availableAtMs,
        );
    }

    if (queued.length === 0) {
      await database
        .prepare(`DELETE FROM events WHERE event_id = ? AND signal = 1`)
        .run(eventId);
    }

    return {
      eventId,
      created,
      event: envelope,
    };
  }

  async function releaseExpiredLeases(): Promise<void> {
    await runInTransaction(async (database) => {
      await database
        .prepare(
          `UPDATE work
           SET
             lease_id = NULL,
             lease_acquired_at_ms = NULL,
             lease_expires_at_ms = NULL,
             available_at_ms = ?
           WHERE dead = 0
             AND lease_id IS NOT NULL
             AND lease_expires_at_ms IS NOT NULL
             AND lease_expires_at_ms < ?`,
        )
        .run(clock.nowMs(), clock.nowMs());
    });
  }

  function scheduleDispatchAt(
    worker: WorkerRuntimeState,
    targetAtMs: number,
  ): void {
    if (closed || worker.closed || worker.failure !== null) {
      return;
    }

    if (
      worker.scheduledDispatch !== null &&
      worker.scheduledDispatch.dueAtMs <= targetAtMs
    ) {
      return;
    }

    worker.scheduledDispatch?.cancel();

    const delayMs = Math.max(0, targetAtMs - clock.nowMs());
    const task = worker.scheduler.scheduleOnce(delayMs, () => {
      worker.scheduledDispatch = null;
      requestDispatchRun(worker);
    });

    worker.scheduledDispatch = {
      dueAtMs: clock.nowMs() + delayMs,
      cancel: () => task.cancel(),
    };
  }

  async function scheduleNextDispatchFromStore(
    worker: WorkerRuntimeState,
  ): Promise<void> {
    const row = await storage.read(async (database) => {
      return await database
        .prepare(
          `SELECT candidate.available_at_ms
           FROM work AS candidate
           WHERE candidate.dead = 0
             AND candidate.cancelled = 0
             AND candidate.lease_id IS NULL
             AND (
               candidate.partition_key IS NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM work AS predecessor
                 WHERE predecessor.dead = 0
                   AND predecessor.cancelled = 0
                   AND predecessor.signal = candidate.signal
                   AND predecessor.queue_name = candidate.queue_name
                   AND predecessor.partition_key = candidate.partition_key
                   AND predecessor.work_id < candidate.work_id
               )
             )
           ORDER BY candidate.available_at_ms ASC
           LIMIT 1`,
        )
        .get();
    });

    const pollAtMs = clock.nowMs() + worker.storePollMs;
    const nextWorkAtMs =
      row === undefined
        ? pollAtMs
        : decodeRow(row, AvailableAtRowSchema).available_at_ms;

    scheduleDispatchAt(worker, Math.min(nextWorkAtMs, pollAtMs));
  }

  function assertWorkerWaitActive(
    worker: WorkerRuntimeState,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();

    if (closed) {
      throw new Error("ledger closed while waiting for workers to become idle");
    }

    if (worker.closed) {
      throw new Error("ledger workers closed while waiting to become idle");
    }

    if (worker.failure !== null) {
      throw worker.failure.reason;
    }
  }

  async function hasNonterminalWork(): Promise<boolean> {
    const row = await storage.read(async (database) => {
      return await database
        .prepare(
          `SELECT work_id
           FROM work
           WHERE dead = 0
             AND cancelled = 0
           LIMIT 1`,
        )
        .get();
    });

    return row !== undefined;
  }

  async function waitForWorkerIdle(
    worker: WorkerRuntimeState,
    signal: AbortSignal,
  ): Promise<void> {
    const waitSignal = AbortSignal.any([
      signal,
      worker.lifecycleAbortController.signal,
    ]);

    while (true) {
      assertWorkerWaitActive(worker, signal);

      const observedState = worker.stateChanges.snapshot();
      const durableWorkResult = await raceWithSignal(
        hasNonterminalWork(),
        waitSignal,
      );

      if (durableWorkResult.status === "aborted") {
        assertWorkerWaitActive(worker, signal);
        throw waitSignal.reason;
      }

      assertWorkerWaitActive(worker, signal);

      const runtimeIsActive =
        worker.dispatchLoopActive ||
        worker.dispatchLoopQueued ||
        worker.inFlight.size > 0;

      if (
        !durableWorkResult.value &&
        !runtimeIsActive &&
        worker.stateChanges.snapshot() === observedState
      ) {
        return;
      }

      await worker.stateChanges.waitForChange(observedState, waitSignal);
    }
  }

  function notifySignalObservers(
    events: readonly EventEnvelope<TSignals, keyof TSignals>[],
  ): void {
    for (const event of events) {
      const observers = signalObserversByName.get(String(event.eventName));

      if (observers === undefined) {
        continue;
      }

      for (const observer of [...observers.values()]) {
        queueMicrotask(() => {
          if (!observers.has(observer)) {
            return;
          }

          try {
            void Promise.resolve(observer(event)).catch(() => undefined);
          } catch {
            // Signal observation is live and best-effort.
          }
        });
      }
    }
  }

  async function readEventsAfter(
    afterEventId: number,
    limit: number,
  ): Promise<readonly EventEnvelope<TEvents, keyof TEvents>[]> {
    return await storage.read(async (database) => {
      const highWaterMark = await readCommittedEventId(database);
      const rows = await database
        .prepare(
          `SELECT
             event_id,
             ts_ms,
             event_name,
             payload_json,
             causation_event_id,
             dedupe_key
           FROM events
           WHERE signal = 0
             AND event_id > ?
             AND event_id <= ?
           ORDER BY event_id ASC
           LIMIT ?`,
        )
        .all(afterEventId, highWaterMark, limit);

      return rows.map((row) => {
        return readEventEnvelopeFromRow(row, model);
      });
    });
  }

  async function readLastEvents(limit: number): Promise<{
    readonly events: readonly EventEnvelope<TEvents, keyof TEvents>[];
    readonly highWaterMark: number;
  }> {
    return await storage.read(async (database) => {
      const highWaterMark = await readCommittedEventId(database);
      const rows = await database
        .prepare(
          `SELECT
             event_id,
             ts_ms,
             event_name,
             payload_json,
             causation_event_id,
             dedupe_key
           FROM events
           WHERE signal = 0
             AND event_id <= ?
           ORDER BY event_id DESC
           LIMIT ?`,
        )
        .all(highWaterMark, limit);

      const envelopes = rows.map((row) => {
        return readEventEnvelopeFromRow(row, model);
      });

      return {
        events: envelopes.reverse(),
        highWaterMark,
      };
    });
  }

  async function readStoredLatestEventId(
    database: StorageDatabase,
  ): Promise<number> {
    const row = await database
      .prepare(
        `SELECT event_id
         FROM events
         WHERE signal = 0
         ORDER BY event_id DESC
         LIMIT 1`,
      )
      .get();

    if (row === undefined) {
      return 0;
    }

    return decodeRow(row, EventIdRowSchema).event_id;
  }

  async function readCommittedEventId(
    database: StorageDatabase,
  ): Promise<number> {
    if (activeWriteTransactions > 0) {
      return committedEventId;
    }

    const storedLatestEventId = await readStoredLatestEventId(database);
    committedEventId = Math.max(committedEventId, storedLatestEventId);
    return committedEventId;
  }

  function readLatestEventId(): number {
    return committedEventId;
  }

  function createManagedStreamIterator(input: {
    createIterator(
      signal: AbortSignal,
    ): AsyncIterator<DatabaseLedgerStreamEvent<TEvents>>;
    externalSignal: AbortSignal;
    closeReason: string;
  }): AsyncIterableIterator<DatabaseLedgerStreamEvent<TEvents>> {
    const localController = new AbortController();
    const streamSignal = AbortSignal.any([
      input.externalSignal,
      localController.signal,
    ]);

    const iterator = input.createIterator(streamSignal);

    return {
      next: async () => {
        return await iterator.next();
      },
      return: async () => {
        if (!localController.signal.aborted) {
          localController.abort(new Error(input.closeReason));
        }

        if (iterator.return === undefined) {
          return {
            done: true,
            value: undefined,
          };
        }

        return await iterator.return();
      },
      throw: async (error: unknown) => {
        if (!localController.signal.aborted) {
          localController.abort(
            error instanceof Error ? error : new Error(input.closeReason),
          );
        }

        if (iterator.throw === undefined) {
          throw error;
        }

        return await iterator.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  async function* streamEventsFromAfterEventId(input: {
    readonly afterEventId: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<DatabaseLedgerStreamEvent<TEvents>> {
    const startupResult = await raceWithSignal(startup, input.signal);

    if (startupResult.status === "aborted") {
      return;
    }

    let currentAfterEventId = input.afterEventId;
    const readLimit = 256;

    while (!closed) {
      if (input.signal.aborted) {
        return;
      }

      const observedEvents = eventChanges.snapshot();
      const readResult = await raceWithSignal(
        readEventsAfter(currentAfterEventId, readLimit),
        input.signal,
      );

      if (readResult.status === "aborted") {
        return;
      }

      const events = readResult.value;

      if (events.length > 0) {
        for (const event of events) {
          if (input.signal.aborted || closed) {
            return;
          }

          currentAfterEventId = event.eventId;

          yield {
            event,
            cursor: encodeCursor(event.eventId),
          };
        }

        continue;
      }

      await eventChanges.waitForChange(observedEvents, input.signal);
    }
  }

  async function claimNextDueWork(
    worker: WorkerRuntimeState,
  ): Promise<PersistedWorkLease | null> {
    return await runInTransaction(async (database) => {
      const nowMs = clock.nowMs();

      const candidate = await database
        .prepare(
          `SELECT candidate.work_id
           FROM work AS candidate
           WHERE candidate.dead = 0
             AND candidate.cancelled = 0
             AND candidate.lease_id IS NULL
             AND candidate.available_at_ms <= ?
             AND (
               candidate.partition_key IS NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM work AS predecessor
                 WHERE predecessor.dead = 0
                   AND predecessor.cancelled = 0
                   AND predecessor.signal = candidate.signal
                   AND predecessor.queue_name = candidate.queue_name
                   AND predecessor.partition_key = candidate.partition_key
                   AND predecessor.work_id < candidate.work_id
               )
             )
           ORDER BY candidate.work_id ASC
           LIMIT 1`,
        )
        .get(nowMs);

      if (candidate === undefined) {
        return null;
      }

      const candidateWorkId = decodeRow(candidate, WorkIdRowSchema).work_id;
      const leaseId = randomUUID();
      const leaseExpiresAtMs = nowMs + worker.leaseMs;

      const updateResult = await database
        .prepare(
          `UPDATE work
           SET
             attempt = attempt + 1,
             lease_id = ?,
             lease_acquired_at_ms = ?,
             lease_expires_at_ms = ?
           WHERE work_id = ?
             AND dead = 0
             AND cancelled = 0
             AND lease_id IS NULL`,
        )
        .run(leaseId, nowMs, leaseExpiresAtMs, candidateWorkId);

      if (updateResult.changes <= 0) {
        return null;
      }

      const claimed = await database
        .prepare(
          `SELECT
            work_id,
            queue_name,
            work_key,
            payload_json,
            source_event_id,
            signal,
            attempt,
            lease_id,
            lease_acquired_at_ms,
            lease_expires_at_ms
           FROM work
           WHERE work_id = ?`,
        )
        .get(candidateWorkId);

      if (claimed === undefined) {
        return null;
      }

      const decodedClaimed = decodeRow(claimed, ClaimedWorkRowSchema);

      if (decodedClaimed.lease_id !== leaseId) {
        return null;
      }

      if (
        decodedClaimed.lease_acquired_at_ms === null ||
        decodedClaimed.lease_expires_at_ms === null
      ) {
        return null;
      }

      return {
        workId: decodedClaimed.work_id,
        queueName: decodedClaimed.queue_name,
        workKey: decodedClaimed.work_key,
        payloadJson: decodedClaimed.payload_json,
        sourceEventId: decodedClaimed.source_event_id,
        signal: decodedClaimed.signal === 1,
        attempt: decodedClaimed.attempt,
        leaseId,
        leaseAcquiredAtMs: decodedClaimed.lease_acquired_at_ms,
        leaseExpiresAtMs: decodedClaimed.lease_expires_at_ms,
      };
    });
  }

  async function releaseClaimedLease(
    claimed: PersistedWorkLease,
  ): Promise<void> {
    await runInTransaction(async (database) => {
      await database
        .prepare(
          `UPDATE work
           SET
             lease_id = NULL,
             lease_acquired_at_ms = NULL,
             lease_expires_at_ms = NULL,
             available_at_ms = ?
           WHERE work_id = ?
             AND lease_id = ?
             AND dead = 0`,
        )
        .run(clock.nowMs(), claimed.workId, claimed.leaseId);
    });
  }

  function failWorker(worker: WorkerRuntimeState, reason: unknown): void {
    if (worker.failure !== null) {
      return;
    }

    worker.failure = {
      reason,
    };
    worker.scheduledDispatch?.cancel();
    worker.scheduledDispatch = null;
    worker.lifecycleAbortController.abort(reason);
    worker.stateChanges.notify();
  }

  function requestDispatchRun(worker: WorkerRuntimeState): void {
    if (closed || worker.closed || worker.failure !== null) {
      return;
    }

    if (worker.dispatchLoopActive) {
      if (!worker.dispatchLoopQueued) {
        worker.dispatchLoopQueued = true;
        worker.stateChanges.notify();
      }

      return;
    }

    worker.dispatchLoopActive = true;
    worker.stateChanges.notify();

    const dispatchLoopSettled = runDispatchLoop(worker)
      .catch((error: unknown) => {
        failWorker(worker, error);

        throw error;
      })
      .finally(() => {
        worker.dispatchLoopActive = false;
        worker.dispatchLoopSettled = null;
        worker.stateChanges.notify();

        if (
          worker.dispatchLoopQueued &&
          !closed &&
          !worker.closed &&
          worker.failure === null
        ) {
          worker.dispatchLoopQueued = false;
          requestDispatchRun(worker);
        }
      });
    worker.dispatchLoopSettled = dispatchLoopSettled;

    void dispatchLoopSettled.catch(() => undefined);
  }

  async function runDispatchLoop(worker: WorkerRuntimeState): Promise<void> {
    await startup;

    if (closed || worker.closed || worker.failure !== null) {
      return;
    }

    while (
      !closed &&
      !worker.closed &&
      worker.failure === null &&
      worker.inFlight.size < worker.maxInFlight
    ) {
      const claimed = await claimNextDueWork(worker);

      if (claimed === null) {
        await scheduleNextDispatchFromStore(worker);
        return;
      }

      if (closed || worker.closed || worker.failure !== null) {
        await releaseClaimedLease(claimed);
        return;
      }

      let handedOffToHandler = false;

      try {
        const handler = claimed.signal
          ? registration.signalQueues?.[
              claimed.queueName as keyof TSignalQueues
            ]
          : registration.queues?.[claimed.queueName as keyof TQueues];

        if (handler === undefined) {
          await runInTransaction(async (database) => {
            await database
              .prepare(
                `UPDATE work
                 SET
                   dead = 1,
                   lease_id = NULL,
                   lease_acquired_at_ms = NULL,
                   lease_expires_at_ms = NULL,
                   partition_key = NULL,
                   last_error = ?,
                   terminal_at_ms = ?
                 WHERE work_id = ?
                   AND lease_id = ?`,
              )
              .run(
                `no handler for ${claimed.signal ? "signal " : ""}queue ${claimed.queueName}`,
                clock.nowMs(),
                claimed.workId,
                claimed.leaseId,
              );
          });
          worker.stateChanges.notify();

          continue;
        }

        const run = processClaimedWork(worker, claimed, handler)
          .catch((error: unknown) => {
            failWorker(worker, error);
          })
          .finally(() => {
            worker.inFlight.delete(run);
            worker.stateChanges.notify();
            requestDispatchRun(worker);
          });
        handedOffToHandler = true;

        worker.inFlight.add(run);
        worker.stateChanges.notify();
      } catch (error: unknown) {
        if (!handedOffToHandler) {
          try {
            await releaseClaimedLease(claimed);
          } catch {
            // Preserve the root dispatch failure for shutdown reporting.
          }
        }

        throw error;
      }
    }
  }

  async function processClaimedWork(
    worker: WorkerRuntimeState,
    claimed: PersistedWorkLease,
    handler:
      | QueueHandlerFunction<any, any, any, any, any>
      | QueueOperationHandler<any, any, any, any, any>
      | SignalQueueHandlerFunction<any, any, any>,
  ): Promise<void> {
    const leaseAbortController = new AbortController();
    worker.leaseAbortControllers.set(claimed.leaseId, leaseAbortController);

    let currentLeaseExpiresAtMs = claimed.leaseExpiresAtMs;
    let leaseSettled = false;

    const clearLeaseHeartbeat = (): void => {
      worker.leaseHeartbeatTasks.get(claimed.leaseId)?.cancel();
      worker.leaseHeartbeatTasks.delete(claimed.leaseId);
    };

    const releaseLeaseInStore = async (): Promise<void> => {
      await runInTransaction(async (database) => {
        await database
          .prepare(
            `UPDATE work
             SET
               lease_id = NULL,
               lease_acquired_at_ms = NULL,
               lease_expires_at_ms = NULL,
               available_at_ms = ?
             WHERE work_id = ?
               AND lease_id = ?
               AND dead = 0`,
          )
          .run(clock.nowMs(), claimed.workId, claimed.leaseId);
      });
    };

    const abortLease = (reason: string): void => {
      if (!leaseAbortController.signal.aborted) {
        leaseAbortController.abort(new Error(reason));
      }
    };

    const scheduleLeaseExpiry = (): void => {
      worker.leaseExpiryTasks.get(claimed.leaseId)?.cancel();

      const delayMs = Math.max(0, currentLeaseExpiresAtMs - clock.nowMs());
      const expiryTask = worker.scheduler.scheduleOnce(delayMs, () => {
        abortLease("lease expired");
        clearLeaseHeartbeat();

        void releaseLeaseInStore().then(
          () => {
            scheduleDispatchAt(worker, clock.nowMs());
          },
          () => undefined,
        );
      });

      worker.leaseExpiryTasks.set(claimed.leaseId, {
        cancel: () => expiryTask.cancel(),
      });
    };

    const renewLease = async (): Promise<void> => {
      const nowMs = clock.nowMs();
      const renewedLeaseExpiresAtMs = nowMs + worker.leaseMs;

      const renewal = await runInTransaction(async (database) => {
        return await database
          .prepare(
            `UPDATE work
             SET
               lease_expires_at_ms = ?
             WHERE work_id = ?
               AND lease_id = ?
               AND dead = 0
               AND cancelled = 0`,
          )
          .run(renewedLeaseExpiresAtMs, claimed.workId, claimed.leaseId);
      });

      if (renewal.changes <= 0) {
        throw new Error("lease renewal lost ownership");
      }

      currentLeaseExpiresAtMs = renewedLeaseExpiresAtMs;
      scheduleLeaseExpiry();
    };

    const startLeaseHeartbeat = (): void => {
      if (worker.leaseHeartbeatTasks.has(claimed.leaseId)) {
        return;
      }

      const heartbeatEveryMs = Math.max(1, Math.floor(worker.leaseMs / 3));
      const heartbeatTask = worker.scheduler.scheduleRepeating(
        heartbeatEveryMs,
        () => {
          if (leaseAbortController.signal.aborted) {
            clearLeaseHeartbeat();
            return;
          }

          void renewLease().catch(() => {
            clearLeaseHeartbeat();
            abortLease("lease renewal failed");
          });
        },
      );

      worker.leaseHeartbeatTasks.set(claimed.leaseId, {
        cancel: () => heartbeatTask.cancel(),
      });
    };

    scheduleLeaseExpiry();
    startLeaseHeartbeat();

    try {
      const queueSchema = claimed.signal
        ? model.signalQueues[claimed.queueName as keyof TSignalQueues]
        : model.queues[claimed.queueName as keyof TQueues];

      if (queueSchema === undefined) {
        throw new Error(`unknown queue schema for ${claimed.queueName}`);
      }

      const decodedPayload = decodeValue(
        queueSchema,
        parseJson(claimed.payloadJson, "work.payload_json"),
      );

      const work: QueueWorkItem<any, any> = {
        workId: claimed.workId,
        queueName: claimed.queueName,
        payload: decodedPayload,
        attempt: claimed.attempt,
        sourceEventId: claimed.sourceEventId,
      };

      const lease: WorkLease<any, any> = {
        workId: claimed.workId,
        queueName: claimed.queueName,
        sourceEventId: claimed.sourceEventId,
        attempt: claimed.attempt,
        leaseId: claimed.leaseId,
        leaseAcquiredAtMs: claimed.leaseAcquiredAtMs,
        get leaseExpiresAtMs() {
          return currentLeaseExpiresAtMs;
        },
        signal: leaseAbortController.signal,
      };

      let preparedExecution: PreparedQueueExecution = {
        kind: "handler",
      };

      if (!claimed.signal && typeof handler !== "function") {
        let preparation: QueueOperationPreparation | null = null;

        try {
          preparation = await prepareQueueOperationSettlement({
            handler,
            leaseSignal: lease.signal,
            scheduler: worker.scheduler,
            work,
          });
        } catch (error: unknown) {
          preparedExecution = {
            kind: "failed",
            error,
          };
        }

        if (preparation?.status === "lease_lost") {
          leaseSettled = true;
          return;
        }

        if (preparation?.status === "settle") {
          preparedExecution = {
            kind: "settlement",
            settlement: preparation.settlement,
          };
        }
      }

      const stagedEvents: AppendEventInput[] = [];

      const actions: QueueActions<any, any, any> = {
        emit: (eventName, event, options) => {
          stagedEvents.push({
            eventName: String(eventName),
            payload: event,
            nowMs: clock.nowMs(),
            dedupeKey: options?.dedupeKey,
            causationEventId: claimed.sourceEventId,
          });
        },
        emitSignal: async (signalName, signal, options) => {
          type ImmediateSignalEmission = {
            readonly created: boolean;
            readonly event: EventEnvelope<TSignals, keyof TSignals> | null;
          };

          const appended = await runInTransaction(
            async (database): Promise<ImmediateSignalEmission> => {
              const active = await database
                .prepare(
                  `SELECT work_id
                   FROM work
                   WHERE work_id = ?
                     AND lease_id = ?
                     AND dead = 0`,
                )
                .get(claimed.workId, claimed.leaseId);

              if (active === undefined) {
                return {
                  created: false,
                  event: null,
                };
              }

              const result = await appendSignalInTransaction(database, {
                signalName: String(signalName),
                payload: signal,
                nowMs: clock.nowMs(),
                dedupeKey: options?.dedupeKey,
                causationEventId: claimed.sourceEventId,
              });

              return {
                created: result.created,
                event: result.event,
              };
            },
          );

          if (appended.event !== null) {
            notifySignalObservers([appended.event]);
            worker.stateChanges.notify();
            scheduleDispatchAt(worker, clock.nowMs());
          }
        },
        query: async (queryName, params) => {
          return await runLedgerQuery(
            queryName as keyof TQueries,
            params as never,
          );
        },
      };

      const signalActions: SignalQueueActions<any> = {
        query: actions.query,
      };

      const queueControl: QueueHandlerControl = {
        retry: (error, options) => {
          throw new RetryRequested(error, options?.retryAtMs);
        },
        deadLetter: (error) => {
          throw new DeadLetterRequested(error);
        },
      };

      const signalQueueControl: SignalQueueHandlerControl = {
        retry: (error, options) => {
          throw new RetryRequested(error, options?.retryAtMs);
        },
      };

      let disposition: HandlerDisposition = {
        kind: "ack",
      };

      try {
        if (claimed.signal) {
          await (handler as SignalQueueHandlerFunction<any, any, any>)({
            work,
            lease,
            actions: signalActions,
            control: signalQueueControl,
          });
        } else {
          switch (preparedExecution.kind) {
            case "handler":
              if (typeof handler !== "function") {
                throw new Error("queue operation did not produce a settlement");
              }

              await (handler as QueueHandlerFunction<any, any, any, any, any>)({
                work,
                lease,
                actions,
                control: queueControl,
              });
              break;
            case "settlement":
              await preparedExecution.settlement({
                actions,
                control: queueControl,
              });
              break;
            case "failed":
              throw preparedExecution.error;
          }
        }
      } catch (error: unknown) {
        if (error instanceof RetryRequested) {
          disposition = {
            kind: "retry",
            error: error.error,
            retryAtMs: error.retryAtMs,
          };
        } else if (error instanceof DeadLetterRequested) {
          disposition = {
            kind: "dead_letter",
            error: error.error,
          };
        } else {
          disposition = {
            kind: "retry",
            error: describeUnknownError(error),
          };
        }
      }

      if (claimed.signal && disposition.kind === "dead_letter") {
        disposition = {
          kind: "retry",
          error: "signal queue handlers cannot dead-letter",
        };
      }

      const emitted = await runInTransaction(async (database, tx) => {
        const active = await database
          .prepare(
            `SELECT work_id
             FROM work
             WHERE work_id = ?
               AND lease_id = ?
               AND dead = 0`,
          )
          .get(claimed.workId, claimed.leaseId);

        if (active === undefined) {
          return {
            durableEvents: 0,
            latestDurableEventId: committedEventId,
          };
        }

        let createdDurableCount = 0;
        let latestDurableEventId = committedEventId;

        for (const stagedEvent of stagedEvents) {
          const appended = await appendEventInTransaction(
            database,
            tx,
            stagedEvent,
          );

          if (appended.created) {
            createdDurableCount += 1;
            latestDurableEventId = Math.max(
              latestDurableEventId,
              appended.envelope.eventId,
            );
          }
        }

        switch (disposition.kind) {
          case "ack":
            await database
              .prepare(
                `DELETE FROM work
                 WHERE work_id = ?
                   AND lease_id = ?
                   AND dead = 0`,
              )
              .run(claimed.workId, claimed.leaseId);

            if (claimed.signal) {
              const remainingSignalWork = await database
                .prepare(
                  `SELECT work_id
                   FROM work
                   WHERE source_event_id = ?
                     AND signal = 1
                   LIMIT 1`,
                )
                .get(claimed.sourceEventId);

              if (remainingSignalWork === undefined) {
                await database
                  .prepare(
                    `DELETE FROM events WHERE event_id = ? AND signal = 1`,
                  )
                  .run(claimed.sourceEventId);
              }
            }
            break;

          case "retry":
            await database
              .prepare(
                `UPDATE work
                 SET
                   available_at_ms = ?,
                   lease_id = NULL,
                   lease_acquired_at_ms = NULL,
                   lease_expires_at_ms = NULL,
                   last_error = ?
                 WHERE work_id = ?
                   AND lease_id = ?
                   AND dead = 0`,
              )
              .run(
                disposition.retryAtMs ??
                  clock.nowMs() + worker.defaultRetryDelayMs,
                disposition.error,
                claimed.workId,
                claimed.leaseId,
              );
            break;

          case "dead_letter":
            await database
              .prepare(
                `UPDATE work
                 SET
                   dead = 1,
                   lease_id = NULL,
                   lease_acquired_at_ms = NULL,
                   lease_expires_at_ms = NULL,
                   partition_key = NULL,
                   last_error = ?,
                   terminal_at_ms = ?
                 WHERE work_id = ?
                   AND lease_id = ?
                   AND dead = 0`,
              )
              .run(
                disposition.error,
                clock.nowMs(),
                claimed.workId,
                claimed.leaseId,
              );
            break;
        }

        return {
          durableEvents: createdDurableCount,
          latestDurableEventId,
        };
      });
      leaseSettled = true;

      if (emitted.durableEvents > 0) {
        committedEventId = Math.max(
          committedEventId,
          emitted.latestDurableEventId,
        );
        eventChanges.notify();
      }

      worker.stateChanges.notify();
      scheduleDispatchAt(worker, clock.nowMs());
    } finally {
      clearLeaseHeartbeat();
      worker.leaseExpiryTasks.get(claimed.leaseId)?.cancel();
      worker.leaseExpiryTasks.delete(claimed.leaseId);

      // A failed infrastructure operation leaves ownership registered so
      // worker shutdown can release the durable lease before reporting the
      // supervised failure.
      if (leaseSettled) {
        worker.leaseAbortControllers.delete(claimed.leaseId);
      }
    }
  }

  async function closeWorker(
    worker: WorkerRuntimeState,
    reason: string,
  ): Promise<void> {
    if (worker.closed) {
      return;
    }

    worker.closed = true;
    worker.lifecycleAbortController.abort(new Error(reason));
    worker.stateChanges.notify();

    if (activeWorker === worker) {
      activeWorker = null;
    }

    worker.scheduledDispatch?.cancel();
    worker.scheduledDispatch = null;

    // Wait until claiming has quiesced so we can snapshot+abort the final set
    // of leases this worker owns.
    let observedFailure = worker.failure;

    try {
      await worker.dispatchLoopSettled;
    } catch (error: unknown) {
      if (observedFailure === null) {
        observedFailure = {
          reason: error,
        };
      }
    }

    const leaseIds = [...worker.leaseAbortControllers.keys()];

    for (const controller of worker.leaseAbortControllers.values()) {
      controller.abort(new Error(reason));
    }
    await Promise.allSettled(worker.inFlight);

    for (const expiryTask of worker.leaseExpiryTasks.values()) {
      expiryTask.cancel();
    }

    worker.leaseExpiryTasks.clear();

    for (const heartbeatTask of worker.leaseHeartbeatTasks.values()) {
      heartbeatTask.cancel();
    }

    worker.leaseHeartbeatTasks.clear();
    worker.leaseAbortControllers.clear();

    if (leaseIds.length > 0) {
      const leaseIdPlaceholders = leaseIds.map(() => "?").join(", ");

      await runInTransaction(async (database) => {
        await database
          .prepare(
            `UPDATE work
             SET
               lease_id = NULL,
               lease_acquired_at_ms = NULL,
               lease_expires_at_ms = NULL,
               available_at_ms = ?
             WHERE dead = 0
               AND lease_id IN (${leaseIdPlaceholders})`,
          )
          .run(clock.nowMs(), ...leaseIds);
      });
    }

    const failure = worker.failure ?? observedFailure;

    if (failure !== null) {
      throw failure.reason;
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }

    closed = true;
    eventChanges.notify();

    const workerToClose = activeWorker;
    const closeResults =
      workerToClose === null
        ? []
        : await Promise.allSettled([
            closeWorker(workerToClose, "ledger closed"),
          ]);

    signalObserversByName.clear();

    const storageFailures: unknown[] = [];

    try {
      await startup;
    } catch (error: unknown) {
      storageFailures.push(error);
    }

    try {
      await storage.close();
    } catch (error: unknown) {
      storageFailures.push(error);
    }

    const failures = closeResults.flatMap((result) => {
      if (result.status === "fulfilled") {
        return [];
      }

      return [result.reason];
    });

    const allFailures = [...failures, ...storageFailures];

    if (allFailures.length > 0) {
      const message =
        storageFailures.length === 0
          ? "failed to close ledger workers"
          : "failed to close ledger";

      throw new AggregateError(allFailures, message);
    }
  }

  const ledger: DatabaseLedger<TEvents, TQueries, TSignals> = {
    emit: async (eventName, event, options) => {
      await startup;

      const result = await runInTransaction(
        async (database, tx) =>
          await appendEventInTransaction(database, tx, {
            eventName: String(eventName),
            payload: event,
            nowMs: clock.nowMs(),
            dedupeKey: options?.dedupeKey,
            causationEventId: null,
          }),
      );

      if (result.created) {
        committedEventId = Math.max(committedEventId, result.envelope.eventId);
        eventChanges.notify();
        if (activeWorker !== null) {
          activeWorker.stateChanges.notify();
          scheduleDispatchAt(activeWorker, clock.nowMs());
        }
      }

      return result.envelope as EventEnvelope<TEvents, typeof eventName>;
    },
    query: async (queryName, params) => {
      await startup;
      return await runLedgerQuery(queryName, params);
    },
    cancelWork: async (input: CancelWorkInput): Promise<CancelWorkResult> => {
      await startup;
      const ref = decodeWorkRef(input.ref);

      const nowMs = clock.nowMs();
      let cancelledLeaseId: string | null = null;
      const work = await runInTransaction(async (database) => {
        const existing = await readWorkSnapshotByRef(database, ref);

        if (existing === null) {
          return null;
        }

        if (existing.state === "dead") {
          return existing;
        }

        if (existing.state === "cancelled") {
          cancelledLeaseId = existing.lease?.leaseId ?? null;
          return existing;
        }

        cancelledLeaseId = existing.lease?.leaseId ?? null;

        await database
          .prepare(
            `UPDATE work
             SET
               cancelled = 1,
               cancel_requested_at_ms = ?,
               cancel_reason = ?,
               terminal_at_ms = ?,
               lease_id = NULL,
               lease_acquired_at_ms = NULL,
               lease_expires_at_ms = NULL,
               partition_key = NULL,
               last_error = ?
             WHERE work_ref = ?
               AND dead = 0
               AND cancelled = 0`,
          )
          .run(
            nowMs,
            input.reason ?? null,
            nowMs,
            input.reason ?? "work cancelled",
            ref,
          );

        return await readWorkSnapshotByRef(database, ref);
      });

      if (work === null) {
        return {
          status: "not_found",
          ref,
        };
      }

      if (work.state === "dead") {
        return {
          status: "already_terminal",
          ref,
          work,
        };
      }

      const worker = activeWorker;

      if (worker !== null) {
        worker.stateChanges.notify();
        scheduleDispatchAt(worker, nowMs);
      }

      if (worker !== null && cancelledLeaseId !== null) {
        worker.leaseAbortControllers
          .get(cancelledLeaseId)
          ?.abort(new Error(input.reason ?? "work cancelled"));
      }

      return {
        status: "cancelled",
        work,
      };
    },
    queryWork: async (input) => {
      await startup;

      if (!Number.isInteger(input.workId) || input.workId <= 0) {
        throw new Error(
          `workId must be a positive integer, received ${input.workId}`,
        );
      }

      return await storage.read(
        async (database) => await readWorkSnapshot(database, input.workId),
      );
    },
    listWork: async (input = {}) => {
      await startup;

      const limit = input.limit ?? 100;

      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`limit must be a positive integer, received ${limit}`);
      }

      const clauses: string[] = [];
      const params: unknown[] = [];

      if (input.queueName !== undefined) {
        clauses.push("queue_name = ?");
        params.push(input.queueName);
      }

      if (input.sourceEventId !== undefined) {
        clauses.push("source_event_id = ?");
        params.push(input.sourceEventId);
      }

      if (input.states !== undefined) {
        if (input.states.length === 0) {
          return [];
        }

        const nowMs = clock.nowMs();
        const stateClauses: string[] = [];

        for (const state of input.states) {
          switch (state) {
            case "cancelled":
              stateClauses.push("cancelled != 0");
              break;
            case "dead":
              stateClauses.push("dead != 0 AND cancelled = 0");
              break;
            case "leased":
              stateClauses.push(
                "dead = 0 AND cancelled = 0 AND lease_id IS NOT NULL",
              );
              break;
            case "delayed":
              stateClauses.push(
                "dead = 0 AND cancelled = 0 AND lease_id IS NULL AND available_at_ms > ?",
              );
              params.push(nowMs);
              break;
            case "pending":
              stateClauses.push(
                "dead = 0 AND cancelled = 0 AND lease_id IS NULL AND available_at_ms <= ?",
              );
              params.push(nowMs);
              break;
          }
        }

        clauses.push(
          `(${stateClauses.map((clause) => `(${clause})`).join(" OR ")})`,
        );
      }

      const where =
        clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      const rows = await storage.read(
        async (database) =>
          await database
            .prepare(
              `SELECT
                 work_id,
                 work_ref,
                 queue_name,
                 source_event_id,
                 signal,
                 attempt,
                 available_at_ms,
                 dead,
                 lease_id,
                 lease_acquired_at_ms,
                 lease_expires_at_ms,
                 last_error,
                 cancelled,
                 cancel_requested_at_ms,
                 cancel_reason
               FROM work
               ${where}
               ORDER BY work_id ASC
               LIMIT ?`,
            )
            .all(...params, limit),
      );

      return rows.map(workSnapshotFromRow);
    },
    onSignal: (signalName, observer) => {
      const signalSchema = model.signals[signalName as keyof TSignals];

      if (signalSchema === undefined) {
        throw new Error(`unknown signal name: ${String(signalName)}`);
      }

      const key = String(signalName);
      const storedObserver = observer as SignalObserver;
      const observers = signalObserversByName.get(key) ?? new Set();

      observers.add(storedObserver);
      signalObserversByName.set(key, observers);

      let disposed = false;

      return {
        [Symbol.dispose]: () => {
          if (disposed) {
            return;
          }

          disposed = true;
          observers.delete(storedObserver);

          if (observers.size === 0) {
            signalObserversByName.delete(key);
          }
        },
      };
    },
    tailEvents: ({ last, signal }) => {
      if (!Number.isInteger(last) || last < 0) {
        throw new Error(
          `last must be a non-negative integer, received ${last}`,
        );
      }

      const createIterator = (streamSignal: AbortSignal) => {
        const iterate = async function* (): AsyncIterable<
          DatabaseLedgerStreamEvent<TEvents>
        > {
          const startupResult = await raceWithSignal(startup, streamSignal);

          if (startupResult.status === "aborted" || closed) {
            return;
          }

          // Capture a follow boundary before reading backlog so we never skip
          // events appended during tail startup when `last` resolves to no rows.
          const historyResult = await raceWithSignal(
            readLastEvents(last),
            streamSignal,
          );

          if (historyResult.status === "aborted" || closed) {
            return;
          }

          const history = historyResult.value;
          let afterEventId = Math.max(
            readLatestEventId(),
            history.highWaterMark,
          );

          for (const event of history.events) {
            if (streamSignal.aborted || closed) {
              return;
            }

            afterEventId = Math.max(afterEventId, event.eventId);

            yield {
              event,
              cursor: encodeCursor(event.eventId),
            };
          }

          yield* streamEventsFromAfterEventId({
            afterEventId,
            signal: streamSignal,
          });
        };

        return iterate()[Symbol.asyncIterator]();
      };

      return {
        [Symbol.asyncIterator](): AsyncIterator<
          DatabaseLedgerStreamEvent<TEvents>
        > {
          return createManagedStreamIterator({
            createIterator,
            externalSignal: signal,
            closeReason: "tail iterator closed",
          });
        },
      };
    },
    resumeEvents: ({ cursor, signal }) => {
      const afterEventId = decodeCursor(cursor);

      return {
        [Symbol.asyncIterator](): AsyncIterator<
          DatabaseLedgerStreamEvent<TEvents>
        > {
          return createManagedStreamIterator({
            createIterator: (streamSignal) => {
              return streamEventsFromAfterEventId({
                afterEventId,
                signal: streamSignal,
              })[Symbol.asyncIterator]();
            },
            externalSignal: signal,
            closeReason: "resume iterator closed",
          });
        },
      };
    },
    startWorkers: async (options): Promise<LedgerWorkers> => {
      await startup;

      if (closed) {
        throw new Error("cannot start workers after ledger is closed");
      }

      if (activeWorker !== null) {
        throw new Error("ledger workers are already running");
      }

      const leaseMs = options.leaseMs ?? 1_000;
      const defaultRetryDelayMs = options.defaultRetryDelayMs ?? 1_000;
      const maxInFlight = options.maxInFlight ?? 16;
      const terminalWorkRetentionMs =
        options.terminalWorkRetentionMs ?? defaultTerminalWorkRetentionMs;

      if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
        throw new Error(
          `leaseMs must be a positive integer, received ${leaseMs}`,
        );
      }

      if (!Number.isInteger(defaultRetryDelayMs) || defaultRetryDelayMs <= 0) {
        throw new Error(
          `defaultRetryDelayMs must be a positive integer, received ${defaultRetryDelayMs}`,
        );
      }

      if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
        throw new Error(
          `maxInFlight must be a positive integer, received ${maxInFlight}`,
        );
      }

      if (
        !Number.isInteger(terminalWorkRetentionMs) ||
        terminalWorkRetentionMs < 0
      ) {
        throw new Error(
          `terminalWorkRetentionMs must be a non-negative integer, received ${terminalWorkRetentionMs}`,
        );
      }

      const worker: WorkerRuntimeState = {
        scheduler: options.scheduler,
        leaseMs,
        defaultRetryDelayMs,
        terminalWorkRetentionMs,
        storePollMs: defaultStorePollMs,
        maxInFlight,
        inFlight: new Set(),
        leaseAbortControllers: new Map(),
        leaseExpiryTasks: new Map(),
        leaseHeartbeatTasks: new Map(),
        stateChanges: new ChangeSignal(),
        lifecycleAbortController: new AbortController(),
        closed: false,
        dispatchLoopActive: false,
        dispatchLoopQueued: false,
        dispatchLoopSettled: null,
        failure: null,
        scheduledDispatch: null,
      };

      activeWorker = worker;

      try {
        await releaseExpiredLeases();
        await pruneTerminalWork(worker.terminalWorkRetentionMs);
        await scheduleNextDispatchFromStore(worker);
      } catch (error: unknown) {
        await closeWorker(worker, "ledger workers startup failed");
        throw error;
      }

      let disposed = false;
      const closeHandle = async (): Promise<void> => {
        if (disposed) {
          return;
        }

        disposed = true;
        await closeWorker(worker, "ledger workers closed");
      };

      return {
        waitForIdle: async ({ signal }) => {
          await waitForWorkerIdle(worker, signal);
        },
        close: closeHandle,
        [Symbol.asyncDispose]: closeHandle,
      };
    },
    close,
    [Symbol.asyncDispose]: close,
  };

  return ledger;
}
