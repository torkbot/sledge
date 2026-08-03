import type { TSchema } from "typebox";

import { attachSledgeApplicationConfigure } from "./ledger/internal-storage.ts";
import type {
  AnyRegisteredLedgerModule,
  EventToken,
  Ledger,
  QueryParameters,
  QueryResult,
  QueryToken,
  RegisteredLedgerModuleEventTokens,
  RegisteredLedgerModuleQueryTokens,
  RegisteredLedgerModuleSignalTokens,
  SignalToken,
} from "./ledger/ledger.ts";

const sledgeApplicationTypeBrand: unique symbol = Symbol(
  "sledge.applicationType",
);
declare const installedLedgerModuleTypeBrand: unique symbol;
declare const installedLedgerTokenTypeBrand: unique symbol;
declare const sledgeAssemblyScopeTypeBrand: unique symbol;
declare const revealedSledgeCapabilitiesTypeBrand: unique symbol;

export type LedgerModuleContribution<
  TCapabilities extends object,
  TModule extends AnyRegisteredLedgerModule = AnyRegisteredLedgerModule,
> = {
  readonly module: TModule;
  readonly capabilities: TCapabilities;
};

type InstalledLedgerToken<
  TToken,
  TModule extends AnyRegisteredLedgerModule,
> = TToken & {
  readonly [installedLedgerTokenTypeBrand]: TModule;
};

type SledgeAssemblyScope<TScope> = {
  readonly [sledgeAssemblyScopeTypeBrand]: (scope: TScope) => TScope;
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
    ? TCapabilities & SledgeAssemblyScope<TScope>
    : TCapabilities extends {
          readonly [installedLedgerModuleTypeBrand]: infer TModule;
        }
      ? ScopeInstalledLedgerCapabilities<
          Omit<TCapabilities, typeof installedLedgerModuleTypeBrand>,
          TScope
        > & {
          readonly [installedLedgerModuleTypeBrand]: TModule;
        } & SledgeAssemblyScope<TScope>
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

type RemoveSledgeAssemblyScope<TCapabilities> = TCapabilities extends {
  readonly [installedLedgerTokenTypeBrand]: AnyRegisteredLedgerModule;
}
  ? Omit<TCapabilities, typeof sledgeAssemblyScopeTypeBrand>
  : TCapabilities extends (...args: never[]) => unknown
    ? keyof TCapabilities extends never
      ? TCapabilities
      : never
    : TCapabilities extends readonly unknown[]
      ? {
          readonly [TKey in keyof TCapabilities]: RemoveSledgeAssemblyScope<
            TCapabilities[TKey]
          >;
        }
      : TCapabilities extends object
        ? {
            readonly [TKey in keyof TCapabilities as TKey extends typeof sledgeAssemblyScopeTypeBrand
              ? never
              : TKey]: TKey extends typeof installedLedgerModuleTypeBrand
              ? TCapabilities[TKey]
              : RemoveSledgeAssemblyScope<TCapabilities[TKey]>;
          }
        : TCapabilities;

type InstallableLedgerCapabilities<
  TCapabilities,
  TModule extends AnyRegisteredLedgerModule,
  TScope,
> = TCapabilities extends {
  readonly [installedLedgerTokenTypeBrand]: AnyRegisteredLedgerModule;
}
  ? TCapabilities extends SledgeAssemblyScope<TScope>
    ? TCapabilities
    : never
  : TCapabilities extends {
        readonly [installedLedgerModuleTypeBrand]: AnyRegisteredLedgerModule;
      }
    ? TCapabilities extends SledgeAssemblyScope<TScope>
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

type RevealedSledgeCapabilities<
  TCapabilities extends object,
  TScope,
> = TCapabilities & {
  readonly [revealedSledgeCapabilitiesTypeBrand]: (scope: TScope) => TScope;
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

export interface SledgeAssembly<TScope> {
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
        RemoveSledgeAssemblyScope<TScopedCapabilities>,
        TScope
      >,
  ): RevealedSledgeCapabilities<
    RemoveSledgeAssemblyScope<TScopedCapabilities>,
    TScope
  >;
}

export type SledgeApplication<
  TCapabilities extends object,
  TModules extends AnyRegisteredLedgerModule = AnyRegisteredLedgerModule,
> = {
  readonly [sledgeApplicationTypeBrand]: TCapabilities;
  readonly [installedLedgerModuleTypeBrand]: TModules;
};

export type SledgeApplicationCapabilities<
  TApplication extends SledgeApplication<object>,
> = TApplication[typeof sledgeApplicationTypeBrand];

export type SledgeApplicationModules<
  TApplication extends SledgeApplication<object>,
> = TApplication[typeof installedLedgerModuleTypeBrand];

export type SledgeLedger<TModules extends AnyRegisteredLedgerModule> = Ledger<
  RegisteredLedgerModuleEventTokens<TModules>,
  RegisteredLedgerModuleQueryTokens<TModules>,
  RegisteredLedgerModuleSignalTokens<TModules>
>;

export interface OpenedSledge<
  TCapabilities extends object,
  TModules extends AnyRegisteredLedgerModule,
> extends AsyncDisposable {
  readonly capabilities: TCapabilities;
  readonly ledger: SledgeLedger<TModules>;

  close(): Promise<void>;
}

export function defineSledge<const TCapabilities extends object>(
  configure: <TScope>(
    assembly: SledgeAssembly<TScope>,
  ) =>
    | RevealedSledgeCapabilities<TCapabilities, TScope>
    | Promise<RevealedSledgeCapabilities<TCapabilities, TScope>>,
): SledgeApplication<TCapabilities, InstalledLedgerModules<TCapabilities>> {
  const application = {} as SledgeApplication<
    TCapabilities,
    InstalledLedgerModules<TCapabilities>
  >;
  attachSledgeApplicationConfigure(application, configure);
  return Object.freeze(application);
}
