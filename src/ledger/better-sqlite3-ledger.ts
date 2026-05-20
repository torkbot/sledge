import Database from "better-sqlite3";
import type { TSchema } from "typebox";

import type {
  Ledger,
  BoundLedgerModel,
  LedgerTiming,
  QuerySchema,
} from "./ledger.ts";
import {
  createDatabaseLedger,
  type CreateDatabaseLedgerInput,
  type StorageDatabase,
  type StorageRuntime,
} from "./database-ledger-engine.ts";

type AnyIndexerDef = TSchema;
type AnyQueryDef = QuerySchema<TSchema, TSchema>;

type CreateBetterSqliteLedgerInput<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> = {
  readonly databaseUrl: string;
  readonly boundModel: BoundLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
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
>(
  input: CreateBetterSqliteLedgerInput<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >,
): Ledger<TEvents, TQueries, TSignals> {
  const sharedInput: CreateDatabaseLedgerInput<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  > = {
    storage: createBetterSqliteStorageRuntime(input.databaseUrl),
    boundModel: input.boundModel,
    timing: input.timing,
  };

  return createDatabaseLedger(sharedInput);
}

export function createBetterSqliteStorageRuntime(
  databaseUrl: string,
): StorageRuntime {
  validateDatabaseUrl(databaseUrl);

  const writer = new Database(databaseUrl);
  const writerStorage = wrapBetterSqliteDatabase(writer);
  let closed = false;
  let writeTail: Promise<void> = Promise.resolve();

  const openConnection = (): Database.Database => {
    if (closed) {
      throw new Error("storage runtime is closed");
    }

    return new Database(databaseUrl);
  };

  const closeConnection = (database: Database.Database): void => {
    database.close();
  };

  return {
    read: async (run) => {
      const database = openConnection();

      try {
        return await run(wrapBetterSqliteDatabase(database));
      } finally {
        closeConnection(database);
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
      await writeTail;
      writer.close();
    },
  };
}

function validateDatabaseUrl(databaseUrl: string): void {
  if (databaseUrl === ":memory:") {
    throw new Error(
      "plain :memory: databases are not supported; use a shared memory URL such as file:sledge?mode=memory&cache=shared",
    );
  }

  if (databaseUrl.length === 0) {
    throw new Error("databaseUrl must be non-empty");
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
