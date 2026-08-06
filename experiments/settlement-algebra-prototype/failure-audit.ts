import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";

import { createBetterSqliteDriver } from "../../src/better-sqlite3.ts";
import { defineInvocation } from "../../src/experimental/invocation.ts";
import type { ListWorkInput, WorkSnapshot } from "../../src/ledger.ts";
import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { defineLedger } from "../../src/sledge.ts";
import { Settlement, readResult } from "../../src/stdlib.ts";

const AuditInputSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("cancelled-work"),
    Type.Literal("retrying-defect"),
    Type.Literal("bounded-policy"),
    Type.Literal("lease-interruption"),
  ]),
});
const AuditResultSchema = Type.Object({
  attempt: Type.Integer({ minimum: 1 }),
});
const AuditFailureSchema = Type.Object({
  kind: Type.Literal("attempts-exhausted"),
  attempts: Type.Integer({ minimum: 1 }),
});

export async function runFailureAudit(): Promise<unknown> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-settlement-failure-audit-"),
  );
  const databaseUrl = join(directory.path, "PROTOTYPE-WIPE-ME.sqlite");
  const runtime = new VirtualRuntimeHarness(2_000_000);
  const attempts = new Map<string, number>();
  const application = defineLedger((sledge) => {
    const operation = sledge.install(
      defineInvocation("prototype.settlement.failure-audit", {
        inputSchema: AuditInputSchema,
        resultSchema: AuditResultSchema,
        failureSchema: AuditFailureSchema,
        execute: async ({ input, attempt, signal }) => {
          attempts.set(input.kind, attempt);

          if (input.kind === "lease-interruption" && attempt === 1) {
            await waitForAbort(signal);
          }

          if (input.kind === "retrying-defect") {
            throw new Error("persistent untyped defect");
          }

          if (input.kind === "bounded-policy" && attempt < 3) {
            throw new Error("transient failure before policy exhaustion");
          }

          if (input.kind === "bounded-policy") {
            return Settlement.failed({
              kind: "attempts-exhausted",
              attempts: attempt,
            });
          }

          return Settlement.succeeded({ attempt });
        },
      })(),
    );

    return { operation };
  });

  await using opened = await application.open(
    createBetterSqliteDriver({ databaseUrl }),
    runtime,
  );
  const sourceEventIds = new Map<string, number>();

  for (const kind of [
    "cancelled-work",
    "retrying-defect",
    "bounded-policy",
    "lease-interruption",
  ] as const) {
    const ref = opened.capabilities.operation.result.ref(kind);
    const commit = await opened.ledger.emit(
      opened.capabilities.operation.events.requested,
      { ref, input: { kind } },
    );

    sourceEventIds.set(kind, commit.eventId);
  }

  const cancelledWork = await readOnlyWorkFor(
    opened.ledger,
    sourceEventIds.get("cancelled-work")!,
  );

  if (cancelledWork.ref === null) {
    throw new Error("audit invocation work was not addressable");
  }

  const cancellation = await opened.ledger.cancelWork({
    ref: cancelledWork.ref,
    reason: "operator cancelled raw queue work",
  });

  assert.equal(cancellation.status, "cancelled");

  {
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 16 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 4,
    });

    await waitUntil(runtime, async () => {
      return attempts.get("lease-interruption") === 1;
    });
  }

  {
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 16 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 4,
    });

    await waitUntil(runtime, async () => {
      const boundedRef =
        opened.capabilities.operation.result.ref("bounded-policy");
      const interruptedRef =
        opened.capabilities.operation.result.ref("lease-interruption");
      const bounded = await readResult(
        opened.ledger,
        opened.capabilities.operation.result,
        boundedRef,
      );
      const interrupted = await readResult(
        opened.ledger,
        opened.capabilities.operation.result,
        interruptedRef,
      );

      if (
        bounded !== null &&
        interrupted !== null &&
        (attempts.get("retrying-defect") ?? 0) >= 3
      ) {
        return true;
      }

      await runtime.advanceByMs(10);
      return false;
    });
  }

  const result = opened.capabilities.operation.result;
  const cancelledRef = result.ref("cancelled-work");
  const retryingRef = result.ref("retrying-defect");
  const boundedRef = result.ref("bounded-policy");
  const interruptedRef = result.ref("lease-interruption");
  const cancelledObservation = await readResult(
    opened.ledger,
    result,
    cancelledRef,
  );
  const retryingObservation = await readResult(
    opened.ledger,
    result,
    retryingRef,
  );
  const boundedObservation = await readResult(
    opened.ledger,
    result,
    boundedRef,
  );
  const interruptedObservation = await readResult(
    opened.ledger,
    result,
    interruptedRef,
  );
  const cancelledSnapshot = await readOnlyWorkFor(
    opened.ledger,
    sourceEventIds.get("cancelled-work")!,
  );
  const retryingSnapshot = await readOnlyWorkFor(
    opened.ledger,
    sourceEventIds.get("retrying-defect")!,
  );

  assert.equal(cancelledObservation, null);
  assert.equal(cancelledSnapshot.state, "cancelled");
  assert.equal(retryingObservation, null);
  assert.equal(retryingSnapshot.state, "delayed");
  assert.deepEqual(boundedObservation, {
    ref: boundedRef,
    outcome: "failed",
    error: { kind: "attempts-exhausted", attempts: 3 },
  });
  assert.deepEqual(interruptedObservation, {
    ref: interruptedRef,
    outcome: "succeeded",
    value: { attempt: 2 },
  });

  return {
    verdict:
      "Typed failures, retries, and lease interruption are distinguishable, but raw queue cancellation can orphan a pending result.",
    cases: {
      cancelledWork: {
        work: cancelledSnapshot,
        result: cancelledObservation,
        accounting: "gap: terminal queue state has no result settlement",
      },
      retryingDefect: {
        attempts: attempts.get("retrying-defect"),
        work: retryingSnapshot,
        result: retryingObservation,
        accounting: "nonterminal attempt failure remains retryable",
      },
      boundedPolicy: {
        result: boundedObservation,
        accounting: "caller converted retry exhaustion into typed failure",
      },
      leaseInterruption: {
        result: interruptedObservation,
        accounting:
          "attempt interruption retried instead of cancelling program",
      },
    },
  };
}

async function readOnlyWorkFor(
  ledger: {
    listWork(input?: ListWorkInput): Promise<readonly WorkSnapshot[]>;
  },
  sourceEventId: number,
) {
  const work = await ledger.listWork({ sourceEventId });

  assert.equal(work.length, 1);
  return work[0]!;
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();

  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

async function waitUntil(
  runtime: VirtualRuntimeHarness,
  condition: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await runtime.flush();

    if (await condition()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error("failure audit did not converge");
}
