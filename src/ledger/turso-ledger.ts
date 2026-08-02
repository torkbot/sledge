import { realpathSync } from "node:fs";

import { connect, type Database } from "@tursodatabase/database";

import {
  createComposedDatabaseLedger,
  type StorageDatabase,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import type {
  ComposedLedgerEventTokens,
  ComposedLedgerQueryTokens,
  ComposedLedgerSignalTokens,
  Ledger,
  LedgerModelSource,
  LedgerTiming,
  ComposedLedgerModelFor,
} from "./ledger.ts";
import { storageRuntimeIdentityBrand } from "./internal-storage.ts";
import { resolveLedgerModelSource } from "./ledger-model-resolution.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./projection-kysely-runtime.ts";
import { assertWalCheckpointTruncated } from "./sqlite-wal-checkpoint.ts";

type CreateTursoLedgerInput<TSource extends LedgerModelSource> = {
  readonly databaseUrl: string;
  readonly model: TSource;
  readonly timing: LedgerTiming;
};

export async function createTursoLedger<
  const TSource extends LedgerModelSource,
>(
  input: CreateTursoLedgerInput<TSource>,
): Promise<
  Ledger<
    ComposedLedgerEventTokens<ComposedLedgerModelFor<TSource>>,
    ComposedLedgerQueryTokens<ComposedLedgerModelFor<TSource>>,
    ComposedLedgerSignalTokens<ComposedLedgerModelFor<TSource>>
  >
> {
  const storage = await createTursoStorageRuntime(input.databaseUrl);
  const projectionCompiler =
    createRuntimeKyselySqliteProjectionStatementCompiler();
  let storageTransferred = false;

  try {
    const model = await resolveLedgerModelSource({
      source: input.model,
      storage,
      projectionCompiler,
      timing: input.timing,
    });

    const ledger = createComposedDatabaseLedger({
      storage,
      model,
      projectionCompiler,
      timing: input.timing,
    });
    storageTransferred = true;

    try {
      await ledger.ready();
      return ledger;
    } catch (error: unknown) {
      try {
        await ledger.abortOpen();
      } catch (closeError: unknown) {
        throw new AggregateError(
          [error, closeError],
          "failed to open ledger and close storage",
        );
      }

      throw error;
    }
  } catch (error: unknown) {
    if (storageTransferred) {
      throw error;
    }

    try {
      await storage.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        "failed to resolve ledger model and close storage",
      );
    }

    throw error;
  }
}

export async function createTursoStorageRuntime(
  databaseUrl: string,
): Promise<StorageRuntime> {
  validateDatabaseUrl(databaseUrl);

  const writer = await connect(databaseUrl);
  try {
    await enableForeignKeys(writer);
  } catch (error: unknown) {
    await writer.close();
    throw error;
  }

  const writerStorage = wrapTursoPromiseDatabase(writer);
  const activeReads = new Set<Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let writeTail: Promise<void> = Promise.resolve();

  const openConnection = async (): Promise<Database> => {
    if (closed) {
      throw new Error("storage runtime is closed");
    }

    const database = await connect(databaseUrl);

    try {
      await enableForeignKeys(database);
      return database;
    } catch (error: unknown) {
      await database.close();
      throw error;
    }
  };

  const closeConnection = async (database: Database): Promise<void> => {
    await database.close();
  };

  return {
    [storageRuntimeIdentityBrand]: realpathSync(databaseUrl),
    read: async (run) => {
      if (closed) {
        throw new Error("storage runtime is closed");
      }

      const readSettled = Promise.withResolvers<void>();
      activeReads.add(readSettled.promise);
      let database: Database | null = null;

      try {
        database = await openConnection();
        return await run(wrapTursoPromiseDatabase(database));
      } finally {
        try {
          if (database !== null) {
            await closeConnection(database);
          }
        } finally {
          activeReads.delete(readSettled.promise);
          readSettled.resolve();
        }
      }
    },
    write: async (run) => {
      if (closed) {
        throw new Error("storage runtime is closed");
      }

      const operation = writeTail.then(async () => await run(writerStorage));
      writeTail = operation.then(
        () => undefined,
        () => undefined,
      );

      return await operation;
    },
    close: () => {
      closePromise ??= closeStorageRuntime();
      return closePromise;
    },
  };

  async function closeStorageRuntime(): Promise<void> {
    closed = true;
    await Promise.all([writeTail, ...activeReads]);

    try {
      const checkpoint = await writer.pragma("wal_checkpoint(TRUNCATE)", {});
      assertWalCheckpointTruncated(checkpoint);
    } finally {
      await writer.close();
    }
  }
}

function validateDatabaseUrl(databaseUrl: string): void {
  if (databaseUrl.length === 0) {
    throw new Error("databaseUrl must be non-empty");
  }

  if (isInMemoryDatabaseUrl(databaseUrl)) {
    throw new Error(
      "in-memory SQLite database URLs are not supported by the Turso adapter; pass a durable filesystem path",
    );
  }

  if (isSqliteUriDatabaseUrl(databaseUrl)) {
    throw new Error(
      "SQLite URI databaseUrl values are not supported by the Turso adapter; pass a filesystem path",
    );
  }
}

function isInMemoryDatabaseUrl(databaseUrl: string): boolean {
  if (databaseUrl === ":memory:") {
    return true;
  }

  if (!databaseUrl.startsWith("file:")) {
    return false;
  }

  const queryStart = databaseUrl.indexOf("?");
  const fileTarget =
    queryStart === -1
      ? databaseUrl.slice("file:".length)
      : databaseUrl.slice("file:".length, queryStart);
  const params =
    queryStart === -1
      ? new URLSearchParams()
      : new URLSearchParams(databaseUrl.slice(queryStart + 1));
  const usesMemory =
    fileTarget === ":memory:" || params.get("mode") === "memory";

  return usesMemory;
}

function isSqliteUriDatabaseUrl(databaseUrl: string): boolean {
  return databaseUrl.startsWith("file:");
}

function wrapTursoPromiseDatabase(database: Database): StorageDatabase {
  return {
    exec: async (sql) => {
      await database.exec(sql);
    },
    prepare: (sql) => {
      const statement = database.prepare(sql);

      return {
        run: async (...params) => await statement.run(...params),
        get: async (...params) => {
          const row = await statement.get(...params);

          if (row === undefined) {
            return undefined;
          }

          if (typeof row !== "object" || row === null || Array.isArray(row)) {
            throw new Error("expected row object from turso statement.get");
          }

          return row as Record<string, unknown>;
        },
        all: async (...params) => {
          const rows = await statement.all(...params);

          return rows.map((row) => {
            if (typeof row !== "object" || row === null || Array.isArray(row)) {
              throw new Error("expected row object from turso statement.all");
            }

            return row as Record<string, unknown>;
          });
        },
      };
    },
  };
}

async function enableForeignKeys(database: Database): Promise<void> {
  await database.exec("PRAGMA foreign_keys = ON");
}
