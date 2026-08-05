import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VirtualRuntimeHarness } from "@torkbot/sledge/runtime/virtual-runtime";
import { createTursoDriver } from "@torkbot/sledge/turso";

import { PrototypeArtifactStore } from "./artifact-store.ts";
import { createEpochPressureTestApplication } from "./epoch-application.ts";
import {
  MemoryArtifactSchema,
  PrefixArtifactSchema,
  type PublishedEpoch,
} from "./epoch-model.ts";

const conversationId = "conversation-1";

async function main(): Promise<void> {
  const report = await runEpochPressureTest();

  console.log(JSON.stringify(report, null, 2));
}

async function runEpochPressureTest(): Promise<unknown> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-epoch-pressure-test-"),
  );
  const databaseUrl = join(directory.path, "PROTOTYPE-WIPE-ME.sqlite");
  const runtime = new VirtualRuntimeHarness(1_000_000);
  const artifacts = new PrototypeArtifactStore();

  seedArtifacts(artifacts);

  const { application, log } = createEpochPressureTestApplication({
    artifacts,
    failCompactionOnceFor: new Set(["competitor", "restart"]),
  });
  let firstDreamEventId = 0;
  let checkpointBeforeRestart: unknown;

  {
    await using opened = await application.open(
      createTursoDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10_000,
      maxInFlight: 4,
    });
    const dreamRef = opened.capabilities.dreaming.result.ref("restart");
    const compactionRef = opened.capabilities.compactions.refFor(dreamRef);
    const epochRef = opened.capabilities.epochs.refFor(compactionRef);
    const requested = await opened.ledger.emit(
      opened.capabilities.dreaming.events.requested,
      {
        ref: dreamRef,
        input: {
          attemptId: "restart",
          conversationId,
          parentEpoch: 0,
          cutoff: 4,
          previousMemoryRef: "artifact:memory:zero",
          rawPrefixRef: "artifact:raw:restart",
        },
      },
      { dedupeKey: "epoch:restart:dream" },
    );
    firstDreamEventId = requested.eventId;

    await flushUntil(runtime, "durable memory checkpoint", async () => {
      const [dream, compaction, latest] = await Promise.all([
        opened.ledger.query(opened.capabilities.dreaming.queries.state, {
          ref: dreamRef,
        }),
        opened.ledger.query(opened.capabilities.compactions.queries.state, {
          ref: compactionRef,
        }),
        opened.ledger.query(opened.capabilities.epochs.queries.latest, {
          conversationId,
        }),
      ]);
      const compactionAttempted = log.some(
        (line) => line.includes(compactionRef) && line.includes("attempt 1/3"),
      );

      if (
        dream?.kind !== "succeeded" ||
        compaction?.kind !== "pending" ||
        latest !== null ||
        !compactionAttempted
      ) {
        return false;
      }

      checkpointBeforeRestart = { dream, compaction, latest, epochRef };
      return true;
    });
  }

  let firstEpoch: PublishedEpoch;
  let competingState: unknown;
  let finalEpoch: PublishedEpoch;
  let duplicateDreamEventId = 0;
  let metrics: unknown;
  let promptState: unknown;
  let remainingWork: unknown;
  let eventTrace: readonly unknown[];

  {
    await using opened = await application.open(
      createTursoDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10_000,
      maxInFlight: 4,
    });
    const dreamRef = opened.capabilities.dreaming.result.ref("restart");
    const duplicate = await opened.ledger.emit(
      opened.capabilities.dreaming.events.requested,
      {
        ref: dreamRef,
        input: {
          attemptId: "restart",
          conversationId,
          parentEpoch: 0,
          cutoff: 4,
          previousMemoryRef: "artifact:memory:zero",
          rawPrefixRef: "artifact:raw:restart",
        },
      },
      { dedupeKey: "epoch:restart:dream" },
    );
    duplicateDreamEventId = duplicate.eventId;

    assert.equal(duplicateDreamEventId, firstDreamEventId);

    await runtime.advanceByMs(10_000);
    firstEpoch = await waitForEpoch(opened, runtime, 4);

    const firstMemory = artifacts.get(
      firstEpoch.memoryRef,
      MemoryArtifactSchema,
    );
    const firstPrefix = artifacts.get(
      firstEpoch.compactedPrefixRef,
      PrefixArtifactSchema,
    );

    assert.deepEqual(firstMemory, {
      entries: [
        {
          key: "project.constraint",
          value: "small composable building blocks",
        },
        { key: "user.name", value: "Geoff" },
      ],
    });
    assert.deepEqual(
      firstPrefix.messages.map((message) => [message.cursor, message.kind]),
      [
        [2, "transient"],
        [4, "transient"],
      ],
    );

    const competitorDreamRef =
      opened.capabilities.dreaming.result.ref("competitor");
    const competitorCompactionRef =
      opened.capabilities.compactions.refFor(competitorDreamRef);
    const competitorEpochRef = opened.capabilities.epochs.refFor(
      competitorCompactionRef,
    );
    const nextDreamRef = opened.capabilities.dreaming.result.ref("next");

    await opened.ledger.emit(
      opened.capabilities.dreaming.events.requested,
      {
        ref: competitorDreamRef,
        input: {
          attemptId: "competitor",
          conversationId,
          parentEpoch: 1,
          cutoff: 6,
          previousMemoryRef: firstEpoch.memoryRef,
          rawPrefixRef: "artifact:raw:competitor",
        },
      },
      { dedupeKey: "epoch:competitor:dream" },
    );
    await opened.ledger.emit(
      opened.capabilities.dreaming.events.requested,
      {
        ref: nextDreamRef,
        input: {
          attemptId: "next",
          conversationId,
          parentEpoch: 1,
          cutoff: 5,
          previousMemoryRef: firstEpoch.memoryRef,
          rawPrefixRef: "artifact:raw:next",
        },
      },
      { dedupeKey: "epoch:next:dream" },
    );
    const secondEpoch = await waitForEpoch(opened, runtime, 5);
    assert.equal(secondEpoch.epoch, 2);
    assert.equal(secondEpoch.parentEpoch, 1);

    await runtime.advanceByMs(10_000);
    competingState = await waitForEpochState(
      opened,
      runtime,
      competitorEpochRef,
      "failed",
    );
    assert.deepEqual(competingState, {
      kind: "failed",
      reason: "stale_parent",
    });
    assert.deepEqual(
      await opened.ledger.query(opened.capabilities.epochs.queries.latest, {
        conversationId,
      }),
      secondEpoch,
    );

    const rebaseDreamRef = opened.capabilities.dreaming.result.ref("rebase");

    await opened.ledger.emit(
      opened.capabilities.dreaming.events.requested,
      {
        ref: rebaseDreamRef,
        input: {
          attemptId: "rebase",
          conversationId,
          parentEpoch: 2,
          cutoff: 6,
          previousMemoryRef: secondEpoch.memoryRef,
          rawPrefixRef: "artifact:raw:rebase",
        },
      },
      { dedupeKey: "epoch:rebase:dream" },
    );
    finalEpoch = await waitForEpoch(opened, runtime, 6);
    assert.equal(finalEpoch.epoch, 3);
    assert.equal(finalEpoch.parentEpoch, 2);

    const finalMemory = artifacts.get(
      finalEpoch.memoryRef,
      MemoryArtifactSchema,
    );
    const finalPrefix = artifacts.get(
      finalEpoch.compactedPrefixRef,
      PrefixArtifactSchema,
    );

    assert.deepEqual(finalMemory, firstMemory);
    assert.deepEqual(
      finalPrefix.messages.map((message) => message.cursor),
      [2, 4, 5, 6],
    );
    assert(
      finalPrefix.messages.every((message) => message.kind === "transient"),
    );
    promptState = {
      epoch: finalEpoch.epoch,
      systemMemory: finalMemory.entries,
      conversation: finalPrefix.messages.map((message) => message.text),
    };

    await workers.waitForIdle({ signal: AbortSignal.timeout(5_000) });
    const latestEventId = await readLatestEventId(opened.ledger);
    eventTrace = await readEventTrace(opened.ledger, latestEventId);
    const [dreaming, compactions, epochs] = await Promise.all([
      opened.ledger.query(opened.capabilities.dreaming.queries.metrics, {}),
      opened.ledger.query(opened.capabilities.compactions.queries.metrics, {}),
      opened.ledger.query(opened.capabilities.epochs.queries.metrics, {}),
    ]);
    metrics = {
      dreaming,
      compactions,
      epochs,
      totalRows:
        dreaming.requests +
        dreaming.settlements +
        compactions.sources +
        compactions.settlements +
        epochs.candidates +
        epochs.terminals +
        epochs.publishedConversations,
    };
    remainingWork = await opened.ledger.listWork({ limit: 1_000 });
  }

  assert.equal(eventTrace.length, 16, JSON.stringify(eventTrace, null, 2));
  assert.deepEqual(metrics, {
    dreaming: { requests: 4, settlements: 4 },
    compactions: { sources: 4, settlements: 4 },
    epochs: { candidates: 4, terminals: 4, publishedConversations: 1 },
    totalRows: 25,
  });
  assert.deepEqual(remainingWork, []);

  return {
    databaseRestarts: 1,
    eventRows: eventTrace.length,
    expectedEventRows: 16,
    projectionMetrics: metrics,
    duplicateJoinedOriginalRequest: duplicateDreamEventId === firstDreamEventId,
    checkpointBeforeRestart,
    firstEpoch,
    competingState,
    finalEpoch,
    promptState,
    attempts: log,
    remainingWork,
  };
}

