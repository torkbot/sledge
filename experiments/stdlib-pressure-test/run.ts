import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { VirtualRuntimeHarness } from "@torkbot/sledge/runtime/virtual-runtime";
import { createTursoDriver } from "@torkbot/sledge/turso";

import { createPressureTestApplication } from "./application.ts";
import type { CompositionResult } from "./composition.ts";

type CompositionSettledState = {
  readonly kind: "settled";
  readonly result: CompositionResult;
};

type DemoReport = {
  readonly databaseRestarts: number;
  readonly durableEventCount: number;
  readonly expectedDurableEventCount: number;
  readonly eventTrace: readonly unknown[];
  readonly invocationAttempts: readonly string[];
  readonly restartAll: unknown;
  readonly raceBeforeLateLoser: unknown;
  readonly raceAfterLateLoser: unknown;
  readonly historicalRace: unknown;
  readonly nestedAll: unknown;
  readonly lateTool: unknown;
  readonly projectionMetrics: unknown;
  readonly remainingWork: unknown;
};

async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    const report = await runDemo();

    console.log(
      JSON.stringify(
        process.argv.includes("--trace") ? report : summarize(report),
        null,
        2,
      ),
    );
    return;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let report: DemoReport | null = null;
  let status = "No scenario has run.";

  try {
    while (true) {
      console.clear();
      console.log("\x1b[1mSledge stdlib pressure test\x1b[0m");
      console.log(
        "\x1b[2mInvocation + heterogeneous all/race composition on a scratch ledger\x1b[0m\n",
      );
      console.log(`\x1b[1mStatus\x1b[0m\n${status}\n`);
      console.log(`\x1b[1mState\x1b[0m\n${JSON.stringify(report, null, 2)}\n`);
      console.log(
        "\x1b[1m[d]\x1b[0m \x1b[2mrun deterministic pressure test\x1b[0m  " +
          "\x1b[1m[q]\x1b[0m \x1b[2mquit\x1b[0m",
      );
      const command = (await readline.question("> ")).trim().toLowerCase();

      if (command === "q") {
        return;
      }

      if (command === "d") {
        status = "Running...";
        report = await runDemo();
        status = "All pressure-test invariants held.";
      } else {
        status = `Unknown command ${JSON.stringify(command)}.`;
      }
    }
  } finally {
    readline.close();
  }
}

