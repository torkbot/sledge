import type { TSchema } from "typebox";

import type {
  AnyRegisteredLedgerModule,
  LedgerModuleContribution,
  LedgerTiming,
  QueryParameters,
  QueryResult,
  QueryToken,
} from "./ledger.ts";
import type { AnyComposedLedgerModel } from "./ledger-composition.ts";
import {
  createComposedDatabaseLedger,
  createPreparedComposedDatabaseLedger,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import {
  composeRegisteredLedgerModules,
  isLedgerModuleContribution,
  readLedgerApplicationConfigure,
  storageRuntimeIdentityBrand,
} from "./internal-storage.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";
import type {
  ApplicationLedger,
  LedgerApplication,
  LedgerApplicationCapabilities,
  LedgerAssembly,
  OpenedLedger,
} from "../sledge.ts";

type RuntimeLedgerConfigure<TCapabilities extends object> = (
  assembly: LedgerAssembly,
) => TCapabilities | Promise<TCapabilities>;

type PreparedLedger = ReturnType<
  typeof createPreparedComposedDatabaseLedger<AnyComposedLedgerModel>
>;

/**
 * Runs one application definition against adapter-owned storage. Every query
 * observes an immutable prefix of the installed module order. Returning from
 * the definition revokes the assembly before the owning ledger is opened.
 */
async function resolveLedgerApplication<
  const TApplication extends LedgerApplication<object>,
>(input: {
  readonly application: TApplication;
  readonly storage: StorageRuntime;
  readonly projectionCompiler: ProjectionStatementCompiler;
  readonly timing: LedgerTiming;
}): Promise<{
  readonly capabilities: LedgerApplicationCapabilities<TApplication>;
  readonly model: AnyComposedLedgerModel;
}> {
  const configure = readLedgerApplicationConfigure<
    RuntimeLedgerConfigure<LedgerApplicationCapabilities<TApplication>>
  >(input.application);

  if (configure === undefined) {
    throw new Error("invalid ledger application");
  }

  const modules: AnyRegisteredLedgerModule[] = [];
  const moduleIds = new Set<string>();
  const resolutionQueries: Promise<unknown>[] = [];
  const preparedLedgersByModuleCount = new Map<
    number,
    Promise<PreparedLedger>
  >();
  let assemblyOpen = true;
  const borrowedStorage: StorageRuntime = {
    [storageRuntimeIdentityBrand]: input.storage[storageRuntimeIdentityBrand],
    read: async (run) => await input.storage.read(run),
    write: async (run) => await input.storage.write(run),
    close: async () => undefined,
  };

  await using preparedLedgers = new AsyncDisposableStack();

  const assertAssemblyOpen = (): void => {
    if (!assemblyOpen) {
      throw new Error("ledger assembly has already closed");
    }
  };

  const composeModules = (
    installed: readonly [
      AnyRegisteredLedgerModule,
      ...AnyRegisteredLedgerModule[],
    ],
  ): AnyComposedLedgerModel => {
    const [first, ...rest] = installed;

    return composeRegisteredLedgerModules(
      first,
      ...rest,
    ) as AnyComposedLedgerModel;
  };

  const prepareModules = (
    installed: readonly [
      AnyRegisteredLedgerModule,
      ...AnyRegisteredLedgerModule[],
    ],
  ): Promise<PreparedLedger> => {
    const existing = preparedLedgersByModuleCount.get(installed.length);

    if (existing !== undefined) {
      return existing;
    }

    const preparing = (async () => {
      const ledger = createPreparedComposedDatabaseLedger({
        storage: borrowedStorage,
        model: composeModules(installed),
        projectionCompiler: input.projectionCompiler,
        timing: input.timing,
      });

      try {
        await ledger.ready();
      } catch (error: unknown) {
        await ledger.abortOpen().catch(() => undefined);
        throw error;
      }

      preparedLedgers.use(ledger);
      return ledger;
    })();

    preparedLedgersByModuleCount.set(installed.length, preparing);
    return preparing;
  };

  const runQuery = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      assertAssemblyOpen();
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    let result: Promise<T>;

    try {
      result = operation();
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    resolutionQueries.push(result);
    void result.catch(() => undefined);

    return result;
  };

  const install = <
    TModule extends AnyRegisteredLedgerModule,
    TCapabilities extends object,
  >(
    contribution: LedgerModuleContribution<TCapabilities, TModule>,
  ): TCapabilities => {
    assertAssemblyOpen();

    if (!isLedgerModuleContribution(contribution)) {
      throw new Error("invalid ledger module contribution");
    }

    const moduleId = contribution.module.moduleId.toLowerCase();

    if (moduleIds.has(moduleId)) {
      throw new Error(
        `duplicate ledger module id ${contribution.module.moduleId}`,
      );
    }

    moduleIds.add(moduleId);
    modules.push(contribution.module);
    return contribution.capabilities;
  };
  const query = <
    const TQuery extends QueryToken<string, string, TSchema, TSchema>,
  >(
    queryToken: TQuery,
    params: QueryParameters<NoInfer<TQuery>>,
  ): Promise<QueryResult<TQuery>> =>
    runQuery(async () => {
      const [first, ...rest] = modules;

      if (first === undefined) {
        throw new Error(
          "ledger application must install at least one module before querying",
        );
      }

      const ledger = await prepareModules([first, ...rest]);
      return await ledger.query(queryToken, params);
    });
  const assembly = Object.freeze({
    install,
    query,
  });

  let configuration:
    | {
        readonly status: "fulfilled";
        readonly value: LedgerApplicationCapabilities<TApplication>;
      }
    | { readonly status: "rejected"; readonly reason: unknown };

  try {
    configuration = {
      status: "fulfilled",
      value: await configure(assembly),
    };
  } catch (reason: unknown) {
    configuration = { status: "rejected", reason };
  }

  // Values and methods may escape through application closures. Revoke the
  // assembly first, then settle every query that began while it was valid so
  // abandoned failures cannot be hidden and prepared readers cannot overlap
  // the owning runtime.
  assemblyOpen = false;
  const queryFailures = (await Promise.allSettled(resolutionQueries)).flatMap(
    (result) => (result.status === "rejected" ? [result.reason] : []),
  );

  if (configuration.status === "rejected") {
    const additionalFailures = queryFailures.filter(
      (failure) => failure !== configuration.reason,
    );

    if (additionalFailures.length > 0) {
      throw new AggregateError(
        [configuration.reason, ...additionalFailures],
        "ledger application definition and assembly queries failed",
      );
    }

    throw configuration.reason;
  }

  if (queryFailures.length === 1) {
    throw queryFailures[0];
  }

  if (queryFailures.length > 1) {
    throw new AggregateError(
      queryFailures,
      "ledger application assembly queries failed",
    );
  }

  const [first, ...rest] = modules;

  if (first === undefined) {
    throw new Error("ledger application must install at least one module");
  }

  return {
    capabilities: configuration.value,
    model: composeModules([first, ...rest]),
  };
}

/** Opens the final graph and transfers adapter storage ownership atomically. */
export async function openLedgerApplication<
  const TApplication extends LedgerApplication<object>,
>(input: {
  readonly application: TApplication;
  readonly storage: StorageRuntime;
  readonly projectionCompiler: ProjectionStatementCompiler;
  readonly timing: LedgerTiming;
}): Promise<OpenedLedger<LedgerApplicationCapabilities<TApplication>>> {
  let storageTransferred = false;

  try {
    const resolved = await resolveLedgerApplication(input);
    const ledger = createComposedDatabaseLedger({
      storage: input.storage,
      model: resolved.model,
      projectionCompiler: input.projectionCompiler,
      timing: input.timing,
    });
    storageTransferred = true;

    try {
      await ledger.ready();
    } catch (error: unknown) {
      try {
        await ledger.abortOpen();
      } catch (closeError: unknown) {
        throw new AggregateError(
          [error, closeError],
          "failed to open ledger application and close storage",
        );
      }

      throw error;
    }

    const close = async (): Promise<void> => await ledger.close();

    const typedLedger = ledger as ApplicationLedger;

    return Object.freeze({
      capabilities: resolved.capabilities,
      ledger: typedLedger,
      close,
      [Symbol.asyncDispose]: close,
    });
  } catch (error: unknown) {
    if (storageTransferred) {
      throw error;
    }

    try {
      await input.storage.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        "failed to open ledger application and close storage",
      );
    }

    throw error;
  }
}
