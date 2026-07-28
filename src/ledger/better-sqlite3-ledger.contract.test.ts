import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { createBetterSqliteLedger } from "./better-sqlite3-ledger.ts";
import {
  createLedgerContractControlledWork,
  createLedgerContractHarnessLedger,
  createLedgerContractModel,
  LedgerContractPausableScheduler,
  runLedgerContractSuite,
  type LedgerContractDecisionMode,
  type LedgerContractHarness,
} from "./ledger.contract.ts";
import { composeLedgerModels, type LedgerWorkers } from "./ledger.ts";

runLedgerContractSuite({
  suiteName: "better-sqlite ledger contract",
  create: async (): Promise<LedgerContractHarness> => {
    const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
    const databaseUrl = join(
      tmpdir(),
      `sledge-contract-better-${randomUUID()}.sqlite`,
    );
    let decisionMode: LedgerContractDecisionMode = "ack";
    let materializationFailureText: string | null = null;
    const controlledWork = createLedgerContractControlledWork();

    const createRuntimeLedger = () => {
      const model = createLedgerContractModel({
        readDecisionMode: () => decisionMode,
        readMaterializationFailureText: () => materializationFailureText,
        nowMs: () => runtime.nowMs(),
        runControlledWork: (workKey, attempt) =>
          controlledWork.run(workKey, attempt),
      });
      const ledger = createBetterSqliteLedger({
        databaseUrl,
        model: composeLedgerModels(model),
        timing: {
          clock: runtime.clock,
        },
      });

      return createLedgerContractHarnessLedger(ledger);
    };

    let ledger = createRuntimeLedger();
    let primaryMaxInFlight = 16;
    let primaryScheduler = new LedgerContractPausableScheduler(
      runtime.scheduler,
    );
    let workers: LedgerWorkers = await ledger.startWorkers({
      scheduler: primaryScheduler,
      leaseMs: 1_000,
      defaultRetryDelayMs: 1_000,
      maxInFlight: primaryMaxInFlight,
    });
    const competingRuntimes: {
      ledger: typeof ledger;
      workers: LedgerWorkers;
    }[] = [];

    const stopCompetingWorkers = async (): Promise<void> => {
      const runtimes = competingRuntimes.splice(0);

      for (const competing of runtimes) {
        await competing.workers.close();
        await competing.ledger.close();
      }
    };

    return {
      get ledger() {
        return ledger;
      },
      nowMs: () => runtime.nowMs(),
      advanceByMs: async (ms) => runtime.advanceByMs(ms),
      flush: async () => runtime.flush(),
      waitForIdle: async () => {
        await workers.waitForIdle({
          signal: new AbortController().signal,
        });
      },
      restart: async () => {
        await stopCompetingWorkers();
        await workers.close();
        await ledger.close();
        ledger = createRuntimeLedger();
        primaryScheduler = new LedgerContractPausableScheduler(
          runtime.scheduler,
        );
        workers = await ledger.startWorkers({
          scheduler: primaryScheduler,
          leaseMs: 1_000,
          defaultRetryDelayMs: 1_000,
          maxInFlight: primaryMaxInFlight,
        });
      },
      restartWorkers: async ({ maxInFlight }) => {
        await workers.close();
        primaryMaxInFlight = maxInFlight;
        primaryScheduler = new LedgerContractPausableScheduler(
          runtime.scheduler,
        );
        workers = await ledger.startWorkers({
          scheduler: primaryScheduler,
          leaseMs: 1_000,
          defaultRetryDelayMs: 1_000,
          maxInFlight,
        });
      },
      startCompetingWorkers: async ({ maxInFlight }) => {
        const competingLedger = createRuntimeLedger();
        const competingWorkers = await competingLedger.startWorkers({
          scheduler: runtime.scheduler,
          leaseMs: 1_000,
          defaultRetryDelayMs: 1_000,
          maxInFlight,
        });

        competingRuntimes.push({
          ledger: competingLedger,
          workers: competingWorkers,
        });
      },
      stopCompetingWorkers,
      pausePrimaryScheduler: () => primaryScheduler.pause(),
      stopPrimaryWorkers: async () => {
        await workers.close();
      },
      stop: async () => {
        controlledWork.releaseAll();
        await stopCompetingWorkers();
        await workers.close();
        await ledger.close();
        await rm(databaseUrl, { force: true });
      },
      setDecisionMode: (mode) => {
        decisionMode = mode;
      },
      setMaterializationFailureText: (text) => {
        materializationFailureText = text;
      },
      prepareControlledWork: (workKey) => controlledWork.prepare(workKey),
      prepareControlledWorkAttempt: (workKey, attempt, outcome) =>
        controlledWork.prepareAttempt(workKey, attempt, outcome),
      getStartedControlledWorkKeys: () => controlledWork.startedWorkKeys(),
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
