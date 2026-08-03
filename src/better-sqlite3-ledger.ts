import { createBetterSqliteStorageRuntime } from "./ledger/better-sqlite3-ledger.ts";
import type { LedgerTiming } from "./ledger/ledger.ts";
import { openSledgeApplication } from "./ledger/sledge-application.ts";
import { createRuntimeKyselySqliteProjectionStatementCompiler } from "./ledger/projection-kysely-runtime.ts";
import type {
  OpenedSledge,
  SledgeApplication,
  SledgeApplicationCapabilities,
  SledgeApplicationModules,
} from "./sledge.ts";

type CreateBetterSqliteSledgeInput<
  TApplication extends SledgeApplication<object>,
> = {
  readonly application: TApplication;
  readonly databaseUrl: string;
  readonly timing: LedgerTiming;
};

export async function createBetterSqliteSledge<
  const TApplication extends SledgeApplication<object>,
>(
  input: CreateBetterSqliteSledgeInput<TApplication>,
): Promise<
  OpenedSledge<
    SledgeApplicationCapabilities<TApplication>,
    SledgeApplicationModules<TApplication>
  >
> {
  const projectionCompiler =
    createRuntimeKyselySqliteProjectionStatementCompiler();
  const storage = createBetterSqliteStorageRuntime(input.databaseUrl);

  return await openSledgeApplication({
    application: input.application,
    storage,
    projectionCompiler,
    timing: input.timing,
  });
}
