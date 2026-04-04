import type { LedgerCursor } from "../../src/ledger/ledger.ts";

export type AgentIoRequest =
  | {
      readonly kind: "model.request";
      readonly agentId: string;
      readonly turnId: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "tool.request";
      readonly agentId: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly params: unknown;
    };

export type AgentIoResult =
  | {
      readonly kind: "model.completed";
      readonly agentId: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly outputText: string;
    }
  | {
      readonly kind: "model.failed";
      readonly agentId: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly error: string;
    }
  | {
      readonly kind: "tool.completed";
      readonly agentId: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly toolCallId: string;
      readonly content: unknown;
      readonly isError?: boolean;
    }
  | {
      readonly kind: "tool.failed";
      readonly agentId: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly toolCallId: string;
      readonly error: string;
    };

export interface AgentIoPort {
  tailRequests(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<{
    readonly request: AgentIoRequest;
    readonly cursor: LedgerCursor;
  }>;
  resumeRequests(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<{
    readonly request: AgentIoRequest;
    readonly cursor: LedgerCursor;
  }>;
  reportResult(result: AgentIoResult): Promise<void>;
}
