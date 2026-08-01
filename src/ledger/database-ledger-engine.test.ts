import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { RuntimeScheduler } from "../runtime/contracts.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import {
  createBetterSqliteLedger as createPublicBetterSqliteLedger,
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
  storageRuntimeIdentityBrand,
  type LedgerImplementations,
} from "./internal-storage.ts";
import {
  composeLedgerModels,
  defineLedgerShape,
  type EnqueueOptions,
  type LedgerTiming,
  type RegisteredLedgerModel,
  type LedgerModel,
  type QuerySchema,
  type RegisterFunction,
  type SignalEnqueueOptions,
} from "./ledger.ts";
import type { DatabaseLedger } from "./database-ledger-engine.ts";
import type {
  AnyProjectionSchema,
  ProjectionIndexerDefinitions,
  ProjectionQueryDefinitions,
} from "./projection-access.ts";
import { createSqliteProjectionStatementCompiler } from "./projection-sql-compiler.ts";
import { defineProjectionSchema } from "./projections.ts";
import { createTursoStorageRuntime } from "./turso-ledger.ts";

const projectionCompiler = createSqliteProjectionStatementCompiler();

function createBetterSqliteLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, TSchema>,
  const TQueries extends Record<string, QuerySchema<TSchema, TSchema>>,
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
  const TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  const TQueryDefinitions extends ProjectionQueryDefinitions = {},
>(input: {
  readonly databaseUrl: string;
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
}): DatabaseLedger<TEvents, TQueries, TSignals> {
  return createDatabaseLedger({
    storage: createBetterSqliteStorageRuntime(input.databaseUrl),
    model: input.model,
    projectionCompiler,
    timing: input.timing,
  });
}

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
  readonly eventOutcomes?: {
    readonly [TEventName in keyof TEvents]: TSchema | null;
  };
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
    eventOutcomes:
      input.eventOutcomes ??
      (Object.fromEntries(
        Object.keys(input.events).map((eventName) => [eventName, null]),
      ) as {
        readonly [TEventName in keyof TEvents]: TSchema | null;
      }),
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
        moduleId: "engine.fixture",
        materializationHistory: null,
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

function createImmediateJobTestModel(queueHandler: () => void | Promise<void>) {
  return defineEngineFixtureModel({
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
        "job.run": queueHandler,
      },
    },
  });
}

