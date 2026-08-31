import type { Static, TSchema } from "typebox";

import {
  attachLedgerApplicationConfigure,
  readLedgerDriverOpen,
} from "./ledger/internal-storage.ts";
import type {
  EventToken,
  Ledger,
  LedgerModuleContribution,
  LedgerTiming,
  QueryToken,
  SignalToken,
} from "./ledger/ledger.ts";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "./runtime/node-runtime.ts";

export { defineModule } from "./ledger/ledger.ts";
export {
  rehydrateException,
  serializeException,
  SerializedExceptionFrameSchema,
  SerializedExceptionSchema,
  type SerializedException,
  type SerializedExceptionFrame,
} from "./exception.ts";
export type {
  EventObservation,
  LedgerCursor,
  LedgerModuleContribution,
  LedgerModuleDefinition,
  LedgerModuleOwner,
  LedgerQuiescence,
  LedgerQueryRequest,
  LedgerQuerySnapshot,
  LedgerQuerySnapshotResults,
} from "./ledger/ledger.ts";

const ledgerApplicationTypeBrand: unique symbol = Symbol(
  "sledge.applicationType",
);
declare const ledgerDriverTypeBrand: unique symbol;
export interface LedgerAssembly {
  install<const TCapabilities extends object>(
    contribution: LedgerModuleContribution<TCapabilities>,
  ): TCapabilities;

  query<
    const TModuleId extends string,
    const TName extends string,
    const TParamsSchema extends TSchema,
    const TResultSchema extends TSchema,
  >(
    query: QueryToken<TModuleId, TName, TParamsSchema, TResultSchema>,
    params: Static<TParamsSchema>,
  ): Promise<Static<TResultSchema>>;
}

export interface LedgerDriver {
  readonly [ledgerDriverTypeBrand]: true;
}

export interface LedgerApplication<TCapabilities extends object> {
  readonly [ledgerApplicationTypeBrand]: TCapabilities;

  open(
    driver: LedgerDriver,
    timing?: LedgerTiming,
  ): Promise<OpenedLedger<TCapabilities>>;
}

export type LedgerApplicationCapabilities<
  TApplication extends LedgerApplication<object>,
> = TApplication[typeof ledgerApplicationTypeBrand];

export type ApplicationLedger = Ledger<
  EventToken<string, string, TSchema, TSchema | null>,
  QueryToken<string, string, TSchema, TSchema>,
  SignalToken<string, string, TSchema>
>;

export interface OpenedLedger<
  TCapabilities extends object,
> extends AsyncDisposable {
  readonly capabilities: TCapabilities;
  readonly ledger: ApplicationLedger;

  close(): Promise<void>;
}

const defaultNodeTiming: LedgerTiming = Object.freeze({
  clock: new SystemRuntimeClock(),
  scheduler: new NodeRuntimeScheduler(),
});

export function defineLedger<const TCapabilities extends object>(
  configure: (
    assembly: LedgerAssembly,
  ) => TCapabilities | Promise<TCapabilities>,
): LedgerApplication<TCapabilities> {
  type TApplication = LedgerApplication<TCapabilities>;

  let application: TApplication;
  const open: TApplication["open"] = async (
    driver,
    timing = defaultNodeTiming,
  ) => {
    const openDriver = readLedgerDriverOpen(driver);

    if (openDriver === undefined) {
      throw new Error("invalid ledger driver");
    }

    return await openDriver({ application, timing });
  };
  // The application brand carries its capability type only to TypeScript.
  // Runtime state consists of this method plus the private configure registry.
  application = { open } as TApplication;
  attachLedgerApplicationConfigure(application, configure);
  return Object.freeze(application);
}
