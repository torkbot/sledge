import assert from "node:assert/strict";
import test from "node:test";

import {
  declareLedgerModuleInternal as declareLedgerModule,
  linkLedgerModuleInternal as linkLedgerModule,
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
  assert(Object.isFrozen(first.module));
  assert.equal(
    Reflect.set(first.module, "moduleId", "contract.rewritten-module"),
    false,
  );
  assert.equal(first.module.moduleId, "contract.module-factory");
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
  let retainedDeclaration!: object;
  const defineScopedModule = defineModule(
    "contract.scoped-module",
    (module) => {
      retained = module;
      const declaration = module.declare({ events: {} });
      retainedDeclaration = declaration;
      const registered = module.link(declaration, null).register({});
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
  assert.throws(
    () => retained.link(retainedDeclaration as never, null),
    /ledger module definition has already closed/,
  );
});

test("module linking accepts only declarations from the current factory invocation", () => {
  let retainedDeclaration!: ReturnType<
    LedgerModuleDefinition<"contract.owned-link">["declare"]
  >;
  const defineOwnedModule = defineModule(
    "contract.owned-link",
    (module, reusePreviousDeclaration: boolean) => {
      const declaration = reusePreviousDeclaration
        ? retainedDeclaration
        : module.declare({ events: {} });

      retainedDeclaration = declaration;

      const registered = module.link(declaration, null).register({});
      return module.expose(registered, {});
    },
  );

  defineOwnedModule(false);

  assert.throws(
    () => defineOwnedModule(true),
    /ledger module declaration does not belong to this definition/,
  );
});

test("module exposure accepts only registration through the scoped link", () => {
  const defineBypassedModule = defineModule(
    "contract.bypassed-link",
    (module) => {
      const declaration = module.declare({ events: {} });
      const registered = linkLedgerModule(declaration, null).register({});

      return module.expose(registered, {});
    },
  );

  assert.throws(
    defineBypassedModule,
    /registered ledger module contract\.bypassed-link does not belong to this definition/,
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

  const defineForgedModule = defineModule("contract.owning-module", (module) =>
    module.expose(
      {
        moduleId: "contract.owning-module",
      } as unknown as AnyRegisteredLedgerModule & {
        readonly moduleId: "contract.owning-module";
      },
      {},
    ),
  );
  assert.throws(() => defineForgedModule(), /invalid registered ledger module/);
});

test("module factories reject definitions that bypass module.expose", async () => {
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
    async (module) => {
      await Promise.resolve();
      const registered = registerEmptyModule(module);

      return module.expose(registered, {});
    },
  );

  assert.throws(
    () => defineRawModule(),
    /must return module\.expose\(\.\.\.\) directly/,
  );
  assert.throws(
    () => defineAsyncModule(),
    /must return module\.expose\(\.\.\.\) directly/,
  );

  // Let the rejected async continuation settle. Node's test runner reports an
  // unhandled rejection as a test failure if the sync boundary did not consume
  // it.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("module ids are validated when their factory is defined", () => {
  assert.throws(
    () =>
      defineModule("contract::invalid", (module) => {
        const registered = registerEmptyModule(module);
        return module.expose(registered, {});
      }),
    /ledger module id must not contain reserved separator :/,
  );
  assert.throws(
    () =>
      defineModule("contract:invalid", (module) => {
        const registered = registerEmptyModule(module);
        return module.expose(registered, {});
      }),
    /ledger module id must not contain reserved separator :/,
  );
});

function registerEmptyModule<const TModuleId extends string>(
  module: LedgerModuleDefinition<TModuleId>,
) {
  const declaration = module.declare({ events: {} });
  return module.link(declaration, null).register({});
}
