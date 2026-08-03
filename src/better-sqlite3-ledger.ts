import { createBetterSqliteStorageRuntime } from "./ledger/better-sqlite3-ledger.ts";
import { createLedgerDriver } from "./ledger/internal-storage.ts";
import { openLedgerApplication } from "./ledger/sledge-application.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./ledger/projection-kysely-runtime.ts";
import type { LedgerDriver } from "./sledge.ts";

type CreateBetterSqliteDriverInput = {
  readonly databaseUrl: string;
};

export function createBetterSqliteDriver(
  input: CreateBetterSqliteDriverInput,
): LedgerDriver {
  return createLedgerDriver(async ({ application, timing }) => {
    const projectionCompiler =
      createRuntimeKyselySqliteProjectionStatementCompiler();
    const storage = createBetterSqliteStorageRuntime(input.databaseUrl);

    return await openLedgerApplication({
      application,
      storage,
      projectionCompiler,
      timing,
    });
  });
}
