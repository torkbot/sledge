import { randomUUID } from "node:crypto";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Sqids from "sqids";
import type {
  BoundLedgerModel,
  EventEnvelope,
  Ledger,
  LedgerBuilder,
  LedgerCursor,
  LedgerStreamEvent,
  LedgerTiming,
  MaterializerFunction,
  ProjectorFunction,
  QuerySchema,
  QueueActions,
  QueueHandlerFunction,
  QueueHandlerOutcome,
  QueueWorkItem,
  WorkLease,
  LeaseHold,
} from "./ledger.ts";

type AnyIndexerDef = TSchema;
type AnyQueryDef = QuerySchema<TSchema, TSchema>;

type PersistedWorkLease = {
  readonly workId: number;
  readonly queueName: string;
  readonly payloadJson: string;
  readonly sourceEventId: number;
  readonly attempt: number;
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

type StorageRow = Record<string, unknown>;

export interface StorageStatement {
  run(...params: unknown[]): Promise<{
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }>;

  get(...params: unknown[]): Promise<StorageRow | undefined>;

  all(...params: unknown[]): Promise<readonly StorageRow[]>;
}

export interface StorageDatabase {
  exec(sql: string): Promise<void>;

  prepare(sql: string): StorageStatement;

  close(): Promise<void>;
}

type OpenDatabaseLedgerEngineInput<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
> = {
  readonly boundModel: BoundLedgerModel<TEvents, TQueues, TIndexers, TQueries>;
  readonly timing: LedgerTiming;
  readonly database: StorageDatabase;
  readonly leaseMs?: number;
  readonly defaultRetryDelayMs?: number;
  readonly maxInFlight?: number;
  readonly maxBusyRetries?: number;
  readonly maxBusyRetryDelayMs?: number;
};

export type CreateDatabaseLedgerInput<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
> = {
  readonly database: StorageDatabase;
  readonly boundModel: BoundLedgerModel<TEvents, TQueues, TIndexers, TQueries>;
  readonly timing: LedgerTiming;
  readonly leaseMs?: number;
  readonly defaultRetryDelayMs?: number;
  readonly maxInFlight?: number;
  readonly maxBusyRetries?: number;
  readonly maxBusyRetryDelayMs?: number;
};

export function createDatabaseLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef>,
  const TQueries extends Record<string, AnyQueryDef>,
>(
  input: CreateDatabaseLedgerInput<TEvents, TQueues, TIndexers, TQueries>,
): Ledger<TEvents, TQueries> {
  return openDatabaseLedgerEngine({
    boundModel: input.boundModel,
    timing: input.timing,
    database: input.database,
    leaseMs: input.leaseMs,
    defaultRetryDelayMs: input.defaultRetryDelayMs,
    maxInFlight: input.maxInFlight,
    maxBusyRetries: input.maxBusyRetries,
    maxBusyRetryDelayMs: input.maxBusyRetryDelayMs,
  });
}

class RuntimeBuilder<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
> implements LedgerBuilder<TEvents, TQueues, TIndexers, TQueries> {
  readonly projectorsByEvent = new Map<
    string,
    ProjectorFunction<any, any, any>[]
  >();
  readonly materializersByEvent = new Map<
    string,
    MaterializerFunction<any, any, any>[]
  >();
  readonly handlersByQueue = new Map<
    string,
    QueueHandlerFunction<any, any, any, any>
  >();

  project<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    projector: ProjectorFunction<TEvents, TEventName, TIndexers>,
  ): this {
    const key = String(eventName);
    const existing = this.projectorsByEvent.get(key) ?? [];
    existing.push(projector as ProjectorFunction<any, any, any>);
    this.projectorsByEvent.set(key, existing);

    return this;
  }

  materialize<const TEventName extends keyof TEvents>(
    eventName: TEventName,
    materializer: MaterializerFunction<TEvents, TEventName, TQueues>,
  ): this {
    const key = String(eventName);
    const existing = this.materializersByEvent.get(key) ?? [];
    existing.push(materializer as MaterializerFunction<any, any, any>);
    this.materializersByEvent.set(key, existing);

    return this;
  }

  handle<const TQueueName extends keyof TQueues>(
    queueName: TQueueName,
    handler: QueueHandlerFunction<TEvents, TQueues, TQueueName, TQueries>,
  ): this {
    const key = String(queueName);

    if (this.handlersByQueue.has(key)) {
      throw new Error(`duplicate queue handler registration: ${key}`);
    }

    this.handlersByQueue.set(
      key,
      handler as QueueHandlerFunction<any, any, any, any>,
    );

    return this;
  }
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

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeCode = (error as { readonly code?: unknown }).code;

  if (maybeCode === "SQLITE_BUSY") {
    return true;
  }

  return error.message.includes("SQLITE_BUSY");
}

