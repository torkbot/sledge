import type {
  AnyRegisteredLedgerModule,
  RegisteredLedgerModuleEventTokens,
  RegisteredLedgerModuleQueryTokens,
  RegisteredLedgerModuleSignalTokens,
} from "./ledger.ts";
import {
  composedLedgerModulesBrand,
  registeredLedgerContractsBrand,
  registeredLedgerRuntimeBrand,
} from "./internal-storage.ts";

export type ComposedLedgerModel<
  TModules extends readonly AnyRegisteredLedgerModule[],
> = {
  readonly [composedLedgerModulesBrand]: TModules;
  readonly [registeredLedgerContractsBrand]: AnyRegisteredLedgerModule[typeof registeredLedgerContractsBrand];
  readonly [registeredLedgerRuntimeBrand]: AnyRegisteredLedgerModule[typeof registeredLedgerRuntimeBrand];
};

export type AnyComposedLedgerModel = ComposedLedgerModel<
  readonly AnyRegisteredLedgerModule[]
>;

export type ComposedLedgerEventTokens<TModel extends AnyComposedLedgerModel> =
  RegisteredLedgerModuleEventTokens<
    TModel[typeof composedLedgerModulesBrand][number]
  >;

export type ComposedLedgerSignalTokens<TModel extends AnyComposedLedgerModel> =
  RegisteredLedgerModuleSignalTokens<
    TModel[typeof composedLedgerModulesBrand][number]
  >;

export type ComposedLedgerQueryTokens<TModel extends AnyComposedLedgerModel> =
  RegisteredLedgerModuleQueryTokens<
    TModel[typeof composedLedgerModulesBrand][number]
  >;
