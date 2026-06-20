import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type, type TSchema } from "typebox";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import {
  createBetterSqliteLedger,
  createBetterSqliteStorageRuntime,
} from "./better-sqlite3-ledger.ts";
import {
  createDatabaseLedger,
  type StorageDatabase,
  type StorageRuntime,
  type StorageStatement,
} from "./database-ledger-engine.ts";
import {
  attachLedgerImplementationFactory,
  type LedgerImplementations,
} from "./internal-storage.ts";
import {
  type RegisteredLedgerModel,
  type LedgerModel,
  type QuerySchema,
  type RegisterFunction,
} from "./ledger.ts";
import { createSqliteProjectionStatementCompiler } from "./projection-sql-compiler.ts";
import { defineProjectionSchema } from "./projections.ts";
import { createTursoStorageRuntime } from "./turso-ledger.ts";

const projectionCompiler = createSqliteProjectionStatementCompiler();

type EngineFixtureModel<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, TSchema> = {},
  TQueries extends Record<string, QuerySchema<TSchema, TSchema>> = {},
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
  withImplementations(
    implementations: LedgerImplementations<TIndexers, TQueries, TEvents>,
  ): RegisteredLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
};

function defineEngineFixtureModel<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, TSchema> = {},
  const TQueries extends Record<string, QuerySchema<TSchema, TSchema>> = {},
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
>(input: {
  readonly events: TEvents;
  readonly signals?: TSignals;
  readonly queues: TQueues;
  readonly signalQueues?: TSignalQueues;
  readonly indexers?: TIndexers;
  readonly queries?: TQueries;
  readonly register: RegisterFunction<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
}): EngineFixtureModel<
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
  const projections = defineProjectionSchema({});

  return {
    model,
    register: input.register,
    withImplementations(implementations) {
      // Engine tests exercise custom storage hooks that the public v2
      // construction path deliberately no longer exposes.
      const registeredModel = {
        model,
        projections,
        register: input.register,
      } as unknown as RegisteredLedgerModel<
        TEvents,
        TQueues,
        TIndexers,
        TQueries,
        TSignals,
        TSignalQueues
      >;

      return attachLedgerImplementationFactory(
        registeredModel,
        () => implementations,
      );
    },
  };
}

