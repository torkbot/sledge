import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { createBetterSqliteDriver } from "../better-sqlite3.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { defineLedger, type LedgerDriver } from "../sledge.ts";
import { waitForResult } from "../stdlib.ts";
import { createTursoDriver } from "../turso.ts";
import { defineDeadline } from "./deadline.ts";
import { defineExternalValue } from "./external-value.ts";

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
  test(`${adapter.name} external values and deadlines expose readable results`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-producers-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(1_000);
    const application = defineLedger((sledge) => {
      const approval = sledge.install(
        defineExternalValue("experimental.contract.approval", {
          valueSchema: Type.Object({ approved: Type.Boolean() }),
        })(),
      );
      const deadline = sledge.install(
        defineDeadline("experimental.contract.deadline")(),
      );

      return { approval, deadline };
    });
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "producers.sqlite")),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      scheduler: runtime.scheduler,
    });
    const approvalRef = opened.capabilities.approval.result.ref("one");
    const deadlineRef = opened.capabilities.deadline.result.ref("one");

    await opened.ledger.emit(opened.capabilities.approval.events.opened, {
      ref: approvalRef,
      prompt: "continue?",
    });
    await opened.ledger.emit(opened.capabilities.approval.events.supplied, {
      ref: approvalRef,
      value: { approved: true },
    });
    await opened.ledger.emit(opened.capabilities.approval.events.supplied, {
      ref: approvalRef,
      value: { approved: false },
    });
    await opened.ledger.emit(opened.capabilities.deadline.events.scheduled, {
      ref: deadlineRef,
      atMs: 1_050,
    });

    const approval = waitForResult(
      opened.ledger,
      opened.capabilities.approval.result,
      approvalRef,
      AbortSignal.timeout(5_000),
    );
    await driveUntil(runtime, approval, "external value");

    assert.deepEqual(await approval, {
      ref: approvalRef,
      outcome: "succeeded",
      value: { approved: true },
    });

    const deadline = waitForResult(
      opened.ledger,
      opened.capabilities.deadline.result,
      deadlineRef,
      AbortSignal.timeout(5_000),
    );

    await runtime.advanceByMs(50);
    await driveUntil(runtime, deadline, "deadline");

    assert.deepEqual(await deadline, {
      ref: deadlineRef,
      outcome: "succeeded",
      value: { firedAtMs: 1_050 },
    });
  });
}

async function driveUntil<T>(
  runtime: VirtualRuntimeHarness,
  operation: Promise<T>,
  description: string,
): Promise<void> {
  let settled = false;
  operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    await runtime.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (!settled) {
    throw new Error(`producer did not settle ${description}`);
  }
}