function singleConnectionStorageRuntime(
  database: StorageDatabase,
): StorageRuntime {
  return {
    [storageRuntimeIdentityBrand]: `single-connection-test:${randomUUID()}`,
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

test("storage runtimes reject in-memory database URLs", async () => {
  assert.throws(
    () => createBetterSqliteStorageRuntime(":memory:"),
    /in-memory SQLite database URLs are not supported/,
  );
  assert.throws(
    () => createBetterSqliteStorageRuntime("file::memory:"),
    /in-memory SQLite database URLs are not supported/,
  );
  assert.throws(
    () => createBetterSqliteStorageRuntime("file:ledger?mode=memory"),
    /in-memory SQLite database URLs are not supported/,
  );

  await assert.rejects(
    async () => await createTursoStorageRuntime(":memory:"),
    /in-memory SQLite database URLs are not supported/,
  );
  await assert.rejects(
    async () => await createTursoStorageRuntime("file::memory:"),
    /in-memory SQLite database URLs are not supported/,
  );
  await assert.rejects(
    async () => await createTursoStorageRuntime("file:ledger?mode=memory"),
    /in-memory SQLite database URLs are not supported/,
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

test("storage runtimes reject SQLite URI database URLs", async () => {
  assert.throws(
    () => createBetterSqliteStorageRuntime("file:ledger.sqlite?mode=rwc"),
    /SQLite URI databaseUrl values are not supported/,
  );

  await assert.rejects(
    async () => await createTursoStorageRuntime("file:ledger.sqlite?mode=rwc"),
    /SQLite URI databaseUrl values are not supported/,
  );
});

test("storage runtimes do not persist literal files for shared memory URLs", async () => {
  const filePrefix = `file:sledge-${Date.now()}-${Math.random()}`;
  const databaseUrl = `${filePrefix}?mode=memory&cache=shared`;
  const before = new Set(await readdir(process.cwd()));

  try {
    assert.throws(
      () => createBetterSqliteStorageRuntime(databaseUrl),
      /in-memory/,
    );
    await assert.rejects(
      async () => await createTursoStorageRuntime(databaseUrl),
      /in-memory/,
    );
  } finally {
    const createdEntries = (await readdir(process.cwd())).filter((entry) => {
      return !before.has(entry) && entry.startsWith(filePrefix);
    });

    for (const entry of createdEntries) {
      await rm(entry, { force: true });
    }

    assert.deepEqual(createdEntries, []);
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

for (const driver of ["better-sqlite3", "turso"] as const) {
  test(`${driver} runtime close finishes reads accepted before close`, async () => {
    const databaseUrl = createTempDatabasePath();
    const storage =
      driver === "better-sqlite3"
        ? createBetterSqliteStorageRuntime(databaseUrl)
        : await createTursoStorageRuntime(databaseUrl);

    try {
      const read = storage.read(async (database) => {
        const row = await database.prepare("SELECT 42 AS value").get();
        return row?.value;
      });
      const closing = storage.close();

      assert.equal(await read, 42);
      await closing;
    } finally {
      await storage.close();
      await rm(databaseUrl, { force: true });
      await rm(`${databaseUrl}-wal`, { force: true });
      await rm(`${databaseUrl}-shm`, { force: true });
    }
  });

  test(`${driver} runtime close finishes writes accepted before close`, async () => {
    const databaseUrl = createTempDatabasePath();
    const storage =
      driver === "better-sqlite3"
        ? createBetterSqliteStorageRuntime(databaseUrl)
        : await createTursoStorageRuntime(databaseUrl);
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();

    try {
      const write = storage.write(async (database) => {
        await database.exec(
          "CREATE TABLE close_write (id INTEGER PRIMARY KEY)",
        );
        writeStarted.resolve();
        await releaseWrite.promise;
        await database.prepare("INSERT INTO close_write (id) VALUES (1)").run();
      });
      const queuedWrite = storage.write(async (database) => {
        await database.prepare("INSERT INTO close_write (id) VALUES (2)").run();
      });

      await writeStarted.promise;

      const closing = storage.close();
      assert.equal(await settlesWithin(closing, 10), false);

      releaseWrite.resolve();
      await write;
      await queuedWrite;
      await closing;

      const inspector = new Database(databaseUrl, { readonly: true });
      try {
        assert.equal(
          inspector.prepare("SELECT COUNT(*) FROM close_write").pluck().get(),
          2,
        );
      } finally {
        inspector.close();
      }
    } finally {
      releaseWrite.resolve();
      await storage.close();
      await rm(databaseUrl, { force: true });
      await rm(`${databaseUrl}-wal`, { force: true });
      await rm(`${databaseUrl}-shm`, { force: true });
    }
  });
}

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
      if (sql.includes("SELECT candidate.available_at_ms")) {
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
        sql.includes("SELECT candidate.work_id") &&
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

test("idle workers wake promptly for sibling-runtime commits", async () => {
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
  const workerLedger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  const emitterLedger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  let workers: Awaited<ReturnType<typeof workerLedger.startWorkers>> | null =
    null;

  try {
    workers = await workerLedger.startWorkers({
      scheduler: runtime.scheduler,
    });

    await runtime.flush();
    await emitterLedger.emit("job.requested", { id: 1 });

    assert.equal(processed, 0);
    assert.equal(readCount(database, `SELECT COUNT(*) as total FROM work`), 1);

    await runtime.flush();
    await waitFor(runtime, () => processed === 1);
    await waitFor(
      runtime,
      () => readCount(database, `SELECT COUNT(*) as total FROM work`) === 0,
    );
  } finally {
    await workers?.close();
    database.close();
    await emitterLedger.close();
    await workerLedger.close();
    await rm(databaseUrl, {
      force: true,
    });
  }
});

test("store discovery remains independent of a known durable deadline", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const processed: number[] = [];

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({
        availableAtMs: Type.Number(),
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
            {
              availableAtMs: event.payload.availableAtMs,
              workKey: `job:${event.payload.id}`,
            },
          );
        },
      },
      queues: {
        "job.run": ({ work }) => {
          processed.push(work.payload.id);
        },
      },
    },
  }).withImplementations({
    indexers: {},
    queries: {},
  });

  const workerLedger = createBetterSqliteLedger({
    databaseUrl,
    model,
    timing: {
      clock: runtime.clock,
    },
  });
  let workers: Awaited<ReturnType<typeof workerLedger.startWorkers>> | null =
    null;
  let emitterDatabase: Database.Database | null = null;

  try {
    await workerLedger.emit("job.requested", {
      availableAtMs: runtime.nowMs() + 5_000,
      id: 1,
    });
    workers = await workerLedger.startWorkers({
      scheduler: runtime.scheduler,
    });
    await runtime.flush();

    const externalDatabase = new Database(databaseUrl, { timeout: 0 });
    emitterDatabase = externalDatabase;
    externalDatabase.pragma("foreign_keys = ON");
    const delayed = Value.Decode(
      Type.Object({
        queue_name: Type.String(),
        source_event_id: Type.Number(),
      }),
      externalDatabase
        .prepare(
          `SELECT queue_name, source_event_id
           FROM work
           ORDER BY work_id ASC
           LIMIT 1`,
        )
        .get(),
    );

    externalDatabase
      .prepare(
        `INSERT INTO work (
           queue_name,
           payload_json,
           source_event_id,
           signal,
           attempt,
           available_at_ms,
           dead
         ) VALUES (?, ?, ?, 0, 0, ?, 0)`,
      )
      .run(
        delayed.queue_name,
        JSON.stringify({ id: 2 }),
        delayed.source_event_id,
        runtime.nowMs(),
      );

    await runtime.advanceByMs(999);
    assert.deepEqual(processed, []);

    await runtime.advanceByMs(1);
    await waitFor(runtime, () => processed.length === 1);
    assert.deepEqual(processed, [2]);
    await waitFor(
      runtime,
      () =>
        readCount(
          externalDatabase,
          `SELECT COUNT(*) AS total FROM work WHERE lease_id IS NOT NULL`,
        ) === 0,
    );
  } finally {
    await workers?.close();
    emitterDatabase?.close();
    await workerLedger.close();
    await rm(databaseUrl, { force: true });
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
    [storageRuntimeIdentityBrand]: databaseUrl,
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

test("ledger startup initialization is isolated per database", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const firstDatabaseUrl = createTempDatabasePath();
  const secondDatabaseUrl = createTempDatabasePath();
  const firstStorageRuntime =
    createBetterSqliteStorageRuntime(firstDatabaseUrl);
  const secondStorageRuntime =
    createBetterSqliteStorageRuntime(secondDatabaseUrl);
  const firstStartupEntered = Promise.withResolvers<void>();
  const allowFirstStartup = Promise.withResolvers<void>();
  let firstWrite = true;
  const firstStorage: StorageRuntime = {
    [storageRuntimeIdentityBrand]:
      firstStorageRuntime[storageRuntimeIdentityBrand],
    read: async (run) => await firstStorageRuntime.read(run),
    write: async (run) => {
      return await firstStorageRuntime.write(async (database) => {
        if (firstWrite) {
          firstWrite = false;
          firstStartupEntered.resolve();
          await allowFirstStartup.promise;
        }

        return await run(database);
      });
    },
    close: async () => await firstStorageRuntime.close(),
  };
  const model = defineEngineFixtureModel({
    events: {},
    queues: {},
    indexers: {},
    queries: {},
    register: {},
  });
  const firstLedger = createDatabaseLedger({
    projectionCompiler,
    storage: firstStorage,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });
  const secondLedger = createDatabaseLedger({
    projectionCompiler,
    storage: secondStorageRuntime,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  try {
    await firstStartupEntered.promise;

    const secondStartup = secondLedger.listWork();
    assert.equal(await settlesWithin(secondStartup, 50), true);
    assert.deepEqual(await secondStartup, []);
  } finally {
    allowFirstStartup.resolve();
    await Promise.allSettled([firstLedger.close(), secondLedger.close()]);
    await rm(firstDatabaseUrl, { force: true });
    await rm(secondDatabaseUrl, { force: true });
  }
});

test("ledger close closes storage after startup failure", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  let closeCalls = 0;

  const storage: StorageRuntime = {
    [storageRuntimeIdentityBrand]: `startup-failure-test:${randomUUID()}`,
    read: async () => {
      throw new Error("unexpected read");
    },
    write: async () => {
      throw new Error("startup failed");
    },
    close: async () => {
      closeCalls += 1;
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

  const isExpectedFailure = (error: unknown): boolean => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "failed to close ledger");
    assert.equal(error.errors.length, 1);

    const failure = error.errors[0];
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "startup failed");

    return true;
  };

  await assert.rejects(ledger.close(), isExpectedFailure);
  await assert.rejects(ledger.close(), isExpectedFailure);
  assert.equal(closeCalls, 1);
});

test("worker failures preserve arbitrary rejection reasons", async () => {
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
        sql.includes("SELECT candidate.work_id") &&
        sql.includes("available_at_ms <= ?")
      ) {
        failedClaim = true;

        return {
          run: statement.run,
          all: statement.all,
          get: async () => {
            throw null;
          },
        };
      }

      return statement;
    },
  };

  const model = createImmediateJobTestModel(() => undefined);

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
  const workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });
  await runtime.flush();

  try {
    await workers.waitForIdle({
      signal: new AbortController().signal,
    });
    assert.fail("expected waitForIdle to reject");
  } catch (error: unknown) {
    assert.equal(error, null);
  }

  await assert.rejects(
    async () => {
      await ledger.close();
    },
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "failed to close ledger workers");
      assert.equal(error.errors.length, 1);
      assert.equal(error.errors[0], null);

      return true;
    },
  );
});