async function runDemo(): Promise<DemoReport> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-stdlib-pressure-test-"),
  );
  const databaseUrl = join(directory.path, "PROTOTYPE-WIPE-ME.sqlite");
  const runtime = new VirtualRuntimeHarness(1_000_000);
  const { application, log } = createPressureTestApplication();
  let durableEventCount = 0;
  let restartAllRef = "";

  {
    await using opened = await application.open(
      createTursoDriver({ databaseUrl }),
      {
        clock: runtime.clock,
        scheduler: runtime.scheduler,
      },
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 100,
      maxInFlight: 4,
    });
    const compactionRef =
      opened.capabilities.compactions.result.ref("restart:compaction");
    const toolRef = opened.capabilities.toolCalls.result.ref("restart:tool");
    const groupRef = opened.capabilities.composition.result.ref("restart:all");
    restartAllRef = groupRef;

    await opened.ledger.emit(
      opened.capabilities.composition.events.opened,
      {
        ref: groupRef,
        mode: "all",
        members: [
          { key: "compaction", ref: compactionRef },
          { key: "tool", ref: toolRef },
        ],
      },
      { dedupeKey: "prototype:restart:all" },
    );
    await opened.ledger.emit(
      opened.capabilities.compactions.events.requested,
      {
        ref: compactionRef,
        input: {
          documentId: "document-restart",
          revisions: ["r1", "r2", "r3"],
        },
      },
      { dedupeKey: "prototype:restart:compaction" },
    );
    await waitUntil(runtime, "pre-restart compaction", async () => {
      const [compaction, group] = await Promise.all([
        opened.ledger.query(opened.capabilities.compactions.queries.state, {
          ref: compactionRef,
        }),
        opened.ledger.query(opened.capabilities.composition.queries.state, {
          ref: groupRef,
        }),
      ]);

      return compaction?.kind === "succeeded" && group?.kind === "pending";
    });
    await workers.waitForIdle({ signal: AbortSignal.timeout(5_000) });
    const latestEventId = await readLatestEventId(opened.ledger);
    assert.equal(
      (await readEventTrace(opened.ledger, latestEventId)).length,
      3,
    );
  }

  let restartAll: CompositionSettledState;
  let raceBeforeLateLoser: CompositionSettledState;
  let raceAfterLateLoser: unknown;
  let historicalRace: CompositionSettledState;
  let nestedAll: CompositionSettledState;
  let lateTool: unknown;
  let projectionMetrics: unknown;
  let remainingWork: unknown;
  let eventTrace: readonly unknown[];

  {
    await using opened = await application.open(
      createTursoDriver({ databaseUrl }),
      {
        clock: runtime.clock,
        scheduler: runtime.scheduler,
      },
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 100,
      maxInFlight: 4,
    });
    const restartToolRef =
      opened.capabilities.toolCalls.result.ref("restart:tool");
    const restartGroupRef =
      opened.capabilities.composition.result.ref("restart:all");

    assert.equal(restartGroupRef, restartAllRef);
    await opened.ledger.emit(
      opened.capabilities.toolCalls.events.requested,
      {
        ref: restartToolRef,
        input: {
          toolName: "search_workspace",
          query: "restart",
          behavior: "succeed",
        },
      },
      { dedupeKey: "prototype:restart:tool" },
    );
    restartAll = await waitForComposition(opened, runtime, restartGroupRef);
    assert.equal(restartAll.result.outcome, "succeeded");
    assert.deepEqual(
      restartAll.result.members.map((member) => member.key),
      ["compaction", "tool"],
    );

    const winnerRef = opened.capabilities.compactions.result.ref("race:winner");
    const lateToolRef = opened.capabilities.toolCalls.result.ref("race:late");
    const raceRef = opened.capabilities.composition.result.ref("race:group");

    await opened.ledger.emit(
      opened.capabilities.composition.events.opened,
      {
        ref: raceRef,
        mode: "race",
        members: [
          { key: "compaction", ref: winnerRef },
          { key: "tool", ref: lateToolRef },
        ],
      },
      { dedupeKey: "prototype:race:opened" },
    );
    await waitUntil(runtime, "pending race", async () => {
      const state = await opened.ledger.query(
        opened.capabilities.composition.queries.state,
        { ref: raceRef },
      );

      return state?.kind === "pending";
    });
    await opened.ledger.emit(
      opened.capabilities.compactions.events.requested,
      {
        ref: winnerRef,
        input: {
          documentId: "race-winner",
          revisions: ["r1", "r2"],
        },
      },
      { dedupeKey: "prototype:race:winner" },
    );
    raceBeforeLateLoser = await waitForComposition(opened, runtime, raceRef);
    assert.equal(raceBeforeLateLoser.result.winner, "compaction");
    assert.equal(raceBeforeLateLoser.result.outcome, "succeeded");
    assert.equal(raceBeforeLateLoser.result.members.length, 1);

    const lateToolRequest = {
      ref: lateToolRef,
      input: {
        toolName: "search_workspace" as const,
        query: "late-loser",
        behavior: "fail" as const,
      },
    };

    await opened.ledger.emit(
      opened.capabilities.toolCalls.events.requested,
      lateToolRequest,
      { dedupeKey: "prototype:race:late" },
    );
    await waitUntil(runtime, "finite failed tool invocation", async () => {
      const state = await opened.ledger.query(
        opened.capabilities.toolCalls.queries.state,
        { ref: lateToolRef },
      );

      return state?.kind === "failed";
    });
    raceAfterLateLoser = await opened.ledger.query(
      opened.capabilities.composition.queries.state,
      { ref: raceRef },
    );
    assert.deepEqual(raceAfterLateLoser, raceBeforeLateLoser);

    await opened.ledger.emit(
      opened.capabilities.toolCalls.events.requested,
      lateToolRequest,
      { dedupeKey: "prototype:race:late" },
    );

    const historicalRaceRef =
      opened.capabilities.composition.result.ref("historical:race");

    await opened.ledger.emit(
      opened.capabilities.composition.events.opened,
      {
        ref: historicalRaceRef,
        mode: "race",
        members: [
          { key: "later", ref: raceRef },
          { key: "earlier", ref: restartGroupRef },
        ],
      },
      { dedupeKey: "prototype:historical:race" },
    );
    historicalRace = await waitForComposition(
      opened,
      runtime,
      historicalRaceRef,
    );
    assert.equal(historicalRace.result.winner, "earlier");

    const nestedRef = opened.capabilities.composition.result.ref("nested:all");

    await opened.ledger.emit(
      opened.capabilities.composition.events.opened,
      {
        ref: nestedRef,
        mode: "all",
        members: [
          { key: "historicalRace", ref: historicalRaceRef },
          { key: "race", ref: raceRef },
          { key: "failedTool", ref: lateToolRef },
        ],
      },
      { dedupeKey: "prototype:nested:all" },
    );
    nestedAll = await waitForComposition(opened, runtime, nestedRef);
    assert.equal(nestedAll.result.outcome, "failed");
    assert.deepEqual(
      nestedAll.result.members.map((member) => member.key),
      ["historicalRace", "race", "failedTool"],
    );

    lateTool = await opened.ledger.query(
      opened.capabilities.toolCalls.queries.state,
      { ref: lateToolRef },
    );
    await workers.waitForIdle({ signal: AbortSignal.timeout(5_000) });
    const latestEventId = await readLatestEventId(opened.ledger);
    eventTrace = await readEventTrace(opened.ledger, latestEventId);
    durableEventCount = eventTrace.length;
    const [toolCalls, compactions, composition] = await Promise.all([
      opened.ledger.query(opened.capabilities.toolCalls.queries.metrics, {}),
      opened.ledger.query(opened.capabilities.compactions.queries.metrics, {}),
      opened.ledger.query(opened.capabilities.composition.queries.metrics, {}),
    ]);
    projectionMetrics = {
      toolCalls,
      compactions,
      composition,
      totalRows:
        toolCalls.requests +
        toolCalls.settlements +
        compactions.requests +
        compactions.settlements +
        composition.groups +
        composition.members +
        composition.completions +
        composition.settlements,
    };
    remainingWork = await opened.ledger.listWork({ limit: 1_000 });
  }

  assert.equal(durableEventCount, 16, JSON.stringify(eventTrace, null, 2));
  assert.equal(log.filter((line) => line.includes("race:late")).length, 2);
  assert.deepEqual(projectionMetrics, {
    toolCalls: { requests: 2, settlements: 2 },
    compactions: { requests: 2, settlements: 2 },
    composition: {
      completions: 4,
      groups: 4,
      members: 9,
      settlements: 8,
    },
    totalRows: 33,
  });

  return {
    databaseRestarts: 1,
    durableEventCount,
    expectedDurableEventCount: 16,
    eventTrace,
    invocationAttempts: log,
    restartAll,
    raceBeforeLateLoser,
    raceAfterLateLoser,
    historicalRace,
    nestedAll,
    lateTool,
    projectionMetrics,
    remainingWork,
  };
}

