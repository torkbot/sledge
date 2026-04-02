import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAgentAdvance,
  deriveAgentAdvanceTodo,
  executeAgentAdvance,
} from "./agent-advance.ts";

test("decideAgentAdvance dead-letters unknown agent", () => {
  const state = {
    exists: false,
    phase: "idle",
    headNodeId: null,
    nextOpportunityCount: 0,
    whenIdleCount: 0,
    hasMessages: false,
  } as const;

  const todo = deriveAgentAdvanceTodo({ state });
  const decision = decideAgentAdvance({
    agentId: "missing-agent",
    state,
    todo,
  });

  assert.deepEqual(decision, {
    kind: "dead_letter",
    error: "advance requested for unknown agent: missing-agent",
  });
});

test("decideAgentAdvance chooses next_opportunity branch when available", () => {
  const state = {
    exists: true,
    phase: "idle",
    headNodeId: "n1",
    nextOpportunityCount: 2,
    whenIdleCount: 1,
    hasMessages: true,
  } as const;

  const todo = deriveAgentAdvanceTodo({ state });

  assert.equal(todo.shouldFlushNextOpportunity, true);
  assert.equal(todo.shouldConsumeWhenIdle, true);

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo,
  });

  assert.deepEqual(decision, {
    kind: "noop",
    reason: "next_opportunity dispatch not implemented yet",
  });
});

test("decideAgentAdvance chooses when_idle branch only when idle", () => {
  const state = {
    exists: true,
    phase: "model_running",
    headNodeId: "n1",
    nextOpportunityCount: 0,
    whenIdleCount: 1,
    hasMessages: true,
  } as const;

  const todo = deriveAgentAdvanceTodo({ state });

  assert.equal(todo.shouldFlushNextOpportunity, false);
  assert.equal(todo.shouldConsumeWhenIdle, false);

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo,
  });

  assert.deepEqual(decision, {
    kind: "noop",
    reason: "no pending work",
  });
});

test("executeAgentAdvance maps noop decision to ack", () => {
  const outcome = executeAgentAdvance({
    agentId: "agent-1",
    state: {
      exists: true,
      phase: "idle",
      headNodeId: "n1",
      nextOpportunityCount: 0,
      whenIdleCount: 0,
      hasMessages: false,
    },
  });

  assert.deepEqual(outcome, {
    outcome: "ack",
  });
});