test("worker supervision reports work-processing failures", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const storage = createBetterSqliteStorageRuntime(databaseUrl);
  let ackFailed = false;

  const failingStorage: StorageRuntime = {
    [storageRuntimeIdentityBrand]: storage[storageRuntimeIdentityBrand],
    read: async (run) => await storage.read(run),
    write: async (run) => {
      return await storage.write(async (database) => {
        const failingDatabase: StorageDatabase = {
          exec: database.exec,
          prepare: (sql): StorageStatement => {
            const statement = database.prepare(sql);

            if (
              !ackFailed &&
              sql.includes("DELETE FROM work") &&
              sql.includes("lease_id = ?")
            ) {
              return {
                get: statement.get,
                all: statement.all,
                run: async () => {
                  ackFailed = true;
                  throw new Error("ack failed");
                },
              };
            }

            return statement;
          },
        };

        return await run(failingDatabase);
      });
    },
    close: async () => await storage.close(),
  };

  const model = createImmediateJobTestModel(() => undefined);

  const ledger = createDatabaseLedger({
    projectionCompiler,
    storage: failingStorage,
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  try {
    await ledger.emit("job.requested", { id: 1 });
    const workers = await ledger.startWorkers({
      scheduler: runtime.scheduler,
    });
    const waiting = workers.waitForIdle({
      signal: new AbortController().signal,
    });

    await waitFor(runtime, () => ackFailed);
    await assert.rejects(waiting, /ack failed/);

    await assert.rejects(ledger.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "failed to close ledger workers");
      assert.equal(error.errors.length, 1);

      const failure = error.errors[0];
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, "ack failed");

      return true;
    });

    const inspector = new Database(databaseUrl);

    try {
      assert.equal(
        readCount(
          inspector,
          "SELECT COUNT(*) AS total FROM work WHERE lease_id IS NULL",
        ),
        1,
      );
    } finally {
      inspector.close();
    }
  } finally {
    await storage.close();
  }
});

