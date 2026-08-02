import {
  attachPreparedLedgerModelState,
  readLedgerModelResolver,
  readPreparedLedgerModelState,
  storageRuntimeIdentityBrand,
} from "./internal-storage.ts";
import {
  createPreparedComposedDatabaseLedger,
  type StorageRuntime,
} from "./database-ledger-engine.ts";
import type {
  AnyComposedLedgerModel,
  AnyPreparedLedgerModel,
  AnyRegisteredLedgerModule,
  ComposedLedgerModelFor,
  LedgerModelResolutionPorts,
  LedgerModelSource,
  LedgerTiming,
} from "./ledger.ts";
import { composeLedgerModules } from "./ledger.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";

type PreparedLedgerRuntimeState = {
  readonly owner: object;
  readonly modules: readonly [
    AnyRegisteredLedgerModule,
    ...AnyRegisteredLedgerModule[],
  ];
  readonly model: AnyComposedLedgerModel;
};

type RuntimeLedgerModelResolver = (
  phases: LedgerModelResolutionPorts,
) => Promise<AnyPreparedLedgerModel>;

/**
 * Resolves a model definition against one adapter-owned storage runtime.
 * Prepared ledgers borrow that runtime and expose only query capability; the
 * final ledger receives ownership after every prepared handle has closed.
 */
export async function resolveLedgerModelSource<
  const TSource extends LedgerModelSource,
>(input: {
  readonly source: TSource;
  readonly storage: StorageRuntime;
  readonly projectionCompiler: ProjectionStatementCompiler;
  readonly timing: LedgerTiming;
}): Promise<ComposedLedgerModelFor<TSource>> {
  const resolver = readLedgerModelResolver<RuntimeLedgerModelResolver>(
    input.source,
  );

  if (resolver === undefined) {
    return input.source as ComposedLedgerModelFor<TSource>;
  }

  const owner = {};
  const borrowedStorage: StorageRuntime = {
    [storageRuntimeIdentityBrand]: input.storage[storageRuntimeIdentityBrand],
    read: async (run) => await input.storage.read(run),
    write: async (run) => await input.storage.write(run),
    close: async () => undefined,
  };

  await using preparedLedgers = new AsyncDisposableStack();

  const prepareModules = async (
    modules: readonly [
      AnyRegisteredLedgerModule,
      ...AnyRegisteredLedgerModule[],
    ],
  ): Promise<AnyPreparedLedgerModel> => {
    const [first, ...rest] = modules;
    const model = composeLedgerModules(first, ...rest);
    const ledger = createPreparedComposedDatabaseLedger({
      storage: borrowedStorage,
      model,
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

    const prepared = {
      query: ledger.query.bind(ledger),
    } as unknown as AnyPreparedLedgerModel;

    return attachPreparedLedgerModelState(prepared, {
      owner,
      modules,
      model,
    } satisfies PreparedLedgerRuntimeState);
  };

  const readPreparedState = (
    prepared: AnyPreparedLedgerModel,
  ): PreparedLedgerRuntimeState => {
    const state =
      readPreparedLedgerModelState<PreparedLedgerRuntimeState>(prepared);

    if (state === undefined || state.owner !== owner) {
      throw new Error(
        "prepared ledger model belongs to another model resolution",
      );
    }

    return state;
  };

  // The public interface carries exact tuple types across each transition.
  // This implementation operates on their common runtime representation and
  // is kept behind the adapter-owned resolution boundary.
  const phases = {
    prepare: async (
      first: AnyRegisteredLedgerModule,
      ...rest: readonly AnyRegisteredLedgerModule[]
    ) => await prepareModules([first, ...rest]),
    extend: async (
      prepared: AnyPreparedLedgerModel,
      first: AnyRegisteredLedgerModule,
      ...rest: readonly AnyRegisteredLedgerModule[]
    ) => {
      const state = readPreparedState(prepared);
      return await prepareModules([
        state.modules[0],
        ...state.modules.slice(1),
        first,
        ...rest,
      ]);
    },
  } as LedgerModelResolutionPorts;

  const prepared = await resolver(phases);
  const model = readPreparedState(prepared).model;

  return model as ComposedLedgerModelFor<TSource>;
}
