import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { declareLedgerModule } from "./ledger/ledger.ts";
import { defineResult, type ResultRef } from "./stdlib.ts";

const OutputSchema = Type.Object({
  value: Type.String({ minLength: 1 }),
});

test("result refs are bound to their producing module", () => {
  const jobs = defineResult({
    moduleId: "contract.jobs",
    resultSchema: OutputSchema,
  });
  const deadlines = defineResult({
    moduleId: "contract.deadlines",
    resultSchema: OutputSchema,
  });
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
  const result = defineResult({
    moduleId: "contract.operations",
    resultSchema: OutputSchema,
  });
  const declaration = declareLedgerModule({
    moduleId: "contract.operations",
    events: {
      completed: Type.Object({
        ref: result.refSchema,
        output: OutputSchema,
      }),
    },
  });
  const completed = result.fromEvent(
    declaration.events.completed,
    (payload) => ({
      ref: payload.ref,
      outcome: "succeeded",
    }),
  );
  const ref = completed.ref("operation-1");

  assert.notEqual(completed, result);
  assert.equal(completed.source.event, declaration.events.completed);
  assert.deepEqual(
    completed.source.observe({
      ref,
      output: { value: "done" },
    }),
    {
      ref,
      outcome: "succeeded",
    },
  );
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(completed));
  assert(Object.isFrozen(completed.source));

  const foreignDeclaration = declareLedgerModule({
    moduleId: "contract.foreign",
    events: {
      completed: Type.Object({
        ref: result.refSchema,
        output: OutputSchema,
      }),
    },
  });

  if (false) {
    // A module cannot claim another module's event as the producer of its
    // terminal result.
    // @ts-expect-error terminal result events must have the same module owner
    result.fromEvent(foreignDeclaration.events.completed, () => ({
      ref: result.ref("foreign"),
      outcome: "succeeded",
    }));
  }
});

test("result module ids use Sledge's reserved identity separator", () => {
  assert.throws(
    () =>
      defineResult({
        moduleId: "contract::invalid",
        resultSchema: OutputSchema,
      }),
    /ledger module id must not contain reserved separator ::/,
  );
});
