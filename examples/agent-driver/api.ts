import { randomUUID } from "node:crypto";

import type { Static } from "@sinclair/typebox";

import type {
  Ledger,
  LedgerCursor,
  LedgerStreamEvent,
} from "../../src/ledger/ledger.ts";
import {
  AGENT_EVENT_NAME,
  AGENT_HEAD_QUERY_NAME,
  AGENT_MESSAGES_QUERY_NAME,
  AGENT_NODE_CHILDREN_QUERY_NAME,
  AGENT_NODE_EXISTS_QUERY_NAME,
  AGENT_PENDING_INPUTS_QUERY_NAME,
  AGENT_RUNTIME_STATE_QUERY_NAME,
  AgentHeadQueryParamsSchema,
  AgentHeadQueryResultSchema,
  AgentMessagesQueryParamsSchema,
  AgentMessagesQueryResultSchema,
  AgentNodeChildrenQueryParamsSchema,
  AgentNodeChildrenQueryResultSchema,
  AgentPendingInputsQueryParamsSchema,
  AgentPendingInputsQueryResultSchema,
  AgentRuntimeStateQueryParamsSchema,
  AgentRuntimeStateQueryResultSchema,
  USER_EVENT_NAME,
} from "./contracts.ts";
import type {
  AgentContext,
  AgentDriverEvents,
  AgentDriverQueries,
  AgentInputTiming,
} from "./contracts.ts";

type AgentHeadQueryParams = Static<typeof AgentHeadQueryParamsSchema>;
type AgentHeadQueryResult = Static<typeof AgentHeadQueryResultSchema>;
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
type AgentMessagesQueryParams = Static<typeof AgentMessagesQueryParamsSchema>;
type AgentMessagesQueryResult = Static<typeof AgentMessagesQueryResultSchema>;
type AgentRuntimeStateQueryParams = Static<
  typeof AgentRuntimeStateQueryParamsSchema
>;
type AgentRuntimeStateQueryResult = Static<
  typeof AgentRuntimeStateQueryResultSchema
>;

export type InitializeAgentInput = {
  readonly agentId: string;
  readonly context: AgentContext;
};

export type InitializeAgentResult = {
  readonly agentId: string;
  readonly nodeId: string;
};

export type SubmitUserInput = {
  readonly agentId: string;
  readonly timing: AgentInputTiming;
  /** Idempotency key for this user input command. */
  readonly idempotencyKey: string;
  readonly content: string;
  readonly forkFromNodeId?: string;
};

export type SubmitUserInputResult = {
  readonly agentId: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
};

export type AgentDriver = {
  initializeAgent(input: InitializeAgentInput): Promise<InitializeAgentResult>;
  submitUserInput(input: SubmitUserInput): Promise<SubmitUserInputResult>;
  getHead(input: AgentHeadQueryParams): Promise<AgentHeadQueryResult>;
  getPendingInputs(
    input: AgentPendingInputsQueryParams,
  ): Promise<AgentPendingInputsQueryResult>;
  getNodeChildren(
    input: AgentNodeChildrenQueryParams,
  ): Promise<AgentNodeChildrenQueryResult>;
  getMessages(
    input: AgentMessagesQueryParams,
  ): Promise<AgentMessagesQueryResult>;
  getRuntimeState(
    input: AgentRuntimeStateQueryParams,
  ): Promise<AgentRuntimeStateQueryResult>;
  waitForIdle(input: {
    readonly agentId: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
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
    initializeAgent: async (input) => {
      const existing = await ledger.query(AGENT_HEAD_QUERY_NAME, {
        agentId: input.agentId,
      });

      if (existing !== null) {
        throw new Error(`agent already initialized: ${input.agentId}`);
      }

      const nodeId = randomUUID();

      await ledger.emit(
        AGENT_EVENT_NAME,
        {
          kind: "context.initialized",
          agentId: input.agentId,
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
        nodeId,
      };
    },
    submitUserInput: async (input) => {
      const nodeId = randomUUID();

      let parentNodeId = input.forkFromNodeId;

      if (parentNodeId === undefined) {
        const head = await ledger.query(AGENT_HEAD_QUERY_NAME, {
          agentId: input.agentId,
        });

        if (head === null) {
          throw new Error(
            `cannot submit input for unknown agent: ${input.agentId}`,
          );
        }

        parentNodeId = head.nodeId;
      } else {
        const parentExists = await ledger.query(AGENT_NODE_EXISTS_QUERY_NAME, {
          agentId: input.agentId,
          nodeId: parentNodeId,
        });

        if (!parentExists) {
          throw new Error(
            `cannot fork from missing parent node: ${input.agentId}/${parentNodeId}`,
          );
        }
      }

      await ledger.emit(
        USER_EVENT_NAME,
        {
          kind: "input.recorded",
          agentId: input.agentId,
          nodeId,
          parentNodeId,
          timing: input.timing,
          idempotencyKey: input.idempotencyKey,
          content: input.content,
          forkFromNodeId: input.forkFromNodeId,
        },
        {
          dedupeKey: `agent:${input.agentId}:input:${input.idempotencyKey}`,
        },
      );

      return {
        agentId: input.agentId,
        nodeId,
        parentNodeId,
      };
    },
    getHead: async (input) => {
      return await ledger.query(AGENT_HEAD_QUERY_NAME, input);
    },
    getPendingInputs: async (input) => {
      return await ledger.query(AGENT_PENDING_INPUTS_QUERY_NAME, input);
    },
    getNodeChildren: async (input) => {
      return await ledger.query(AGENT_NODE_CHILDREN_QUERY_NAME, input);
    },
    getMessages: async (input) => {
      return await ledger.query(AGENT_MESSAGES_QUERY_NAME, input);
    },
    getRuntimeState: async (input) => {
      return await ledger.query(AGENT_RUNTIME_STATE_QUERY_NAME, input);
    },
    waitForIdle: async (input) => {
      const initial = await ledger.query(AGENT_RUNTIME_STATE_QUERY_NAME, {
        agentId: input.agentId,
      });

      if (!initial.exists) {
        throw new Error(`cannot wait for unknown agent: ${input.agentId}`);
      }

      if (initial.phase === "idle") {
        return;
      }

      const stream = ledger.tailEvents({
        last: 0,
        signal: input.signal,
      });

      for await (const item of stream) {
        const payload = item.event.payload;

        if (payload.agentId !== input.agentId) {
          continue;
        }

        const state = await ledger.query(AGENT_RUNTIME_STATE_QUERY_NAME, {
          agentId: input.agentId,
        });

        if (!state.exists) {
          throw new Error(`agent disappeared while waiting: ${input.agentId}`);
        }

        if (state.phase === "idle") {
          return;
        }
      }
    },
    tailEvents: (input) => {
      return ledger.tailEvents(input);
    },
    resumeEvents: (input) => {
      return ledger.resumeEvents(input);
    },
  };
}
