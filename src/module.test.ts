import assert from "node:assert/strict";
import test from "node:test";

import {
  declareLedgerModule,
  linkLedgerModule,
  type AnyRegisteredLedgerModule,
  type LedgerModuleDefinition,
} from "./ledger/ledger.ts";
import { defineModule } from "./sledge.ts";

test("module factories bind identity once and reveal fresh contributions", () => {
  const defineExampleModule = defineModule(
    "contract.module-factory",
    (module, label: string) => {
      const registered = registerEmptyModule(module);

      return module.expose(registered, {
        label,
        moduleId: module.moduleId,
      });
    },
  );

  const first = defineExampleModule("first");
  const second = defineExampleModule("second");

  assert(Object.isFrozen(defineExampleModule));
  assert(Object.isFrozen(first));
  assert.notEqual(first, second);
  assert.notEqual(first.module, second.module);
  assert.deepEqual(first.capabilities, {
    label: "first",
    moduleId: "contract.module-factory",
  });
  assert.deepEqual(second.capabilities, {
    label: "second",
    moduleId: "contract.module-factory",
  });
});

test("module owners are revoked after revealing one contribution", () => {
  let retained!: LedgerModuleDefinition<"contract.scoped-module">;
  const defineScopedModule = defineModule(
    "contract.scoped-module",
    (module) => {
      retained = module;
      const registered = registerEmptyModule(module);
      const contribution = module.expose(registered, {});

      assert.throws(
        () => module.expose(registered, {}),
        /ledger module definition has already closed/,
      );

      return contribution;
    },
  );

  defineScopedModule();

  assert.throws(
    () => retained.moduleId,
    /ledger module definition has already closed/,
  );
  assert.throws(
    () => retained.declare({ events: {} }),
    /ledger module definition has already closed/,
  );
});

test("a module owner cannot reveal a differently owned registered module", () => {
  const foreignDeclaration = declareLedgerModule({
    moduleId: "contract.foreign-module",
    events: {},
  });
  const foreign = linkLedgerModule(foreignDeclaration, null).register({});

  if (false) {
    defineModule("contract.owning-module", (module) => {
      // @ts-expect-error registered modules must have the factory's owner
      return module.expose(foreign, {});
    });
  }

  const defineInvalidModule = defineModule("contract.owning-module", (module) =>
    module.expose(
      // This cast models an untyped caller. Runtime owner validation must
      // remain independent from the public phantom type.
      foreign as unknown as AnyRegisteredLedgerModule & {
        readonly moduleId: "contract.owning-module";
      },
      {},
    ),
  );

  assert.throws(
    () => defineInvalidModule(),
    /cannot expose registered module contract.foreign-module/,
  );
});

test("module factories reject definitions that bypass module.expose", () => {
  if (false) {
    // @ts-expect-error contributions must be revealed by the module owner
    defineModule("contract.raw-module", (module) => {
      const registered = registerEmptyModule(module);

      return { module: registered, capabilities: {} };
    });
  }

  // This adapter models JavaScript without TypeScript's factory contract.
  // Runtime authenticity still rejects both raw and asynchronous results.
  const unsafeDefineModule = defineModule as unknown as (
    moduleId: string,
    define: (module: LedgerModuleDefinition<string>) => unknown,
  ) => () => unknown;
  const defineRawModule = unsafeDefineModule(
    "contract.raw-module",
    (module) => {
      const registered = registerEmptyModule(module);

      return { module: registered, capabilities: {} };
    },
  );
  const defineAsyncModule = unsafeDefineModule(
    "contract.async-module",
    async () => await Promise.resolve({}),
  );

  assert.throws(
    () => defineRawModule(),
    /must return module\.expose\(\.\.\.\) directly/,
  );
  assert.throws(
    () => defineAsyncModule(),
    /must return module\.expose\(\.\.\.\) directly/,
  );
});

test("module ids are validated when their factory is defined", () => {
  assert.throws(
    () =>
      defineModule("contract::invalid", (module) => {
        const registered = registerEmptyModule(module);
        return module.expose(registered, {});
      }),
    /ledger module id must not contain reserved separator ::/,
  );
});

function registerEmptyModule<const TModuleId extends string>(
  module: LedgerModuleDefinition<TModuleId>,
) {
  const declaration = module.declare({ events: {} });
  return linkLedgerModule(declaration, null).register({});
}
