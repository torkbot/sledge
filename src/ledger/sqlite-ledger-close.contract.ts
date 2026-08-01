import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { Type } from "typebox";

import {
  composeLedgerModels,
  type ComposedLedgerEventTokens,
  type ComposedLedgerQueryTokens,
  type ComposedLedgerSignalTokens,
  defineLedgerShape,
  type Ledger,
  type LedgerTiming,
} from "./ledger.ts";

const closeContractShape = defineLedgerShape({
  moduleId: "sqlite-ledger-close.contract",
  events: {
    recorded: {
      payload: Type.Object({
        value: Type.String(),
      }),
      outcome: Type.String(),
    },
  },
});
const closeContractModule = closeContractShape.register({
  events: {
    recorded: ({ event }) => event.payload.value,
  },
});
const closeContractModel = composeLedgerModels(closeContractModule);
const closeContractTiming: LedgerTiming = {
  clock: {
    nowMs: () => 1_900_000_000_000,
  },
};

type CloseContractLedger = Ledger<
  ComposedLedgerEventTokens<typeof closeContractModel>,
  ComposedLedgerQueryTokens<typeof closeContractModel>,
  ComposedLedgerSignalTokens<typeof closeContractModel>
>;

export function runSqliteLedgerCloseContract(input: {
  readonly suiteName: string;
  create(input: {
    readonly databaseUrl: string;
    readonly model: typeof closeContractModel;
    readonly timing: LedgerTiming;
  }): CloseContractLedger | Promise<CloseContractLedger>;
  openCheckpointBlocker(databaseUrl: string):
    | Promise<{
        close(): Promise<void>;
      }>
    | {
        close(): Promise<void>;
      };
}): void {
  test(`${input.suiteName} clean close leaves one portable SQLite file`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sledge-clean-close-contract-"),
    );
    const databaseUrl = join(directory, "ledger.sqlite");
    const portableDatabaseUrl = join(directory, "portable.sqlite");
    const ledger = await input.create({
      databaseUrl,
      model: closeContractModel,
      timing: closeContractTiming,
    });

    try {
      await ledger.emit(
        closeContractModule.events.recorded,
        {
          value: "survives without the WAL",
        },
        {
          dedupeKey: "portable-event",
        },
      );

      assert.ok((await stat(`${databaseUrl}-wal`)).size > 0);

      await ledger.close();
      await ledger.close();

      const walSizeAfterClose = await fileSizeOrNull(`${databaseUrl}-wal`);
      assert.ok(walSizeAfterClose === null || walSizeAfterClose === 0);

      await copyFile(databaseUrl, portableDatabaseUrl);

      const portableLedger = await input.create({
        databaseUrl: portableDatabaseUrl,
        model: closeContractModel,
        timing: closeContractTiming,
      });

      try {
        const duplicate = await portableLedger.emit(
          closeContractModule.events.recorded,
          {
            value: "would be new if the copied database were empty",
          },
          {
            dedupeKey: "portable-event",
          },
        );

        assert.equal(duplicate.outcome, "survives without the WAL");
        assert.deepEqual(duplicate.payload, {
          value: "survives without the WAL",
        });
      } finally {
        await portableLedger.close();
      }
    } finally {
      await ledger.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test(`${input.suiteName} busy close reports the checkpoint failure and releases its writer`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sledge-busy-close-contract-"),
    );
    const databaseUrl = join(directory, "ledger.sqlite");
    const ledger = await input.create({
      databaseUrl,
      model: closeContractModel,
      timing: closeContractTiming,
    });
    let blocker:
      | {
          close(): Promise<void>;
        }
      | undefined;

    try {
      await ledger.emit(closeContractModule.events.recorded, {
        value: "visible to the blocking reader",
      });
      blocker = await input.openCheckpointBlocker(databaseUrl);
      await ledger.emit(closeContractModule.events.recorded, {
        value: "blocked from checkpointing",
      });

      const closeResults = await Promise.allSettled([
        ledger.close(),
        ledger.close(),
      ]);

      for (const result of closeResults) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
          assert.ok(isBusyCheckpointFailure(result.reason));
        }
      }

      await assert.rejects(ledger.close(), isBusyCheckpointFailure);

      await blocker.close();
      blocker = undefined;

      const inspector = new Database(databaseUrl, { timeout: 0 });
      try {
        assert.equal(
          inspector.pragma("journal_mode = DELETE", { simple: true }),
          "delete",
        );
      } finally {
        inspector.close();
      }
    } finally {
      await blocker?.close();
      await ledger.close().catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });
}

function isBusyCheckpointFailure(error: unknown): boolean {
  if (
    !(error instanceof AggregateError) ||
    error.message !== "failed to close ledger"
  ) {
    return false;
  }

  return error.errors.some((cause: unknown) => {
    return (
      cause instanceof Error &&
      /^SQLite WAL checkpoint could not truncate because another connection is busy \(busy: 1, log: (?:\d+|unknown), checkpointed: (?:\d+|unknown)\)$/.test(
        cause.message,
      )
    );
  });
}

async function fileSizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
