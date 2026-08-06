import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { createBetterSqliteDriver } from "../better-sqlite3.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { defineLedger } from "../sledge.ts";
import { Settlement } from "../stdlib.ts";
import {
  bindExecutionService,
  defineActivity,
  defineExecutionModule,
  defineExecutionProgram,
  defineExecutionService,
  type ExecutionRef,
} from "./execution.ts";

const ArithmeticFailureSchema = Type.Object({
  operation: Type.String(),
  message: Type.String(),
});
const Increment = defineExecutionService<
  "test.increment",
  (value: number) => Promise<number>
>("test.increment");
const Double = defineExecutionService<
  "test.double",
  (value: number, attempt: number) => Promise<number>
>("test.double");
const increment = defineActivity("test.increment", Increment, {
  inputSchema: Type.Number(),
  resultSchema: Type.Number(),
  failureSchema: ArithmeticFailureSchema,
  execute: async ({ input, service }) => {
    return Settlement.succeeded(await service(input));
  },
});
const double = defineActivity("test.double", Double, {
  inputSchema: Type.Number(),
  resultSchema: Type.Number(),
  failureSchema: ArithmeticFailureSchema,
  execute: async ({ input, service, attempt }) => {
    return Settlement.succeeded(await service(input, attempt));
  },
});
const arithmetic = defineExecutionProgram("test.arithmetic", {
  inputSchema: Type.Object({ value: Type.Number() }),
  resultSchema: Type.Number(),
  failureSchema: ArithmeticFailureSchema,
  build: ({ value }) => {
    return increment(value).flatMap((incremented) => {
      return incremented % 2 === 0
        ? double(incremented)
        : increment(incremented);
    });
  },
});

if (false) {
  defineExecutionModule("test.missing-service", {
    programs: [arithmetic],
    // @ts-expect-error Every service required by the graph must be bound.
    services: [],
  });
}

test("execution flatMap journals activity output and resumes after restart", async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-execution-test-"),
  );
  const databaseUrl = join(directory.path, "execution.sqlite");
  const runtime = new VirtualRuntimeHarness(1_000_000);
  let incrementCalls = 0;
  let doubleCalls = 0;
  const application = defineLedger((sledge) => {
    const { execution } = sledge.install(
      defineExecutionModule("test.execution", {
        programs: [arithmetic],
        services: [
          bindExecutionService(Increment, async (value) => {
            incrementCalls += 1;
            return value + 1;
          }),
          bindExecutionService(Double, async (value, attempt) => {
            doubleCalls += 1;

            if (attempt === 1) {
              throw new Error("retry after restart");
            }

            return value * 2;
          }),
        ],
      })(),
    );

    return { execution };
  });

  let ref: ExecutionRef<number, "test.arithmetic">;

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: (queue) => ({
        maxInFlight: queue.name === "control" ? 2 : 1,
      }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 3,
    });

    ref = await opened.capabilities.execution.start(
      opened.ledger,
      arithmetic,
      { value: 1 },
      { key: "restart" },
    );

    await waitFor(runtime, () => doubleCalls === 1);
    assert.equal(
      await opened.capabilities.execution.read(opened.ledger, arithmetic, ref),
      null,
    );
  }

  await runtime.advanceByMs(10);

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: (queue) => ({
        maxInFlight: queue.name === "control" ? 2 : 1,
      }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 3,
    });

    await waitFor(runtime, async () => {
      return (
        (await opened.capabilities.execution.read(
          opened.ledger,
          arithmetic,
          ref,
        )) !== null
      );
    });

    assert.deepEqual(
      await opened.capabilities.execution.read(opened.ledger, arithmetic, ref),
      Settlement.succeeded(4),
    );
    assert.equal(incrementCalls, 1);
    assert.equal(doubleCalls, 2);
    assert.deepEqual(await opened.ledger.listWork(), []);
  }
});

async function waitFor(
  runtime: VirtualRuntimeHarness,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await runtime.flush();

    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error("execution test timed out");
}
