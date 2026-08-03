import type { TSchema } from "typebox";

import {
  attachLedgerApplicationConfigure,
  readLedgerDriverOpen,
} from "./ledger/internal-storage.ts";
import type {
  AnyRegisteredLedgerModule,
  EventToken,
  Ledger,
  LedgerModuleContribution,
  LedgerTiming,
  QueryParameters,
  QueryResult,
  QueryToken,
  RegisteredLedgerModuleEventTokens,
  RegisteredLedgerModuleQueryTokens,
  RegisteredLedgerModuleSignalTokens,
  SignalToken,
} from "./ledger/ledger.ts";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "./runtime/node-runtime.ts";

export { defineModule } from "./ledger/ledger.ts";
export type {
  LedgerModuleContribution,
  LedgerModuleDefinition,
  LedgerModuleOwner,
} from "./ledger/ledger.ts";

const ledgerApplicationTypeBrand: unique symbol = Symbol(
  "sledge.applicationType",
);
declare const installedLedgerModuleTypeBrand: unique symbol;
declare const installedLedgerTokenTypeBrand: unique symbol;
declare const ledgerAssemblyScopeTypeBrand: unique symbol;
declare const revealedLedgerCapabilitiesTypeBrand: unique symbol;
declare const ledgerDriverTypeBrand: unique symbol;

type InstalledLedgerToken<
  TToken,
  TModule extends AnyRegisteredLedgerModule,
> = TToken & {
  readonly [installedLedgerTokenTypeBrand]: TModule;
};

type LedgerAssemblyScope<TScope> = {
  readonly [ledgerAssemblyScopeTypeBrand]: (scope: TScope) => TScope;
};

type InstallLedgerTokens<
  TCapabilities,
  TModule extends AnyRegisteredLedgerModule,
> = TCapabilities extends {
  readonly [installedLedgerTokenTypeBrand]: AnyRegisteredLedgerModule;
}
  ? TCapabilities
  : TCapabilities extends EventToken<string, string, TSchema, TSchema | null>
    ? TCapabilities extends RegisteredLedgerModuleEventTokens<TModule>
      ? InstalledLedgerToken<TCapabilities, TModule>
      : never
    : TCapabilities extends QueryToken<string, string, TSchema, TSchema>
      ? TCapabilities extends RegisteredLedgerModuleQueryTokens<TModule>
        ? InstalledLedgerToken<TCapabilities, TModule>
        : never
      : TCapabilities extends SignalToken<string, string, TSchema>
        ? TCapabilities extends RegisteredLedgerModuleSignalTokens<TModule>
          ? InstalledLedgerToken<TCapabilities, TModule>
          : never
        : TCapabilities extends { readonly "~kind": string }
          ? TCapabilities
          : TCapabilities extends (...args: never[]) => unknown
            ? TCapabilities
            : TCapabilities extends readonly unknown[]
              ? {
                  readonly [TKey in keyof TCapabilities]: InstallLedgerTokens<
                    TCapabilities[TKey],
                    TModule
                  >;
                }
              : TCapabilities extends object
                ? {
                    readonly [TKey in keyof TCapabilities]: InstallLedgerTokens<
                      TCapabilities[TKey],
                      TModule
                    >;
                  }
                : TCapabilities;

export type InstalledLedgerModuleCapabilities<
  TModule extends AnyRegisteredLedgerModule,
  TCapabilities extends object,
> = InstallLedgerTokens<TCapabilities, TModule> & {
  readonly [installedLedgerModuleTypeBrand]: TModule;
};

