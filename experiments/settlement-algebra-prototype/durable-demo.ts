import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";

import { createBetterSqliteDriver } from "../../src/better-sqlite3.ts";
import { defineAll, defineRace } from "../../src/experimental/composition.ts";
import { defineInvocation } from "../../src/experimental/invocation.ts";
import { defineThen } from "../../src/experimental/then.ts";
import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { defineLedger } from "../../src/sledge.ts";
import { Settlement, matchSettlement, readResult } from "../../src/stdlib.ts";

const RootInputSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  root: Type.Union([
    Type.Literal("succeed"),
    Type.Literal("fail"),
    Type.Literal("cancel"),
    Type.Literal("retry-once"),
  ]),
  derived: Type.Union([
    Type.Literal("succeed"),
    Type.Literal("fail"),
    Type.Literal("cancel"),
    Type.Literal("retry-once"),
  ]),
});
const RootResultSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  derived: Type.Union([
    Type.Literal("succeed"),
    Type.Literal("fail"),
    Type.Literal("cancel"),
    Type.Literal("retry-once"),
  ]),
});
const RootFailureSchema = Type.Object({
  stage: Type.Literal("root"),
  message: Type.String({ minLength: 1 }),
});
const DerivedResultSchema = Type.Object({
  length: Type.Integer({ minimum: 1 }),
});
const DerivedFailureSchema = Type.Object({
  stage: Type.Literal("derived"),
  message: Type.String({ minLength: 1 }),
});
const ChainResultSchema = Type.Object({
  memberCount: Type.Integer({ minimum: 1 }),
});
const ChainFailureSchema = Type.Object({
  stage: Type.Literal("chain"),
  message: Type.String({ minLength: 1 }),
});

