import { realpathSync } from "node:fs";

import Database from "better-sqlite3";

import type {
  AnyComposedLedgerModel,
  ComposedLedgerEventTokens,
  ComposedLedgerQueryTokens,
  ComposedLedgerSignalTokens,
  Ledger,
  LedgerTiming,
} from "./ledger.ts";
import {
  createComposedDatabaseLedger,
  type StorageDatabase,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import { storageRuntimeIdentityBrand } from "./internal-storage.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./projection-kysely-runtime.ts";
import { assertWalCheckpointTruncated } from "./sqlite-wal-checkpoint.ts";

const connectionOptions = {
  timeout: 0,
} satisfies Database.Options;

type CreateBetterSqliteLedgerInput<TModel extends AnyComposedLedgerModel> = {
  readonly databaseUrl: string;
  readonly model: TModel;
  readonly timing: LedgerTiming;
};

export function createBetterSqliteLedger<
  const TModel extends AnyComposedLedgerModel,
>(
  input: CreateBetterSqliteLedgerInput<TModel>,
): Ledger<
  ComposedLedgerEventTokens<TModel>,
  ComposedLedgerQueryTokens<TModel>,
  ComposedLedgerSignalTokens<TModel>
> {
  return createComposedDatabaseLedger({
    storage: createBetterSqliteStorageRuntime(input.databaseUrl),
    model: input.model,
    projectionCompiler: createRuntimeKyselySqliteProjectionStatementCompiler(),
    timing: input.timing,
  });
}

export function createBetterSqliteStorageRuntime(
  databaseUrl: string,
): StorageRuntime {
  validateDatabaseUrl(databaseUrl);

  const writer = new Database(databaseUrl, connectionOptions);
  try {
    enableForeignKeys(writer);
    const journalMode = writer.pragma("journal_mode = WAL", {
      simple: true,
    });

    if (journalMode !== "wal") {
      throw new Error(
        `databaseUrl must support WAL journal mode, received ${String(journalMode)}`,
      );
    }
  } catch (error: unknown) {
    writer.close();
    throw error;
  }

  const writerStorage = wrapBetterSqliteDatabase(writer);
  const activeReads = new Set<Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let writeTail: Promise<void> = Promise.resolve();

  const openConnection = (): Database.Database => {
    if (closed) {
      throw new Error("storage runtime is closed");
    }

    const database = new Database(databaseUrl, connectionOptions);

    try {
      enableForeignKeys(database);
      return database;
    } catch (error: unknown) {
      database.close();
      throw error;
    }
  };

  const closeConnection = (database: Database.Database): void => {
    database.close();
  };

  return {
    [storageRuntimeIdentityBrand]: realpathSync(databaseUrl),
    read: async (run) => {
      if (closed) {
        throw new Error("storage runtime is closed");
      }

      const readSettled = Promise.withResolvers<void>();
      activeReads.add(readSettled.promise);
      let database: Database.Database | null = null;

      try {
        database = openConnection();
        return await run(wrapBetterSqliteDatabase(database));
      } finally {
        try {
          if (database !== null) {
            closeConnection(database);
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
      const checkpoint = writer.pragma("wal_checkpoint(TRUNCATE)");
      assertWalCheckpointTruncated(checkpoint);
    } finally {
      writer.close();
    }
  }
}

function validateDatabaseUrl(databaseUrl: string): void {
  if (databaseUrl.length === 0) {
    throw new Error("databaseUrl must be non-empty");
  }

  if (isInMemoryDatabaseUrl(databaseUrl)) {
    throw new Error(
      "in-memory SQLite database URLs are not supported by the better-sqlite3 adapter; pass a durable filesystem path",
    );
  }

  if (isSqliteUriDatabaseUrl(databaseUrl)) {
    throw new Error(
      "SQLite URI databaseUrl values are not supported by the better-sqlite3 adapter; pass a filesystem path",
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
            throw new Error(
              "expected row object from better-sqlite statement.get",
            );
          }

          return row as Record<string, unknown>;
        },
        all: async (...params) => {
          const rows = statement.all(...params);

          return rows.map((row) => {
            if (typeof row !== "object" || row === null || Array.isArray(row)) {
              throw new Error(
                "expected row object from better-sqlite statement.all",
              );
            }

            return row as Record<string, unknown>;
          });
        },
      };
    },
  };
}

function enableForeignKeys(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  const enabled = database.pragma("foreign_keys", {
    simple: true,
  });

  if (enabled !== 1) {
    throw new Error(
      `database connection must enable foreign key enforcement, received ${String(enabled)}`,
    );
  }
}
