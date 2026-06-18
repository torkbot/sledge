import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { createBetterSqliteLedger } from "./better-sqlite3-ledger.ts";
import {
  createLedgerContractModel,
  runLedgerContractSuite,
  type LedgerContractDecisionMode,
  type LedgerContractHarness,
} from "./ledger.contract.ts";
import { type LedgerWorkers } from "./ledger.ts";

runLedgerContractSuite({
  suiteName: "better-sqlite ledger contract",
  create: async (): Promise<LedgerContractHarness> => {
    const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
    const databaseUrl = join(
      tmpdir(),
      `sledge-contract-better-${randomUUID()}.sqlite`,
    );
    const db = new Database(databaseUrl);

    db.exec(`
      CREATE TABLE IF NOT EXISTS "contractProjection" (
        "sourceEventId" INTEGER PRIMARY KEY,
        "decisionAttempts" INTEGER NOT NULL,
        "dispatchCount" INTEGER NOT NULL,
        "plannedIntentEventId" INTEGER
      );
    `);

    let decisionMode: LedgerContractDecisionMode = "ack";
    let materializationFailureText: string | null = null;

    const createRuntimeLedger = () => {
      return createBetterSqliteLedger({
        databaseUrl,
        model: createLedgerContractModel({
          readDecisionMode: () => decisionMode,
          readMaterializationFailureText: () => materializationFailureText,
          nowMs: () => runtime.nowMs(),
        }),
        timing: {
          clock: runtime.clock,
        },
      });
    };

    let ledger = createRuntimeLedger();
    let workers: LedgerWorkers = await ledger.startWorkers({
      scheduler: runtime.scheduler,
      leaseMs: 1_000,
      defaultRetryDelayMs: 1_000,
    });

    return {
      get ledger() {
        return ledger;
      },
      nowMs: () => runtime.nowMs(),
      advanceByMs: async (ms) => runtime.advanceByMs(ms),
      flush: async () => runtime.flush(),
      restart: async () => {
        await workers.close();
        await ledger.close();
        ledger = createRuntimeLedger();
        workers = await ledger.startWorkers({
          scheduler: runtime.scheduler,
          leaseMs: 1_000,
          defaultRetryDelayMs: 1_000,
        });
      },
      stop: async () => {
        await workers.close();
        await ledger.close();
        db.close();
        await rm(databaseUrl, { force: true });
      },
      setDecisionMode: (mode) => {
        decisionMode = mode;
      },
      setMaterializationFailureText: (text) => {
        materializationFailureText = text;
      },
      getDecisionAttempts: (sourceEventId) =>
        ledger.query("decisionAttempts", {
          sourceEventId,
        }),
      getDispatchCount: (sourceEventId) =>
        ledger.query("dispatchCount", {
          sourceEventId,
        }),
      getSeenSourceEventIds: () => ledger.query("seenSourceEventIds", {}),
    };
  },
});
