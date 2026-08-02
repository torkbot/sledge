import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import {
  storageRuntimeIdentityBrand,
  type LedgerStorageRow,
  type LedgerStorageScope,
  type LedgerStorageStatement,
} from "./internal-storage.ts";
import {
  defineLedgerShape,
  defineMaterialization,
  type LedgerTiming,
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

const materializationHygieneRuntime = new VirtualRuntimeHarness(12_345);
const materializationHygieneTiming: LedgerTiming = {
  clock: materializationHygieneRuntime.clock,
  scheduler: materializationHygieneRuntime.scheduler,
};

function physicalName(
  moduleId: string,
  kind: "index" | "materialization" | "table",
  name: string,
): string {
  return `sledge::${moduleId}::${kind}::${name}`;
}

test("database ledger startup applies materialization history hygiene", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.apply-history",
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
  const materializations = defineMaterialization(shape, {
    namespace: "users",
  })
    .version(1, "create users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              email: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .data("seed user", async ({ db }) => {
          await db
            .insertInto("users")
            .values({
              email: "ada@example.com",
              userId: "ada",
            })
            .execute();
        }),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage();
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await ledger.close();

  const usersTable = physicalName("hygiene.apply-history", "table", "users");
  const userTableStatements = storage.calls.filter((call) => {
    return call.sql.includes(`CREATE TABLE IF NOT EXISTS "${usersTable}"`);
  });
  assert.equal(userTableStatements.length, 1);
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes(`INSERT INTO "${usersTable}"`);
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
      return call.sql.includes(`ALTER TABLE "${usersTable}"`);
    }),
    false,
  );
});

test("database ledger startup replays fresh materializations in migration order", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.fresh-order",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const materializations = defineMaterialization(shape, {
    namespace: "ordered-fresh",
  })
    .version(1, "create and seed users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              email: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .data("seed user", async ({ db }) => {
          await db
            .insertInto("users")
            .values({
              email: "ada@example.com",
              userId: "ada",
            })
            .execute();
        }),
    )
    .version(2, "enforce unique emails", (s) =>
      s.createUniqueIndex("usersByEmail", "users", ["email"]),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage();
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await ledger.close();

  const usersTable = physicalName("hygiene.fresh-order", "table", "users");
  const usersByEmailIndex = physicalName(
    "hygiene.fresh-order",
    "index",
    "usersByEmail",
  );
  const insertUserCallIndex = storage.calls.findIndex((call) => {
    return call.sql.includes(`INSERT INTO "${usersTable}"`);
  });
  const createEmailIndexCallIndex = storage.calls.findIndex((call) => {
    return call.sql.includes(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${usersByEmailIndex}"`,
    );
  });

  assert.notEqual(insertUserCallIndex, -1);
  assert.notEqual(createEmailIndexCallIndex, -1);
  assert.equal(insertUserCallIndex < createEmailIndexCallIndex, true);
});

test("database ledger startup re-reads materialization version under the migration lock", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.lock-reread",
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
  const materializations = defineMaterialization(shape, {
    namespace: "users",
  })
    .version(1, "create users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              email: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .data("seed user", async ({ db }) => {
          await db
            .insertInto("users")
            .values({
              email: "ada@example.com",
              userId: "ada",
            })
            .execute();
        }),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage({
    materializationVersions: [undefined, 1],
  });
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await ledger.close();

  const versionReads = storage.calls.filter((call) => {
    return call.sql.includes(
      "SELECT version FROM sledge_materialization_versions",
    );
  });
  assert.equal(versionReads.length, 2);
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes(
        `CREATE TABLE IF NOT EXISTS "${physicalName(
          "hygiene.lock-reread",
          "table",
          "users",
        )}"`,
      );
    }),
    false,
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes(
        `INSERT INTO "${physicalName(
          "hygiene.lock-reread",
          "table",
          "users",
        )}"`,
      );
    }),
    false,
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql === "COMMIT";
    }),
    true,
  );
});

