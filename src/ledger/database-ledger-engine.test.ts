import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { Type } from "@sinclair/typebox";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { createBetterSqliteLedger } from "./better-sqlite3-ledger.ts";
import { defineLedgerModel } from "./ledger.ts";

async function waitFor(
  runtime: VirtualRuntimeHarness,
  predicate: () => Promise<boolean> | boolean,
): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    await runtime.flush();

    if (await predicate()) {
      return;
    }

    await runtime.advanceByMs(1);
  }

  throw new Error("waitFor timed out");
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number = 2_000,
): Promise<IteratorResult<T>> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`iterator.next timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

test("ledger enforces maxInFlight dispatch concurrency", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  const model = defineLedgerModel({
    events: {
      "job.requested": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "job.run": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {},
    queries: {},
    register(builder) {
      builder.materialize("job.requested", ({ event, actions }) => {
        actions.enqueue("job.run", {
          id: event.payload.id,
        });
      });

      builder.handle("job.run", async () => {
        active += 1;
        peak = Math.max(peak, active);

        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });

        active -= 1;
        completed += 1;

        return {
          outcome: "ack",
        } as const;
      });
    },
  });

  let active = 0;
  let peak = 0;
  let completed = 0;
  const releases: Array<() => void> = [];

  await using ledger = createBetterSqliteLedger({
    database,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    maxInFlight: 2,
  });

  await ledger.emit("job.requested", { id: 1 });
  await ledger.emit("job.requested", { id: 2 });
  await ledger.emit("job.requested", { id: 3 });

  await waitFor(runtime, () => releases.length === 2);
  assert.equal(peak, 2);

  const first = releases.shift();
  assert.ok(first !== undefined);
  first();

  await waitFor(runtime, () => releases.length === 2);

  while (releases.length > 0) {
    const release = releases.shift();

    if (release !== undefined) {
      release();
    }

    await runtime.flush();
  }

  await waitFor(runtime, () => completed === 3);

  assert.equal(peak, 2);
});

test("deduped emit does not replay projections or materialization", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(tmpdir(), `ledger-r1-${randomUUID()}.sqlite`);
  const database = new Database(databasePath);

  let projected = 0;
  let processed = 0;

  const model = defineLedgerModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {
      "message.process": Type.Object({
        id: Type.Number(),
      }),
    },
    indexers: {
      trackProjection: Type.Object({
        id: Type.Number(),
      }),
    },
    queries: {},
    register(builder) {
      builder.project("message.received", async ({ event, actions }) => {
        await actions.index("trackProjection", {
          id: event.payload.id,
        });
      });

      builder.materialize("message.received", ({ event, actions }) => {
        actions.enqueue("message.process", {
          id: event.payload.id,
        });
      });

      builder.handle("message.process", async () => {
        processed += 1;

        return {
          outcome: "ack",
        } as const;
      });
    },
  });

  try {
    await using ledger = createBetterSqliteLedger({
      database,
      boundModel: model.bind({
        indexers: {
          trackProjection: async () => {
            projected += 1;
          },
        },
        queries: {},
      }),
      timing: {
        clock: runtime.clock,
        scheduler: runtime.scheduler,
      },
    });

    await ledger.emit(
      "message.received",
      {
        id: 42,
      },
      {
        dedupeKey: "message:42",
      },
    );

    await ledger.emit(
      "message.received",
      {
        id: 42,
      },
      {
        dedupeKey: "message:42",
      },
    );

    await waitFor(runtime, () => processed === 1);
    assert.equal(projected, 1);
    assert.equal(processed, 1);
  } finally {
    await rm(databasePath, {
      force: true,
    });
  }
});

function createBusyTestModel() {
  return defineLedgerModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: () => {},
  });
}

test("emit retries SQLITE_BUSY transaction conflicts", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(tmpdir(), `ledger-r1-busy-${randomUUID()}.sqlite`);
  const lockHolder = new Database(databasePath, {
    timeout: 0,
  });
  const ledgerDb = new Database(databasePath, {
    timeout: 0,
  });

  const model = createBusyTestModel();

  const ledger = createBetterSqliteLedger({
    database: ledgerDb,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  try {
    lockHolder.exec("BEGIN IMMEDIATE");

    const emit = ledger.emit("message.received", {
      id: 42,
    });

    await sleepMs(25);

    lockHolder.exec("COMMIT");

    await emit;

    const row = lockHolder
      .prepare(`SELECT COUNT(*) as total FROM events`)
      .get();

    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("expected count row object");
    }

    const total = (row as Record<string, unknown>)["total"];

    assert.equal(total, 1);
  } finally {
    try {
      lockHolder.exec("ROLLBACK");
    } catch {
      // Ignore rollback when no transaction is active.
    }

    await ledger.close();

    lockHolder.close();

    await rm(databasePath, {
      force: true,
    });
  }
});

test("emit fails fast when busy retries are disabled", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const databasePath = join(
    tmpdir(),
    `ledger-r1-busy-disabled-${randomUUID()}.sqlite`,
  );
  const lockHolder = new Database(databasePath, {
    timeout: 0,
  });
  const ledgerDb = new Database(databasePath, {
    timeout: 0,
  });

  const model = createBusyTestModel();

  const ledger = createBetterSqliteLedger({
    database: ledgerDb,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    maxBusyRetries: 0,
  });

  try {
    lockHolder.exec("BEGIN IMMEDIATE");

    await assert.rejects(
      ledger.emit("message.received", {
        id: 42,
      }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }

        const maybeCode = (error as { readonly code?: unknown }).code;

        return maybeCode === "SQLITE_BUSY" || error.message.includes("BUSY");
      },
    );
  } finally {
    try {
      lockHolder.exec("ROLLBACK");
    } catch {
      // Ignore rollback when no transaction is active.
    }

    await ledger.close();

    lockHolder.close();

    await rm(databasePath, {
      force: true,
    });
  }
});

test("tailEvents does not expose rolled back in-flight events", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  let releaseMaterializer!: () => void;
  const materializerGate = new Promise<void>((resolve) => {
    releaseMaterializer = () => {
      resolve();
    };
  });

  let materializerStarted = false;

  const model = defineLedgerModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register(builder) {
      builder.materialize("message.received", async () => {
        materializerStarted = true;
        await materializerGate;

        throw new Error("materialization failure");
      });
    },
  });

  await using ledger = createBetterSqliteLedger({
    database,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  const emit = ledger.emit("message.received", {
    id: 1,
  });

  await waitFor(runtime, () => materializerStarted);

  const abortController = new AbortController();
  const iterator = ledger
    .tailEvents({
      last: 1,
      signal: abortController.signal,
    })
    [Symbol.asyncIterator]();

  const next = iterator.next();
  assert.equal(await settlesWithin(next, 20), false);

  releaseMaterializer();

  await assert.rejects(emit);

  assert.equal(await settlesWithin(next, 20), false);

  abortController.abort();

  const done = await next;
  assert.equal(done.done, true);
});

test("tailEvents yields last N events then follows new events", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  const model = defineLedgerModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: () => {},
  });

  await using ledger = createBetterSqliteLedger({
    database,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  await ledger.emit("message.received", { id: 1 });
  await ledger.emit("message.received", { id: 2 });
  await ledger.emit("message.received", { id: 3 });

  const abortController = new AbortController();
  const iterator = ledger
    .tailEvents({
      last: 2,
      signal: abortController.signal,
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(iterator);
  const second = await nextWithTimeout(iterator);

  assert.equal(first.done, false);
  assert.equal(second.done, false);

  if (first.done || second.done) {
    throw new Error("expected backlog events");
  }

  assert.equal(first.value.event.payload.id, 2);
  assert.equal(second.value.event.payload.id, 3);
  assert.equal(typeof first.value.cursor, "string");

  const follow = nextWithTimeout(iterator);

  await ledger.emit("message.received", { id: 4 });

  const third = await follow;

  assert.equal(third.done, false);

  if (third.done) {
    throw new Error("expected followed event");
  }

  assert.equal(third.value.event.payload.id, 4);

  abortController.abort();

  const done = await nextWithTimeout(iterator);
  assert.equal(done.done, true);
});

test("resumeEvents continues from opaque cursor", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  const model = defineLedgerModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: () => {},
  });

  await using ledger = createBetterSqliteLedger({
    database,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  await ledger.emit("message.received", { id: 1 });
  await ledger.emit("message.received", { id: 2 });
  await ledger.emit("message.received", { id: 3 });

  const tailAbortController = new AbortController();
  const tailIterator = ledger
    .tailEvents({
      last: 2,
      signal: tailAbortController.signal,
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(tailIterator);

  assert.equal(first.done, false);

  if (first.done) {
    throw new Error("expected first tail event");
  }

  tailAbortController.abort();

  const resumeAbortController = new AbortController();
  const resumeIterator = ledger
    .resumeEvents({
      cursor: first.value.cursor,
      signal: resumeAbortController.signal,
    })
    [Symbol.asyncIterator]();

  const resumed = await nextWithTimeout(resumeIterator);

  assert.equal(resumed.done, false);

  if (resumed.done) {
    throw new Error("expected resumed event");
  }

  assert.equal(resumed.value.event.payload.id, 3);

  const follow = nextWithTimeout(resumeIterator);
  await ledger.emit("message.received", { id: 4 });

  const followed = await follow;

  assert.equal(followed.done, false);

  if (followed.done) {
    throw new Error("expected followed resumed event");
  }

  assert.equal(followed.value.event.payload.id, 4);

  resumeAbortController.abort();

  const done = await nextWithTimeout(resumeIterator);
  assert.equal(done.done, true);

  assert.throws(() => {
    ledger.resumeEvents({
      cursor: "bad-cursor",
      signal: AbortSignal.timeout(1_000),
    });
  });
});

test("tail iterator return stops stream without external abort", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  const model = defineLedgerModel({
    events: {
      "message.received": Type.Object({
        id: Type.Number(),
      }),
    },
    queues: {},
    indexers: {},
    queries: {},
    register: () => {},
  });

  await using ledger = createBetterSqliteLedger({
    database,
    boundModel: model.bind({
      indexers: {},
      queries: {},
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  await ledger.emit("message.received", { id: 1 });

  const iterator = ledger
    .tailEvents({
      last: 1,
      signal: AbortSignal.timeout(30_000),
    })
    [Symbol.asyncIterator]();

  const first = await nextWithTimeout(iterator);
  assert.equal(first.done, false);

  if (iterator.return === undefined) {
    throw new Error("expected iterator.return to exist");
  }

  const closed = await iterator.return();
  assert.equal(closed.done, true);

  const done = await nextWithTimeout(iterator);
  assert.equal(done.done, true);
});
