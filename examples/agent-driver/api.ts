import { randomUUID } from "node:crypto";

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
  AgentContext,
  AgentDriverEvents,
  AgentDriverQueries,
  AgentInputTiming,
} from "./contracts.ts";

const DEFAULT_BRANCH_ID = "main";

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
  readonly agentId?: string;
  readonly clientRequestId: string;
  readonly context: AgentContext;
};

export type CreateAgentResult = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
};

export type SubmitUserInput = {
  readonly agentId: string;
  readonly timing: AgentInputTiming;
  readonly clientInputId: string;
  readonly content: string;
  readonly forkFromNodeId?: string;
};

export type SubmitUserInputResult = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
};

export type AgentDriver = {
  createAgent(input: CreateAgentInput): Promise<CreateAgentResult>;
  submitUserInput(input: SubmitUserInput): Promise<SubmitUserInputResult>;
  getBranchHead(input: {
    readonly agentId: string;
    readonly branchId?: string;
  }): Promise<AgentBranchHeadQueryResult>;
  getPendingInputs(input: {
    readonly agentId: string;
    readonly branchId?: string;
  }): Promise<AgentPendingInputsQueryResult>;
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
      const agentId = input.agentId ?? randomUUID();
      const branchId = DEFAULT_BRANCH_ID;
      const nodeId = randomUUID();

      await ledger.emit(
        "agent.event",
        {
          kind: "context.initialized",
          agentId,
          branchId,
          nodeId,
          parentNodeId: null,
          context: input.context,
        },
        {
          dedupeKey: `agent:${agentId}:create:${input.clientRequestId}`,
        },
      );

      return {
        agentId,
        branchId,
        nodeId,
      };
    },
    submitUserInput: async (input) => {
      const branchId = DEFAULT_BRANCH_ID;
      const nodeId = randomUUID();

      let parentNodeId = input.forkFromNodeId;

      if (parentNodeId === undefined) {
        const head = await ledger.query("agent.branch.head", {
          agentId: input.agentId,
          branchId,
        });

        if (head === null) {
          throw new Error(
            `cannot submit input for unknown agent branch: ${input.agentId}/${branchId}`,
          );
        }

        parentNodeId = head.nodeId;
      }

      await ledger.emit(
        "user.event",
        {
          kind: "input.recorded",
          agentId: input.agentId,
          branchId,
          nodeId,
          parentNodeId,
          timing: input.timing,
          clientInputId: input.clientInputId,
          content: input.content,
          forkFromNodeId: input.forkFromNodeId,
        },
        {
          dedupeKey: `agent:${input.agentId}:input:${input.clientInputId}`,
        },
      );

      return {
        agentId: input.agentId,
        branchId,
        nodeId,
        parentNodeId,
      };
    },
    getBranchHead: async (input) => {
      return await ledger.query("agent.branch.head", {
        agentId: input.agentId,
        branchId: input.branchId ?? DEFAULT_BRANCH_ID,
      });
    },
    getPendingInputs: async (input) => {
      return await ledger.query("agent.pending-inputs", {
        agentId: input.agentId,
        branchId: input.branchId ?? DEFAULT_BRANCH_ID,
      });
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
