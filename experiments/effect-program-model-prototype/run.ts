import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Static } from "typebox";

import { createBetterSqliteDriver } from "../../src/better-sqlite3.ts";
import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { readResult, type ResultRef } from "../../src/stdlib.ts";
import {
  createEpochEffectApplication,
  EpochResultSchema,
  epochProgram,
  type EpochFunctions,
} from "./epoch-application.ts";

async function main(): Promise<void> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-effect-program-prototype-"),
  );
  const databaseUrl = join(directory.path, "PROTOTYPE-WIPE-ME.sqlite");
  const runtime = new VirtualRuntimeHarness(1_000_000);
  let extractionCalls = 0;
  let compactionCalls = 0;
  let programReplays = 0;
  const functions: EpochFunctions = {
    async extractMemory({ input, signal }) {
      extractionCalls += 1;
      signal.throwIfAborted();
      const durableFacts = input.prefix.filter((message) =>
        message.startsWith("remember:"),
      );

      return {
        durableFacts,
        memory: [...input.previousMemory, ...durableFacts],
      };
    },
    async compactPrefix({ input, signal }) {
      compactionCalls += 1;
      signal.throwIfAborted();

      if (compactionCalls === 1) {
        throw new Error("simulated compaction process loss");
      }

      const durable = new Set(input.memoryExtraction.durableFacts);

      return {
        compactedPrefix: input.prefix.filter(
          (message) => !durable.has(message),
        ),
      };
    },
  };
  const application = createEpochEffectApplication({
    functions,
    program: epochProgram,
    onProgramReplay: () => {
      programReplays += 1;
    },
  });
  let workflowRef: ResultRef<
    Static<typeof EpochResultSchema>,
    "prototype.effect.epoch-workflow"
  >;
  let beforeRestart: unknown;

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10_000,
      maxInFlight: 4,
    });
    workflowRef = opened.capabilities.workflow.result.ref("conversation-1:1");

    await opened.ledger.emit(
      opened.capabilities.workflow.events.requested,
      {
        ref: workflowRef,
        input: {
          previousMemory: ["remember:user-name=Geoff"],
          prefix: [
            "remember:project=Sledge",
            "transient:discuss Effect",
            "remember:constraint=small primitives",
            "transient:pressure test replay",
          ],
        },
      },
      { dedupeKey: `effect:${workflowRef}:requested` },
    );

    await waitUntil(runtime, "failed first compaction attempt", async () => {
      const state = await opened.ledger.query(
        opened.capabilities.workflow.queries.state,
        { ref: workflowRef },
      );

      if (
        state?.kind !== "pending" ||
        extractionCalls !== 1 ||
        compactionCalls !== 1 ||
        programReplays !== 2
      ) {
        return false;
      }

      beforeRestart = {
        compactionCalls,
        extractionCalls,
        programReplays,
        workflow: state,
      };
      return true;
    });
  }

  let result: unknown;
  let eventTrace: readonly unknown[];
  let remainingWork: unknown;

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10_000,
      maxInFlight: 4,
    });

    await runtime.advanceByMs(10_000);
    await waitUntil(runtime, "settled Effect workflow", async () => {
      const observation = await readResult(
        opened.ledger,
        opened.capabilities.workflow.result,
        workflowRef,
      );

      if (observation === null) {
        return false;
      }

      result = observation;
      return true;
    });

    assert.deepEqual(result, {
      ref: workflowRef,
      outcome: "succeeded",
      value: {
        memory: [
          "remember:user-name=Geoff",
          "remember:project=Sledge",
          "remember:constraint=small primitives",
        ],
        compactedPrefix: [
          "transient:discuss Effect",
          "transient:pressure test replay",
        ],
      },
    });
    assert.equal(extractionCalls, 1);
    assert.equal(compactionCalls, 2);
    assert.equal(programReplays, 3);

    eventTrace = await readEventTrace(opened.ledger);
    remainingWork = await opened.ledger.listWork();

    assert.equal(eventTrace.length, 6, JSON.stringify(eventTrace, null, 2));
    assert.deepEqual(remainingWork, []);
  }

  console.log(
    JSON.stringify(
      {
        verdict:
          "The Effect program resumed durably without a polling workflow worker.",
        databaseRestarts: 1,
        durableEvents: eventTrace.length,
        effectProgramReplays: programReplays,
        externalActivityCalls: {
          extractMemory: extractionCalls,
          compactPrefix: compactionCalls,
        },
        beforeRestart,
        result,
        eventTrace,
        remainingWork,
      },
      null,
      2,
    ),
  );
}

async function waitUntil(
  runtime: VirtualRuntimeHarness,
  description: string,
  condition: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await runtime.flush();

    if (await condition()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(`prototype did not observe ${description}`);
}

async function readEventTrace(ledger: {
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<unknown>;
}): Promise<readonly unknown[]> {
  const latestEventId = await readLatestEventId(ledger);
  const abort = new AbortController();
  const trace: unknown[] = [];

  try {
    for await (const item of ledger.tailEvents({
      last: latestEventId,
      signal: abort.signal,
    })) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("event" in item) ||
        typeof item.event !== "object" ||
        item.event === null ||
        !("eventId" in item.event) ||
        typeof item.event.eventId !== "number"
      ) {
        throw new Error("ledger returned an invalid event stream item");
      }

      trace.push({
        eventId: item.event.eventId,
        dedupeKey: "dedupeKey" in item.event ? item.event.dedupeKey : null,
        causationEventId:
          "causationEventId" in item.event ? item.event.causationEventId : null,
      });

      if (item.event.eventId === latestEventId) {
        abort.abort();
        return trace;
      }
    }
  } finally {
    abort.abort();
  }

  throw new Error("event trace did not reach workflow settlement");
}

async function readLatestEventId(ledger: {
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<unknown>;
}): Promise<number> {
  const abort = new AbortController();

  try {
    for await (const item of ledger.tailEvents({
      last: 1,
      signal: abort.signal,
    })) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("event" in item) ||
        typeof item.event !== "object" ||
        item.event === null ||
        !("eventId" in item.event) ||
        typeof item.event.eventId !== "number"
      ) {
        throw new Error("ledger returned an invalid event stream item");
      }

      abort.abort();
      return item.event.eventId;
    }
  } finally {
    abort.abort();
  }

  throw new Error("scratch ledger has no durable events");
}

main().catch((error: unknown) => {
  console.error("Sledge Effect program prototype failed", error);
  process.exitCode = 1;
});
