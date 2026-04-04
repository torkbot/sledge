import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAgentRunModel,
  executeAgentRunModel,
  toImmediateOutcome,
} from "./agent-run-model.ts";

function makeRuntimeState(
  patch: Partial<{
    exists: boolean;
    phase: "idle" | "model_running" | "tools_running";
    headNodeId: string | null;
    nextOpportunityCount: number;
    whenIdleCount: number;
    hasMessages: boolean;
  }> = {},
) {
  return {
    exists: true,
    phase: "model_running" as const,
    headNodeId: "head-1",
    nextOpportunityCount: 0,
    whenIdleCount: 0,
    hasMessages: true,
    ...patch,
  };
}

function makeTurn(
  patch: Partial<{
    agentId: string;
    turnId: string;
    requestNodeId: string;
    status: "requested" | "completed" | "failed";
    lastNodeId: string;
    outputText?: string;
    error?: string;
  }> = {},
) {
  return {
    agentId: "agent-1",
    turnId: "turn-1",
    requestNodeId: "request-1",
    status: "requested" as const,
    lastNodeId: "request-1",
    ...patch,
  };
}

function makeTranscript() {
  return {
    headNodeId: "head-1",
    messages: [
      {
        role: "user" as const,
        content: "hello",
      },
      {
        role: "assistant" as const,
        content: {
          kind: "json",
          value: 42,
        },
      },
    ],
  };
}

test("decideAgentRunModel dead-letters unknown agent", () => {
  const decision = decideAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState({ exists: false }),
    turn: makeTurn(),
  });

  assert.deepEqual(decision, {
    kind: "dead_letter_unknown_agent",
    error: "model run requested for unknown agent: agent-1",
  });
});

test("decideAgentRunModel acks stale non-model phase", () => {
  const decision = decideAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState({ phase: "idle" }),
    turn: makeTurn(),
  });

  assert.equal(decision.kind, "ack_stale_phase");
});

test("decideAgentRunModel dead-letters missing turn", () => {
  const decision = decideAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState(),
    turn: null,
  });

  assert.deepEqual(decision, {
    kind: "dead_letter_missing_turn",
    error: "model run requested for missing turn: agent-1/turn-1",
  });
});

test("decideAgentRunModel handles completed/failed turns deterministically", () => {
  const completed = decideAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState(),
    turn: makeTurn({ status: "completed" }),
  });

  const failed = decideAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState(),
    turn: makeTurn({ status: "failed" }),
  });

  assert.equal(completed.kind, "ack_turn_completed");
  assert.deepEqual(failed, {
    kind: "dead_letter_turn_failed",
    error: "model run requested for failed turn: agent-1/turn-1",
  });
});

test("executeAgentRunModel builds model prompt for invoke decision", () => {
  const execution = executeAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState(),
    turn: makeTurn({ status: "requested" }),
    transcript: makeTranscript(),
  });

  assert.deepEqual(execution.decision, {
    kind: "invoke_model",
    reason: "turn ready for model run: agent-1/turn-1",
  });
  assert.equal(execution.prompt, 'hello\n\n{"kind":"json","value":42}');
});

test("toImmediateOutcome returns null only for invoke_model", () => {
  const invokeExecution = executeAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState(),
    turn: makeTurn(),
    transcript: makeTranscript(),
  });

  const staleExecution = executeAgentRunModel({
    agentId: "agent-1",
    turnId: "turn-1",
    runtimeState: makeRuntimeState({ phase: "tools_running" }),
    turn: makeTurn(),
    transcript: makeTranscript(),
  });

  assert.equal(toImmediateOutcome(invokeExecution.decision), null);
  assert.deepEqual(toImmediateOutcome(staleExecution.decision), {
    outcome: "ack",
  });
});
