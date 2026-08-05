import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { createBetterSqliteDriver } from "../better-sqlite3.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { defineLedger, type LedgerDriver } from "../sledge.ts";
import { readResult, waitForResult } from "../stdlib.ts";
import { createTursoDriver } from "../turso.ts";
import { defineInvocation } from "./invocation.ts";

const adapters: readonly {
  readonly name: string;
  createDriver(databaseUrl: string): LedgerDriver;
}[] = [
  {
    name: "better-sqlite3",
    createDriver: (databaseUrl) => createBetterSqliteDriver({ databaseUrl }),
  },
  {
    name: "turso",
    createDriver: (databaseUrl) => createTursoDriver({ databaseUrl }),
  },
];

for (const adapter of adapters) {
  test(`${adapter.name} invocation settles across an atomic query/stream handoff`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-invocation-${adapter.name}-`),
    );
    const databaseUrl = join(directory.path, "invocation.sqlite");
    const runtime = new VirtualRuntimeHarness(1_000_000);
    const executionStarted = Promise.withResolvers<void>();
    const releaseExecution = Promise.withResolvers<void>();
    const application = defineLedger((sledge) => {
      const invocation = sledge.install(
        defineInvocation("experimental.contract.invocation", {
          inputSchema: Type.Object({ value: Type.String({ minLength: 1 }) }),
          resultSchema: Type.Object({ value: Type.String({ minLength: 1 }) }),
          failureSchema: Type.Never(),
          execute: async ({ input, signal }) => {
            executionStarted.resolve();
            await releaseExecution.promise;
            signal.throwIfAborted();

            return {
              outcome: "succeeded",
              value: { value: input.value.toUpperCase() },
            };
          },
        })(),
      );

      return { invocation };
    });
    await using opened = await application.open(
      adapter.createDriver(databaseUrl),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
    });
    const ref = opened.capabilities.invocation.result.ref("gated");

    await opened.ledger.emit(
      opened.capabilities.invocation.events.requested,
      {
        ref,
        input: { value: "gated" },
      },
      { dedupeKey: `test:${ref}:requested` },
    );
    await runtime.flush();
    await executionStarted.promise;

    const snapshotTaken = Promise.withResolvers<void>();
    const waitLedger = {
      querySnapshot: async (
        ...args: Parameters<typeof opened.ledger.querySnapshot>
      ) => {
        const snapshot = await opened.ledger.querySnapshot(...args);
        snapshotTaken.resolve();
        return snapshot;
      },
      resumeEvents: opened.ledger.resumeEvents.bind(opened.ledger),
    };
    const waiting = waitForResult(
      waitLedger,
      opened.capabilities.invocation.result,
      ref,
      AbortSignal.timeout(5_000),
    );

    await snapshotTaken.promise;
    releaseExecution.resolve();
    await drainWorkers(runtime, workers);

    assert.deepEqual(await waiting, {
      ref,
      outcome: "succeeded",
      value: { value: "GATED" },
    });
    assert.deepEqual(
      await readResult(
        opened.ledger,
        opened.capabilities.invocation.result,
        ref,
      ),
      {
        ref,
        outcome: "succeeded",
        value: { value: "GATED" },
      },
    );
    assert.deepEqual(
      await waitForResult(
        opened.ledger,
        opened.capabilities.invocation.result,
        ref,
        AbortSignal.timeout(5_000),
      ),
      {
        ref,
        outcome: "succeeded",
        value: { value: "GATED" },
      },
    );
  });

  test(`${adapter.name} invocation retries throws and preserves its result identity`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-invocation-retry-${adapter.name}-`),
    );
    const databaseUrl = join(directory.path, "invocation.sqlite");
    const runtime = new VirtualRuntimeHarness(2_000_000);
    const attempts: number[] = [];
    const application = defineLedger((sledge) => {
      const invocation = sledge.install(
        defineInvocation("experimental.contract.retrying-invocation", {
          inputSchema: Type.String({ minLength: 1 }),
          resultSchema: Type.String({ minLength: 1 }),
          failureSchema: Type.Never(),
          execute: async ({ input, ref, attempt }) => {
            attempts.push(attempt);

            if (attempt === 1) {
              throw new Error("retry once");
            }

            assert.equal(
              ref,
              "experimental.contract.retrying-invocation::operation",
            );
            return { outcome: "succeeded", value: input.toUpperCase() };
          },
        })(),
      );

      return { invocation };
    });

    {
      await using opened = await application.open(
        adapter.createDriver(databaseUrl),
        runtime,
      );
      await using workers = await opened.ledger.startWorkers({
        scheduler: runtime.scheduler,
        defaultRetryDelayMs: 10,
      });
      const ref = opened.capabilities.invocation.result.ref("operation");

      await opened.ledger.emit(
        opened.capabilities.invocation.events.requested,
        { ref, input: "retry" },
        { dedupeKey: `test:${ref}:requested` },
      );
      await waitForAttempt(runtime, attempts, 1);

      assert.deepEqual(
        await opened.ledger.query(
          opened.capabilities.invocation.queries.state,
          { ref },
        ),
        { kind: "pending", input: "retry" },
      );
    }

    {
      await using opened = await application.open(
        adapter.createDriver(databaseUrl),
        runtime,
      );
      await using workers = await opened.ledger.startWorkers({
        scheduler: runtime.scheduler,
        defaultRetryDelayMs: 10,
      });
      const ref = opened.capabilities.invocation.result.ref("operation");
      const waiting = waitForResult(
        opened.ledger,
        opened.capabilities.invocation.result,
        ref,
        AbortSignal.timeout(5_000),
      );

      await runtime.advanceByMs(10);
      await drainWorkers(runtime, workers);

      assert.deepEqual(await waiting, {
        ref,
        outcome: "succeeded",
        value: "RETRY",
      });
      assert.deepEqual(attempts, [1, 2]);
    }
  });

  test(`${adapter.name} invocation preserves typed terminal failures`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-invocation-failure-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(2_500_000);
    const application = defineLedger((sledge) => {
      const invocation = sledge.install(
        defineInvocation("experimental.contract.failed-invocation", {
          inputSchema: Type.Object({ operation: Type.String() }),
          resultSchema: Type.Null(),
          failureSchema: Type.Object({
            code: Type.Literal("rejected"),
            message: Type.String({ minLength: 1 }),
          }),
          execute: async ({ input }) => {
            const error = {
              code: "rejected",
              message: `${input.operation} was rejected`,
            } satisfies {
              readonly code: "rejected";
              readonly message: string;
            };

            return { outcome: "failed", error };
          },
        })(),
      );

      return { invocation };
    });
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "invocation.sqlite")),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
    });
    const ref = opened.capabilities.invocation.result.ref("denied");

    await opened.ledger.emit(
      opened.capabilities.invocation.events.requested,
      { ref, input: { operation: "publish" } },
      { dedupeKey: `test:${ref}:requested` },
    );
    await drainWorkers(runtime, workers);

    const expected = {
      ref,
      outcome: "failed" as const,
      error: {
        code: "rejected" as const,
        message: "publish was rejected",
      },
    };

    assert.deepEqual(
      await readResult(
        opened.ledger,
        opened.capabilities.invocation.result,
        ref,
      ),
      expected,
    );
    assert.deepEqual(
      await waitForResult(
        opened.ledger,
        opened.capabilities.invocation.result,
        ref,
        AbortSignal.timeout(5_000),
      ),
      expected,
    );
    assert.deepEqual(
      await opened.ledger.query(opened.capabilities.invocation.queries.state, {
        ref,
      }),
      {
        kind: "failed",
        input: { operation: "publish" },
        error: expected.error,
      },
    );
  });

  test(`${adapter.name} result wait obeys caller cancellation`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-result-wait-abort-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(3_000_000);
    const application = defineLedger((sledge) => {
      const invocation = sledge.install(
        defineInvocation("experimental.contract.abortable-wait", {
          inputSchema: Type.Null(),
          resultSchema: Type.Null(),
          failureSchema: Type.Never(),
          execute: async () => ({ outcome: "succeeded", value: null }),
        })(),
      );

      return { invocation };
    });
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "invocation.sqlite")),
      runtime,
    );
    const controller = new AbortController();
    const ref = opened.capabilities.invocation.result.ref("never-requested");
    const waiting = waitForResult(
      opened.ledger,
      opened.capabilities.invocation.result,
      ref,
      controller.signal,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("stop waiting"));

    await assert.rejects(waiting, /stop waiting/);
  });
}

async function waitForAttempt(
  runtime: VirtualRuntimeHarness,
  attempts: readonly number[],
  expected: number,
): Promise<void> {
  for (let check = 0; check < 200; check += 1) {
    await runtime.flush();

    if (attempts.at(-1) === expected) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(`invocation did not reach attempt ${expected}`);
}

async function drainWorkers(
  runtime: VirtualRuntimeHarness,
  workers: {
    waitForIdle(input: { readonly signal: AbortSignal }): Promise<void>;
  },
): Promise<void> {
  const controller = new AbortController();
  let settled = false;
  const idle = workers.waitForIdle({ signal: controller.signal }).then(() => {
    settled = true;
  });

  try {
    for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
      await runtime.flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (!settled) {
      throw new Error("invocation workers did not become idle");
    }

    await idle;
  } finally {
    controller.abort();
  }
}
