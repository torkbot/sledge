import assert from "node:assert/strict";
import test from "node:test";

import * as publicLedger from "./ledger.ts";

if (false) {
  // @ts-expect-error standalone declaration is not part of the public ledger interface
  type LegacyDeclaration = typeof import("./ledger.ts").declareLedgerModule;
  // @ts-expect-error standalone linking is not part of the public ledger interface
  type LegacyLink = typeof import("./ledger.ts").linkLedgerModule;
  // @ts-expect-error construction phase carriers are inferred, not imported
  type LegacyDeclaredModule = import("./ledger.ts").DeclaredLedgerModule;

  void (0 as unknown as LegacyDeclaration);
  void (0 as unknown as LegacyLink);
  void (0 as unknown as LegacyDeclaredModule);
}

test("the public ledger interface excludes standalone module construction", () => {
  assert.equal(Object.hasOwn(publicLedger, "declareLedgerModule"), false);
  assert.equal(Object.hasOwn(publicLedger, "linkLedgerModule"), false);
  assert.equal(typeof publicLedger.defineMaterialization, "function");
});