test("worker supervision reports sibling wake scheduling failures", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const schedulingFailure = new Error("sibling wake scheduling failed");
  let failNextOneShot = false;

  const scheduler: RuntimeScheduler = {
    scheduleOnce: (delayMs, task) => {
      if (failNextOneShot) {
        failNextOneShot = false;
        throw schedulingFailure;
      }

      return runtime.scheduler.scheduleOnce(delayMs, task);
    },
    scheduleRepeating: (everyMs, task) =>
      runtime.scheduler.scheduleRepeating(everyMs, task),
  };
  const model = createImmediateJobTestModel(
    () => undefined,
  ).withImplementations({
    indexers: {},
    queries: {},
  });
  const workerLedger = createBetterSqliteLedger({
    databaseUrl,
    model,
    timing: {
      clock: runtime.clock,
    },
  });
  const emitterLedger = createBetterSqliteLedger({
    databaseUrl,
    model,
    timing: {
      clock: runtime.clock,
    },
  });

  try {
    const workers = await workerLedger.startWorkers({ scheduler });
    const waitAbortController = new AbortController();

    failNextOneShot = true;
    await emitterLedger.emit("job.requested", { id: 1 });
    const waiting = workers.waitForIdle({
      signal: waitAbortController.signal,
    });
    await runtime.flush();

    runtime.scheduler.scheduleOnce(1, () => {
      waitAbortController.abort(new Error("worker failure was not supervised"));
    });
    await runtime.advanceByMs(1);

    await assert.rejects(waiting, (error: unknown) => {
      assert.equal(error, schedulingFailure);
      return true;
    });
    await emitterLedger.close();
    await assert.rejects(workerLedger.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "failed to close ledger workers");
      assert.deepEqual(error.errors, [schedulingFailure]);
      return true;
    });
  } finally {
    await Promise.allSettled([emitterLedger.close(), workerLedger.close()]);
    await rm(databaseUrl, { force: true });
  }
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

