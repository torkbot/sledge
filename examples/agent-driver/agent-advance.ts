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

export type AgentAdvanceTransition =
  | {
      readonly kind: "dead_letter_unknown_agent";
      readonly error: string;
    }
  | {
      readonly kind: "start_turn_from_next_opportunity";
      readonly reason: string;
    }
  | {
      readonly kind: "start_turn_from_when_idle";
      readonly reason: string;
    }
  | {
      readonly kind: "await_turn_boundary_with_next_opportunity";
      readonly reason: string;
    }
  | {
      readonly kind: "await_idle_for_when_idle";
      readonly reason: string;
    }
  | {
      readonly kind: "await_in_flight_turn";
      readonly reason: string;
    }
  | {
      readonly kind: "noop_no_pending_work";
      readonly reason: string;
    };

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
}): AgentAdvanceTransition {
  if (!input.state.exists) {
    return {
      kind: "dead_letter_unknown_agent",
      error: `advance requested for unknown agent: ${input.agentId}`,
    };
  }

  if (input.state.phase === "idle") {
    if (input.todo.shouldFlushNextOpportunity) {
      return {
        kind: "start_turn_from_next_opportunity",
        reason: "idle with next_opportunity backlog",
      };
    }

    if (input.todo.shouldConsumeWhenIdle) {
      return {
        kind: "start_turn_from_when_idle",
        reason: "idle with when_idle backlog",
      };
    }

    return {
      kind: "noop_no_pending_work",
      reason: "idle with no pending input",
    };
  }

  if (input.todo.shouldFlushNextOpportunity) {
    return {
      kind: "await_turn_boundary_with_next_opportunity",
      reason: "turn is in-flight; next_opportunity queued",
    };
  }

  if (input.state.whenIdleCount > 0) {
    return {
      kind: "await_idle_for_when_idle",
      reason: "turn is in-flight; when_idle queued",
    };
  }

  return {
    kind: "await_in_flight_turn",
    reason: "turn in-flight with no queued input",
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled transition: ${JSON.stringify(value)}`);
}

export function toQueueOutcome(
  transition: AgentAdvanceTransition,
): QueueHandlerOutcome {
  switch (transition.kind) {
    case "dead_letter_unknown_agent":
      return {
        outcome: "dead_letter",
        error: transition.error,
      };
    case "start_turn_from_next_opportunity":
    case "start_turn_from_when_idle":
    case "await_turn_boundary_with_next_opportunity":
    case "await_idle_for_when_idle":
    case "await_in_flight_turn":
    case "noop_no_pending_work":
      return {
        outcome: "ack",
      };
    default:
      return assertNever(transition);
  }
}

export type AgentAdvanceExecution = {
  readonly todo: AgentAdvanceTodo;
  readonly transition: AgentAdvanceTransition;
  readonly outcome: QueueHandlerOutcome;
};

export function executeAgentAdvance(input: {
  readonly agentId: string;
  readonly state: AgentAdvanceRecoveryState;
}): AgentAdvanceExecution {
  const todo = deriveAgentAdvanceTodo({
    state: input.state,
  });

  const transition = decideAgentAdvance({
    agentId: input.agentId,
    state: input.state,
    todo,
  });

  return {
    todo,
    transition,
    outcome: toQueueOutcome(transition),
  };
}
