import { connect } from "@tursodatabase/database";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { createTursoLedger } from "./turso-ledger.ts";
import {
  ledgerContractModel,
  registerLedgerContractModel,
  runLedgerContractSuite,
  type LedgerContractDecisionMode,
  type LedgerContractHarness,
  type LedgerContractIndexers,
  type LedgerContractQueries,
} from "./ledger.contract.ts";
import {
  bindLedgerModel,
  defineLedgerModel,
  registerLedgerModel,
  type LedgerImplementations,
  type LedgerWorkers,
} from "./ledger.ts";

runLedgerContractSuite({
  suiteName: "turso ledger contract",
  create: async (): Promise<LedgerContractHarness> => {
    const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
    const db = await connect(":memory:");

    await db.exec(`
      CREATE TABLE IF NOT EXISTS contract_projection (
        source_event_id INTEGER PRIMARY KEY,
        decision_attempts INTEGER NOT NULL DEFAULT 0,
        dispatch_count INTEGER NOT NULL DEFAULT 0,
        planned_intent_event_id INTEGER
      );
    `);

    let decisionMode: LedgerContractDecisionMode = "ack";
    let materializationFailureText: string | null = null;

    const implementations: LedgerImplementations<
      LedgerContractIndexers,
      LedgerContractQueries
    > = {
      indexers: {
        upsertObserved: async (input) => {
          await db
            .prepare(
              `INSERT INTO contract_projection (
                source_event_id,
                decision_attempts,
                dispatch_count,
                planned_intent_event_id
              ) VALUES (?, 0, 0, NULL)
              ON CONFLICT(source_event_id) DO NOTHING`,
            )
            .run(input.sourceEventId);
        },
        incrementDecisionAttempts: async (input) => {
          await db
            .prepare(
              `UPDATE contract_projection
               SET decision_attempts = decision_attempts + 1
               WHERE source_event_id = ?`,
            )
            .run(input.sourceEventId);
        },
        setPlannedIntent: async (input) => {
          await db
            .prepare(
              `UPDATE contract_projection
               SET planned_intent_event_id = ?
               WHERE source_event_id = ?`,
            )
            .run(input.intentEventId, input.sourceEventId);
        },
        incrementDispatchCount: async (input) => {
          await db
            .prepare(
              `UPDATE contract_projection
               SET dispatch_count = dispatch_count + 1
               WHERE source_event_id = ?`,
            )
            .run(input.sourceEventId);
        },
      },
      queries: {
        decisionAttempts: async (params) => {
          const row = await db
            .prepare(
              `SELECT decision_attempts
               FROM contract_projection
               WHERE source_event_id = ?`,
            )
            .get(params.sourceEventId);

          return row?.decision_attempts ?? 0;
        },
        dispatchCount: async (params) => {
          const row = await db
            .prepare(
              `SELECT dispatch_count
               FROM contract_projection
               WHERE source_event_id = ?`,
            )
            .get(params.sourceEventId);

          return row?.dispatch_count ?? 0;
        },
        seenSourceEventIds: async () => {
          const rows = await db
            .prepare(
              `SELECT source_event_id
               FROM contract_projection
               ORDER BY source_event_id ASC`,
            )
            .all();

          return rows.map((row) => row.source_event_id);
        },
      },
    };

    const createRuntimeLedger = () => {
      const definedModel = defineLedgerModel({
        events: ledgerContractModel.events,
        queues: ledgerContractModel.queues,
        indexers: ledgerContractModel.indexers,
        queries: ledgerContractModel.queries,
      });

      const registeredModel = registerLedgerModel(
        definedModel,
        registerLedgerContractModel({
          readDecisionMode: () => decisionMode,
          readMaterializationFailureText: () => materializationFailureText,
          nowMs: () => runtime.nowMs(),
        }),
      );

      return createTursoLedger({
        database: db,
        boundModel: bindLedgerModel(registeredModel, implementations),
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
        await db.close();
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
