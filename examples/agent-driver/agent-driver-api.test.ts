import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";

import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { openAgentDriverRuntime, type PiAiGateway } from "./runtime.ts";

function createPiAiStub(): PiAiGateway {
  return {
    runTurn: async () => {
      return {
        outputText: "stub",
      };
    },
  };
}

test("createAgent initializes a branch head and emits context event", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  await using agentRuntime = openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    llm: createPiAiStub(),
  });

  await agentRuntime.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are concise.",
      model: {
        provider: "anthropic",
        model: "claude-4.1",
        thinkingLevel: "medium",
      },
      tools: ["search"],
    },
  });

  const head = await agentRuntime.driver.getBranchHead({
    agentId: "agent-1",
    branchId: "main",
  });

  assert.deepEqual(head, {
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-root",
    parentNodeId: null,
    eventName: "agent.event",
    eventKind: "context.initialized",
  });
});

test("submitUserInput splits next_opportunity and when_idle queues", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  await using agentRuntime = openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    llm: createPiAiStub(),
  });

  await agentRuntime.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are concise.",
      model: {
        provider: "anthropic",
        model: "claude-4.1",
      },
      tools: [],
    },
  });

  await agentRuntime.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-1",
    parentNodeId: "node-root",
    mode: "continue",
    timing: "next_opportunity",
    clientInputId: "input-1",
    content: "Apply at next boundary",
  });

  await agentRuntime.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-2",
    parentNodeId: "node-1",
    mode: "continue",
    timing: "when_idle",
    clientInputId: "input-2",
    content: "Queue for idle",
  });

  const pending = await agentRuntime.driver.getPendingInputs({
    agentId: "agent-1",
    branchId: "main",
  });

  assert.equal(pending.nextOpportunity.length, 1);
  assert.equal(pending.nextOpportunity[0]?.clientInputId, "input-1");
  assert.equal(pending.whenIdle.length, 1);
  assert.equal(pending.whenIdle[0]?.clientInputId, "input-2");
});

test("fork mode records sibling children from the same parent node", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  await using agentRuntime = openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    llm: createPiAiStub(),
  });

  await agentRuntime.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are concise.",
      model: {
        provider: "anthropic",
        model: "claude-4.1",
      },
      tools: [],
    },
  });

  await agentRuntime.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-main-1",
    parentNodeId: "node-root",
    mode: "continue",
    timing: "next_opportunity",
    clientInputId: "input-main-1",
    content: "Continue on main",
  });

  await agentRuntime.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "branch-alt",
    nodeId: "node-alt-1",
    parentNodeId: "node-root",
    mode: "fork",
    timing: "next_opportunity",
    clientInputId: "input-alt-1",
    content: "Fork from root",
  });

  const children = await agentRuntime.driver.getNodeChildren({
    agentId: "agent-1",
    nodeId: "node-root",
  });

  assert.deepEqual(children, [
    {
      branchId: "main",
      nodeId: "node-main-1",
      eventName: "user.event",
      eventKind: "input.recorded",
    },
    {
      branchId: "branch-alt",
      nodeId: "node-alt-1",
      eventName: "user.event",
      eventKind: "input.recorded",
    },
  ]);
});

test("tailEvents and resumeEvents expose the agent event stream", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  await using agentRuntime = openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    llm: createPiAiStub(),
  });

  const abortController = new AbortController();
  const stream = agentRuntime.tailEvents({
    last: 10,
    signal: abortController.signal,
  });

  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();

  assert.equal(first.done, false);

  if (first.done) {
    throw new Error("expected one event from tail stream");
  }

  const resumeController = new AbortController();
  const resumed = agentRuntime.resumeEvents({
    cursor: first.value.cursor,
    signal: resumeController.signal,
  });

  const resumedIterator = resumed[Symbol.asyncIterator]();
  const resumedFirst = await resumedIterator.next();

  assert.equal(resumedFirst.done, false);
});
