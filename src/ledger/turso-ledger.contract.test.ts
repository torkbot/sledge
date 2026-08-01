import { connect } from "@tursodatabase/database";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { createTursoLedger } from "./turso-ledger.ts";
import {
  createLedgerContractControlledWork,
  createLedgerContractHarnessLedger,
  createLedgerContractModel,
  createLedgerContractTimedWork,
  LedgerContractPausableScheduler,
  runLedgerContractSuite,
  type LedgerContractDecisionMode,
  type LedgerContractHarness,
} from "./ledger.contract.ts";
import { composeLedgerModels, type LedgerWorkers } from "./ledger.ts";
import { runSqliteLedgerCloseContract } from "./sqlite-ledger-close.contract.ts";

runSqliteLedgerCloseContract({
  suiteName: "turso ledger",
  create: async (input) => await createTursoLedger(input),
  openCheckpointBlocker: async (databaseUrl) => {
    const database = await connect(databaseUrl, { timeout: 0 });
    await database.exec("BEGIN");
    await database.prepare("SELECT COUNT(*) FROM events").get();

    return {
      close: async () => {
        await database.exec("ROLLBACK");
        await database.close();
      },
    };
  },
});

runLedgerContractSuite({
  suiteName: "turso ledger contract",
  create: async (): Promise<LedgerContractHarness> => {
    const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
    const databaseUrl = join(
      tmpdir(),
      `sledge-contract-turso-${randomUUID()}.sqlite`,
    );
    let decisionMode: LedgerContractDecisionMode = "ack";
    let materializationFailureText: string | null = null;
    const controlledWork = createLedgerContractControlledWork();
    const timedWork = createLedgerContractTimedWork();

    const createRuntimeLedger = async () => {
      const model = createLedgerContractModel({
        readDecisionMode: () => decisionMode,
        readMaterializationFailureText: () => materializationFailureText,
        nowMs: () => runtime.nowMs(),
        runControlledWork: (workKey, attempt) =>
          controlledWork.run(workKey, attempt),
        runTimedWork: (workKey, timeoutMs, leaseSignal, control) =>
          timedWork.run(workKey, timeoutMs, leaseSignal, control),
      });
      const ledger = await createTursoLedger({
        databaseUrl,
        model: composeLedgerModels(model),
        timing: {
          clock: runtime.clock,
        },
      });

      return createLedgerContractHarnessLedger(ledger);
    };

    let ledger = await createRuntimeLedger();
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
        ledger = await createRuntimeLedger();
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
        const competingLedger = await createRuntimeLedger();
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
      emitCoalescedFromPeer: async (input) => {
        const peerLedger = await createRuntimeLedger();

        try {
          return await peerLedger.emit("coalesced-work.requested", input);
        } finally {
          await peerLedger.close();
        }
      },
      stopCompetingWorkers,
      pausePrimaryScheduler: () => primaryScheduler.pause(),
      stopPrimaryWorkers: async () => {
        await workers.close();
      },
      stop: async () => {
        controlledWork.releaseAll();
        timedWork.releaseAll();
        await stopCompetingWorkers();
        await workers.close();
        await ledger.close();
        await rm(databaseUrl, { force: true });
        await rm(`${databaseUrl}-wal`, { force: true });
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
      prepareTimedWork: (workKey) => timedWork.prepare(workKey),
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
      getObservedMessages: () => ledger.query("observedMessages", {}),
    };
  },
});
