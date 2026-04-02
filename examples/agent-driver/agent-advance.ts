import type { Static } from "@sinclair/typebox";

import type { QueueHandlerOutcome } from "../../src/ledger/ledger.ts";
import {
  AGENT_RUNTIME_STATE_QUERY_NAME,
  AgentDriverQuerySchemas,
} from "./contracts.ts";

export type AgentAdvanceRecoveryState = Static<
  (typeof AgentDriverQuerySchemas)[typeof AGENT_RUNTIME_STATE_QUERY_NAME]["result"]
>;

export type AgentAdvanceTodo = {
  readonly shouldFlushNextOpportunity: boolean;
  readonly shouldConsumeWhenIdle: boolean;
  readonly hasTranscript: boolean;
};

export type AgentAdvanceDecision =
  | { readonly kind: "dead_letter"; readonly error: string }
  | { readonly kind: "noop"; readonly reason: string };

export function deriveAgentAdvanceTodo(input: {
  readonly state: AgentAdvanceRecoveryState;
}): AgentAdvanceTodo {
  return {
    shouldFlushNextOpportunity: input.state.nextOpportunityCount > 0,
    shouldConsumeWhenIdle:
      input.state.phase === "idle" && input.state.whenIdleCount > 0,
    hasTranscript: input.state.hasMessages,
  };
}

export function decideAgentAdvance(input: {
  readonly agentId: string;
  readonly state: AgentAdvanceRecoveryState;
  readonly todo: AgentAdvanceTodo;
}): AgentAdvanceDecision {
  if (!input.state.exists) {
    return {
      kind: "dead_letter",
      error: `advance requested for unknown agent: ${input.agentId}`,
    };
  }

  if (input.todo.shouldFlushNextOpportunity) {
    return {
      kind: "noop",
      reason: "next_opportunity dispatch scaffolded but not implemented yet",
    };
  }

  if (input.todo.shouldConsumeWhenIdle) {
    return {
      kind: "noop",
      reason: "when_idle dispatch scaffolded but not implemented yet",
    };
  }

  return {
    kind: "noop",
    reason: "no pending work",
  };
}

export function toQueueOutcome(
  decision: AgentAdvanceDecision,
): QueueHandlerOutcome {
  switch (decision.kind) {
    case "dead_letter":
      return {
        outcome: "dead_letter",
        error: decision.error,
      };
    case "noop":
      return {
        outcome: "ack",
      };
  }
}

export async function executeAgentAdvanceScaffold(input: {
  readonly agentId: string;
  readonly loadState: (input: {
    readonly agentId: string;
  }) => Promise<AgentAdvanceRecoveryState>;
}): Promise<QueueHandlerOutcome> {
  const state = await input.loadState({
    agentId: input.agentId,
  });

  const todo = deriveAgentAdvanceTodo({
    state,
  });

  const decision = decideAgentAdvance({
    agentId: input.agentId,
    state,
    todo,
  });

  return toQueueOutcome(decision);
}
