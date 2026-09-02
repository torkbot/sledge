import assert from "node:assert/strict";
import test from "node:test";

import { raceWithSignal } from "./async-signals.ts";

// ── raceWithSignal ────────────────────────────────────────────────────────────

test("raceWithSignal returns completed when operation resolves before abort", async () => {
  const controller = new AbortController();
  const result = await raceWithSignal(Promise.resolve("hello"), controller.signal);
  assert.deepEqual(result, { status: "completed", value: "hello" });
});

test("raceWithSignal returns aborted when signal is already aborted before call", async () => {
  const controller = new AbortController();
  controller.abort();

  // The operation never settles — only the pre-aborted signal should win.
  const pending = new Promise<never>(() => undefined);
  const result = await raceWithSignal(pending, controller.signal);
  assert.deepEqual(result, { status: "aborted" });
});

test("raceWithSignal returns aborted when signal fires while operation is pending", async () => {
  const controller = new AbortController();
  const { promise: operation, resolve: resolveOperation } =
    Promise.withResolvers<string>();

  const racePromise = raceWithSignal(operation, controller.signal);
  controller.abort();

  const result = await racePromise;
  assert.deepEqual(result, { status: "aborted" });

  // Settle the dangling operation so it does not leak across other tests.
  resolveOperation("unused");
});

test("raceWithSignal propagates rejection when operation rejects before signal aborts", async () => {
  const controller = new AbortController();
  const expected = new Error("storage failure");

  await assert.rejects(
    raceWithSignal(Promise.reject(expected), controller.signal),
    (err) => err === expected,
  );
});

// Regression test for issue #68:
// When aborted.promise wins the race, operation.then(…) is left as a
// dangling promise. If operation later rejects, Node.js 15+ fires
// UnhandledPromiseRejection → process crash. The fix attaches
// `void operation.catch(() => undefined)` in the finally block.
test("raceWithSignal suppresses operation rejection when signal aborts first (issue #68)", async () => {
  const controller = new AbortController();
  const { promise: operation, reject: rejectOperation } =
    Promise.withResolvers<string>();

  // Abort before the operation settles so aborted.promise wins the race.
  controller.abort();
  const result = await raceWithSignal(operation, controller.signal);
  assert.deepEqual(result, { status: "aborted" });

  // Collect any unhandled rejections that fire after this point.
  const unhandledReasons: unknown[] = [];
  const captureUnhandled = (reason: unknown) => {
    unhandledReasons.push(reason);
  };
  process.on("unhandledRejection", captureUnhandled);

  try {
    // Reject the operation AFTER the race has already settled.
    rejectOperation(new Error("post-abort storage failure"));

    // setImmediate runs after the microtask checkpoint where Node.js detects
    // unhandled rejections, so any missing handler will have fired by now.
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(
      unhandledReasons,
      [],
      "expected no unhandled rejection after signal-aborted raceWithSignal",
    );
  } finally {
    process.off("unhandledRejection", captureUnhandled);
  }
});
