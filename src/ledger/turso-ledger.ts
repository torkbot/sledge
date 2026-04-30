import type { TSchema } from "typebox";
import type { Database } from "@tursodatabase/database";

import {
  createDatabaseLedger,
  type CreateDatabaseLedgerInput,
  type StorageDatabase,
} from "./database-ledger-engine.ts";
import type {
  BoundLedgerModel,
  Ledger,
  LedgerTiming,
  QuerySchema,
} from "./ledger.ts";

type AnyIndexerDef = TSchema;
type AnyQueryDef = QuerySchema<TSchema, TSchema>;

type CreateTursoLedgerInput<
  TEvents extends Record<string, TSchema>,
  TQueues extends Record<string, TSchema>,
  TIndexers extends Record<string, AnyIndexerDef>,
  TQueries extends Record<string, AnyQueryDef>,
  TSignals extends Record<string, TSchema> = {},
  TSignalQueues extends Record<string, TSchema> = {},
> = {
  readonly database: Database;
  readonly boundModel: BoundLedgerModel<
    TEvents,
    TQueues,
    TIndexers,
    TQueries,
    TSignals,
    TSignalQueues
  >;
  readonly timing: LedgerTiming;
  readonly maxBusyRetries?: number;
  readonly maxBusyRetryDelayMs?: number;
};

export function createTursoLedger<
  const TEvents extends Record<string, TSchema>,
  const TQueues extends Record<string, TSchema>,
  const TIndexers extends Record<string, AnyIndexerDef> = {},
  const TQueries extends Record<string, AnyQueryDef> = {},
  const TSignals extends Record<string, TSchema> = {},
  const TSignalQueues extends Record<string, TSchema> = {},
>(
  input: CreateTursoLedgerInput<
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
    database: wrapTursoPromiseDatabase(input.database),
    boundModel: input.boundModel,
    timing: input.timing,
    maxBusyRetries: input.maxBusyRetries,
    maxBusyRetryDelayMs: input.maxBusyRetryDelayMs,
  };

  return createDatabaseLedger(sharedInput);
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
    close: async () => {
      await database.close();
    },
  };
}
