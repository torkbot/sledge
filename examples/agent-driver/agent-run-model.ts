import type { Static } from "@sinclair/typebox";

import type { QueueHandlerOutcome } from "../../src/ledger/ledger.ts";
import {
  AGENT_MESSAGES_QUERY_NAME,
  AGENT_RUNTIME_STATE_QUERY_NAME,
  AGENT_TURN_QUERY_NAME,
  AgentDriverQuerySchemas,
} from "./contracts.ts";

type AgentRuntimeState = Static<
  (typeof AgentDriverQuerySchemas)[typeof AGENT_RUNTIME_STATE_QUERY_NAME]["result"]
>;

type AgentTurnState = Static<
  (typeof AgentDriverQuerySchemas)[typeof AGENT_TURN_QUERY_NAME]["result"]
>;

type AgentMessages = Static<
  (typeof AgentDriverQuerySchemas)[typeof AGENT_MESSAGES_QUERY_NAME]["result"]
>;

export type AgentRunModelDecision =
  | {
      readonly kind: "dead_letter_unknown_agent";
      readonly error: string;
    }
  | {
      readonly kind: "ack_stale_phase";
      readonly reason: string;
    }
  | {
      readonly kind: "dead_letter_missing_turn";
      readonly error: string;
    }
  | {
      readonly kind: "ack_turn_completed";
      readonly reason: string;
    }
  | {
      readonly kind: "dead_letter_turn_failed";
      readonly error: string;
    }
  | {
      readonly kind: "invoke_model";
      readonly reason: string;
    };

export type AgentRunModelExecution = {
  readonly decision: AgentRunModelDecision;
  readonly prompt: string | null;
};

function summarizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

function buildModelPrompt(messages: AgentMessages["messages"]): string {
  if (messages.length === 0) {
    return "";
  }

  return messages
    .map((message) => summarizeMessageContent(message.content))
    .join("\n\n");
}

function assertNever(value: never): never {
  throw new Error(`unhandled run-model decision: ${JSON.stringify(value)}`);
}

export function decideAgentRunModel(input: {
  readonly agentId: string;
  readonly turnId: string;
  readonly runtimeState: AgentRuntimeState;
  readonly turn: AgentTurnState;
}): AgentRunModelDecision {
  if (!input.runtimeState.exists) {
    return {
      kind: "dead_letter_unknown_agent",
      error: `model run requested for unknown agent: ${input.agentId}`,
    };
  }

  if (input.runtimeState.phase !== "model_running") {
    return {
      kind: "ack_stale_phase",
      reason: `stale model run delivery while phase=${input.runtimeState.phase}`,
    };
  }

  if (input.turn === null) {
    return {
      kind: "dead_letter_missing_turn",
      error: `model run requested for missing turn: ${input.agentId}/${input.turnId}`,
    };
  }

  if (input.turn.status === "completed") {
    return {
      kind: "ack_turn_completed",
      reason: `turn already completed: ${input.agentId}/${input.turnId}`,
    };
  }

  if (input.turn.status === "failed") {
    return {
      kind: "dead_letter_turn_failed",
      error: `model run requested for failed turn: ${input.agentId}/${input.turnId}`,
    };
  }

  return {
    kind: "invoke_model",
    reason: `turn ready for model run: ${input.agentId}/${input.turnId}`,
  };
}

export function toImmediateOutcome(
  decision: AgentRunModelDecision,
): QueueHandlerOutcome | null {
  switch (decision.kind) {
    case "dead_letter_unknown_agent":
    case "dead_letter_missing_turn":
    case "dead_letter_turn_failed":
      return {
        outcome: "dead_letter",
        error: decision.error,
      };
    case "ack_stale_phase":
    case "ack_turn_completed":
      return {
        outcome: "ack",
      };
    case "invoke_model":
      return null;
    default:
      return assertNever(decision);
  }
}

export function executeAgentRunModel(input: {
  readonly agentId: string;
  readonly turnId: string;
  readonly runtimeState: AgentRuntimeState;
  readonly turn: AgentTurnState;
  readonly transcript: AgentMessages;
}): AgentRunModelExecution {
  const decision = decideAgentRunModel({
    agentId: input.agentId,
    turnId: input.turnId,
    runtimeState: input.runtimeState,
    turn: input.turn,
  });

  if (decision.kind !== "invoke_model") {
    return {
      decision,
      prompt: null,
    };
  }

  return {
    decision,
    prompt: buildModelPrompt(input.transcript.messages),
  };
}