function computeBusyRetryDelayMs(attempt: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, 2 ** attempt);
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const cursorSqids = new Sqids({
  minLength: 6,
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

const AvailableAtRowSchema = Type.Object({
  available_at_ms: Type.Number(),
});

const WorkIdRowSchema = Type.Object({
  work_id: Type.Number(),
});

const ClaimedWorkRowSchema = Type.Object({
  work_id: Type.Number(),
  queue_name: Type.String(),
  payload_json: Type.String(),
  source_event_id: Type.Number(),
  attempt: Type.Number(),
  lease_id: Type.Union([Type.Null(), Type.String()]),
  lease_acquired_at_ms: Type.Union([Type.Null(), Type.Number()]),
  lease_expires_at_ms: Type.Union([Type.Null(), Type.Number()]),
});

function decodeRow<const TSchemaDef extends TSchema>(
  row: StorageRow,
  schema: TSchemaDef,
): Static<TSchemaDef> {
  return Value.Decode(schema, row);
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

  const payload = Value.Decode(
    eventSchema,
    parseJson(decodedRow.payload_json, "events.payload_json"),
  );

  return {
    eventId: decodedRow.event_id,
    tsMs: decodedRow.ts_ms,
    eventName,
    payload,
    causationEventId: decodedRow.causation_event_id,
    dedupeKey: decodedRow.dedupe_key,
  };
}

function openDatabaseLedgerEngine<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef>,
  const TQueries extends Record<string, AnyQueryDef>,
>(
  input: OpenDatabaseLedgerEngineInput<TEvents, TQueues, TIndexers, TQueries>,
): Ledger<TEvents, TQueries> {
  const builder = new RuntimeBuilder<TEvents, TQueues, TIndexers, TQueries>();

  const clock = input.timing.clock;
  const scheduler = input.timing.scheduler;
  const database = input.database;
  const model = input.boundModel.model;
  const implementations = input.boundModel.implementations;
  const register = input.boundModel.register;

  register(builder);
  const leaseMs = input.leaseMs ?? 1_000;
  const defaultRetryDelayMs = input.defaultRetryDelayMs ?? 1_000;
  const maxInFlight = input.maxInFlight ?? 16;
  const maxBusyRetries = input.maxBusyRetries ?? 8;
  const maxBusyRetryDelayMs = input.maxBusyRetryDelayMs ?? 50;

  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
    throw new Error(
      `maxInFlight must be a positive integer, received ${maxInFlight}`,
    );
  }

  if (!Number.isInteger(maxBusyRetries) || maxBusyRetries < 0) {
    throw new Error(
      `maxBusyRetries must be a non-negative integer, received ${maxBusyRetries}`,
    );
  }

  if (!Number.isInteger(maxBusyRetryDelayMs) || maxBusyRetryDelayMs <= 0) {
    throw new Error(
      `maxBusyRetryDelayMs must be a positive integer, received ${maxBusyRetryDelayMs}`,
    );
  }

  let closed = false;
  let dispatchLoopActive = false;
  let dispatchLoopQueued = false;
  let scheduledDispatch: { dueAtMs: number; cancel(): void } | null = null;
  const inFlight = new Set<Promise<void>>();
  const leaseAbortControllers = new Map<string, AbortController>();
  const leaseExpiryTasks = new Map<string, { cancel(): void }>();
  const leaseHeartbeatTasks = new Map<string, { cancel(): void }>();
  const eventWaiters = new Set<() => void>();
  let appendSequence = 0;

  let mutationTail: Promise<void> = Promise.resolve();

  const startup = (async () => {
    await withBusyRetry(async () => {
      await database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        causation_event_id INTEGER,
        dedupe_key TEXT UNIQUE
      );

      CREATE TABLE IF NOT EXISTS work (
        work_id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_event_id INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at_ms INTEGER NOT NULL,
        dead INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT,
        lease_acquired_at_ms INTEGER,
        lease_expires_at_ms INTEGER,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_work_due
        ON work(dead, lease_id, available_at_ms, work_id);
    `);
    });

    await releaseExpiredLeases();
    await scheduleNextDispatchFromStore();
  })();

  function runSerialized<T>(run: () => Promise<T>): Promise<T> {
    const operation = mutationTail.then(run, run);
    mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  async function withBusyRetry<T>(run: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await run();
      } catch (error: unknown) {
        if (!isSqliteBusyError(error) || attempt >= maxBusyRetries) {
          throw error;
        }

        attempt += 1;

        await sleepMs(computeBusyRetryDelayMs(attempt, maxBusyRetryDelayMs));
      }
    }
  }

  async function runInTransaction<T>(run: () => Promise<T>): Promise<T> {
    return await runSerialized(async () => {
      return await withBusyRetry(async () => {
        let began = false;

        try {
          await database.exec("BEGIN IMMEDIATE");
          began = true;

          const result = await run();
          await database.exec("COMMIT");

          return result;
        } catch (error: unknown) {
          if (began) {
            try {
              await database.exec("ROLLBACK");
            } catch {
              // Suppress rollback failures to preserve the root cause.
            }
          }

          throw error;
        }
      });
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

    return Value.Decode(schema, payload);
  }

  async function appendEventInTransaction(
    eventInput: AppendEventInput,
  ): Promise<{
    eventId: number;
    created: boolean;
  }> {
    const eventName = eventInput.eventName as keyof TEvents;
    const eventSchema = model.events[eventName];

    if (eventSchema === undefined) {
      throw new Error(`unknown event name: ${eventInput.eventName}`);
    }

    const decodedPayload = decodeEventPayload(eventName, eventInput.payload);
    const encodedPayload = Value.Encode(eventSchema, decodedPayload);

    const payloadJson = JSON.stringify(encodedPayload);

    let created = false;
    let eventId = 0;

    if (eventInput.dedupeKey === undefined) {
      const eventInsert = await database
        .prepare(
          `INSERT INTO events (ts_ms, event_name, payload_json, causation_event_id, dedupe_key)
           VALUES (?, ?, ?, ?, NULL)`,
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
          `INSERT INTO events (ts_ms, event_name, payload_json, causation_event_id, dedupe_key)
           VALUES (?, ?, ?, ?, ?)
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
          .prepare(`SELECT event_id FROM events WHERE dedupe_key = ?`)
          .get(eventInput.dedupeKey);

        if (existing === undefined) {
          throw new Error(
            `dedupe conflict resolved without durable winner for key ${eventInput.dedupeKey}`,
          );
        }

        eventId = decodeRow(existing, EventIdRowSchema).event_id;
      }
    }

    if (!created) {
      return {
        eventId,
        created: false,
      };
    }

    const envelope: EventEnvelope<TEvents, keyof TEvents> = {
      eventId,
      tsMs: eventInput.nowMs,
      eventName,
      payload: decodedPayload,
      causationEventId: eventInput.causationEventId,
      dedupeKey: eventInput.dedupeKey ?? null,
    };

    const projectors =
      builder.projectorsByEvent.get(eventInput.eventName) ?? [];

    for (const projector of projectors) {
      await projector({
        event: envelope,
        actions: {
          index: async (indexName, indexInput) => {
            const schema = model.indexers[indexName as keyof TIndexers];
            const implementation =
              implementations.indexers[indexName as keyof TIndexers];

            if (schema === undefined || implementation === undefined) {
              throw new Error(`unknown indexer: ${String(indexName)}`);
            }

            const decodedInput = Value.Decode(schema, indexInput);
            const encodedInput = Value.Encode(schema, decodedInput);
            const canonicalInput = Value.Decode(schema, encodedInput);

            await implementation(canonicalInput as never);
          },
        },
      });
    }

    const materializers =
      builder.materializersByEvent.get(eventInput.eventName) ?? [];

    for (const materializer of materializers) {
      const queued: {
        queueName: string;
        payload: unknown;
        availableAtMs: number;
      }[] = [];

      await materializer({
        event: envelope,
        actions: {
          enqueue: (queueName, payload, options) => {
            const queueSchema = model.queues[queueName as keyof TQueues];

            if (queueSchema === undefined) {
              throw new Error(`unknown queue: ${String(queueName)}`);
            }

            const decodedQueuePayload = Value.Decode(queueSchema, payload);
            const encodedQueuePayload = Value.Encode(
              queueSchema,
              decodedQueuePayload,
            );

            queued.push({
              queueName: String(queueName),
              payload: encodedQueuePayload,
              availableAtMs: options?.availableAtMs ?? eventInput.nowMs,
            });
          },
        },
      });

      for (const work of queued) {
        await database
          .prepare(
            `INSERT INTO work (
              queue_name,
              payload_json,
              source_event_id,
              attempt,
              available_at_ms,
              dead,
              lease_id,
              lease_acquired_at_ms,
              lease_expires_at_ms,
              last_error
            ) VALUES (?, ?, ?, 0, ?, 0, NULL, NULL, NULL, NULL)`,
          )
          .run(
            work.queueName,
            JSON.stringify(work.payload),
            eventId,
            work.availableAtMs,
          );
      }
    }

    return {
      eventId,
      created,
    };
  }

  async function releaseExpiredLeases(): Promise<void> {
    await runInTransaction(async () => {
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

  function scheduleDispatchAt(targetAtMs: number): void {
    if (closed) {
      return;
    }

    if (scheduledDispatch !== null && scheduledDispatch.dueAtMs <= targetAtMs) {
      return;
    }

    scheduledDispatch?.cancel();

    const delayMs = Math.max(0, targetAtMs - clock.nowMs());
    const task = scheduler.scheduleOnce(delayMs, () => {
      scheduledDispatch = null;
      requestDispatchRun();
    });

    scheduledDispatch = {
      dueAtMs: clock.nowMs() + delayMs,
      cancel: () => task.cancel(),
    };
  }

  async function scheduleNextDispatchFromStore(): Promise<void> {
    const row = await database
      .prepare(
        `SELECT available_at_ms
         FROM work
         WHERE dead = 0
           AND lease_id IS NULL
         ORDER BY available_at_ms ASC
         LIMIT 1`,
      )
      .get();

    if (row === undefined) {
      return;
    }

    scheduleDispatchAt(decodeRow(row, AvailableAtRowSchema).available_at_ms);
  }

  function notifyEventWaiters(): void {
    appendSequence += 1;

    const waiters = [...eventWaiters.values()];
    eventWaiters.clear();

    for (const waiter of waiters) {
      waiter();
    }
  }

  async function waitForEventAppend(input: {
    readonly signal: AbortSignal;
    readonly observedAppendSequence: number;
  }): Promise<void> {
    if (input.signal.aborted || closed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const onEvent = () => {
        finish();
      };

      const onAbort = () => {
        finish();
      };

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        eventWaiters.delete(onEvent);
        input.signal.removeEventListener("abort", onAbort);
        resolve();
      };

      input.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      eventWaiters.add(onEvent);

      if (
        input.signal.aborted ||
        closed ||
        appendSequence !== input.observedAppendSequence
      ) {
        finish();
      }
    });
  }

  async function readEventsAfter(
    afterEventId: number,
    limit: number,
  ): Promise<readonly EventEnvelope<TEvents, keyof TEvents>[]> {
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
         WHERE event_id > ?
         ORDER BY event_id ASC
         LIMIT ?`,
      )
      .all(afterEventId, limit);

    return rows.map((row) => {
      return readEventEnvelopeFromRow(row, model);
    });
  }

  async function readLastEvents(
    limit: number,
  ): Promise<readonly EventEnvelope<TEvents, keyof TEvents>[]> {
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
         ORDER BY event_id DESC
         LIMIT ?`,
      )
      .all(limit);

    const envelopes = rows.map((row) => {
      return readEventEnvelopeFromRow(row, model);
    });

    return envelopes.reverse();
  }

  async function readLatestEventId(): Promise<number> {
    const row = await database
      .prepare(
        `SELECT event_id
         FROM events
         ORDER BY event_id DESC
         LIMIT 1`,
      )
      .get();

    if (row === undefined) {
      return 0;
    }

    return decodeRow(row, EventIdRowSchema).event_id;
  }

  async function* streamEventsFromAfterEventId(input: {
    readonly afterEventId: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<TEvents>> {
    await startup;

    let currentAfterEventId = input.afterEventId;
    const readLimit = 256;

    while (!closed) {
      if (input.signal.aborted) {
        return;
      }

      const observedAppendSequence = appendSequence;
      const events = await readEventsAfter(currentAfterEventId, readLimit);

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

      await waitForEventAppend({
        signal: input.signal,
        observedAppendSequence,
      });
    }
  }

  async function claimNextDueWork(): Promise<PersistedWorkLease | null> {
    return await runInTransaction(async () => {
      const nowMs = clock.nowMs();

      const candidate = await database
        .prepare(
          `SELECT work_id
           FROM work
           WHERE dead = 0
             AND lease_id IS NULL
             AND available_at_ms <= ?
           ORDER BY work_id ASC
           LIMIT 1`,
        )
        .get(nowMs);

      if (candidate === undefined) {
        return null;
      }

      const candidateWorkId = decodeRow(candidate, WorkIdRowSchema).work_id;
      const leaseId = randomUUID();
      const leaseExpiresAtMs = nowMs + leaseMs;

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
            payload_json,
            source_event_id,
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
        payloadJson: decodedClaimed.payload_json,
        sourceEventId: decodedClaimed.source_event_id,
        attempt: decodedClaimed.attempt,
        leaseId,
        leaseAcquiredAtMs: decodedClaimed.lease_acquired_at_ms,
        leaseExpiresAtMs: decodedClaimed.lease_expires_at_ms,
      };
    });
  }

  function requestDispatchRun(): void {
    if (closed) {
      return;
    }

    if (dispatchLoopActive) {
      dispatchLoopQueued = true;
      return;
    }

    dispatchLoopActive = true;

    void runDispatchLoop().finally(() => {
      dispatchLoopActive = false;

      if (dispatchLoopQueued && !closed) {
        dispatchLoopQueued = false;
        requestDispatchRun();
      }
    });
  }

  async function runDispatchLoop(): Promise<void> {
    await startup;

    if (closed) {
      return;
    }

    while (!closed && inFlight.size < maxInFlight) {
      const claimed = await claimNextDueWork();

      if (claimed === null) {
        await scheduleNextDispatchFromStore();
        return;
      }

      const handler = builder.handlersByQueue.get(claimed.queueName);

      if (handler === undefined) {
        await runInTransaction(async () => {
          await database
            .prepare(
              `UPDATE work
               SET
                 dead = 1,
                 lease_id = NULL,
                 lease_acquired_at_ms = NULL,
                 lease_expires_at_ms = NULL,
                 last_error = ?
               WHERE work_id = ?
                 AND lease_id = ?`,
            )
            .run(
              `no handler for queue ${claimed.queueName}`,
              claimed.workId,
              claimed.leaseId,
            );
        });

        continue;
      }

      const run = processClaimedWork(claimed, handler).finally(() => {
        inFlight.delete(run);
        requestDispatchRun();
      });

      inFlight.add(run);
    }
  }

  async function processClaimedWork(
    claimed: PersistedWorkLease,
    handler: QueueHandlerFunction<any, any, any, any>,
  ): Promise<void> {
    const leaseAbortController = new AbortController();
    leaseAbortControllers.set(claimed.leaseId, leaseAbortController);

    let currentLeaseExpiresAtMs = claimed.leaseExpiresAtMs;
    let activeLeaseHolds = 0;

    const clearLeaseHeartbeat = (): void => {
      leaseHeartbeatTasks.get(claimed.leaseId)?.cancel();
      leaseHeartbeatTasks.delete(claimed.leaseId);
    };

    const releaseLeaseInStore = async (): Promise<void> => {
      await runInTransaction(async () => {
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
      leaseExpiryTasks.get(claimed.leaseId)?.cancel();

      const delayMs = Math.max(0, currentLeaseExpiresAtMs - clock.nowMs());
      const expiryTask = scheduler.scheduleOnce(delayMs, () => {
        abortLease("lease expired");
        clearLeaseHeartbeat();

        void releaseLeaseInStore().then(
          () => {
            scheduleDispatchAt(clock.nowMs());
          },
          () => undefined,
        );
      });

      leaseExpiryTasks.set(claimed.leaseId, {
        cancel: () => expiryTask.cancel(),
      });
    };

    const renewLease = async (): Promise<void> => {
      const nowMs = clock.nowMs();
      const renewedLeaseExpiresAtMs = nowMs + leaseMs;

      const renewal = await runInTransaction(async () => {
        return await database
          .prepare(
            `UPDATE work
             SET
               lease_expires_at_ms = ?
             WHERE work_id = ?
               AND lease_id = ?
               AND dead = 0`,
          )
          .run(renewedLeaseExpiresAtMs, claimed.workId, claimed.leaseId);
      });

      if (renewal.changes <= 0) {
        throw new Error("lease renewal lost ownership");
      }

      currentLeaseExpiresAtMs = renewedLeaseExpiresAtMs;
      scheduleLeaseExpiry();
    };

    scheduleLeaseExpiry();

    const startLeaseHeartbeat = (): void => {
      if (leaseHeartbeatTasks.has(claimed.leaseId)) {
        return;
      }

      const heartbeatEveryMs = Math.max(1, Math.floor(leaseMs / 3));
      const heartbeatTask = scheduler.scheduleRepeating(
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

      leaseHeartbeatTasks.set(claimed.leaseId, {
        cancel: () => heartbeatTask.cancel(),
      });
    };

    const stopLeaseHeartbeat = (): void => {
      clearLeaseHeartbeat();
    };

    const queueSchema = model.queues[claimed.queueName as keyof TQueues];

    if (queueSchema === undefined) {
      throw new Error(`unknown queue schema for ${claimed.queueName}`);
    }

    const decodedPayload = Value.Decode(
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
      leaseExpiresAtMs: claimed.leaseExpiresAtMs,
      signal: leaseAbortController.signal,
      hold: () => {
        if (leaseAbortController.signal.aborted) {
          throw new Error("cannot hold aborted lease");
        }

        activeLeaseHolds += 1;

        if (activeLeaseHolds === 1) {
          startLeaseHeartbeat();
        }

        let disposed = false;

        return {
          signal: leaseAbortController.signal,
          [Symbol.asyncDispose]: async () => {
            if (disposed) {
              return;
            }

            disposed = true;
            activeLeaseHolds = Math.max(0, activeLeaseHolds - 1);

            if (activeLeaseHolds === 0) {
              stopLeaseHeartbeat();
            }
          },
        } satisfies LeaseHold;
      },
    };

    const stagedEvents: AppendEventInput[] = [];

    const actions: QueueActions<any, any> = {
      emit: (eventName, event, options) => {
        stagedEvents.push({
          eventName: String(eventName),
          payload: event,
          nowMs: clock.nowMs(),
          dedupeKey: options?.dedupeKey,
          causationEventId: claimed.sourceEventId,
        });
      },
      query: async (queryName, params) => {
        const schema = model.queries[queryName as keyof TQueries];
        const implementation =
          implementations.queries[queryName as keyof TQueries];

        if (schema === undefined || implementation === undefined) {
          throw new Error(`unknown query: ${String(queryName)}`);
        }

        const decodedParams = Value.Decode(schema.params, params);
        const encodedParams = Value.Encode(schema.params, decodedParams);
        const canonicalParams = Value.Decode(schema.params, encodedParams);

        const rawResult = await implementation(canonicalParams as never);
        const decodedResult = Value.Decode(schema.result, rawResult);

        return decodedResult as never;
      },
    };

    let outcome: QueueHandlerOutcome;

    try {
      outcome = await handler({
        work,
        lease,
        actions,
      });
    } catch (error: unknown) {
      outcome = {
        outcome: "retry",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const emittedEvents = await runInTransaction(async () => {
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
        return 0;
      }

      let createdCount = 0;

      for (const stagedEvent of stagedEvents) {
        const appended = await appendEventInTransaction(stagedEvent);

        if (appended.created) {
          createdCount += 1;
        }
      }

      switch (outcome.outcome) {
        case "ack":
          await database
            .prepare(
              `DELETE FROM work
               WHERE work_id = ?
                 AND lease_id = ?
                 AND dead = 0`,
            )
            .run(claimed.workId, claimed.leaseId);
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
              outcome.retryAtMs ?? clock.nowMs() + defaultRetryDelayMs,
              outcome.error,
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
                 last_error = ?
               WHERE work_id = ?
                 AND lease_id = ?
                 AND dead = 0`,
            )
            .run(outcome.error, claimed.workId, claimed.leaseId);
          break;
      }

      return createdCount;
    });

    stopLeaseHeartbeat();

    leaseExpiryTasks.get(claimed.leaseId)?.cancel();
    leaseExpiryTasks.delete(claimed.leaseId);
    leaseAbortControllers.delete(claimed.leaseId);

    if (emittedEvents > 0) {
      notifyEventWaiters();
    }

    scheduleDispatchAt(clock.nowMs());
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }

    closed = true;
    notifyEventWaiters();

    scheduledDispatch?.cancel();
    scheduledDispatch = null;

    for (const expiryTask of leaseExpiryTasks.values()) {
      expiryTask.cancel();
    }

    leaseExpiryTasks.clear();

    for (const heartbeatTask of leaseHeartbeatTasks.values()) {
      heartbeatTask.cancel();
    }

    leaseHeartbeatTasks.clear();

    for (const controller of leaseAbortControllers.values()) {
      controller.abort(new Error("ledger closed"));
    }

    leaseAbortControllers.clear();

    await Promise.allSettled(inFlight);

    await runInTransaction(async () => {
      await database
        .prepare(
          `UPDATE work
           SET
             lease_id = NULL,
             lease_acquired_at_ms = NULL,
             lease_expires_at_ms = NULL,
             available_at_ms = ?
           WHERE dead = 0
             AND lease_id IS NOT NULL`,
        )
        .run(clock.nowMs());
    });
  }

  const ledger: Ledger<TEvents, TQueries> = {
    emit: async (eventName, event, options) => {
      await startup;

      const result = await runInTransaction(
        async () =>
          await appendEventInTransaction({
            eventName: String(eventName),
            payload: event,
            nowMs: clock.nowMs(),
            dedupeKey: options?.dedupeKey,
            causationEventId: null,
          }),
      );

      if (result.created) {
        notifyEventWaiters();
        scheduleDispatchAt(clock.nowMs());
      }
    },
    query: async (queryName, params) => {
      await startup;

      const schema = model.queries[queryName as keyof TQueries];
      const implementation =
        implementations.queries[queryName as keyof TQueries];

      if (schema === undefined || implementation === undefined) {
        throw new Error(`unknown query: ${String(queryName)}`);
      }

      const decodedParams = Value.Decode(schema.params, params);
      const encodedParams = Value.Encode(schema.params, decodedParams);
      const canonicalParams = Value.Decode(schema.params, encodedParams);

      const rawResult = await implementation(canonicalParams as never);
      const decodedResult = Value.Decode(schema.result, rawResult);

      return decodedResult as never;
    },
    tailEvents: ({ last, signal }) => {
      if (!Number.isInteger(last) || last < 0) {
        throw new Error(
          `last must be a non-negative integer, received ${last}`,
        );
      }

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<
          LedgerStreamEvent<TEvents>
        > {
          await startup;

          // Capture a follow boundary before reading backlog so we never skip
          // events appended during tail startup when `last` resolves to no rows.
          let afterEventId = await readLatestEventId();
          const historicalEvents = await readLastEvents(last);

          for (const event of historicalEvents) {
            if (signal.aborted || closed) {
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
            signal,
          });
        },
      };
    },
    resumeEvents: ({ cursor, signal }) => {
      const afterEventId = decodeCursor(cursor);

      return streamEventsFromAfterEventId({
        afterEventId,
        signal,
      });
    },
    close,
    [Symbol.asyncDispose]: close,
  };

  return ledger;
}