type ScopeInstalledLedgerCapabilities<TCapabilities, TScope> =
  TCapabilities extends InstalledLedgerToken<unknown, AnyRegisteredLedgerModule>
    ? TCapabilities & LedgerAssemblyScope<TScope>
    : TCapabilities extends {
          readonly [installedLedgerModuleTypeBrand]: infer TModule;
        }
      ? ScopeInstalledLedgerCapabilities<
          Omit<TCapabilities, typeof installedLedgerModuleTypeBrand>,
          TScope
        > & {
          readonly [installedLedgerModuleTypeBrand]: TModule;
        } & LedgerAssemblyScope<TScope>
      : TCapabilities extends (...args: never[]) => unknown
        ? keyof TCapabilities extends never
          ? TCapabilities
          : never
        : TCapabilities extends readonly unknown[]
          ? {
              readonly [TKey in keyof TCapabilities]: ScopeInstalledLedgerCapabilities<
                TCapabilities[TKey],
                TScope
              >;
            }
          : TCapabilities extends object
            ? {
                readonly [TKey in keyof TCapabilities]: ScopeInstalledLedgerCapabilities<
                  TCapabilities[TKey],
                  TScope
                >;
              }
            : TCapabilities;

type RemoveLedgerAssemblyScope<TCapabilities> = TCapabilities extends {
  readonly [installedLedgerTokenTypeBrand]: AnyRegisteredLedgerModule;
}
  ? Omit<TCapabilities, typeof ledgerAssemblyScopeTypeBrand>
  : TCapabilities extends (...args: never[]) => unknown
    ? keyof TCapabilities extends never
      ? TCapabilities
      : never
    : TCapabilities extends readonly unknown[]
      ? {
          readonly [TKey in keyof TCapabilities]: RemoveLedgerAssemblyScope<
            TCapabilities[TKey]
          >;
        }
      : TCapabilities extends object
        ? {
            readonly [TKey in keyof TCapabilities as TKey extends typeof ledgerAssemblyScopeTypeBrand
              ? never
              : TKey]: TKey extends typeof installedLedgerModuleTypeBrand
              ? TCapabilities[TKey]
              : RemoveLedgerAssemblyScope<TCapabilities[TKey]>;
          }
        : TCapabilities;

type InstallableLedgerCapabilities<
  TCapabilities,
  TModule extends AnyRegisteredLedgerModule,
  TScope,
> = TCapabilities extends {
  readonly [installedLedgerTokenTypeBrand]: AnyRegisteredLedgerModule;
}
  ? TCapabilities extends LedgerAssemblyScope<TScope>
    ? TCapabilities
    : never
  : TCapabilities extends {
        readonly [installedLedgerModuleTypeBrand]: AnyRegisteredLedgerModule;
      }
    ? TCapabilities extends LedgerAssemblyScope<TScope>
      ? TCapabilities
      : never
    : TCapabilities extends EventToken<string, string, TSchema, TSchema | null>
      ? TCapabilities extends RegisteredLedgerModuleEventTokens<TModule>
        ? TCapabilities
        : never
      : TCapabilities extends QueryToken<string, string, TSchema, TSchema>
        ? TCapabilities extends RegisteredLedgerModuleQueryTokens<TModule>
          ? TCapabilities
          : never
        : TCapabilities extends SignalToken<string, string, TSchema>
          ? TCapabilities extends RegisteredLedgerModuleSignalTokens<TModule>
            ? TCapabilities
            : never
          : TCapabilities extends (...args: never[]) => unknown
            ? keyof TCapabilities extends never
              ? TCapabilities
              : never
            : TCapabilities extends readonly unknown[]
              ? {
                  readonly [TKey in keyof TCapabilities]: InstallableLedgerCapabilities<
                    TCapabilities[TKey],
                    TModule,
                    TScope
                  >;
                }
              : TCapabilities extends object
                ? {
                    readonly [TKey in keyof TCapabilities]: InstallableLedgerCapabilities<
                      TCapabilities[TKey],
                      TModule,
                      TScope
                    >;
                  }
                : TCapabilities;

type RevealedLedgerCapabilities<
  TCapabilities extends object,
  TScope,
> = TCapabilities & {
  readonly [revealedLedgerCapabilitiesTypeBrand]: (scope: TScope) => TScope;
};

