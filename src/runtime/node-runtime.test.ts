import assert from "node:assert/strict";
import test from "node:test";

import { NodeRuntimeScheduler, SystemRuntimeClock } from "./node-runtime.ts";

test("SystemRuntimeClock reads wall time", () => {
  const before = Date.now();
  const clock = new SystemRuntimeClock();
  const now = clock.nowMs();
  const after = Date.now();

  assert.ok(now >= before);
  assert.ok(now <= after);
});

test("NodeRuntimeScheduler scheduleOnce executes and cancel prevents execution", async () => {
  const scheduler = new NodeRuntimeScheduler();

  const observed: string[] = [];

  await new Promise<void>((resolve) => {
    scheduler.scheduleOnce(5, () => {
      observed.push("ran");
      resolve();
    });
  });

  assert.deepEqual(observed, ["ran"]);

  const cancelled = scheduler.scheduleOnce(10, () => {
    observed.push("should-not-run");
  });

  cancelled.cancel();

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

  assert.deepEqual(observed, ["ran"]);
});

test("NodeRuntimeScheduler scheduleOnce preserves long delays and cancellation", (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout"],
  });
  let nowMs = 1_900_000_000_000;
  context.mock.method(performance, "now", () => nowMs);

  const scheduler = new NodeRuntimeScheduler();
  const maximumTimerDelayMs = 2_147_483_647;
  let calls = 0;

  const scheduled = scheduler.scheduleOnce(maximumTimerDelayMs + 10, () => {
    calls += 1;
  });

  nowMs += 1;
  context.mock.timers.tick(1);
  assert.equal(calls, 0);

  nowMs += maximumTimerDelayMs - 1;
  context.mock.timers.tick(maximumTimerDelayMs - 1);
  assert.equal(calls, 0);

  scheduled.cancel();
  context.mock.timers.tick(10);
  assert.equal(calls, 0);

  scheduler.scheduleOnce(maximumTimerDelayMs + 10, () => {
    calls += 1;
  });
  nowMs += maximumTimerDelayMs;
  context.mock.timers.tick(maximumTimerDelayMs);
  assert.equal(calls, 0);

  nowMs += 9;
  context.mock.timers.tick(9);
  assert.equal(calls, 0);

  nowMs += 1;
  context.mock.timers.tick(1);
  assert.equal(calls, 1);
});

test("NodeRuntimeScheduler scheduleOnce does not add a chunk after a late callback", (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout"],
  });
  const maximumTimerDelayMs = 2_147_483_647;
  let nowMs = 1_900_000_000_000;
  context.mock.method(performance, "now", () => nowMs);

  const scheduler = new NodeRuntimeScheduler();
  let calls = 0;

  scheduler.scheduleOnce(maximumTimerDelayMs + 10, () => {
    calls += 1;
  });

  nowMs += maximumTimerDelayMs + 20;
  context.mock.timers.tick(maximumTimerDelayMs);

  assert.equal(calls, 1);
});

test("NodeRuntimeScheduler scheduleOnce is not extended by wall-clock rollback", (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout"],
  });
  let wallNowMs = 1_900_000_000_000;
  let monotonicNowMs = 1_000;
  context.mock.method(Date, "now", () => wallNowMs);
  context.mock.method(performance, "now", () => monotonicNowMs);

  const scheduler = new NodeRuntimeScheduler();
  let calls = 0;

  scheduler.scheduleOnce(10, () => {
    calls += 1;
  });

  wallNowMs -= 60 * 60 * 1_000;
  monotonicNowMs += 10;
  context.mock.timers.tick(10);

  assert.equal(calls, 1);
});
