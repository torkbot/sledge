import type { LedgerStorageRow } from "./ledger/internal-storage.ts";
import { SqliteQueryCompiler } from "kysely";
import {
  createLedgerDriver,
  storageRuntimeIdentityBrand,
} from "./ledger/internal-storage.ts";
import type {
  StorageDatabase,
  StorageRuntime,
} from "./ledger/database-ledger-engine.ts";
import { openLedgerApplication } from "./ledger/sledge-application.ts";
import { createKyselySqliteProjectionStatementCompiler } from "./ledger/projection-kysely-compiler.ts";
import type { KyselyProjectionQueryCompilerConstructor } from "./ledger/projection-kysely-compiler.ts";
import type { LedgerDriver } from "./sledge.ts";

type DurableObjectSqlValue =
  | ArrayBuffer
  | bigint
  | boolean
  | number
  | string
  | null;

interface DurableObjectSqlCursor<
  TRow extends Record<string, DurableObjectSqlValue>,
> extends Iterable<TRow> {
  readonly rowsWritten: number;
  toArray(): TRow[];
}

interface DurableObjectSqlStorage {
  exec<TRow extends Record<string, DurableObjectSqlValue>>(
    query: string,
    ...bindings: readonly DurableObjectSqlValue[]
  ): DurableObjectSqlCursor<TRow>;
}

export interface SledgeDurableObjectStorage {
  readonly sql: DurableObjectSqlStorage;

  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

type CreateDurableObjectDriverInput = {
  readonly databaseIdentity: string;
  readonly storage: SledgeDurableObjectStorage;
};

// Sledge deliberately models only the stable compileQuery subset of Kysely's
// compiler. Kysely types that method against a closed operation-node union,
// while Sledge constructs structurally compatible nodes without importing
// Kysely internals. The runtime adapter is the necessary type-erasure seam.
const DurableObjectSqliteQueryCompiler =
  SqliteQueryCompiler as unknown as KyselyProjectionQueryCompilerConstructor;

/**
 * Uses the SQLite database already owned by a Durable Object. The object
 * runtime remains responsible for exclusive database ownership and commit
 * durability; Sledge remains responsible for its event/work transactions.
 */
export function createDurableObjectDriver(
  input: CreateDurableObjectDriverInput,
): LedgerDriver {
  if (input.databaseIdentity.length === 0) {
    throw new Error("databaseIdentity must be non-empty");
  }

  return createLedgerDriver(async ({ application, timing }) => {
    const projectionCompiler = createKyselySqliteProjectionStatementCompiler({
      SqliteQueryCompiler: DurableObjectSqliteQueryCompiler,
    });
    const storage = createDurableObjectStorageRuntime(input);

    return await openLedgerApplication({
      application,
      storage,
      projectionCompiler,
      timing,
    });
  });
}

function createDurableObjectStorageRuntime(
  input: CreateDurableObjectDriverInput,
): StorageRuntime {
  let closed = false;

  return {
    [storageRuntimeIdentityBrand]: input.databaseIdentity,
    read: async (run) => {
      assertOpen();
      return await run(wrapSqlStorage(input.storage.sql));
    },
    write: async (run) => {
      assertOpen();

      return await input.storage.transaction(async () => {
        return await run(wrapSqlStorage(input.storage.sql, true));
      });
    },
    close: async () => {
      closed = true;
    },
  };

  function assertOpen(): void {
    if (closed) {
      throw new Error("storage runtime is closed");
    }
  }
}

function wrapSqlStorage(
  sql: DurableObjectSqlStorage,
  ownsTransaction = false,
): StorageDatabase {
  return {
    exec: async (statement) => {
      if (ownsTransaction && isTransactionControlStatement(statement)) {
        return;
      }

      consume(sql.exec(statement));
    },
    prepare: (statement) => ({
      run: async (...params) => {
        const cursor = sql.exec(statement, ...encodeBindings(params));
        consume(cursor);
        const lastInsertRow = sql
          .exec<{
            readonly last_insert_rowid: number | bigint;
          }>("SELECT last_insert_rowid() AS last_insert_rowid")
          .toArray()[0];

        if (lastInsertRow === undefined) {
          throw new Error("SQLite did not return last_insert_rowid()");
        }

        return {
          changes: cursor.rowsWritten,
          lastInsertRowid: lastInsertRow.last_insert_rowid,
        };
      },
      get: async (...params) => {
        return sql
          .exec<
            Record<string, DurableObjectSqlValue>
          >(statement, ...encodeBindings(params))
          .toArray()[0] as LedgerStorageRow | undefined;
      },
      all: async (...params) => {
        return sql
          .exec<
            Record<string, DurableObjectSqlValue>
          >(statement, ...encodeBindings(params))
          .toArray() as readonly LedgerStorageRow[];
      },
    }),
  };
}

function isTransactionControlStatement(statement: string): boolean {
  const normalized = statement.trim().toUpperCase();

  return (
    normalized === "BEGIN IMMEDIATE" ||
    normalized === "COMMIT" ||
    normalized === "ROLLBACK"
  );
}

function encodeBindings(
  params: readonly unknown[],
): readonly DurableObjectSqlValue[] {
  return params.map((param) => {
    if (
      param === null ||
      typeof param === "bigint" ||
      typeof param === "boolean" ||
      typeof param === "number" ||
      typeof param === "string" ||
      param instanceof ArrayBuffer
    ) {
      return param;
    }

    if (ArrayBuffer.isView(param)) {
      return new Uint8Array(
        new Uint8Array(param.buffer, param.byteOffset, param.byteLength),
      ).buffer;
    }

    throw new TypeError(`unsupported SQLite binding: ${typeof param}`);
  });
}

function consume(cursor: Iterable<unknown>): void {
  for (const _row of cursor) {
    // Exhausting the cursor completes statements that return rows.
  }
}
