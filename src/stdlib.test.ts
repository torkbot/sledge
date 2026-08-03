import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  declareLedgerModuleInternal as declareLedgerModule,
  type LedgerModuleOwner,
} from "./ledger/ledger.ts";
import { defineModule } from "./sledge.ts";
import { defineResult, type ResultRef } from "./stdlib.ts";

const OutputSchema = Type.Object({
  value: Type.String({ minLength: 1 }),
});

test("result refs are bound to their producing module", () => {
  const jobs = defineResultModule("contract.jobs")().capabilities.result;
  const deadlines =
    defineResultModule("contract.deadlines")().capabilities.result;
  const jobRef = jobs.ref("job-1");
  const deadlineRef = deadlines.ref("job-1");

  assert.equal(jobRef, "contract.jobs::job-1");
  assert.equal(jobs.ref("line\nbreak"), "contract.jobs::line\nbreak");
  assert.equal(Value.Decode(jobs.refSchema, jobRef), jobRef);
  assert.throws(() => Value.Decode(jobs.refSchema, deadlineRef));
  assert.throws(() => jobs.ref(""), /result key must not be empty/);

  const sameOwner: ResultRef<{ readonly value: string }, "contract.jobs"> =
    jobRef;
  void sameOwner;

  // Owner identity remains part of the phantom type even when result payloads
  // share the same schema.
  // @ts-expect-error deadline refs cannot be used as job refs
  const wrongOwner: typeof jobRef = deadlineRef;
  void wrongOwner;
});

test("a declared result returns a new terminal-event capability", () => {
  const defineOperationsModule = defineModule(
    "contract.operations",
    (module) => {
      const declared = defineResult(module, { resultSchema: OutputSchema });
      const declaration = module.declare({
        events: {
          completed: Type.Object({
            ref: declared.refSchema,
            output: OutputSchema,
          }),
          alsoCompleted: Type.Object({
            ref: declared.refSchema,
            output: OutputSchema,
          }),
        },
      });
      const completed = declared.fromEvent(
        declaration.events.completed,
        (payload) => ({
          ref: payload.ref,
          outcome: "succeeded",
          value: payload.output,
        }),
      );
      assert.throws(
        () =>
          declared.fromEvent(declaration.events.alsoCompleted, (payload) => ({
            ref: payload.ref,
            outcome: "succeeded",
            value: payload.output,
          })),
        /ledger module contract.operations result is already bound/,
      );
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, { completed, declared });
    },
  );
  const { completed, declared } = defineOperationsModule().capabilities;
  const ref = completed.ref("operation-1");

  assert.notEqual(completed, declared);
  assert.deepEqual(
    completed.source.observe({
      ref,
      output: { value: "done" },
    }),
    {
      ref,
      outcome: "succeeded",
      value: { value: "done" },
    },
  );
  assert(Object.isFrozen(declared));
  assert(Object.isFrozen(completed));
  assert(Object.isFrozen(completed.source));

  const foreignDeclaration = declareLedgerModule({
    moduleId: "contract.foreign",
    events: {
      completed: Type.Object({
        ref: declared.refSchema,
        output: OutputSchema,
      }),
    },
  });

  if (false) {
    // A module cannot claim another module's event as the producer of its
    // terminal result.
    // @ts-expect-error terminal result events must have the same module owner
    declared.fromEvent(foreignDeclaration.events.completed, () => ({
      ref: declared.ref("foreign"),
      outcome: "succeeded",
      value: { value: "foreign" },
    }));
  }
});

test("one ledger module owns at most one result protocol", () => {
  const defineSingleResultModule = defineModule(
    "contract.single-result",
    (module) => {
      const result = defineResult(module, { resultSchema: OutputSchema });

      assert.throws(
        () => defineResult(module, { resultSchema: OutputSchema }),
        /ledger module contract.single-result already defines a result/,
      );

      const declaration = module.declare({ events: {} });
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, { result });
    },
  );

  defineSingleResultModule();
});

test("result terminal events belong to the exact module definition", () => {
  let previousEvent: object | undefined;
  const foreignEvent = declareLedgerModule({
    moduleId: "contract.foreign-terminal",
    events: { completed: Type.Object({}) },
  }).events.completed;
  const defineScopedTerminalModule = defineModule(
    "contract.scoped-terminal",
    (module) => {
      const result = defineResult(module, { resultSchema: OutputSchema });
      const declaration = module.declare({
        events: {
          completed: Type.Object({
            ref: result.refSchema,
            output: OutputSchema,
          }),
        },
      });
      const observe = (payload: {
        readonly ref: ReturnType<typeof result.ref>;
        readonly output: { readonly value: string };
      }) => ({
        ref: payload.ref,
        outcome: "succeeded" as const,
        value: payload.output,
      });

      assert.throws(
        () => Reflect.apply(result.fromEvent, result, [foreignEvent, observe]),
        /result cannot bind event owned by contract.foreign-terminal/,
      );

      if (previousEvent !== undefined) {
        assert.throws(
          () =>
            Reflect.apply(result.fromEvent, result, [previousEvent, observe]),
          /result event does not belong to this definition/,
        );
      }

      const completed = result.fromEvent(declaration.events.completed, observe);
      previousEvent = declaration.events.completed;
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, { completed });
    },
  );

  defineScopedTerminalModule();
  defineScopedTerminalModule();
});

test("result definitions require a live Sledge module owner", () => {
  let retainedOwner!: LedgerModuleOwner<"contract.scoped-result">;
  const defineScopedResultModule = defineModule(
    "contract.scoped-result",
    (module) => {
      retainedOwner = module;
      const result = defineResult(module, { resultSchema: OutputSchema });
      const declaration = module.declare({ events: {} });
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, { result });
    },
  );

  defineScopedResultModule();

  assert.throws(
    () => defineResult(retainedOwner, { resultSchema: OutputSchema }),
    /ledger module definition has already closed/,
  );

  if (false) {
    defineResult(
      // @ts-expect-error plain objects are not Sledge-owned module identities
      { moduleId: "contract.forged" },
      { resultSchema: OutputSchema },
    );
  }

  // This cast models untyped JavaScript crossing the public boundary. The
  // private owner registry still rejects a structurally similar object.
  const forged = {
    moduleId: "contract.forged",
  } as unknown as LedgerModuleOwner<"contract.forged">;
  assert.throws(
    () => defineResult(forged, { resultSchema: OutputSchema }),
    /invalid ledger module owner/,
  );
});

function defineResultModule<const TModuleId extends string>(
  moduleId: TModuleId,
) {
  return defineModule(moduleId, (module) => {
    const result = defineResult(module, { resultSchema: OutputSchema });
    const declaration = module.declare({ events: {} });
    const registered = module.link(declaration, null).register({});

    return module.expose(registered, { result });
  });
}
