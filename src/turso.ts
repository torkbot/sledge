import { createLedgerDriver } from "./ledger/internal-storage.ts";
import { openLedgerApplication } from "./ledger/sledge-application.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./ledger/projection-kysely-runtime.ts";
import { createTursoStorageRuntime } from "./ledger/turso-ledger.ts";
import type { LedgerDriver } from "./sledge.ts";

type CreateTursoDriverInput = {
  readonly databaseUrl: string;
};

export function createTursoDriver(input: CreateTursoDriverInput): LedgerDriver {
  return createLedgerDriver(async ({ application, timing }) => {
    const projectionCompiler =
      createRuntimeKyselySqliteProjectionStatementCompiler();
    const storage = await createTursoStorageRuntime(input.databaseUrl);

    return await openLedgerApplication({
      application,
      storage,
      projectionCompiler,
      timing,
    });
  });
}
