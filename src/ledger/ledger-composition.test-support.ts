import type { ComposedLedgerModel } from "./ledger-composition.ts";
import type { AnyRegisteredLedgerModule } from "./ledger.ts";
import { composeRegisteredLedgerModules } from "./internal-storage.ts";

/** Internal composition access for black-box engine and adapter contracts. */
export function composeLedgerModulesForTest<
  const TFirst extends AnyRegisteredLedgerModule,
  const TRest extends readonly AnyRegisteredLedgerModule[],
>(
  first: TFirst,
  ...rest: TRest
): ComposedLedgerModel<readonly [TFirst, ...TRest]> {
  return composeRegisteredLedgerModules(first, ...rest) as ComposedLedgerModel<
    readonly [TFirst, ...TRest]
  >;
}