type InstalledLedgerModules<TCapabilities> = TCapabilities extends {
  readonly [installedLedgerTokenTypeBrand]: infer TModule extends
    AnyRegisteredLedgerModule;
}
  ? TModule
  : TCapabilities extends {
        readonly [installedLedgerModuleTypeBrand]: infer TModule extends
          AnyRegisteredLedgerModule;
      }
    ?
        | TModule
        | InstalledLedgerModules<
            Omit<TCapabilities, typeof installedLedgerModuleTypeBrand>
          >
    : TCapabilities extends (...args: never[]) => unknown
      ? never
      : TCapabilities extends readonly unknown[]
        ? InstalledLedgerModules<TCapabilities[number]>
        : TCapabilities extends object
          ? {
              [TKey in keyof TCapabilities]: InstalledLedgerModules<
                TCapabilities[TKey]
              >;
            }[keyof TCapabilities]
          : never;

export interface LedgerAssembly<TScope> {
  install<
    const TModule extends AnyRegisteredLedgerModule,
    const TCapabilities extends object,
  >(
    contribution: LedgerModuleContribution<TCapabilities, TModule> & {
      readonly capabilities: TCapabilities &
        InstallableLedgerCapabilities<TCapabilities, TModule, TScope>;
    },
  ): ScopeInstalledLedgerCapabilities<
    InstalledLedgerModuleCapabilities<TModule, TCapabilities>,
    TScope
  >;

  query<const TQuery extends QueryToken<string, string, TSchema, TSchema>>(
    query: ScopeInstalledLedgerCapabilities<
      InstalledLedgerToken<TQuery, AnyRegisteredLedgerModule>,
      TScope
    >,
    params: QueryParameters<TQuery>,
  ): Promise<QueryResult<TQuery>>;

  expose<const TScopedCapabilities extends object>(
    capabilities: TScopedCapabilities &
      ScopeInstalledLedgerCapabilities<
        RemoveLedgerAssemblyScope<TScopedCapabilities>,
        TScope
      >,
  ): RevealedLedgerCapabilities<
    RemoveLedgerAssemblyScope<TScopedCapabilities>,
    TScope
  >;
}

export interface LedgerDriver {
  readonly [ledgerDriverTypeBrand]: true;
}

export interface LedgerApplication<
  TCapabilities extends object,
  TModules extends AnyRegisteredLedgerModule = AnyRegisteredLedgerModule,
> {
  readonly [ledgerApplicationTypeBrand]: TCapabilities;
  readonly [installedLedgerModuleTypeBrand]: TModules;

  open(
    driver: LedgerDriver,
    timing?: LedgerTiming,
  ): Promise<OpenedLedger<TCapabilities, TModules>>;
}

export type LedgerApplicationCapabilities<
  TApplication extends LedgerApplication<object>,
> = TApplication[typeof ledgerApplicationTypeBrand];

export type LedgerApplicationModules<
  TApplication extends LedgerApplication<object>,
> = TApplication[typeof installedLedgerModuleTypeBrand];

export type ApplicationLedger<TModules extends AnyRegisteredLedgerModule> =
  Ledger<
    RegisteredLedgerModuleEventTokens<TModules>,
    RegisteredLedgerModuleQueryTokens<TModules>,
    RegisteredLedgerModuleSignalTokens<TModules>
  >;

export interface OpenedLedger<
  TCapabilities extends object,
  TModules extends AnyRegisteredLedgerModule,
> extends AsyncDisposable {
  readonly capabilities: TCapabilities;
  readonly ledger: ApplicationLedger<TModules>;

  close(): Promise<void>;
}

const defaultNodeTiming: LedgerTiming = Object.freeze({
  clock: new SystemRuntimeClock(),
  scheduler: new NodeRuntimeScheduler(),
});

export function defineLedger<const TCapabilities extends object>(
  configure: <TScope>(
    assembly: LedgerAssembly<TScope>,
  ) =>
    | RevealedLedgerCapabilities<TCapabilities, TScope>
    | Promise<RevealedLedgerCapabilities<TCapabilities, TScope>>,
): LedgerApplication<TCapabilities, InstalledLedgerModules<TCapabilities>> {
  type TApplication = LedgerApplication<
    TCapabilities,
    InstalledLedgerModules<TCapabilities>
  >;

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
  // The brands prove capabilities and installed modules only to TypeScript.
  // Runtime state consists of this method plus the private configure registry.
  application = { open } as TApplication;
  attachLedgerApplicationConfigure(application, configure);
  return Object.freeze(application);
}
