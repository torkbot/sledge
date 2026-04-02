import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAgentAdvance,
  deriveAgentAdvanceTodo,
  executeAgentAdvance,
  type AgentAdvanceRecoveryState,
} from "./agent-advance.ts";

function makeState(
  patch: Partial<AgentAdvanceRecoveryState> = {},
): AgentAdvanceRecoveryState {
  return {
    exists: true,
    phase: "idle",
    headNodeId: "n1",
    nextOpportunityCount: 0,
    whenIdleCount: 0,
    hasMessages: false,
    ...patch,
  };
}

test("deriveAgentAdvanceTodo reflects next_opportunity and transcript flags", () => {
  const todo = deriveAgentAdvanceTodo({
    state: makeState({
      nextOpportunityCount: 2,
      hasMessages: true,
    }),
  });

  assert.deepEqual(todo, {
    shouldFlushNextOpportunity: true,
    shouldConsumeWhenIdle: false,
    hasTranscript: true,
  });
});

test("deriveAgentAdvanceTodo only consumes when_idle when phase is idle", () => {
  const idleTodo = deriveAgentAdvanceTodo({
    state: makeState({
      phase: "idle",
      whenIdleCount: 1,
    }),
  });

  const runningTodo = deriveAgentAdvanceTodo({
    state: makeState({
      phase: "model_running",
      whenIdleCount: 1,
    }),
  });

  assert.equal(idleTodo.shouldConsumeWhenIdle, true);
  assert.equal(runningTodo.shouldConsumeWhenIdle, false);
});

test("decideAgentAdvance dead-letters unknown agent even when todo has work", () => {
  const state = makeState({
    exists: false,
    headNodeId: null,
    nextOpportunityCount: 1,
    whenIdleCount: 1,
  });

  const decision = decideAgentAdvance({
    agentId: "missing-agent",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "dead_letter",
    error: "advance requested for unknown agent: missing-agent",
  });
});

test("decideAgentAdvance prioritizes next_opportunity over when_idle", () => {
  const state = makeState({
    nextOpportunityCount: 3,
    whenIdleCount: 2,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "noop",
    reason: "next_opportunity dispatch not implemented yet",
  });
});

test("decideAgentAdvance selects when_idle branch when idle and no next_opportunity", () => {
  const state = makeState({
    nextOpportunityCount: 0,
    whenIdleCount: 1,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "noop",
    reason: "when_idle dispatch not implemented yet",
  });
});

test("decideAgentAdvance returns no pending work when running and only when_idle exists", () => {
  const state = makeState({
    phase: "tools_running",
    nextOpportunityCount: 0,
    whenIdleCount: 1,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "noop",
    reason: "no pending work",
  });
});

test("executeAgentAdvance maps noop decision to ack", () => {
  const outcome = executeAgentAdvance({
    agentId: "agent-1",
    state: makeState(),
  });

  assert.deepEqual(outcome, {
    outcome: "ack",
  });
});

test("executeAgentAdvance maps unknown-agent decision to dead_letter outcome", () => {
  const outcome = executeAgentAdvance({
    agentId: "missing-agent",
    state: makeState({
      exists: false,
      headNodeId: null,
    }),
  });

  assert.deepEqual(outcome, {
    outcome: "dead_letter",
    error: "advance requested for unknown agent: missing-agent",
  });
});
