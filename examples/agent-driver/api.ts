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

/**
 * One-shot agent initialization command.
 *
 * `agentId` is caller-provided domain identity. Runtime must reject
 * initialization if this identity already exists.
 */
export type InitializeAgentInput = {
  readonly agentId: string;
  readonly context: AgentContext;
};

/**
 * Runtime-assigned identifiers for the initialized agent root node.
 */
export type InitializeAgentResult = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
};

/**
 * Submit one user input intent for an existing agent.
 */
export type SubmitUserInput = {
  readonly agentId: string;
  readonly timing: AgentInputTiming;
  readonly clientInputId: string;
  readonly content: string;
  readonly forkFromNodeId?: string;
};

/**
 * Runtime-assigned placement metadata for the recorded input node.
 */
export type SubmitUserInputResult = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
};

/**
 * Public, user-facing driver for a durable ledger-backed agent runtime.
 *
 * Callers own logical `agentId` identity. Runtime owns graph topology
 * identifiers (`branchId`, `nodeId`, `parentNodeId`).
 */
export type AgentDriver = {
  /**
   * Initialize an agent identity exactly once.
   *
   * Should fail predictably if the agent already exists.
   */
  initializeAgent(input: InitializeAgentInput): Promise<InitializeAgentResult>;

  /**
   * Record one user input intent for later orchestration.
   */
  submitUserInput(input: SubmitUserInput): Promise<SubmitUserInputResult>;

  /**
   * Read the latest branch head. Defaults branch to `main` when omitted.
   */
  getBranchHead(input: {
    readonly agentId: string;
    readonly branchId?: string;
  }): Promise<AgentBranchHeadQueryResult>;

  /**
   * Read pending inputs split by timing queue. Defaults branch to `main`.
   */
  getPendingInputs(input: {
    readonly agentId: string;
    readonly branchId?: string;
  }): Promise<AgentPendingInputsQueryResult>;

  /**
   * List child nodes for one parent node.
   */
  getNodeChildren(
    input: AgentNodeChildrenQueryParams,
  ): Promise<AgentNodeChildrenQueryResult>;

  /**
   * Tail event stream with opaque resume cursor emission.
   */
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;

  /**
   * Resume event stream from a previously persisted opaque cursor.
   */
  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
};

export function createAgentDriver(
  ledger: Ledger<AgentDriverEvents, AgentDriverQueries>,
): AgentDriver {
  return {
    initializeAgent: async (input) => {
      const branchId = DEFAULT_BRANCH_ID;
      const existing = await ledger.query("agent.branch.head", {
        agentId: input.agentId,
        branchId,
      });

      if (existing !== null) {
        throw new Error(`agent already initialized: ${input.agentId}`);
      }

      const nodeId = randomUUID();

      await ledger.emit(
        "agent.event",
        {
          kind: "context.initialized",
          agentId: input.agentId,
          branchId,
          nodeId,
          parentNodeId: null,
          context: input.context,
        },
        {
          dedupeKey: `agent:${input.agentId}:init`,
        },
      );

      return {
        agentId: input.agentId,
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