test("database ledger startup creates indexes for incremental create-table migrations", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.incremental-indexes",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const materializations = defineMaterialization(shape, {
    namespace: "sessions",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "create sessions", (s) =>
      s.createTable("sessions", (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
            userId: t.text().notNull(),
          })
          .primaryKey(["sessionId"])
          .index("sessionsByUser", ["userId"]),
      ),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage({
    materializationVersions: [1, 1],
  });
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await ledger.close();

  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes(
        `CREATE TABLE IF NOT EXISTS "${physicalName(
          "hygiene.incremental-indexes",
          "table",
          "users",
        )}"`,
      );
    }),
    false,
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes(
        `CREATE TABLE IF NOT EXISTS "${physicalName(
          "hygiene.incremental-indexes",
          "table",
          "sessions",
        )}"`,
      );
    }),
    true,
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes(
        `CREATE INDEX IF NOT EXISTS "${physicalName(
          "hygiene.incremental-indexes",
          "index",
          "sessionsByUser",
        )}"`,
      );
    }),
    true,
  );
  assert.equal(
    storage.calls.some((call) => {
      return (
        call.sql.includes("sledge_materialization_versions") &&
        call.method === "run" &&
        call.params[1] === 2
      );
    }),
    true,
  );
});

test("database ledger startup preserves foreign keys for incrementally created tables", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.incremental-foreign-keys",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const materializations = defineMaterialization(shape, {
    namespace: "sessions-with-users",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "create sessions", (s) =>
      s
        .createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
              userId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        )
        .addForeignKey("sessionUser", (r) =>
          r.foreignKey("sessions", ["userId"]).references("users", ["userId"]),
        ),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage({
    materializationVersions: [1, 1],
  });
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await ledger.close();

  const sessionsTable = physicalName(
    "hygiene.incremental-foreign-keys",
    "table",
    "sessions",
  );
  const usersTable = physicalName(
    "hygiene.incremental-foreign-keys",
    "table",
    "users",
  );
  const createSessions = storage.calls.find((call) => {
    return call.sql.includes(`CREATE TABLE IF NOT EXISTS "${sessionsTable}"`);
  });

  assert.ok(createSessions !== undefined);
  assert.match(
    createSessions.sql,
    new RegExp(
      `CONSTRAINT "sessionUser" FOREIGN KEY \\("userId"\\) REFERENCES "${usersTable}" \\("userId"\\) ON DELETE RESTRICT`,
    ),
  );
});

test("database ledger startup rejects foreign keys that depend on same-migration added columns", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.late-foreign-key-columns",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const materializations = defineMaterialization(shape, {
    namespace: "late-foreign-key-columns",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "create sessions", (s) =>
      s
        .createTable("sessions", (t) =>
          t
            .columns({
              sessionId: t.text().notNull(),
            })
            .primaryKey(["sessionId"]),
        )
        .addColumn("sessions", "userId", (t) => t.text())
        .addForeignKey("sessionUser", (r) =>
          r.foreignKey("sessions", ["userId"]).references("users", ["userId"]),
        ),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage({
    materializationVersions: [1, 1],
  });
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await assert.rejects(
    async () => {
      await ledger.close();
    },
    (error: unknown) => {
      return errorTreeIncludesMessage(
        error,
        `materialization ${physicalName(
          "hygiene.late-foreign-key-columns",
          "materialization",
          "late-foreign-key-columns",
        )} migration cannot add foreign key sessionUser incrementally on SQLite`,
      );
    },
  );
  assert.equal(
    storage.calls.some((call) => {
      return call.sql.includes('CONSTRAINT "sessionUser"');
    }),
    false,
  );
});

