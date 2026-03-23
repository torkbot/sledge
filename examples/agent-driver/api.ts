import type { Static } from "@sinclair/typebox";

import type {
  Ledger,
  LedgerCursor,
  LedgerStreamEvent,
} from "../../src/ledger/ledger.ts";
import {
  AgentBranchHeadQueryParamsSchema,
  AgentBranchHeadQueryResultSchema,
  AgentNodeChildrenQueryParamsSchema,
  AgentNodeChildrenQueryResultSchema,
  AgentPendingInputsQueryParamsSchema,
  AgentPendingInputsQueryResultSchema,
} from "./contracts.ts";
import type {
  AgentBranchMode,
  AgentContext,
  AgentDriverEvents,
  AgentDriverQueries,
  AgentInputTiming,
} from "./contracts.ts";

type AgentBranchHeadQueryParams = Static<
  typeof AgentBranchHeadQueryParamsSchema
>;
type AgentBranchHeadQueryResult = Static<
  typeof AgentBranchHeadQueryResultSchema
>;
type AgentPendingInputsQueryParams = Static<
  typeof AgentPendingInputsQueryParamsSchema
>;
type AgentPendingInputsQueryResult = Static<
  typeof AgentPendingInputsQueryResultSchema
>;
type AgentNodeChildrenQueryParams = Static<
  typeof AgentNodeChildrenQueryParamsSchema
>;
type AgentNodeChildrenQueryResult = Static<
  typeof AgentNodeChildrenQueryResultSchema
>;

export type CreateAgentInput = {
  readonly agentId: string;
  readonly branchId: string;
  readonly rootNodeId: string;
  readonly context: AgentContext;
};

export type SubmitUserInput = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
  readonly mode: AgentBranchMode;
  readonly timing: AgentInputTiming;
  readonly clientInputId: string;
  readonly content: string;
};

export type AgentDriver = {
  createAgent(input: CreateAgentInput): Promise<void>;
  submitUserInput(input: SubmitUserInput): Promise<void>;
  getBranchHead(
    input: AgentBranchHeadQueryParams,
  ): Promise<AgentBranchHeadQueryResult>;
  getPendingInputs(
    input: AgentPendingInputsQueryParams,
  ): Promise<AgentPendingInputsQueryResult>;
  getNodeChildren(
    input: AgentNodeChildrenQueryParams,
  ): Promise<AgentNodeChildrenQueryResult>;
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
};

export function createAgentDriver(
  ledger: Ledger<AgentDriverEvents, AgentDriverQueries>,
): AgentDriver {
  return {
    createAgent: async (input) => {
      await ledger.emit(
        "agent.event",
        {
          kind: "context.initialized",
          agentId: input.agentId,
          branchId: input.branchId,
          nodeId: input.rootNodeId,
          parentNodeId: null,
          context: input.context,
        },
        {
          dedupeKey: `agent:${input.agentId}:node:${input.rootNodeId}`,
        },
      );
    },
    submitUserInput: async (input) => {
      await ledger.emit(
        "user.event",
        {
          kind: "input.recorded",
          agentId: input.agentId,
          branchId: input.branchId,
          nodeId: input.nodeId,
          parentNodeId: input.parentNodeId,
          mode: input.mode,
          timing: input.timing,
          clientInputId: input.clientInputId,
          content: input.content,
        },
        {
          dedupeKey: `agent:${input.agentId}:input:${input.clientInputId}`,
        },
      );
    },
    getBranchHead: async (input) => {
      return await ledger.query("agent.branch.head", input);
    },
    getPendingInputs: async (input) => {
      return await ledger.query("agent.pending-inputs", input);
    },
    getNodeChildren: async (input) => {
      return await ledger.query("agent.node.children", input);
    },
    tailEvents: (input) => {
      return ledger.tailEvents(input);
    },
    resumeEvents: (input) => {
      return ledger.resumeEvents(input);
    },
  };
}