function summarize(report: DemoReport): unknown {
  return {
    databaseRestarts: report.databaseRestarts,
    durableEventCount: report.durableEventCount,
    expectedDurableEventCount: report.expectedDurableEventCount,
    projectionMetrics: report.projectionMetrics,
    invocationAttempts: report.invocationAttempts,
    outcomes: {
      restartAll: report.restartAll,
      raceBeforeLateLoser: report.raceBeforeLateLoser,
      raceAfterLateLoser: report.raceAfterLateLoser,
      historicalRace: report.historicalRace,
      nestedAll: report.nestedAll,
      lateTool: report.lateTool,
    },
    remainingWork: report.remainingWork,
  };
}

async function waitForComposition<
  TOpened extends {
    readonly ledger: {
      query(token: unknown, params: unknown): Promise<unknown>;
    };
    readonly capabilities: {
      readonly composition: {
        readonly queries: { readonly state: unknown };
      };
    };
  },
>(
  opened: TOpened,
  runtime: VirtualRuntimeHarness,
  ref: string,
): Promise<CompositionSettledState> {
  let settled: CompositionSettledState | null = null;

  await waitUntil(runtime, `composition ${ref}`, async () => {
    const state = await opened.ledger.query(
      opened.capabilities.composition.queries.state,
      { ref },
    );

    if (
      typeof state === "object" &&
      state !== null &&
      "kind" in state &&
      state.kind === "settled"
    ) {
      settled = state as CompositionSettledState;
      return true;
    }

    return false;
  });

  if (settled === null) {
    throw new Error(`composition ${ref} did not settle`);
  }

  return settled;
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
        payload: "payload" in event ? event.payload : null,
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
  console.error("Sledge stdlib pressure test failed", error);
  process.exitCode = 1;
});
