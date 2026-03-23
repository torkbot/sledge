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
 * Create-agent command.
 *
 * `idempotencyKey` is caller-provided dedupe identity for this create request.
 * Retry the same create call with the same key to avoid duplicate agent
 * initialization events.
 */
export type CreateAgentInput = {
  /**
   * Optional logical agent identity from the caller.
   *
   * If omitted, the runtime allocates a durable agent id.
   */
  readonly agentId?: string;

  /**
   * Optional idempotency key for create retries.
   *
   * When omitted, create is still accepted but retries are not deduplicated by
   * caller identity.
   */
  readonly idempotencyKey?: string;

  /**
   * Initial immutable context for this agent.
   */
  readonly context: AgentContext;
};

/**
 * Runtime-assigned identifiers for the initialized agent root.
 */
export type CreateAgentResult = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
};

/**
 * Submit one user input intent for an existing agent.
 */
export type SubmitUserInput = {
  /** Logical agent identity. */
  readonly agentId: string;

  /** Scheduling policy for when this input should be consumed. */
  readonly timing: AgentInputTiming;

  /**
   * Caller-provided idempotency identity for this user input.
   */
  readonly clientInputId: string;

  /** User text payload. */
  readonly content: string;

  /**
   * Optional explicit fork anchor. If set, runtime records this input against
   * a new branch lineage rooted from `forkFromNodeId`.
   */
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
 * Callers submit intent; runtime owns graph topology identifiers.
 */
export type AgentDriver = {
  /**
   * Create a new agent root context event.
   */
  createAgent(input: CreateAgentInput): Promise<CreateAgentResult>;

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
    createAgent: async (input) => {
      const agentId = input.agentId ?? randomUUID();
      const branchId = DEFAULT_BRANCH_ID;
      const nodeId = randomUUID();

      let emitOptions:
        | {
            readonly dedupeKey?: string;
          }
        | undefined;

      if (input.idempotencyKey !== undefined) {
        emitOptions = {
          dedupeKey: `agent:${agentId}:create:${input.idempotencyKey}`,
        };
      }

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
        emitOptions,
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