test("database ledger startup runs data migrations against replayed schema state", async () => {
  const shape = defineLedgerShape({
    moduleId: "hygiene.replayed-data",
    events: {},
    queues: {},
    signals: {},
    signalQueues: {},
  });
  const materializations = defineMaterialization(shape, {
    namespace: "replayed-data",
  })
    .version(1, "create users", (s) =>
      s
        .createTable("users", (t) =>
          t
            .columns({
              userId: t.text().notNull(),
            })
            .primaryKey(["userId"]),
        )
        .data("try future table", async ({ db }) => {
          await db
            // @ts-expect-error Future tables are not visible to earlier data migrations.
            .insertInto("sessions")
            .values({
              // @ts-expect-error Future table columns are not visible either.
              sessionId: "s_1",
            })
            .execute();
        }),
    )
    .version(2, "create sessions", (s) =>
      s.createTable("sessions", (t) =>
        t
          .columns({
            sessionId: t.text().notNull(),
          })
          .primaryKey(["sessionId"]),
      ),
    )
    .define({
      indexers: {},
      queries: {},
    });
  const model = withMaterializations(shape, materializations).register({});
  const storage = createMaterializationHygieneStorage();
  const ledger = createDatabaseLedger({
    model,
    projectionCompiler: createSqliteProjectionStatementCompiler(),
    storage: storage.runtime,
    timing: materializationHygieneTiming,
  });

  await assert.rejects(
    async () => {
      await ledger.close();
    },
    (error: unknown) => {
      return errorTreeIncludesMessage(error, "projection table sessions");
    },
  );
});

function createMaterializationHygieneStorage(input?: {
  readonly materializationVersions?: readonly (number | undefined)[];
}): {
  readonly calls: readonly StorageCall[];
  readonly runtime: StorageRuntime;
} {
  const calls: StorageCall[] = [];
  const materializationVersions = [...(input?.materializationVersions ?? [])];
  const state: {
    ledgerRootModuleIdsJson: string | null;
  } = {
    ledgerRootModuleIdsJson: null,
  };
  const scope: LedgerStorageScope = {
    exec: async (sql) => {
      calls.push({
        method: "exec",
        params: [],
        sql,
      });
    },
    prepare: (sql) => {
      return createStorageStatement(calls, sql, materializationVersions, state);
    },
  };

  return {
    calls,
    runtime: {
      close: async () => {},
      [storageRuntimeIdentityBrand]: `materialization-hygiene:${randomUUID()}`,
      read: async (run) => await run(scope),
      write: async (run) => await run(scope),
    },
  };
}

function createStorageStatement(
  calls: StorageCall[],
  sql: string,
  materializationVersions: (number | undefined)[],
  state: {
    ledgerRootModuleIdsJson: string | null;
  },
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
          "causation_work_json",
          "dedupe_key",
          "signal",
        ]);
      }

      if (sql === "PRAGMA table_info(work)") {
        return createTableInfoRows([
          "work_id",
          "queue_name",
          "work_key",
          "partition_key",
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

      if (
        sql.includes("SELECT version FROM sledge_materialization_versions") &&
        materializationVersions.length > 0
      ) {
        const version = materializationVersions.shift();

        if (version === undefined) {
          return undefined;
        }

        return {
          version,
        };
      }

      if (
        sql.includes("FROM sledge_ledger_root") &&
        state.ledgerRootModuleIdsJson !== null
      ) {
        return {
          module_ids_json: state.ledgerRootModuleIdsJson,
        };
      }

      if (
        sql.includes("AS latest_event_id") &&
        sql.includes("FROM sledge_history")
      ) {
        return {
          expired_through_event_id: 0,
          latest_event_id: 0,
        };
      }

      return undefined;
    },
    run: async (...params) => {
      calls.push({
        method: "run",
        params,
        sql,
      });

      if (
        sql.includes("INSERT INTO sledge_ledger_root") &&
        state.ledgerRootModuleIdsJson === null
      ) {
        const [moduleIdsJson] = params;

        if (typeof moduleIdsJson !== "string") {
          throw new Error("invalid composed ledger root identity");
        }

        state.ledgerRootModuleIdsJson = moduleIdsJson;
      }

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

function errorTreeIncludesMessage(error: unknown, message: string): boolean {
  if (error instanceof Error && error.message.includes(message)) {
    return true;
  }

  if (error instanceof AggregateError) {
    return error.errors.some((cause: unknown) => {
      return errorTreeIncludesMessage(cause, message);
    });
  }

  return false;
}
