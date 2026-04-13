import type Database from "better-sqlite3";
import type { TSchema } from "@sinclair/typebox";

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
  readonly database: Database.Database;
  readonly boundModel: BoundLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly timing: LedgerTiming;
  readonly leaseMs?: number;
  readonly defaultRetryDelayMs?: number;
  readonly maxInFlight?: number;
  readonly maxBusyRetries?: number;
  readonly maxBusyRetryDelayMs?: number;
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
): Ledger<TEvents, TQueries> {
  const sharedInput: CreateDatabaseLedgerInput<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  > = {
    database: wrapBetterSqliteDatabase(input.database),
    boundModel: input.boundModel,
    timing: input.timing,
    leaseMs: input.leaseMs,
    defaultRetryDelayMs: input.defaultRetryDelayMs,
    maxInFlight: input.maxInFlight,
    maxBusyRetries: input.maxBusyRetries,
    maxBusyRetryDelayMs: input.maxBusyRetryDelayMs,
  };

  return createDatabaseLedger(sharedInput);
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
    close: async () => {
      database.close();
    },
  };
}
