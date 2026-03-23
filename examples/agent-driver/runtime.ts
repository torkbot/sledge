import type Database from "better-sqlite3";

import type {
  LedgerCursor,
  LedgerStreamEvent,
  LedgerTiming,
} from "../../src/ledger/ledger.ts";
import type { AgentDriver } from "./api.ts";
import type { AgentDriverEvents } from "./contracts.ts";

/**
 * Minimal pi-ai contract we expect to integrate with from the orchestrator.
 */
export interface PiAiGateway {
  runTurn(input: {
    readonly agentId: string;
    readonly branchId: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly outputText: string;
  }>;
}

export type OpenAgentDriverRuntimeInput = {
  readonly database: Database.Database;
  readonly timing: LedgerTiming;
  readonly llm: PiAiGateway;
};

export type AgentDriverRuntime = AsyncDisposable & {
  readonly driver: AgentDriver;
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
  close(): Promise<void>;
};

export function openAgentDriverRuntime(
  input: OpenAgentDriverRuntimeInput,
): AgentDriverRuntime {
  void input;

  throw new Error(
    "not implemented: durable ledger model + agent.advance runtime wiring",
  );
}
