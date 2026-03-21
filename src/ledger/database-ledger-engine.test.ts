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
