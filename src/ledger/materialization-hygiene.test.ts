import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import type {
  LedgerStorageRow,
  LedgerStorageScope,
  LedgerStorageStatement,
} from "./internal-storage.ts";
import {
  defineLedgerShape,
  defineMaterializationHistory,
  defineMaterializationSchema,
  defineMaterializations,
  withMaterializations,
} from "./ledger.ts";
import {
  createDatabaseLedger,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import { createSqliteProjectionStatementCompiler } from "./projection-sql-compiler.ts";

type StorageCall = {
  readonly method: "all" | "exec" | "get" | "run";
  readonly params: readonly unknown[];
  readonly sql: string;
};

test("database ledger startup applies materialization history hygiene", async () => {
  const shape = defineLedgerShape({
    events: {
      "user.created": Type.Object({
        email: Type.String(),
        userId: Type.String(),
      }),
    },
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const schema = defineMaterializationSchema({
    namespace: "users",
    version: 1,
    tables: {
      users: (t) =>
        t
          .columns({
            email: t.text().notNull(),
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
    },
  });
  const history = defineMaterializationHistory(shape, schema, (m) => [
    m.migration(1, "create users", (s) => [
      s.createTable("users", (t) =>
        t
          .columns({
            email: t.text().notNull(),
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
      s.data("seed user", async ({ db }) => {
        await db
          .insertInto("users")
          .values({
            email: "ada@example.com",
            userId: "ada",
          })
          .execute();
      }),
    ]),
  ]);
  const materializations = defineMaterializations({
    history,
    indexers: {},
    queries: {},
  });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage();
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: {
      clock: {
        nowMs: () => 12_345,
      },
    },
  });

  await ledger.close();

  const userTableStatements = storage.calls.filter((call) => {
    return call.sql.includes('CREATE TABLE IF NOT EXISTS "users"');
  });
  assert.equal(userTableStatements.length, 1);
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes('INSERT INTO "users"');
    }),
    true,
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes("sledge_materialization_versions");
    }),
    true,
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes('ALTER TABLE "users"');
    }),
    false,
  );
});

function createMaterializationHygieneStorage(): {
  readonly calls: readonly StorageCall[];
  readonly runtime: StorageRuntime;
} {
  const calls: StorageCall[] = [];
  const scope: LedgerStorageScope = {
    exec: async (sql) => {
      calls.push({
        method: "exec",
        params: [],
        sql,
      });
    },
    prepare: (sql) => {
      return createStorageStatement(calls, sql);
    },
  };

  return {
    calls,
    runtime: {
      close: async () => {},
      read: async (run) => await run(scope),
      write: async (run) => await run(scope),
    },
  };
}

function createStorageStatement(
  calls: StorageCall[],
  sql: string,
): LedgerStorageStatement {
  return {
    all: async (...params) => {
      calls.push({
        method: "all",
        params,
        sql,
      });

      if (sql === "PRAGMA table_info(events)") {
        return createTableInfoRows([
          "event_id",
          "ts_ms",
          "event_name",
          "payload_json",
          "causation_event_id",
          "dedupe_key",
          "signal",
        ]);
      }

      if (sql === "PRAGMA table_info(work)") {
        return createTableInfoRows([
          "work_id",
          "queue_name",
          "work_key",
          "payload_json",
          "source_event_id",
          "signal",
          "attempt",
          "available_at_ms",
          "dead",
          "lease_id",
          "lease_acquired_at_ms",
          "lease_expires_at_ms",
          "last_error",
          "cancelled",
          "cancel_requested_at_ms",
          "cancel_reason",
          "terminal_at_ms",
        ]);
      }

      return [];
    },
    get: async (...params) => {
      calls.push({
        method: "get",
        params,
        sql,
      });

      return undefined;
    },
    run: async (...params) => {
      calls.push({
        method: "run",
        params,
        sql,
      });

      return {
        changes: 1,
        lastInsertRowid: 1,
      };
    },
  };
}

function createTableInfoRows(
  columnNames: readonly string[],
): readonly LedgerStorageRow[] {
  return columnNames.map((name) => {
    return { name };
  });
}
