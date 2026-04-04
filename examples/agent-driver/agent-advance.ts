import type { Static } from "@sinclair/typebox";

import type { QueueHandlerOutcome } from "../../src/ledger/ledger.ts";
import {
  AGENT_EVENT_NAME,
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
      readonly kind: "dead_letter_missing_head";
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

export type AgentAdvanceEffect =
  | {
      readonly kind: "emit";
      readonly eventName: typeof AGENT_EVENT_NAME;
      readonly payload: {
        readonly kind: "input.batch.claimed";
        readonly agentId: string;
        readonly nodeId: string;
        readonly parentNodeId: string;
        readonly turnId: string;
        readonly inputNodeIds: string[];
      };
      readonly dedupeKey: string;
    }
  | {
      readonly kind: "emit";
      readonly eventName: typeof AGENT_EVENT_NAME;
      readonly payload: {
        readonly kind: "turn.state.updated";
        readonly agentId: string;
        readonly nodeId: string;
        readonly parentNodeId: string;
        readonly phase: "model_running";
      };
      readonly dedupeKey: string;
    }
  | {
      readonly kind: "emit";
      readonly eventName: typeof AGENT_EVENT_NAME;
      readonly payload: {
        readonly kind: "turn.model.requested";
        readonly agentId: string;
        readonly nodeId: string;
        readonly parentNodeId: string;
        readonly turnId: string;
      };
      readonly dedupeKey: string;
    };

export type AgentAdvanceExecution = {
  readonly todo: AgentAdvanceTodo;
  readonly transition: AgentAdvanceTransition;
  readonly effects: readonly AgentAdvanceEffect[];
  readonly outcome: QueueHandlerOutcome;
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

  if (input.state.headNodeId === null) {
    return {
      kind: "dead_letter_missing_head",
      error: `advance requested for agent with missing head: ${input.agentId}`,
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

function deriveEffects(input: {
  readonly agentId: string;
  readonly workId: number;
  readonly state: AgentAdvanceRecoveryState;
  readonly transition: AgentAdvanceTransition;
}): readonly AgentAdvanceEffect[] {
  switch (input.transition.kind) {
    case "start_turn_from_next_opportunity":
    case "start_turn_from_when_idle": {
      const headNodeId = input.state.headNodeId;

      if (headNodeId === null) {
        return [];
      }

      const turnId = `turn/${input.agentId}/${input.workId}`;
      const claimEventNodeId = `agent-event/${input.workId}/claim`;
      const phaseEventNodeId = `agent-event/${input.workId}/phase-model-running`;
      const requestModelNodeId = `agent-event/${input.workId}/request-model`;

      const inputNodeIds =
        input.transition.kind === "start_turn_from_next_opportunity"
          ? [`claim/next/${input.workId}`]
          : [`claim/idle/${input.workId}`];

      return [
        {
          kind: "emit",
          eventName: AGENT_EVENT_NAME,
          payload: {
            kind: "input.batch.claimed",
            agentId: input.agentId,
            nodeId: claimEventNodeId,
            parentNodeId: headNodeId,
            turnId,
            inputNodeIds,
          },
          dedupeKey: `agent:${input.agentId}:advance:${input.workId}:claim`,
        },
        {
          kind: "emit",
          eventName: AGENT_EVENT_NAME,
          payload: {
            kind: "turn.state.updated",
            agentId: input.agentId,
            nodeId: phaseEventNodeId,
            parentNodeId: claimEventNodeId,
            phase: "model_running",
          },
          dedupeKey: `agent:${input.agentId}:advance:${input.workId}:phase:model_running`,
        },
        {
          kind: "emit",
          eventName: AGENT_EVENT_NAME,
          payload: {
            kind: "turn.model.requested",
            agentId: input.agentId,
            nodeId: requestModelNodeId,
            parentNodeId: phaseEventNodeId,
            turnId,
          },
          dedupeKey: `agent:${input.agentId}:advance:${input.workId}:request-model`,
        },
      ];
    }
    case "dead_letter_unknown_agent":
    case "dead_letter_missing_head":
    case "await_turn_boundary_with_next_opportunity":
    case "await_idle_for_when_idle":
    case "await_in_flight_turn":
    case "noop_no_pending_work":
      return [];
    default:
      return assertNever(input.transition);
  }
}

export function toQueueOutcome(
  transition: AgentAdvanceTransition,
): QueueHandlerOutcome {
  switch (transition.kind) {
    case "dead_letter_unknown_agent":
    case "dead_letter_missing_head":
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

export function executeAgentAdvance(input: {
  readonly agentId: string;
  readonly workId: number;
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

  const effects = deriveEffects({
    agentId: input.agentId,
    workId: input.workId,
    state: input.state,
    transition,
  });

  return {
    todo,
    transition,
    effects,
    outcome: toQueueOutcome(transition),
  };
}