function seedArtifacts(artifacts: PrototypeArtifactStore): void {
  artifacts.put("artifact:memory:zero", MemoryArtifactSchema, { entries: [] });
  const initialMessages = [
    {
      cursor: 1,
      id: "message-1",
      kind: "durable" as const,
      memory: { key: "user.name", value: "Geoff" },
      text: "The user's name is Geoff.",
    },
    {
      cursor: 2,
      id: "message-2",
      kind: "transient" as const,
      text: "We are pressure-testing the stdlib design.",
    },
    {
      cursor: 3,
      id: "message-3",
      kind: "durable" as const,
      memory: {
        key: "project.constraint",
        value: "small composable building blocks",
      },
      text: "The stdlib must use small composable building blocks.",
    },
    {
      cursor: 4,
      id: "message-4",
      kind: "transient" as const,
      text: "Compaction may need to finish before the next agent turn.",
    },
  ];

  artifacts.put("artifact:raw:restart", PrefixArtifactSchema, {
    messages: initialMessages,
  });
  artifacts.put("artifact:raw:next", PrefixArtifactSchema, {
    messages: [
      ...initialMessages.filter((message) => message.kind === "transient"),
      {
        cursor: 5,
        id: "message-5",
        kind: "transient",
        text: "A later turn added more transient work.",
      },
    ],
  });
  const throughSix = [
    ...initialMessages.filter((message) => message.kind === "transient"),
    {
      cursor: 5,
      id: "message-5",
      kind: "transient" as const,
      text: "A later turn added more transient work.",
    },
    {
      cursor: 6,
      id: "message-6",
      kind: "transient" as const,
      text: "More work arrived while background compaction was running.",
    },
  ];

  artifacts.put("artifact:raw:competitor", PrefixArtifactSchema, {
    messages: throughSix,
  });
  artifacts.put("artifact:raw:rebase", PrefixArtifactSchema, {
    messages: throughSix,
  });
}

