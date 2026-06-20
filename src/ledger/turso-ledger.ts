import { connect, type Database } from "@tursodatabase/database";
import type { TSchema } from "typebox";

import {
  createDatabaseLedger,
  type CreateDatabaseLedgerInput,
  type StorageDatabase,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import type {
  RegisteredLedgerModel,
  Ledger,
  LedgerTiming,
  QuerySchema,
} from "./ledger.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./projection-kysely-runtime.ts";
import type {
  AnyProjectionSchema,
  ProjectionIndexerDefinitions,
  ProjectionQueryDefinitions,
} from "./projection-access.ts";

type AnyIndexerDef = TSchema;
type AnyQueryDef = QuerySchema<TSchema, TSchema>;

type CreateTursoLedgerInput<
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

export async function createTursoLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef> = {},
  const TQueries extends Record<string, AnyQueryDef> = {},
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
  const TProjectionSchema extends AnyProjectionSchema = AnyProjectionSchema,
  const TIndexerDefinitions extends ProjectionIndexerDefinitions<string> = {},
  const TQueryDefinitions extends ProjectionQueryDefinitions = {},
>(
  input: CreateTursoLedgerInput<
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
): Promise<Ledger<TEvents, TQueries, TSignals>> {
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
    storage: await createTursoStorageRuntime(input.databaseUrl),
    model: input.model,
    projectionCompiler: createRuntimeKyselySqliteProjectionStatementCompiler(),
    timing: input.timing,
  };

  return createDatabaseLedger(sharedInput);
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
    read: async (run) => {
      if (closed) {
        throw new Error("storage runtime is closed");
      }

      const readSettled = Promise.withResolvers<void>();
      activeReads.add(readSettled.promise);
      let database: Database | null = null;

      try {
        database = await openConnection();
        if (closed) {
          throw new Error("storage runtime is closed");
        }

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
      await writer.close();
    },
  };
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
