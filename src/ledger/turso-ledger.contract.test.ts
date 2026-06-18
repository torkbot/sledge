import { connect } from "@tursodatabase/database";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { type LedgerImplementations, type LedgerWorkers } from "./ledger.ts";
import { defineProjectionSchema } from "./projections.ts";

runLedgerContractSuite({
  suiteName: "turso ledger contract",
  create: async (): Promise<LedgerContractHarness> => {
    const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
    const databaseUrl = join(
      tmpdir(),
      `sledge-contract-turso-${randomUUID()}.sqlite`,
    );
    const db = await connect(databaseUrl);

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
        upsertObserved: async (scope, input) => {
          await scope
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
        incrementDecisionAttempts: async (scope, input) => {
          await scope
            .prepare(
              `UPDATE contract_projection
               SET decision_attempts = decision_attempts + 1
               WHERE source_event_id = ?`,
            )
            .run(input.sourceEventId);
        },
        setPlannedIntent: async (scope, input) => {
          await scope
            .prepare(
              `UPDATE contract_projection
               SET planned_intent_event_id = ?
               WHERE source_event_id = ?`,
            )
            .run(input.intentEventId, input.sourceEventId);
        },
        incrementDispatchCount: async (scope, input) => {
          await scope
            .prepare(
              `UPDATE contract_projection
               SET dispatch_count = dispatch_count + 1
               WHERE source_event_id = ?`,
            )
            .run(input.sourceEventId);
        },
      },
      queries: {
        decisionAttempts: async (scope, params) => {
          const row = await scope
            .prepare(
              `SELECT decision_attempts
               FROM contract_projection
               WHERE source_event_id = ?`,
            )
            .get(params.sourceEventId);

          return row?.decision_attempts ?? 0;
        },
        dispatchCount: async (scope, params) => {
          const row = await scope
            .prepare(
              `SELECT dispatch_count
               FROM contract_projection
               WHERE source_event_id = ?`,
            )
            .get(params.sourceEventId);

          return row?.dispatch_count ?? 0;
        },
        seenSourceEventIds: async (scope, _params) => {
          const rows = await scope
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

    const createRuntimeLedger = async () => {
      return await createTursoLedger({
        databaseUrl,
        boundModel: {
          model: {
            events: ledgerContractModel.events,
            queues: ledgerContractModel.queues,
            signals: {},
            signalQueues: {},
            indexers: ledgerContractModel.indexers,
            queries: ledgerContractModel.queries,
          },
          projections: defineProjectionSchema({}),
          register: registerLedgerContractModel({
            readDecisionMode: () => decisionMode,
            readMaterializationFailureText: () => materializationFailureText,
            nowMs: () => runtime.nowMs(),
          }),
          implementations,
        },
        timing: {
          clock: runtime.clock,
        },
      });
    };

    let ledger = await createRuntimeLedger();
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
        ledger = await createRuntimeLedger();
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
        await rm(databaseUrl, { force: true });
        await rm(`${databaseUrl}-wal`, { force: true });
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