export async function runDurableDemo(): Promise<unknown> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-settlement-prototype-"),
  );
  const databaseUrl = join(directory.path, "PROTOTYPE-WIPE-ME.sqlite");
  const runtime = new VirtualRuntimeHarness(1_000_000);
  const rootAttempts = new Map<string, number>();
  const derivedAttempts = new Map<string, number>();
  const afterAllExecutions = new Set<string>();
  const application = defineLedger((sledge) => {
    const root = sledge.install(
      defineInvocation("prototype.settlement.root", {
        inputSchema: RootInputSchema,
        resultSchema: RootResultSchema,
        failureSchema: RootFailureSchema,
        execute: async ({ input, attempt }) => {
          rootAttempts.set(input.key, attempt);

          if (input.root === "retry-once" && attempt === 1) {
            throw new Error("retry root attempt");
          }

          if (input.root === "fail") {
            return Settlement.failed({
              stage: "root",
              message: `root rejected ${input.key}`,
            });
          }

          if (input.root === "cancel") {
            return Settlement.cancelled();
          }

          return Settlement.succeeded({
            key: input.key,
            text: `value:${input.key}`,
            derived: input.derived,
          });
        },
      })(),
    );
    const derived = sledge.install(
      defineThen("prototype.settlement.derived", root.result, {
        resultSchema: DerivedResultSchema,
        failureSchema: DerivedFailureSchema,
        execute: async ({ value, attempt }) => {
          derivedAttempts.set(value.key, attempt);

          if (value.derived === "retry-once" && attempt === 1) {
            throw new Error("retry derived attempt");
          }

          if (value.derived === "fail") {
            return Settlement.failed({
              stage: "derived",
              message: `derived rejected ${value.key}`,
            });
          }

          if (value.derived === "cancel") {
            return Settlement.cancelled();
          }

          return Settlement.succeeded({ length: value.text.length });
        },
      })(),
    );
    const all = sledge.install(
      defineAll("prototype.settlement.all", [root.result, derived.result])(),
    );
    const race = sledge.install(
      defineRace("prototype.settlement.race", [root.result, derived.result])(),
    );
    const afterAll = sledge.install(
      defineThen("prototype.settlement.after-all", all.result, {
        resultSchema: ChainResultSchema,
        failureSchema: ChainFailureSchema,
        execute: async ({ sourceRef, value }) => {
          afterAllExecutions.add(sourceRef);

          return Settlement.succeeded({
            memberCount: Object.keys(value.members).length,
          });
        },
      })(),
    );

    return { afterAll, all, derived, race, root };
  });
  const scenarios = [
    { key: "retry", root: "retry-once", derived: "retry-once" },
    { key: "root-failure", root: "fail", derived: "succeed" },
    { key: "root-cancel", root: "cancel", derived: "succeed" },
    { key: "derived-failure", root: "succeed", derived: "fail" },
  ] as const;

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 16 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 8,
    });

    for (const scenario of scenarios) {
      const ref = opened.capabilities.root.result.ref(scenario.key);

      await opened.ledger.emit(
        opened.capabilities.root.events.requested,
        { ref, input: scenario },
        { dedupeKey: `settlement:${scenario.key}:requested` },
      );
    }

    for (const group of [
      { key: "retry-chain", source: "retry" },
      { key: "failure-chain", source: "root-failure" },
      { key: "cancel-chain", source: "root-cancel" },
    ] as const) {
      const rootRef = opened.capabilities.root.result.ref(group.source);
      const derivedRef = opened.capabilities.derived.refFor(rootRef);

      await opened.ledger.emit(opened.capabilities.all.events.opened, {
        ref: opened.capabilities.all.result.ref(group.key),
        members: { root: rootRef, derived: derivedRef },
      });
    }

    const failureRootRef = opened.capabilities.root.result.ref("root-failure");
    const failureDerivedRef =
      opened.capabilities.derived.refFor(failureRootRef);

    await opened.ledger.emit(opened.capabilities.race.events.opened, {
      ref: opened.capabilities.race.result.ref("failure-race"),
      members: { root: failureRootRef, derived: failureDerivedRef },
    });

    await waitUntil(runtime, "first retryable root attempt", async () =>
      Promise.resolve(rootAttempts.get("retry") === 1),
    );
  }

  const observations: Record<string, unknown> = {};

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 16 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 8,
    });

    for (const scenario of scenarios) {
      const sourceRef = opened.capabilities.root.result.ref(scenario.key);
      const derivedRef = opened.capabilities.derived.refFor(sourceRef);

      await waitUntil(runtime, `${scenario.key} settlement`, async () => {
        const observation = await readResult(
          opened.ledger,
          opened.capabilities.derived.result,
          derivedRef,
        );

        if (observation === null) {
          await runtime.advanceByMs(10);
          return false;
        }

        observations[scenario.key] = {
          observation,
          ordinaryProgramValue: matchSettlement(observation, {
            succeeded: (value) => `value:${value.length}`,
            failed: (error) => `error:${error.stage}:${error.message}`,
            cancelled: () => "cancelled",
          }),
        };
        return true;
      });
    }

    assert.equal(rootAttempts.get("retry"), 2);
    assert.equal(derivedAttempts.get("retry"), 2);
    assert.equal(derivedAttempts.has("root-failure"), false);
    assert.equal(derivedAttempts.has("root-cancel"), false);
    assert.equal(derivedAttempts.get("derived-failure"), 1);

    const allRef = opened.capabilities.all.result.ref("retry-chain");
    const afterAllRef = opened.capabilities.afterAll.refFor(allRef);
    const failedAllRef = opened.capabilities.all.result.ref("failure-chain");
    const afterFailedAllRef = opened.capabilities.afterAll.refFor(failedAllRef);
    const cancelledAllRef = opened.capabilities.all.result.ref("cancel-chain");
    const afterCancelledAllRef =
      opened.capabilities.afterAll.refFor(cancelledAllRef);
    const raceRef = opened.capabilities.race.result.ref("failure-race");

    for (const ref of [afterAllRef, afterFailedAllRef, afterCancelledAllRef]) {
      await waitUntil(runtime, `${ref} settlement`, async () => {
        return (
          (await readResult(
            opened.ledger,
            opened.capabilities.afterAll.result,
            ref,
          )) !== null
        );
      });
    }

    await waitUntil(runtime, `${raceRef} settlement`, async () => {
      return (
        (await readResult(
          opened.ledger,
          opened.capabilities.race.result,
          raceRef,
        )) !== null
      );
    });

    const allObservation = await readRequiredResult(
      opened.ledger,
      opened.capabilities.all.result,
      allRef,
    );
    const afterAllObservation = await readRequiredResult(
      opened.ledger,
      opened.capabilities.afterAll.result,
      afterAllRef,
    );
    const afterFailedAllObservation = await readRequiredResult(
      opened.ledger,
      opened.capabilities.afterAll.result,
      afterFailedAllRef,
    );
    const afterCancelledAllObservation = await readRequiredResult(
      opened.ledger,
      opened.capabilities.afterAll.result,
      afterCancelledAllRef,
    );
    const raceObservation = await readRequiredResult(
      opened.ledger,
      opened.capabilities.race.result,
      raceRef,
    );

    assert.equal(allObservation.outcome, "succeeded");
    assert.deepEqual(afterAllObservation, {
      ref: afterAllRef,
      outcome: "succeeded",
      value: { memberCount: 2 },
    });
    assert.equal(afterFailedAllObservation.outcome, "failed");
    assert.deepEqual(afterCancelledAllObservation, {
      ref: afterCancelledAllRef,
      outcome: "cancelled",
    });
    assert.deepEqual([...afterAllExecutions], [allRef]);
    assert.equal(raceObservation.outcome, "failed");
    assert.equal((await opened.ledger.listWork()).length, 0);

    const eventCount = await readEventCount(opened.ledger);

    assert.equal(eventCount, 23);

    return {
      verdict:
        "One Settlement shape crossed invocation, then, all, race, another then, ResultPort, and ordinary code.",
      databaseRestarts: 1,
      eventCount,
      expectedEventCount: 23,
      attempts: {
        root: Object.fromEntries(rootAttempts),
        derived: Object.fromEntries(derivedAttempts),
      },
      observations,
      composites: {
        all: allObservation,
        thenAll: afterAllObservation,
        thenFailedAll: afterFailedAllObservation,
        thenCancelledAll: afterCancelledAllObservation,
        race: raceObservation,
      },
      remainingWork: [],
    };
  }
}

async function readRequiredResult<
  const TPort extends Parameters<typeof readResult>[1],
>(
  ledger: Parameters<typeof readResult>[0],
  result: TPort,
  ref: ReturnType<TPort["ref"]>,
) {
  const observation = await readResult(ledger, result, ref);

  if (observation === null) {
    throw new Error(`prototype did not observe ${ref}`);
  }

  return observation;
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

async function readEventCount(ledger: {
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<unknown>;
}): Promise<number> {
  const latestAbort = new AbortController();
  let latestEventId = 0;

  try {
    for await (const item of ledger.tailEvents({
      last: 1,
      signal: latestAbort.signal,
    })) {
      latestEventId = readEventId(item);
      latestAbort.abort();
      break;
    }
  } finally {
    latestAbort.abort();
  }

  const traceAbort = new AbortController();
  let count = 0;

  try {
    for await (const item of ledger.tailEvents({
      last: latestEventId,
      signal: traceAbort.signal,
    })) {
      count += 1;

      if (readEventId(item) === latestEventId) {
        traceAbort.abort();
        return count;
      }
    }
  } finally {
    traceAbort.abort();
  }

  throw new Error("event trace did not reach the latest event");
}

function readEventId(item: unknown): number {
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

  return item.event.eventId;
}