async function waitFor(
  runtime: VirtualRuntimeHarness,
  predicate: () => Promise<boolean> | boolean,
): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    await runtime.flush();

    if (await predicate()) {
      return;
    }

    await runtime.advanceByMs(1);
  }

  throw new Error("waitFor timed out");
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number = 2_000,
): Promise<IteratorResult<T>> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`iterator.next timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function wrapBetterSqliteDatabase(
  database: Database.Database,
): StorageDatabase {
  return {
    exec: async (sql) => {
      database.exec(sql);
    },
    prepare: (sql) => {
      const statement = database.prepare(sql);

      return {
        run: async (...params) => statement.run(...params),
        get: async (...params) => {
          const row = statement.get(...params);

          if (row === undefined) {
            return undefined;
          }

          if (typeof row !== "object" || row === null || Array.isArray(row)) {
            throw new Error("expected row object");
          }

          return row as Record<string, unknown>;
        },
        all: async (...params) => {
          const rows = statement.all(...params);

          return rows.map((row) => {
            if (typeof row !== "object" || row === null || Array.isArray(row)) {
              throw new Error("expected row object");
            }

            return row as Record<string, unknown>;
          });
        },
      };
    },
  };
}

function createTempDatabasePath(): string {
  return join(tmpdir(), `sledge-${randomUUID()}.sqlite`);
}

function singleConnectionStorageRuntime(
  database: StorageDatabase,
): StorageRuntime {
  return {
    read: async (run) => await run(database),
    write: async (run) => await run(database),
    close: async () => undefined,
  };
}

test("better-sqlite runtime enables WAL and fail-fast lock handling", async () => {
  const databaseUrl = createTempDatabasePath();
  const storage = createBetterSqliteStorageRuntime(databaseUrl);
  const inspector = new Database(databaseUrl, {
    timeout: 0,
  });

  try {
    const row = inspector.pragma("journal_mode", {
      simple: true,
    });

    assert.equal(row, "wal");

    const lockHolder = new Database(databaseUrl, {
      timeout: 0,
    });

    try {
      lockHolder.exec("BEGIN IMMEDIATE");

      await assert.rejects(
        storage.write(async (database) => {
          await database.exec(
            "CREATE TABLE lock_probe (id INTEGER PRIMARY KEY)",
          );
        }),
        (error: unknown) => {
          if (!(error instanceof Error)) {
            return false;
          }

          const maybeCode = (error as { readonly code?: unknown }).code;

          return maybeCode === "SQLITE_BUSY" || error.message.includes("BUSY");
        },
      );
    } finally {
      try {
        lockHolder.exec("ROLLBACK");
      } catch {
        // Ignore rollback when no transaction is active.
      }

      lockHolder.close();
    }
  } finally {
    await storage.close();
    inspector.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

test("storage runtimes reject non-shared in-memory database URLs", async () => {
  assert.throws(
    () => createBetterSqliteStorageRuntime(":memory:"),
    /non-shared in-memory/,
  );
  assert.throws(
    () => createBetterSqliteStorageRuntime("file::memory:"),
    /non-shared in-memory/,
  );
  assert.throws(
    () => createBetterSqliteStorageRuntime("file:ledger?mode=memory"),
    /non-shared in-memory/,
  );

  await assert.rejects(
    async () => await createTursoStorageRuntime(":memory:"),
    /non-shared in-memory/,
  );
  await assert.rejects(
    async () => await createTursoStorageRuntime("file::memory:"),
    /non-shared in-memory/,
  );
  await assert.rejects(
    async () => await createTursoStorageRuntime("file:ledger?mode=memory"),
    /non-shared in-memory/,
  );
});

test("turso runtime enables foreign key enforcement on every connection", async () => {
  const databaseUrl = createTempDatabasePath();
  const storage = await createTursoStorageRuntime(databaseUrl);

  try {
    assert.equal(
      await storage.write(async (database) => {
        return await readForeignKeyPragma(database);
      }),
      1,
    );
    assert.equal(
      await storage.read(async (database) => {
        return await readForeignKeyPragma(database);
      }),
      1,
    );
  } finally {
    await storage.close();
    await rm(databaseUrl, {
      force: true,
    });
    await rm(`${databaseUrl}-wal`, {
      force: true,
    });
  }
});

test("better-sqlite runtime close waits for in-flight reads", async () => {
  const databaseUrl = createTempDatabasePath();
  const storage = createBetterSqliteStorageRuntime(databaseUrl);
  const readStarted = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();

  try {
    const read = storage.read(async () => {
      readStarted.resolve();
      await releaseRead.promise;
      return 1;
    });

    await readStarted.promise;

    const closing = storage.close();
    assert.equal(await settlesWithin(closing, 10), false);

    releaseRead.resolve();
    assert.equal(await read, 1);
    await closing;
  } finally {
    await storage.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

async function readForeignKeyPragma(
  database: StorageDatabase,
): Promise<unknown> {
  const row = await database.prepare("PRAGMA foreign_keys").get();

  if (row === undefined) {
    throw new Error("PRAGMA foreign_keys did not return a row");
  }

  return row.foreign_keys;
}

test("turso runtime close waits for in-flight reads", async () => {
  const databaseUrl = createTempDatabasePath();
  const storage = await createTursoStorageRuntime(databaseUrl);
  const readStarted = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();

  try {
    const read = storage.read(async () => {
      readStarted.resolve();
      await releaseRead.promise;
      return 1;
    });

    await readStarted.promise;

    const closing = storage.close();
    assert.equal(await settlesWithin(closing, 10), false);

    releaseRead.resolve();
    assert.equal(await read, 1);
    await closing;
  } finally {
    await storage.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

test("ledger queries do not block external write transactions", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const queryStarted = Promise.withResolvers<void>();
  const releaseQuery = Promise.withResolvers<void>();
  let slowQueryActive = false;
  let beginAttemptedDuringSlowQuery = false;

  const storage = wrapBetterSqliteDatabase(database);
  const serializedStorage: StorageDatabase = {
    exec: async (sql) => {
      if (sql === "BEGIN IMMEDIATE" && slowQueryActive) {
        beginAttemptedDuringSlowQuery = true;
      }

      await storage.exec(sql);
    },
    prepare: (sql) => {
      if (sql === "SELECT value FROM slow_read") {
        return {
          run: async () => {
            return { changes: 0, lastInsertRowid: 0 };
          },
          get: async () => {
            slowQueryActive = true;
            queryStarted.resolve();
            await releaseQuery.promise;
            slowQueryActive = false;

            return { value: "ok" };
          },
          all: async () => [],
        };
      }

      return storage.prepare(sql);
    },
  };

  const model = defineEngineFixtureModel({
    events: {
      "thing.recorded": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {
      slow: {
        params: Type.Object({}),
        result: Type.Object({ value: Type.String() }),
      },
    },
    register: {},
  });

  await using ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(serializedStorage),
    model: model.withImplementations({
      indexers: {},
      queries: {
        slow: async () => {
          return await serializedStorage
            .prepare("SELECT value FROM slow_read")
            .get();
        },
      },
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  const queryPromise = ledger.query("slow", {});
  await queryStarted.promise;

  const emitPromise = ledger.emit("thing.recorded", { id: 1 });
  assert.equal(await settlesWithin(emitPromise, 10), true);
  assert.equal(beginAttemptedDuringSlowQuery, true);

  releaseQuery.resolve();

  assert.deepEqual(await queryPromise, { value: "ok" });
});

test("dispatch scheduling reads do not block event writes", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const scheduleReadStarted = Promise.withResolvers<void>();
  const releaseScheduleRead = Promise.withResolvers<void>();
  let scheduleReadActive = false;
  let beginAttemptedDuringScheduleRead = false;

  const storage = wrapBetterSqliteDatabase(database);
  const serializedStorage: StorageDatabase = {
    exec: async (sql) => {
      if (sql === "BEGIN IMMEDIATE" && scheduleReadActive) {
        beginAttemptedDuringScheduleRead = true;
      }

      await storage.exec(sql);
    },
    prepare: (sql) => {
      if (sql.includes("SELECT available_at_ms")) {
        return {
          run: async () => {
            return { changes: 0, lastInsertRowid: 0 };
          },
          get: async () => {
            scheduleReadActive = true;
            scheduleReadStarted.resolve();
            await releaseScheduleRead.promise;
            scheduleReadActive = false;

            return undefined;
          },
          all: async () => [],
        };
      }

      return storage.prepare(sql);
    },
  };

  const model = defineEngineFixtureModel({
    events: {
      "thing.recorded": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  await using ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(serializedStorage),
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  const workersPromise = ledger.startWorkers({
    scheduler: runtime.scheduler,
  });
  await scheduleReadStarted.promise;

  const emitPromise = ledger.emit("thing.recorded", { id: 1 });
  assert.equal(await settlesWithin(emitPromise, 10), true);
  assert.equal(beginAttemptedDuringScheduleRead, true);

  releaseScheduleRead.resolve();

  await using workers = await workersPromise;
  await emitPromise;
  assert.equal(beginAttemptedDuringScheduleRead, true);
});

test("event-handler queries remain reentrant inside append transactions", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  let observedEvents = 0;

  const model = defineEngineFixtureModel({
    events: {
      "thing.recorded": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {
      eventCount: {
        params: Type.Object({}),
        result: Type.Object({ count: Type.Number() }),
      },
    },
    register: {
      events: {
        "thing.recorded": async ({ actions }) => {
          const result = await actions.query("eventCount", {});
          observedEvents = result.count;
        },
      },
    },
  });

  await using ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(wrapBetterSqliteDatabase(database)),
    model: model.withImplementations({
      indexers: {},
      queries: {
        eventCount: async () => {
          const row = await wrapBetterSqliteDatabase(database)
            .prepare("SELECT COUNT(*) AS count FROM events")
            .get();

          return row;
        },
      },
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("thing.recorded", { id: 1 });

  assert.equal(observedEvents, 1);
});

test("event-handler query actions expire after handler completion", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  let queryInvocations = 0;
  let capturedQuery:
    | ((params: Record<string, never>) => Promise<{ count: number }>)
    | null = null;

  const model = defineEngineFixtureModel({
    events: {
      "thing.recorded": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {
      eventCount: {
        params: Type.Object({}),
        result: Type.Object({ count: Type.Number() }),
      },
    },
    register: {
      events: {
        "thing.recorded": async ({ actions }) => {
          capturedQuery = async (params) => {
            return await actions.query("eventCount", params);
          };
        },
      },
    },
  });

  await using ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(wrapBetterSqliteDatabase(database)),
    model: model.withImplementations({
      indexers: {},
      queries: {
        eventCount: async () => {
          queryInvocations += 1;
          const row = await wrapBetterSqliteDatabase(database)
            .prepare("SELECT COUNT(*) AS count FROM events")
            .get();

          return row;
        },
      },
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("thing.recorded", { id: 1 });

  assert.notEqual(capturedQuery, null);
  await assert.rejects(
    async () => await capturedQuery?.({}),
    /event actions are only valid during event handling/,
  );
  assert.equal(queryInvocations, 0);
});

test("unawaited event-handler queries settle before rollback", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const queryStarted = Promise.withResolvers<void>();
  const releaseQuery = Promise.withResolvers<void>();
  let slowQueryActive = false;
  let commitAttemptedDuringSlowQuery = false;
  let rolledBack = false;

  const storage = wrapBetterSqliteDatabase(database);
  const serializedStorage: StorageDatabase = {
    exec: async (sql) => {
      if (sql === "COMMIT" && slowQueryActive) {
        commitAttemptedDuringSlowQuery = true;
      }

      if (sql === "ROLLBACK") {
        rolledBack = true;
      }

      await storage.exec(sql);
    },
    prepare: (sql) => {
      if (sql === "SELECT value FROM slow_read") {
        return {
          run: async () => {
            return { changes: 0, lastInsertRowid: 0 };
          },
          get: async () => {
            slowQueryActive = true;
            queryStarted.resolve();
            await releaseQuery.promise;
            slowQueryActive = false;

            return { value: "ok" };
          },
          all: async () => [],
        };
      }

      return storage.prepare(sql);
    },
  };

  const model = defineEngineFixtureModel({
    events: {
      "thing.recorded": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {
      slow: {
        params: Type.Object({}),
        result: Type.Object({ value: Type.String() }),
      },
    },
    register: {
      events: {
        "thing.recorded": ({ actions }) => {
          void actions.query("slow", {});
        },
      },
    },
  });

  await using ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(serializedStorage),
    model: model.withImplementations({
      indexers: {},
      queries: {
        slow: async () => {
          return await serializedStorage
            .prepare("SELECT value FROM slow_read")
            .get();
        },
      },
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  const emitPromise = ledger.emit("thing.recorded", { id: 1 });
  await queryStarted.promise;

  assert.equal(await settlesWithin(emitPromise, 10), false);
  assert.equal(commitAttemptedDuringSlowQuery, false);

  releaseQuery.resolve();

  await assert.rejects(
    async () => await emitPromise,
    /event actions must be awaited before the handler returns/,
  );
  assert.equal(commitAttemptedDuringSlowQuery, false);
  assert.equal(rolledBack, true);

  const row = await storage
    .prepare("SELECT COUNT(*) AS count FROM events")
    .get();

  assert.deepEqual(row, { count: 0 });
});

test("ledger construction and emit do not start queue workers", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  let processed = 0;

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            {
              id: event.payload.id,
            },
            { workKey: `job:${event.payload.id}` },
          );
        },
      },
      queues: {
        "job.run": () => {
          processed += 1;
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("job.requested", { id: 1 });
  await runtime.flush();
  await runtime.advanceByMs(1_000);

  assert.equal(processed, 0);
  assert.equal(readCount(database, `SELECT COUNT(*) as total FROM work`), 1);

  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await waitFor(runtime, () => processed === 1);
  await waitFor(
    runtime,
    () => readCount(database, `SELECT COUNT(*) as total FROM work`) === 0,
  );
});

test("closing workers during a pending claim releases the claimed work", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const claimStarted = Promise.withResolvers<void>();
  const allowClaim = Promise.withResolvers<void>();
  const storage = wrapBetterSqliteDatabase(database);
  let blockedClaim = false;

  const blockingStorage: StorageDatabase = {
    exec: storage.exec,
    prepare: (sql): StorageStatement => {
      const statement = storage.prepare(sql);

      if (
        !blockedClaim &&
        sql.includes("SELECT work_id") &&
        sql.includes("available_at_ms <= ?")
      ) {
        blockedClaim = true;

        return {
          run: statement.run,
          all: statement.all,
          get: async (...params) => {
            claimStarted.resolve();
            await allowClaim.promise;
            return await statement.get(...params);
          },
        };
      }

      return statement;
    },
  };

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", {
            id: event.payload.id,
          });
        },
      },
    },
  });

  await using ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(blockingStorage),
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("job.requested", { id: 1 });
  const workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await runtime.flush();
  await claimStarted.promise;

  const closing = workers.close();
  allowClaim.resolve();
  await closing;

  assert.equal(readCount(database, `SELECT COUNT(*) as total FROM work`), 1);
  assert.equal(
    readCount(database, `SELECT COUNT(*) as total FROM work WHERE dead = 1`),
    0,
  );
  assert.equal(
    readCount(
      database,
      `SELECT COUNT(*) as total FROM work WHERE lease_id IS NOT NULL`,
    ),
    0,
  );
});

test("idle workers discover work materialized by another ledger handle", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  let processed = 0;

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            {
              id: event.payload.id,
            },
            { workKey: `job:${event.payload.id}` },
          );
        },
      },
      queues: {
        "job.run": () => {
          processed += 1;
        },
      },
    },
  });

  try {
    await using workerLedger = createBetterSqliteLedger({
      databaseUrl,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await using emitterLedger = createBetterSqliteLedger({
      databaseUrl,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await using workers = await workerLedger.startWorkers({
      scheduler: runtime.scheduler,
    });

    await runtime.flush();
    await emitterLedger.emit("job.requested", { id: 1 });

    assert.equal(processed, 0);
    assert.equal(readCount(database, `SELECT COUNT(*) as total FROM work`), 1);

    await runtime.advanceByMs(999);
    await runtime.flush();
    assert.equal(processed, 0);

    await runtime.advanceByMs(1);
    await waitFor(runtime, () => processed === 1);
    await waitFor(
      runtime,
      () => readCount(database, `SELECT COUNT(*) as total FROM work`) === 0,
    );
  } finally {
    database.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

test("ledger close waits for startup before closing storage", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const storageDatabase = wrapBetterSqliteDatabase(database);
  const startupEntered = Promise.withResolvers<void>();
  const allowStartup = Promise.withResolvers<void>();
  let closeCalled = false;

  const storage: StorageRuntime = {
    read: async (run) => await run(storageDatabase),
    write: async (run) => {
      startupEntered.resolve();
      await allowStartup.promise;
      return await run(storageDatabase);
    },
    close: async () => {
      closeCalled = true;
    },
  };

  const model = defineEngineFixtureModel({
    events: {},
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  try {
    await using ledger = createDatabaseLedger({
      projectionCompiler,
      storage,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await startupEntered.promise;

    const closing = ledger.close();
    assert.equal(await settlesWithin(closing, 10), false);
    assert.equal(closeCalled, false);

    allowStartup.resolve();
    await closing;
    assert.equal(closeCalled, true);
  } finally {
    database.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

test("ledger close closes storage after startup failure", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  let closeCalled = false;

  const storage: StorageRuntime = {
    read: async () => {
      throw new Error("unexpected read");
    },
    write: async () => {
      throw new Error("startup failed");
    },
    close: async () => {
      closeCalled = true;
    },
  };

  const model = defineEngineFixtureModel({
    events: {},
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  const ledger = createDatabaseLedger({
    projectionCompiler,
    storage,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await assert.rejects(
    async () => await ledger.close(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "failed to close ledger");
      assert.equal(error.errors.length, 1);

      const failure = error.errors[0];
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, "startup failed");

      return true;
    },
  );
  assert.equal(closeCalled, true);
});

test("ledger close reports dispatch loop claim failures", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const storage = wrapBetterSqliteDatabase(database);
  let failedClaim = false;

  const failingStorage: StorageDatabase = {
    exec: storage.exec,
    prepare: (sql): StorageStatement => {
      const statement = storage.prepare(sql);

      if (
        !failedClaim &&
        sql.includes("SELECT work_id") &&
        sql.includes("available_at_ms <= ?")
      ) {
        failedClaim = true;

        return {
          run: statement.run,
          all: statement.all,
          get: async () => {
            throw new Error("claim failed");
          },
        };
      }

      return statement;
    },
  };

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", {
            id: event.payload.id,
          });
        },
      },
    },
  });

  const ledger = createDatabaseLedger({
    projectionCompiler,
    storage: singleConnectionStorageRuntime(failingStorage),
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("job.requested", { id: 1 });
  await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });
  await runtime.flush();

  await assert.rejects(
    async () => {
      await ledger.close();
    },
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "failed to close ledger workers");
      assert.equal(error.errors.length, 1);

      const failure = error.errors[0];
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, "claim failed");

      return true;
    },
  );
});

test("startWorkers rejects while workers are already running", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {},
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await assert.rejects(
    ledger.startWorkers({
      scheduler: runtime.scheduler,
    }),
    /ledger workers are already running/,
  );
});

test("startWorkers rejects invalid lease and retry timing options", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "job.run": () => undefined,
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await assert.rejects(
    async () =>
      await ledger.startWorkers({
        scheduler: runtime.scheduler,
        leaseMs: 0,
      }),
    /leaseMs must be a positive integer/,
  );

  await assert.rejects(
    async () =>
      await ledger.startWorkers({
        scheduler: runtime.scheduler,
        defaultRetryDelayMs: -1,
      }),
    /defaultRetryDelayMs must be a positive integer/,
  );

  await assert.rejects(
    async () =>
      await ledger.startWorkers({
        scheduler: runtime.scheduler,
        maxInFlight: 0,
      }),
    /maxInFlight must be a positive integer/,
  );
});

test("ledger enforces maxInFlight dispatch concurrency", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "job.run": async () => {
          active += 1;
          peak = Math.max(peak, active);

          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });

          active -= 1;
          completed += 1;
        },
      },
    },
  });

  let active = 0;
  let peak = 0;
  let completed = 0;
  const releases: Array<() => void> = [];

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    maxInFlight: 2,
  });

  await ledger.emit("job.requested", { id: 1 });
  await ledger.emit("job.requested", { id: 2 });
  await ledger.emit("job.requested", { id: 3 });

  await waitFor(runtime, () => releases.length === 2);
  assert.equal(peak, 2);

  const first = releases.shift();
  assert.ok(first !== undefined);
  first();

  await waitFor(runtime, () => releases.length === 2);

  while (releases.length > 0) {
    const release = releases.shift();

    if (release !== undefined) {
      release();
    }

    await runtime.flush();
  }

  await waitFor(runtime, () => completed === 3);

  assert.equal(peak, 2);
});

test("deduped emit does not replay projections or materialization", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(tmpdir(), `ledger-r1-${randomUUID()}.sqlite`);
  const database = new Database(databasePath);

  let projected = 0;
  let processed = 0;

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
      "message.updated": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "message.process": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {
      trackProjection: Type.Object({
        id: Type.Number(),
      }),
    },
    queries: {},
    register: {
      events: {
        "message.received": async ({ event, actions }) => {
          await actions.index("trackProjection", {
            id: event.payload.id,
          });

          actions.enqueue("message.process", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "message.process": async () => {
          processed += 1;
        },
      },
    },
  });

  try {
    await using ledger = createBetterSqliteLedger({
      databaseUrl: databasePath,
      model: model.withImplementations({
        indexers: {
          trackProjection: async () => {
            projected += 1;
          },
        },
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });
    await using workers = await ledger.startWorkers({
      scheduler: runtime.scheduler,
    });

    const first = await ledger.emit(
      "message.received",
      {
        id: 42,
      },
      {
        dedupeKey: "message:42",
      },
    );

    const second = await ledger.emit(
      "message.received",
      {
        id: 43,
      },
      {
        dedupeKey: "message:42",
      },
    );

    assert.equal(second.eventId, first.eventId);
    assert.deepEqual(second.payload, {
      id: 42,
    });

    await assert.rejects(
      async () =>
        await ledger.emit(
          "message.updated",
          {
            id: 42,
          },
          {
            dedupeKey: "message:42",
          },
        ),
      /dedupe key message:42 already belongs to event message\.received/,
    );

    await waitFor(runtime, () => processed === 1);
    assert.equal(projected, 1);
    assert.equal(processed, 1);
  } finally {
    await rm(databasePath, {
      force: true,
    });
  }
});

test("event handlers can query to drive enqueue decisions", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  let enabled = false;

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {
      "config.enabled": {
        params: Type.Object({}),
        result: Type.Boolean(),
      },
    },
    register: {
      events: {
        "job.requested": async ({ event, actions }) => {
          if (!(await actions.query("config.enabled", {}))) {
            return;
          }

          actions.enqueue("job.run", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "job.run": async () => {},
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {
        "config.enabled": async () => enabled,
      },
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await ledger.emit("job.requested", { id: 1 });
  await runtime.flush();

  assert.equal(
    readCount(database, "SELECT COUNT(*) AS total FROM work"),
    0,
    "no work should enqueue when query returns false",
  );

  enabled = true;

  await ledger.emit("job.requested", { id: 2 });
  await runtime.flush();

  assert.equal(
    readCount(database, "SELECT COUNT(*) AS total FROM work"),
    1,
    "work should enqueue when query returns true",
  );
});

function readCount(database: Database.Database, sql: string): number {
  const row = database.prepare(sql).get();

  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("expected count row object");
  }

  const total = (row as Record<string, unknown>)["total"];

  if (typeof total !== "number") {
    throw new Error("expected numeric count");
  }

  return total;
}

test("signals materialize signal work and are pruned after ack", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  let broadcasts = 0;
  let holdSignal = true;
  let releaseSignal!: () => void;
  const signalGate = new Promise<void>((resolve) => {
    releaseSignal = resolve;
  });

  const model = defineEngineFixtureModel({
    events: {
      "response.generate": Type.Object({
        id: Type.Number(),
      }),
    },
    signals: {
      "response.delta": Type.Object({
        id: Type.Number(),
        seq: Type.Number(),
      }),
    },
    queues: {
      "response.run": Type.Object({
        id: Type.Number(),
      }),
    },
    signalQueues: {
      "delta.broadcast": Type.Object({
        id: Type.Number(),
        seq: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "response.generate": ({ event, actions }) => {
          actions.enqueue("response.run", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "response.run": async ({ work, actions }) => {
          await actions.emitSignal(
            "response.delta",
            {
              id: work.payload.id,
              seq: 1,
            },
            {
              dedupeKey: `response-delta:${work.payload.id}:1`,
            },
          );
        },
      },
      signals: {
        "response.delta": ({ event, actions }) => {
          actions.enqueueSignal("delta.broadcast", {
            id: event.payload.id,
            seq: event.payload.seq,
          });
        },
      },
      signalQueues: {
        "delta.broadcast": async () => {
          broadcasts += 1;

          if (holdSignal) {
            await signalGate;
          }
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  const observedSignals: Array<{ id: number; seq: number }> = [];
  const signalSubscription = ledger.onSignal("response.delta", (signal) => {
    observedSignals.push(signal.payload);
  });

  await ledger.emit("response.generate", { id: 1 });
  await waitFor(runtime, () => broadcasts === 1);
  await waitFor(runtime, () => observedSignals.length === 1);

  assert.deepEqual(observedSignals, [{ id: 1, seq: 1 }]);

  assert.equal(
    readCount(
      database,
      `SELECT COUNT(*) as total FROM events WHERE signal = 1`,
    ),
    1,
  );
  assert.equal(
    readCount(database, `SELECT COUNT(*) as total FROM work WHERE signal = 1`),
    1,
  );

  const controller = new AbortController();
  const iterator = ledger
    .tailEvents({
      last: 10,
      signal: controller.signal,
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(iterator);
  assert.equal(first.done, false);

  if (first.done) {
    throw new Error("expected durable event");
  }

  assert.equal(first.value.event.eventName, "response.generate");
  const next = iterator.next();
  assert.equal(await settlesWithin(next, 20), false);
  controller.abort();
  await iterator.return?.();

  holdSignal = false;
  releaseSignal();

  await waitFor(runtime, () => {
    return (
      readCount(
        database,
        `SELECT COUNT(*) as total FROM events WHERE signal = 1`,
      ) === 0 &&
      readCount(
        database,
        `SELECT COUNT(*) as total FROM work WHERE signal = 1`,
      ) === 0
    );
  });

  signalSubscription[Symbol.dispose]();

  await ledger.emit("response.generate", { id: 1 });
  await waitFor(runtime, () => broadcasts === 2);
  assert.equal(observedSignals.length, 1);
});

test("queue handlers publish signals immediately before handler completion", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const gate = Promise.withResolvers<void>();
  let observerCount = 0;

  const model = defineEngineFixtureModel({
    events: {
      "response.generate": Type.Object({
        id: Type.Number(),
      }),
    },
    signals: {
      "response.delta": Type.Object({
        id: Type.Number(),
        seq: Type.Number(),
      }),
    },
    queues: {
      "response.run": Type.Object({
        id: Type.Number(),
      }),
    },
    signalQueues: {},
    indexers: {},
    queries: {},
    register: {
      events: {
        "response.generate": ({ event, actions }) => {
          actions.enqueue("response.run", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "response.run": async ({ work, actions }) => {
          await actions.emitSignal("response.delta", {
            id: work.payload.id,
            seq: 1,
          });

          await gate.promise;
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  const subscription = ledger.onSignal("response.delta", () => {
    observerCount += 1;
  });

  await ledger.emit("response.generate", { id: 1 });
  await waitFor(runtime, () => observerCount === 1);

  gate.resolve();
  await waitFor(
    runtime,
    () => readCount(database, `SELECT COUNT(*) as total FROM work`) === 0,
  );

  subscription[Symbol.dispose]();
});

test("signal retry keeps signal event until signal work acks", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  let attempts = 0;

  const model = defineEngineFixtureModel({
    events: {
      "response.generate": Type.Object({
        id: Type.Number(),
      }),
    },
    signals: {
      "response.delta": Type.Object({
        id: Type.Number(),
        seq: Type.Number(),
      }),
    },
    queues: {
      "response.run": Type.Object({
        id: Type.Number(),
      }),
    },
    signalQueues: {
      "delta.broadcast": Type.Object({
        id: Type.Number(),
        seq: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "response.generate": ({ event, actions }) => {
          actions.enqueue("response.run", {
            id: event.payload.id,
          });
        },
      },
      queues: {
        "response.run": async ({ work, actions }) => {
          await actions.emitSignal("response.delta", {
            id: work.payload.id,
            seq: 1,
          });
        },
      },
      signals: {
        "response.delta": ({ event, actions }) => {
          actions.enqueueSignal("delta.broadcast", {
            id: event.payload.id,
            seq: event.payload.seq,
          });
        },
      },
      signalQueues: {
        "delta.broadcast": async ({ control }) => {
          attempts += 1;

          if (attempts === 1) {
            return control.retry("retry once", {
              retryAtMs: runtime.nowMs() + 100,
            });
          }
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await ledger.emit("response.generate", { id: 1 });
  await waitFor(runtime, () => attempts === 1);

  assert.equal(
    readCount(
      database,
      `SELECT COUNT(*) as total FROM events WHERE signal = 1`,
    ),
    1,
  );
  assert.equal(
    readCount(database, `SELECT COUNT(*) as total FROM work WHERE signal = 1`),
    1,
  );

  await runtime.advanceByMs(100);
  await waitFor(runtime, () => attempts === 2);
  await waitFor(runtime, () => {
    return (
      readCount(
        database,
        `SELECT COUNT(*) as total FROM events WHERE signal = 1`,
      ) === 0 &&
      readCount(
        database,
        `SELECT COUNT(*) as total FROM work WHERE signal = 1`,
      ) === 0
    );
  });
});

function createBusyTestModel() {
  return defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });
}

test("emit fails fast when busy retries are disabled", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(
    tmpdir(),
    `ledger-r1-busy-disabled-${randomUUID()}.sqlite`,
  );
  const lockHolder = new Database(databasePath, {
    timeout: 0,
  });
  const model = createBusyTestModel();

  const ledger = createBetterSqliteLedger({
    databaseUrl: databasePath,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  try {
    await ledger.listWork();
    lockHolder.exec("BEGIN IMMEDIATE");

    await assert.rejects(
      ledger.emit("message.received", {
        id: 42,
      }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }

        const maybeCode = (error as { readonly code?: unknown }).code;

        return maybeCode === "SQLITE_BUSY" || error.message.includes("BUSY");
      },
    );
  } finally {
    try {
      lockHolder.exec("ROLLBACK");
    } catch {
      // Ignore rollback when no transaction is active.
    }

    await ledger.close();

    lockHolder.close();

    await rm(databasePath, {
      force: true,
    });
  }
});

test("tailEvents does not expose rolled back in-flight events", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  let releaseMaterializer!: () => void;
  const materializerGate = new Promise<void>((resolve) => {
    releaseMaterializer = () => {
      resolve();
    };
  });

  let materializerStarted = false;

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {
      events: {
        "message.received": async () => {
          materializerStarted = true;
          await materializerGate;

          throw new Error("materialization failure");
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  const emit = ledger.emit("message.received", {
    id: 1,
  });

  await waitFor(runtime, () => materializerStarted);

  const abortController = new AbortController();
  const iterator = ledger
    .tailEvents({
      last: 1,
      signal: abortController.signal,
    })
    [Symbol.asyncIterator]();

  const next = iterator.next();
  assert.equal(await settlesWithin(next, 20), false);

  releaseMaterializer();

  await assert.rejects(emit);

  assert.equal(await settlesWithin(next, 20), false);

  abortController.abort();

  const done = await next;
  assert.equal(done.done, true);
});

test("tailEvents does not expose rolled back events from a shared read/write scope", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  let releaseMaterializer!: () => void;
  const materializerGate = new Promise<void>((resolve) => {
    releaseMaterializer = () => {
      resolve();
    };
  });

  let materializerStarted = false;

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {
      events: {
        "message.received": async () => {
          materializerStarted = true;
          await materializerGate;

          throw new Error("materialization failure");
        },
      },
    },
  });

  try {
    await using ledger = createDatabaseLedger({
      projectionCompiler,
      storage: singleConnectionStorageRuntime(
        wrapBetterSqliteDatabase(database),
      ),
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    const emit = ledger.emit("message.received", {
      id: 1,
    });

    await waitFor(runtime, () => materializerStarted);

    const abortController = new AbortController();
    const iterator = ledger
      .tailEvents({
        last: 1,
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]();

    const next = iterator.next();
    assert.equal(await settlesWithin(next, 20), false);

    releaseMaterializer();

    await assert.rejects(emit);

    assert.equal(await settlesWithin(next, 20), false);

    abortController.abort();

    const done = await next;
    assert.equal(done.done, true);
  } finally {
    database.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

test("tailEvents yields last N events then follows new events", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("message.received", { id: 1 });
  await ledger.emit("message.received", { id: 2 });
  await ledger.emit("message.received", { id: 3 });

  const abortController = new AbortController();
  const iterator = ledger
    .tailEvents({
      last: 2,
      signal: abortController.signal,
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(iterator);
  const second = await nextWithTimeout(iterator);

  assert.equal(first.done, false);
  assert.equal(second.done, false);

  if (first.done || second.done) {
    throw new Error("expected backlog events");
  }

  assert.equal(first.value.event.payload.id, 2);
  assert.equal(second.value.event.payload.id, 3);
  assert.equal(typeof first.value.cursor, "string");

  const follow = nextWithTimeout(iterator);

  await ledger.emit("message.received", { id: 4 });

  const third = await follow;

  assert.equal(third.done, false);

  if (third.done) {
    throw new Error("expected followed event");
  }

  assert.equal(third.value.event.payload.id, 4);

  abortController.abort();

  const done = await nextWithTimeout(iterator);
  assert.equal(done.done, true);
});

test("tailEvents reads durable events committed by another handle", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(
    tmpdir(),
    `ledger-tail-shared-${randomUUID()}.sqlite`,
  );
  const firstDatabase = new Database(databasePath);
  const secondDatabase = new Database(databasePath);

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  try {
    await using firstLedger = createBetterSqliteLedger({
      databaseUrl: databasePath,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await using secondLedger = createBetterSqliteLedger({
      databaseUrl: databasePath,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await secondLedger.emit("message.received", { id: 1 });

    const abortController = new AbortController();
    const iterator = firstLedger
      .tailEvents({
        last: 1,
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]();

    const first = await nextWithTimeout(iterator);
    assert.equal(first.done, false);

    if (first.done) {
      throw new Error("expected event from second ledger handle");
    }

    assert.equal(first.value.event.payload.id, 1);

    abortController.abort();

    const done = await nextWithTimeout(iterator);
    assert.equal(done.done, true);
  } finally {
    firstDatabase.close();
    secondDatabase.close();
    await rm(databasePath, {
      force: true,
    });
  }
});

test("tailEvents last 0 follows after another handle's current boundary", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(
    tmpdir(),
    `ledger-tail-follow-shared-${randomUUID()}.sqlite`,
  );
  const firstDatabase = new Database(databasePath);
  const secondDatabase = new Database(databasePath);

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  try {
    await using firstLedger = createBetterSqliteLedger({
      databaseUrl: databasePath,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await using secondLedger = createBetterSqliteLedger({
      databaseUrl: databasePath,
      model: model.withImplementations({
        indexers: {},
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
      },
    });

    await secondLedger.emit("message.received", { id: 1 });

    const abortController = new AbortController();
    const iterator = firstLedger
      .tailEvents({
        last: 0,
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]();

    const next = nextWithTimeout(iterator);
    assert.equal(await settlesWithin(next, 10), false);

    await firstLedger.emit("message.received", { id: 2 });

    const followed = await next;
    assert.equal(followed.done, false);

    if (followed.done) {
      throw new Error("expected followed event");
    }

    assert.equal(followed.value.event.payload.id, 2);

    abortController.abort();

    const done = await nextWithTimeout(iterator);
    assert.equal(done.done, true);
  } finally {
    firstDatabase.close();
    secondDatabase.close();
    await rm(databasePath, {
      force: true,
    });
  }
});

test("resumeEvents continues from opaque cursor", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("message.received", { id: 1 });
  await ledger.emit("message.received", { id: 2 });
  await ledger.emit("message.received", { id: 3 });

  const tailAbortController = new AbortController();
  const tailIterator = ledger
    .tailEvents({
      last: 2,
      signal: tailAbortController.signal,
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(tailIterator);

  assert.equal(first.done, false);

  if (first.done) {
    throw new Error("expected first tail event");
  }

  tailAbortController.abort();

  const resumeAbortController = new AbortController();
  const resumeIterator = ledger
    .resumeEvents({
      cursor: first.value.cursor,
      signal: resumeAbortController.signal,
    })
    [Symbol.asyncIterator]();

  const resumed = await nextWithTimeout(resumeIterator);

  assert.equal(resumed.done, false);

  if (resumed.done) {
    throw new Error("expected resumed event");
  }

  assert.equal(resumed.value.event.payload.id, 3);

  const follow = nextWithTimeout(resumeIterator);
  await ledger.emit("message.received", { id: 4 });

  const followed = await follow;

  assert.equal(followed.done, false);

  if (followed.done) {
    throw new Error("expected followed resumed event");
  }

  assert.equal(followed.value.event.payload.id, 4);

  resumeAbortController.abort();

  const done = await nextWithTimeout(resumeIterator);
  assert.equal(done.done, true);

  assert.throws(() => {
    ledger.resumeEvents({
      cursor: "bad-cursor",
      signal: AbortSignal.timeout(1_000),
    });
  });
});

test("tail iterator return stops stream without external abort", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("message.received", { id: 1 });

  const iterator = ledger
    .tailEvents({
      last: 1,
      signal: AbortSignal.timeout(30_000),
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(iterator);
  assert.equal(first.done, false);

  if (iterator.return === undefined) {
    throw new Error("expected iterator.return to exist");
  }

  const closed = await iterator.return();
  assert.equal(closed.done, true);

  const done = await nextWithTimeout(iterator);
  assert.equal(done.done, true);
});

test("cancelWork durably cancels pending work by ref before execution", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  let processed = 0;

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            {
              id: event.payload.id,
            },
            { workKey: `job:${event.payload.id}` },
          );
        },
      },
      queues: {
        "job.run": () => {
          processed += 1;
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("job.requested", { id: 1 });
  const [work] = await ledger.listWork();

  assert.notEqual(work, undefined);
  assert.equal(work?.state, "pending");

  if (work.ref === null) {
    assert.fail("expected queued work to have a ref");
  }

  const cancelled = await ledger.cancelWork({
    ref: work.ref,
    reason: "not needed",
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.work.state, "cancelled");

  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await runtime.flush();
  await runtime.advanceByMs(1_000);

  assert.equal(processed, 0);
  assert.equal(
    (await ledger.queryWork({ workId: work.workId }))?.state,
    "cancelled",
  );
});

test("cancelWork aborts an in-flight lease by ref and makes the work terminal", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const observedAbort = Promise.withResolvers<void>();
  let workId = 0;
  let workRef: {
    readonly sourceEventId: number;
    readonly signal: boolean;
    readonly queueName: string;
    readonly workKey: string;
  } | null = null;

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            {
              id: event.payload.id,
            },
            { workKey: `job:${event.payload.id}` },
          );
        },
      },
      queues: {
        "job.run": async ({ work, lease }) => {
          workId = work.workId;
          workRef = {
            sourceEventId: work.sourceEventId,
            signal: false,
            queueName: String(work.queueName),
            workKey: `job:${work.payload.id}`,
          };

          if (lease.signal.aborted) {
            observedAbort.resolve();
            return;
          }

          await new Promise<void>((resolve) => {
            lease.signal.addEventListener(
              "abort",
              () => {
                observedAbort.resolve();
                resolve();
              },
              { once: true },
            );
          });
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    leaseMs: 1_000,
  });

  await ledger.emit("job.requested", { id: 1 });
  await waitFor(runtime, () => workId !== 0);

  if (workRef === null) {
    assert.fail("expected work ref");
  }

  const cancelled = await ledger.cancelWork({
    ref: workRef,
    reason: "stop now",
  });

  assert.equal(cancelled.status, "cancelled");
  await observedAbort.promise;
  await waitFor(runtime, async () => {
    return (await ledger.queryWork({ workId }))?.state === "cancelled";
  });
});

test("terminalWorkRetentionMs prunes retained dead and cancelled work", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        mode: Type.Union([Type.Literal("cancel"), Type.Literal("dead")]),
      }),
    },
    queues: {
      "job.run": Type.Object({
        mode: Type.Union([Type.Literal("cancel"), Type.Literal("dead")]),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            {
              mode: event.payload.mode,
            },
            { workKey: `job:${event.payload.mode}` },
          );
        },
      },
      queues: {
        "job.run": ({ control }) => {
          return control.deadLetter("done");
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  await ledger.emit("job.requested", { mode: "cancel" });
  await ledger.emit("job.requested", { mode: "dead" });
  const work = await ledger.listWork();
  const cancelWork = work.find((item) => item.state === "pending");

  if (cancelWork === undefined) {
    assert.fail("expected queued work to cancel");
  }

  if (cancelWork.ref === null) {
    assert.fail("expected queued work to have a ref");
  }

  await ledger.cancelWork({ ref: cancelWork.ref });

  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    terminalWorkRetentionMs: 10,
  });

  await waitFor(runtime, async () => {
    const states = (await ledger.listWork()).map((item) => item.state);
    return states.includes("cancelled") && states.includes("dead");
  });

  await runtime.advanceByMs(11);
  await workers.close();
  await using nextWorkers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    terminalWorkRetentionMs: 10,
  });

  assert.deepEqual(await ledger.listWork(), []);
});

test("terminalWorkRetentionMs prunes no-handler dead work", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", { id: event.payload.id });
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });

  await ledger.emit("job.requested", { id: 1 });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    terminalWorkRetentionMs: 10,
  });

  await waitFor(runtime, async () => {
    return (await ledger.listWork({ states: ["dead"] })).length === 1;
  });

  await runtime.advanceByMs(11);
  await workers.close();
  await using nextWorkers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    terminalWorkRetentionMs: 10,
  });

  assert.deepEqual(await ledger.listWork(), []);
});

test("listWork applies state filters before limit", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
        delayMs: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            { id: event.payload.id },
            { availableAtMs: runtime.nowMs() + event.payload.delayMs },
          );
        },
      },
      queues: {},
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });

  await ledger.emit("job.requested", { id: 1, delayMs: 0 });
  await ledger.emit("job.requested", { id: 2, delayMs: 0 });
  await ledger.emit("job.requested", { id: 3, delayMs: 10_000 });

  const delayed = await ledger.listWork({
    states: ["delayed"],
    limit: 1,
  });

  assert.equal(delayed.length, 1);
  assert.equal(delayed[0]?.state, "delayed");
});

test("work queries do not wait for in-flight event projection transactions", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const handlerStarted = Promise.withResolvers<void>();
  const releaseHandler = Promise.withResolvers<void>();

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": async ({ event, actions }) => {
          actions.enqueue("job.run", { id: event.payload.id });
          handlerStarted.resolve();
          await releaseHandler.promise;
          throw new Error("rollback append");
        },
      },
      queues: {},
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });

  const emitPromise = ledger.emit("job.requested", { id: 1 });
  await handlerStarted.promise;

  const listPromise = ledger.listWork();
  assert.equal(await settlesWithin(listPromise, 10), true);
  assert.deepEqual(await listPromise, []);

  releaseHandler.resolve();
  await assert.rejects(async () => await emitPromise, /rollback append/);
});

test("work key migration adds column before creating ref index", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  database.exec(`
    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      causation_event_id INTEGER,
      dedupe_key TEXT UNIQUE,
      signal INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE work (
      work_id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
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
  `);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({ id: Type.Number() }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });

  await ledger.emit("job.requested", { id: 1 });

  const columns = database.prepare("PRAGMA table_info(work)").all();
  assert.equal(
    columns.some((row) => {
      return (row as { readonly name?: unknown }).name === "work_key";
    }),
    true,
  );
});

test("enqueue rejects empty work keys", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({ id: Type.Number() }),
    },
    queues: {
      "job.run": Type.Object({ id: Type.Number() }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", { id: event.payload.id }, { workKey: "" });
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });

  await assert.rejects(
    async () => await ledger.emit("job.requested", { id: 1 }),
    /workKey must be non-empty/,
  );
});
