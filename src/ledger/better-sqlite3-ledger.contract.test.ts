import Database from "better-sqlite3";

import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { createBetterSqliteLedger } from "./better-sqlite3-ledger.ts";
import {
  ledgerContractModel,
  registerLedgerContractModel,
  runLedgerContractSuite,
  type LedgerContractDecisionMode,
  type LedgerContractHarness,
  type LedgerContractIndexers,
  type LedgerContractQueries,
} from "./ledger.contract.ts";
import { defineLedgerModel, type LedgerImplementations } from "./ledger.ts";

runLedgerContractSuite({
  suiteName: "better-sqlite ledger contract",
  create: async (): Promise<LedgerContractHarness> => {
    const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
    const db = new Database(":memory:");

    db.exec(`
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
        upsertObserved: (input) => {
          db.prepare(
            `INSERT INTO contract_projection (
              source_event_id,
              decision_attempts,
              dispatch_count,
              planned_intent_event_id
            ) VALUES (?, 0, 0, NULL)
            ON CONFLICT(source_event_id) DO NOTHING`,
          ).run(input.sourceEventId);
        },
        incrementDecisionAttempts: (input) => {
          db.prepare(
            `UPDATE contract_projection
             SET decision_attempts = decision_attempts + 1
             WHERE source_event_id = ?`,
          ).run(input.sourceEventId);
        },
        setPlannedIntent: (input) => {
          db.prepare(
            `UPDATE contract_projection
             SET planned_intent_event_id = ?
             WHERE source_event_id = ?`,
          ).run(input.intentEventId, input.sourceEventId);
        },
        incrementDispatchCount: (input) => {
          db.prepare(
            `UPDATE contract_projection
             SET dispatch_count = dispatch_count + 1
             WHERE source_event_id = ?`,
          ).run(input.sourceEventId);
        },
      },
      queries: {
        decisionAttempts: (params) => {
          const row = db
            .prepare<[number], { decision_attempts: number }>(
              `SELECT decision_attempts
               FROM contract_projection
               WHERE source_event_id = ?`,
            )
            .get(params.sourceEventId);

          return row?.decision_attempts ?? 0;
        },
        dispatchCount: (params) => {
          const row = db
            .prepare<[number], { dispatch_count: number }>(
              `SELECT dispatch_count
               FROM contract_projection
               WHERE source_event_id = ?`,
            )
            .get(params.sourceEventId);

          return row?.dispatch_count ?? 0;
        },
        seenSourceEventIds: () => {
          const rows = db
            .prepare<[], { source_event_id: number }>(
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
        register: (builder) => {
          registerLedgerContractModel(builder, {
            readDecisionMode: () => decisionMode,
            readMaterializationFailureText: () => materializationFailureText,
            nowMs: () => runtime.nowMs(),
          });
        },
      });

      return createBetterSqliteLedger({
        database: db,
        boundModel: definedModel.bind(implementations),
        timing: {
          clock: runtime.clock,
          scheduler: runtime.scheduler,
        },
        leaseMs: 1_000,
        defaultRetryDelayMs: 1_000,
      });
    };

    let ledger = createRuntimeLedger();

    return {
      get ledger() {
        return ledger;
      },
      nowMs: () => runtime.nowMs(),
      advanceByMs: async (ms) => runtime.advanceByMs(ms),
      flush: async () => runtime.flush(),
      restart: async () => {
        await ledger.close();
        ledger = createRuntimeLedger();
      },
      stop: async () => {
        await ledger.close();
        db.close();
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
