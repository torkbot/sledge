import Database from "better-sqlite3";
import type { TSchema } from "typebox";

import type {
  Ledger,
  RegisteredLedgerModel,
  LedgerTiming,
  QuerySchema,
} from "./ledger.ts";
import type {
  AnyProjectionSchema,
  ProjectionIndexerDefinitions,
  ProjectionQueryDefinitions,
} from "./projection-access.ts";
import {
  createDatabaseLedger,
  type CreateDatabaseLedgerInput,
  type StorageDatabase,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./projection-kysely-runtime.ts";

type AnyIndexerDef = TSchema;
type AnyQueryDef = QuerySchema<TSchema, TSchema>;

const connectionOptions = {
  timeout: 0,
} satisfies Database.Options;

type CreateBetterSqliteLedgerInput<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
  TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  TQueryDefinitions extends ProjectionQueryDefinitions = {},
> = {
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
};

export function createBetterSqliteLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef>,
  const TQueries extends Record<string, AnyQueryDef>,
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
  const TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  const TQueryDefinitions extends ProjectionQueryDefinitions = {},
>(
  input: CreateBetterSqliteLedgerInput<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues,
    TProjectionSchema,
    TIndexerDefinitions,
    TQueryDefinitions
  >,
): Ledger<TEvents, TQueries, TSignals> {
  const sharedInput: CreateDatabaseLedgerInput<
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
    storage: createBetterSqliteStorageRuntime(input.databaseUrl),
    model: input.model,
    projectionCompiler: createRuntimeKyselySqliteProjectionStatementCompiler(),
    timing: input.timing,
  };

  return createDatabaseLedger(sharedInput);
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
      const operation = writeTail.then(async () => {
        if (closed) {
          throw new Error("storage runtime is closed");
        }

        return await run(writerStorage);
      });
      writeTail = operation.then(
        () => undefined,
        () => undefined,
      );

      return await operation;
    },
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      await Promise.all([writeTail, ...activeReads]);
      writer.close();
    },
  };
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
