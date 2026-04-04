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

test("decideAgentAdvance dead-letters unknown agent", () => {
  const state = makeState({
    exists: false,
    headNodeId: null,
  });

  const decision = decideAgentAdvance({
    agentId: "missing-agent",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "dead_letter_unknown_agent",
    error: "advance requested for unknown agent: missing-agent",
  });
});

test("decideAgentAdvance dead-letters agent with missing head", () => {
  const state = makeState({
    headNodeId: null,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "dead_letter_missing_head",
    error: "advance requested for agent with missing head: agent-1",
  });
});

test("decideAgentAdvance starts turn from next_opportunity when idle", () => {
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
    kind: "start_turn_from_next_opportunity",
    reason: "idle with next_opportunity backlog",
  });
});

test("decideAgentAdvance starts turn from when_idle when idle and no next_opportunity", () => {
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
    kind: "start_turn_from_when_idle",
    reason: "idle with when_idle backlog",
  });
});

test("decideAgentAdvance returns idle/noop when no pending input", () => {
  const state = makeState();

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "noop_no_pending_work",
    reason: "idle with no pending input",
  });
});

test("decideAgentAdvance awaits turn boundary when running and next_opportunity exists", () => {
  const state = makeState({
    phase: "model_running",
    nextOpportunityCount: 1,
    whenIdleCount: 1,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "await_turn_boundary_with_next_opportunity",
    reason: "turn is in-flight; next_opportunity queued",
  });
});

test("decideAgentAdvance awaits idle when running and only when_idle exists", () => {
  const state = makeState({
    phase: "tools_running",
    nextOpportunityCount: 0,
    whenIdleCount: 2,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "await_idle_for_when_idle",
    reason: "turn is in-flight; when_idle queued",
  });
});

test("decideAgentAdvance awaits in-flight turn when running and no queued input", () => {
  const state = makeState({
    phase: "tools_running",
    nextOpportunityCount: 0,
    whenIdleCount: 0,
  });

  const decision = decideAgentAdvance({
    agentId: "agent-1",
    state,
    todo: deriveAgentAdvanceTodo({ state }),
  });

  assert.deepEqual(decision, {
    kind: "await_in_flight_turn",
    reason: "turn in-flight with no queued input",
  });
});

test("executeAgentAdvance creates durable emit effects for next_opportunity start", () => {
  const execution = executeAgentAdvance({
    agentId: "agent-1",
    workId: 42,
    state: makeState({
      headNodeId: "head-1",
      nextOpportunityCount: 1,
      hasMessages: true,
    }),
  });

  assert.equal(execution.transition.kind, "start_turn_from_next_opportunity");
  assert.equal(execution.effects.length, 3);

  const claim = execution.effects[0];
  assert.deepEqual(claim, {
    kind: "emit",
    eventName: "agent.event",
    payload: {
      kind: "input.batch.claimed",
      agentId: "agent-1",
      nodeId: "agent-event/42/claim",
      parentNodeId: "head-1",
      turnId: "turn/agent-1/42",
      inputNodeIds: ["claim/next/42"],
    },
    dedupeKey: "agent:agent-1:advance:42:claim",
  });

  const phase = execution.effects[1];
  assert.deepEqual(phase, {
    kind: "emit",
    eventName: "agent.event",
    payload: {
      kind: "turn.state.updated",
      agentId: "agent-1",
      nodeId: "agent-event/42/phase-model-running",
      parentNodeId: "agent-event/42/claim",
      phase: "model_running",
    },
    dedupeKey: "agent:agent-1:advance:42:phase:model_running",
  });

  const requestModel = execution.effects[2];
  assert.deepEqual(requestModel, {
    kind: "emit",
    eventName: "agent.event",
    payload: {
      kind: "turn.model.requested",
      agentId: "agent-1",
      nodeId: "agent-event/42/request-model",
      parentNodeId: "agent-event/42/phase-model-running",
      turnId: "turn/agent-1/42",
    },
    dedupeKey: "agent:agent-1:advance:42:request-model",
  });

  assert.deepEqual(execution.outcome, {
    outcome: "ack",
  });
});

test("executeAgentAdvance maps unknown agent to dead_letter outcome", () => {
  const execution = executeAgentAdvance({
    agentId: "missing-agent",
    workId: 999,
    state: makeState({
      exists: false,
      headNodeId: null,
    }),
  });

  assert.equal(execution.effects.length, 0);
  assert.deepEqual(execution.transition, {
    kind: "dead_letter_unknown_agent",
    error: "advance requested for unknown agent: missing-agent",
  });
  assert.deepEqual(execution.outcome, {
    outcome: "dead_letter",
    error: "advance requested for unknown agent: missing-agent",
  });
});