async function waitForEpoch<
  TOpened extends {
    readonly ledger: {
      query(token: unknown, params: unknown): Promise<unknown>;
    };
    readonly capabilities: {
      readonly epochs: {
        readonly queries: { readonly latest: unknown };
      };
    };
  },
>(
  opened: TOpened,
  runtime: VirtualRuntimeHarness,
  cutoff: number,
): Promise<PublishedEpoch> {
  let epoch: PublishedEpoch | null = null;

  await waitUntil(runtime, `epoch through ${cutoff}`, async () => {
    const candidate = await opened.ledger.query(
      opened.capabilities.epochs.queries.latest,
      { conversationId },
    );

    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "cutoff" in candidate &&
      typeof candidate.cutoff === "number" &&
      candidate.cutoff >= cutoff
    ) {
      epoch = candidate as PublishedEpoch;
      return true;
    }

    return false;
  });

  if (epoch === null) {
    throw new Error(`epoch through ${cutoff} did not publish`);
  }

  return epoch;
}

async function waitForEpochState<
  TOpened extends {
    readonly ledger: {
      query(token: unknown, params: unknown): Promise<unknown>;
    };
    readonly capabilities: {
      readonly epochs: {
        readonly queries: { readonly state: unknown };
      };
    };
  },
>(
  opened: TOpened,
  runtime: VirtualRuntimeHarness,
  ref: string,
  kind: string,
): Promise<unknown> {
  let matched: unknown = null;

  await waitUntil(runtime, `epoch state ${kind}`, async () => {
    const state = await opened.ledger.query(
      opened.capabilities.epochs.queries.state,
      { ref },
    );

    if (
      typeof state === "object" &&
      state !== null &&
      "kind" in state &&
      state.kind === kind
    ) {
      matched = state;
      return true;
    }

    return false;
  });

  return matched;
}

async function flushUntil(
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

    await runtime.advanceByMs(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(`prototype did not observe ${description}`);
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

async function readEventTrace(
  ledger: {
    tailEvents(input: {
      readonly last: number;
      readonly signal: AbortSignal;
    }): AsyncIterable<unknown>;
  },
  latestEventId: number,
): Promise<readonly unknown[]> {
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
        item.event === null
      ) {
        throw new Error("ledger returned an invalid event stream item");
      }

      const event = item.event;
      trace.push({
        eventId: "eventId" in event ? event.eventId : null,
        dedupeKey: "dedupeKey" in event ? event.dedupeKey : null,
      });

      if ("eventId" in event && event.eventId === latestEventId) {
        abort.abort();
        return trace;
      }
    }
  } finally {
    abort.abort();
  }

  throw new Error(`event trace did not reach ${latestEventId}`);
}

main().catch((error: unknown) => {
  console.error("Sledge epoch pressure test failed", error);
  process.exitCode = 1;
});