test("waitForIdle waits for work and supports cancellation", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const releaseHandler = Promise.withResolvers<void>();
  let handlerStarted = false;

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
      queues: {
        "job.run": async () => {
          handlerStarted = true;
          await releaseHandler.promise;
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

  const waitController = new AbortController();

  await workers.waitForIdle({
    signal: waitController.signal,
  });

  await ledger.emit("job.requested", {
    id: 1,
    delayMs: 100,
  });

  let idle = false;
  const waiting = workers
    .waitForIdle({
      signal: waitController.signal,
    })
    .then(() => {
      idle = true;
    });

  await runtime.advanceByMs(99);
  assert.equal(idle, false);

  await runtime.advanceByMs(1);
  await waitFor(runtime, () => handlerStarted);
  assert.equal(idle, false);

  releaseHandler.resolve();
  await waitFor(runtime, () => idle);
  await waiting;

  await ledger.emit("job.requested", {
    id: 2,
    delayMs: 10_000,
  });

  const abortedWaitController = new AbortController();
  const abortedWait = workers.waitForIdle({
    signal: abortedWaitController.signal,
  });
  const reason = new Error("stop waiting");

  abortedWaitController.abort(reason);

  await assert.rejects(abortedWait, (error: unknown) => error === reason);
});

test("waitForIdle aborts while its durable-state read is still pending", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const storage = wrapBetterSqliteDatabase(database);
  const idleReadStarted = Promise.withResolvers<void>();
  const releaseIdleRead = Promise.withResolvers<void>();
  const idleReadFinished = Promise.withResolvers<void>();

  const blockingStorage: StorageDatabase = {
    exec: storage.exec,
    prepare: (sql): StorageStatement => {
      const statement = storage.prepare(sql);

      if (
        sql.includes("FROM work") &&
        sql.includes("cancelled = 0") &&
        !sql.includes("lease_id")
      ) {
        return {
          run: statement.run,
          all: statement.all,
          get: async () => {
            idleReadStarted.resolve();
            await releaseIdleRead.promise;

            try {
              throw new Error("late idle read failure");
            } finally {
              idleReadFinished.resolve();
            }
          },
        };
      }

      return statement;
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
    storage: singleConnectionStorageRuntime(blockingStorage),
    model: model.withImplementations({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
    },
  });

  try {
    const workers = await ledger.startWorkers({
      scheduler: runtime.scheduler,
    });
    const waitController = new AbortController();
    const waiting = workers.waitForIdle({
      signal: waitController.signal,
    });

    await idleReadStarted.promise;

    const reason = new Error("stop waiting");
    waitController.abort(reason);

    await assert.rejects(waiting, (error: unknown) => error === reason);

    releaseIdleRead.resolve();
    await idleReadFinished.promise;
    await workers.close();
    await ledger.close();
  } finally {
    database.close();
  }
});

test("waitForIdle exits a pending durable-state read when workers close or fail", async (t) => {
  for (const transition of ["close", "failure"] as const) {
    await t.test(transition, async () => {
      const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
      const databaseUrl = createTempDatabasePath();
      const database = new Database(databaseUrl);
      const storage = wrapBetterSqliteDatabase(database);
      const idleReadStarted = Promise.withResolvers<void>();
      const releaseIdleRead = Promise.withResolvers<void>();
      const idleReadFinished = Promise.withResolvers<void>();
      const workerFailure = new Error("worker failed");

      const blockingStorage: StorageDatabase = {
        exec: storage.exec,
        prepare: (sql): StorageStatement => {
          const statement = storage.prepare(sql);

          if (
            sql.includes("FROM work") &&
            sql.includes("cancelled = 0") &&
            !sql.includes("lease_id")
          ) {
            return {
              run: statement.run,
              all: statement.all,
              get: async () => {
                idleReadStarted.resolve();
                await releaseIdleRead.promise;

                try {
                  throw new Error("late idle read failure");
                } finally {
                  idleReadFinished.resolve();
                }
              },
            };
          }

          if (
            transition === "failure" &&
            sql.includes("SELECT candidate.work_id") &&
            sql.includes("available_at_ms <= ?")
          ) {
            return {
              run: statement.run,
              all: statement.all,
              get: async () => {
                throw workerFailure;
              },
            };
          }

          return statement;
        },
      };

      const model = createImmediateJobTestModel(() => undefined);
      const ledger = createDatabaseLedger({
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

      try {
        const workers = await ledger.startWorkers({
          scheduler: runtime.scheduler,
        });
        const waiting = workers.waitForIdle({
          signal: new AbortController().signal,
        });

        await idleReadStarted.promise;

        if (transition === "close") {
          const closing = workers.close();

          await assert.rejects(
            waiting,
            /ledger workers closed while waiting to become idle/,
          );
          await closing;
        } else {
          await ledger.emit("job.requested", { id: 1 });
          await runtime.flush();

          await assert.rejects(
            waiting,
            (error: unknown) => error === workerFailure,
          );
          await assert.rejects(
            workers.close(),
            (error: unknown) => error === workerFailure,
          );
        }

        releaseIdleRead.resolve();
        await idleReadFinished.promise;
        await ledger.close();
      } finally {
        database.close();
      }
    });
  }
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
      /dedupe key message:42 already belongs to another event contract/,
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

test("queue emissions require an unexpired authenticated lease", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const releaseFirstAttempt = Promise.withResolvers<void>();
  const firstAttemptReturned = Promise.withResolvers<void>();
  let firstAttemptEntered = false;
  let secondAttemptEntered = false;
  let immediateError: unknown;

  const shape = defineLedgerShape({
    moduleId: "lease-authentication.test",
    events: {
      jobRequested: Type.Object({
        id: Type.Number(),
      }),
      jobCompleted: Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      runJob: Type.Object({
        id: Type.Number(),
      }),
    },
  });
  const module = shape.register({
    events: {
      jobRequested: ({ event, actions }) => {
        actions.enqueue("runJob", event.payload);
      },
    },
    queues: {
      runJob: async ({ work, lease, actions, ledger }) => {
        if (work.attempt > 1) {
          secondAttemptEntered = true;
          await new Promise<void>((resolve) => {
            lease.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          lease.signal.throwIfAborted();
          return;
        }

        firstAttemptEntered = true;
        await releaseFirstAttempt.promise;

        try {
          await ledger.emit(shape.events.jobCompleted, {
            id: work.payload.id,
          });
        } catch (error: unknown) {
          immediateError = error;
        }

        actions.emit("jobCompleted", {
          id: work.payload.id,
        });
        firstAttemptReturned.resolve();
      },
    },
  });

  await using ledger = createPublicBetterSqliteLedger({
    databaseUrl,
    model: composeLedgerModels(module),
    timing: { clock: runtime.clock },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
    leaseMs: 1_000,
  });

  const requested = await ledger.emit(shape.events.jobRequested, {
    id: 1,
  });
  await waitFor(runtime, () => firstAttemptEntered);

  const expiry = database
    .prepare(
      `UPDATE work
       SET lease_expires_at_ms = ?
       WHERE lease_id IS NOT NULL`,
    )
    .run(runtime.nowMs() - 1);

  assert.equal(expiry.changes, 1);
  releaseFirstAttempt.resolve();
  await firstAttemptReturned.promise;
  await runtime.advanceByMs(1_000);
  await waitFor(runtime, () => secondAttemptEntered);

  assert.match(String(immediateError), /lost its lease/);
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*)
         FROM events
         WHERE event_id > ?`,
      )
      .pluck()
      .get(requested.eventId),
    0,
  );
});

test("queue handlers publish signals immediately before handler completion", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const gate = Promise.withResolvers<void>();
  let observerCount = 0;
  let observedSignalEventId: number | null = null;

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

  const subscription = ledger.onSignal("response.delta", (signal) => {
    observerCount += 1;
    observedSignalEventId = signal.eventId;
  });

  await ledger.emit("response.generate", { id: 1 });
  await waitFor(runtime, () => observerCount === 1);

  if (observedSignalEventId === null) {
    assert.fail("expected observed signal event id");
  }

  assert.equal(
    readCount(
      database,
      `SELECT COUNT(*) as total FROM events WHERE signal = 1 AND event_id = ${observedSignalEventId}`,
    ),
    0,
  );

  gate.resolve();
  await waitFor(
    runtime,
    () => readCount(database, `SELECT COUNT(*) as total FROM work`) === 0,
  );
  assert.equal(
    readCount(
      database,
      `SELECT COUNT(*) as total FROM events WHERE signal = 1 AND event_id = ${observedSignalEventId}`,
    ),
    0,
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

test("event consumers abort while a storage read is still pending", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);
  const storage = wrapBetterSqliteDatabase(database);
  const eventReadStarted = Promise.withResolvers<void>();
  const releaseEventRead = Promise.withResolvers<void>();
  const eventReadFinished = Promise.withResolvers<void>();

  const blockingStorage: StorageDatabase = {
    exec: storage.exec,
    prepare: (sql): StorageStatement => {
      const statement = storage.prepare(sql);

      if (sql.includes("FROM events") && sql.includes("event_id > ?")) {
        return {
          run: statement.run,
          get: statement.get,
          all: async (...params) => {
            eventReadStarted.resolve();
            await releaseEventRead.promise;

            try {
              return await statement.all(...params);
            } finally {
              eventReadFinished.resolve();
            }
          },
        };
      }

      return statement;
    },
  };

  const model = createBusyTestModel();
  const ledger = createDatabaseLedger({
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

  try {
    await ledger.listWork();

    const abortController = new AbortController();
    const iterator = ledger
      .tailEvents({
        last: 0,
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]();
    const next = iterator.next();

    await eventReadStarted.promise;
    abortController.abort();

    assert.equal(await settlesWithin(next, 20), true);
    assert.equal((await next).done, true);

    releaseEventRead.resolve();
    await eventReadFinished.promise;
    await ledger.close();
  } finally {
    database.close();
  }
});

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
  const leasedWork = await ledger.queryWork({ workId });

  if (leasedWork?.ref === null || leasedWork === null) {
    assert.fail("expected work ref");
  }

  const cancelled = await ledger.cancelWork({
    ref: leasedWork.ref,
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

  let idle = false;
  const waiting = workers
    .waitForIdle({
      signal: new AbortController().signal,
    })
    .then(() => {
      idle = true;
    });

  await waitFor(runtime, () => idle);
  await waiting;

  const states = (await ledger.listWork()).map((item) => item.state);
  assert.ok(states.includes("cancelled"));
  assert.ok(states.includes("dead"));

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

test("storage metadata migration adds event and work columns before indexes", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  database.exec(`
    CREATE TABLE sledge_storage_layout (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL,
      module_ids_json TEXT NOT NULL
    );

    INSERT INTO sledge_storage_layout (singleton, version, module_ids_json)
    VALUES (1, 1, '["engine.fixture"]');

    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      causation_event_id INTEGER,
      dedupe_key TEXT UNIQUE,
      signal INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO events (
      ts_ms,
      event_name,
      payload_json,
      causation_event_id,
      dedupe_key,
      signal
    ) VALUES (
      1899999999999,
      'job.requested',
      '{"id":0}',
      NULL,
      'legacy-event',
      0
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

    INSERT INTO work (
      queue_name,
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
    ) VALUES (
      'legacy.run',
      '{}',
      1,
      0,
      1,
      1899999999999,
      0,
      'legacy-lease',
      1899999999999,
      1900000001000,
      NULL
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

  const eventColumns = database.prepare("PRAGMA table_info(events)").all();
  const eventColumnNames = eventColumns.map((row) => {
    return (row as { readonly name?: unknown }).name;
  });

  assert.ok(eventColumnNames.includes("causation_work_json"));
  assert.equal(
    (
      database
        .prepare(
          `SELECT causation_work_json
           FROM events
           WHERE dedupe_key = ?`,
        )
        .get("legacy-event") as
        | { readonly causation_work_json?: unknown }
        | undefined
    )?.causation_work_json,
    null,
  );

  const columns = database.prepare("PRAGMA table_info(work)").all();
  const columnNames = columns.map((row) => {
    return (row as { readonly name?: unknown }).name;
  });

  assert.ok(columnNames.includes("work_ref"));
  assert.ok(columnNames.includes("work_key"));
  assert.ok(columnNames.includes("coalescing_key"));
  assert.ok(columnNames.includes("partition_key"));
  assert.ok(columnNames.includes("lease_protocol_version"));

  assert.deepEqual(
    database
      .prepare(
        `SELECT lease_id, lease_protocol_version
         FROM work
         WHERE queue_name = 'legacy.run'`,
      )
      .get(),
    {
      lease_id: null,
      lease_protocol_version: 0,
    },
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT version
         FROM sledge_storage_layout
         WHERE singleton = 1`,
      )
      .get(),
    {
      version: 2,
    },
  );
  assert.throws(() => {
    database
      .prepare(
        `UPDATE work
           SET
             lease_id = 'legacy-reclaim',
             lease_acquired_at_ms = 1900000000000,
             lease_expires_at_ms = 1900000001000
           WHERE queue_name = 'legacy.run'`,
      )
      .run();
  }, /sledge_authenticated_queue_lease/);

  const indexes = database.prepare("PRAGMA index_list(work)").all();
  const indexNames = indexes.map((row) => {
    return (row as { readonly name?: unknown }).name;
  });

  assert.ok(indexNames.includes("idx_work_ref"));
  assert.ok(indexNames.includes("idx_work_key"));
  assert.ok(indexNames.includes("idx_work_coalescing_pending"));
  assert.ok(indexNames.includes("idx_work_partition_order"));
});

test("storage derives coalescing reservations from authenticated claim state", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  const database = new Database(databaseUrl);

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({ logicalId: Type.String() }),
    },
    queues: {
      "job.run": Type.Object({ logicalId: Type.String() }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            { logicalId: event.payload.logicalId },
            {
              coalescingKey: event.payload.logicalId,
              partitionKey: event.payload.logicalId,
            },
          );
        },
      },
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });

  const firstEvent = await ledger.emit("job.requested", {
    logicalId: "job",
  });

  // Reservation membership derives from the attempt and lease fields rather
  // than requiring every claimant to clear coalescing_key itself.
  const claim = database
    .prepare(
      `UPDATE work
       SET
         attempt = attempt + 1,
         lease_id = ?,
         lease_acquired_at_ms = ?,
         lease_expires_at_ms = ?,
         lease_protocol_version = 1
       WHERE source_event_id = ?`,
    )
    .run(
      "old-worker-lease",
      runtime.nowMs(),
      runtime.nowMs() + 30_000,
      firstEvent.eventId,
    );

  assert.equal(claim.changes, 1);

  const retainedKey = database
    .prepare(
      `SELECT coalescing_key
       FROM work
       WHERE source_event_id = ?`,
    )
    .pluck()
    .get(firstEvent.eventId);

  assert.equal(retainedKey, "job");

  const successorEvent = await ledger.emit("job.requested", {
    logicalId: "job",
  });
  const work = await ledger.listWork();

  assert.deepEqual(
    work.map((item) => ({
      sourceEventId: item.sourceEventId,
      attempt: item.attempt,
      state: item.state,
    })),
    [
      {
        sourceEventId: firstEvent.eventId,
        attempt: 1,
        state: "leased",
      },
      {
        sourceEventId: successorEvent.eventId,
        attempt: 0,
        state: "pending",
      },
    ],
  );
});

test("turso storage derives coalescing reservations from authenticated claim state", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({ logicalId: Type.String() }),
    },
    queues: {
      "job.run": Type.Object({ logicalId: Type.String() }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            { logicalId: event.payload.logicalId },
            {
              coalescingKey: event.payload.logicalId,
              partitionKey: event.payload.logicalId,
            },
          );
        },
      },
    },
  });
  const storage = await createTursoStorageRuntime(databaseUrl);

  const ledger = createDatabaseLedger({
    storage,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    projectionCompiler,
    timing: { clock: runtime.clock },
  });

  const firstEvent = await ledger.emit("job.requested", {
    logicalId: "job",
  });
  const claimantStorage = await createTursoStorageRuntime(databaseUrl);

  try {
    const claim = await claimantStorage.write(async (database) => {
      return await database
        .prepare(
          `UPDATE work
           SET
             attempt = attempt + 1,
             lease_id = ?,
             lease_acquired_at_ms = ?,
             lease_expires_at_ms = ?,
             lease_protocol_version = 1
           WHERE source_event_id = ?`,
        )
        .run(
          "old-worker-lease",
          runtime.nowMs(),
          runtime.nowMs() + 30_000,
          firstEvent.eventId,
        );
    });

    assert.equal(claim.changes, 1);
  } finally {
    await claimantStorage.close();
  }

  const successorEvent = await ledger.emit("job.requested", {
    logicalId: "job",
  });
  const work = await ledger.listWork();

  assert.deepEqual(
    work.map((item) => ({
      sourceEventId: item.sourceEventId,
      attempt: item.attempt,
      state: item.state,
    })),
    [
      {
        sourceEventId: firstEvent.eventId,
        attempt: 1,
        state: "leased",
      },
      {
        sourceEventId: successorEvent.eventId,
        attempt: 0,
        state: "pending",
      },
    ],
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

test("durable coalescing has one unambiguous enqueue identity", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();

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
          const uncheckedOptions = {
            coalescingKey: "job",
            workKey: "job",
          } as unknown as EnqueueOptions;

          actions.enqueue(
            "job.run",
            { id: event.payload.id },
            uncheckedOptions,
          );
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
    /workKey and coalescingKey are mutually exclusive/,
  );
});

test("signal enqueue rejects coalescing options from untyped callers", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databaseUrl = createTempDatabasePath();
  let signalError: unknown = null;

  const model = defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({ id: Type.Number() }),
    },
    signals: {
      "job.signalled": Type.Object({ id: Type.Number() }),
    },
    queues: {
      "job.run": Type.Object({ id: Type.Number() }),
    },
    signalQueues: {
      "job.signal": Type.Object({ id: Type.Number() }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue("job.run", { id: event.payload.id });
        },
      },
      queues: {
        "job.run": async ({ work, actions }) => {
          try {
            await actions.emitSignal("job.signalled", {
              id: work.payload.id,
            });
          } catch (error: unknown) {
            signalError = error;
          }
        },
      },
      signals: {
        "job.signalled": ({ event, actions }) => {
          const uncheckedOptions = {
            coalescingKey: "job",
          } as unknown as SignalEnqueueOptions;

          actions.enqueueSignal(
            "job.signal",
            { id: event.payload.id },
            uncheckedOptions,
          );
        },
      },
      signalQueues: {},
    },
  });

  await using ledger = createBetterSqliteLedger({
    databaseUrl,
    model: model.withImplementations({ indexers: {}, queries: {} }),
    timing: { clock: runtime.clock },
  });
  await using workers = await ledger.startWorkers({
    scheduler: runtime.scheduler,
  });

  await ledger.emit("job.requested", { id: 1 });
  await waitFor(runtime, () => signalError !== null);

  assert.match(
    String(signalError),
    /signal queue work does not support coalescingKey/,
  );
  assert.deepEqual(await ledger.listWork({ queueName: "job.signal" }), []);
});

test("enqueue option types keep coalescing off signal queues", () => {
  defineEngineFixtureModel({
    events: {
      "job.requested": Type.Object({ id: Type.Number() }),
    },
    signals: {
      "job.signalled": Type.Object({ id: Type.Number() }),
    },
    queues: {
      "job.run": Type.Object({ id: Type.Number() }),
    },
    signalQueues: {
      "job.signal": Type.Object({ id: Type.Number() }),
    },
    indexers: {},
    queries: {},
    register: {
      events: {
        "job.requested": ({ event, actions }) => {
          actions.enqueue(
            "job.run",
            { id: event.payload.id },
            // @ts-expect-error Durable work cannot have two logical identities.
            { coalescingKey: "job", workKey: "job" },
          );
        },
      },
      signals: {
        "job.signalled": ({ event, actions }) => {
          const durableOptions: EnqueueOptions = {
            coalescingKey: "job",
          };

          actions.enqueueSignal(
            "job.signal",
            { id: event.payload.id },
            // @ts-expect-error Process-local signal queues do not coalesce.
            { coalescingKey: "job" },
          );
          actions.enqueueSignal(
            "job.signal",
            { id: event.payload.id },
            // @ts-expect-error Durable coalescing options cannot be reused.
            durableOptions,
          );
        },
      },
    },
  });
});
