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

test("initializeAgent initializes a branch head and emits context event", async () => {
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

  const created = await agentRuntime.driver.initializeAgent({
    agentId: "agent-1",
    context: {
      systemPrompt: "You are concise.",
      model: {
        api: "anthropic",
        provider: "anthropic",
        id: "claude-sonnet-4-20250514",
      },
      thinkingLevel: "medium",
      tools: ["search"],
      messages: [],
    },
  });

  assert.equal(created.agentId, "agent-1");
  assert.equal(created.branchId, "main");

  const head = await agentRuntime.driver.getBranchHead({
    agentId: created.agentId,
  });

  assert.deepEqual(head, {
    agentId: created.agentId,
    branchId: created.branchId,
    nodeId: created.nodeId,
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

  const created = await agentRuntime.driver.initializeAgent({
    agentId: "agent-1",
    context: {
      systemPrompt: "You are concise.",
      model: {
        api: "anthropic",
        provider: "anthropic",
        id: "claude-sonnet-4-20250514",
      },
      thinkingLevel: "off",
      tools: [],
      messages: [],
    },
  });

  await agentRuntime.driver.submitUserInput({
    agentId: created.agentId,
    timing: "next_opportunity",
    clientInputId: "input-1",
    content: "Apply at next boundary",
  });

  await agentRuntime.driver.submitUserInput({
    agentId: created.agentId,
    timing: "when_idle",
    clientInputId: "input-2",
    content: "Queue for idle",
  });

  const pending = await agentRuntime.driver.getPendingInputs({
    agentId: created.agentId,
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

  const created = await agentRuntime.driver.initializeAgent({
    agentId: "agent-1",
    context: {
      systemPrompt: "You are concise.",
      model: {
        api: "anthropic",
        provider: "anthropic",
        id: "claude-sonnet-4-20250514",
      },
      thinkingLevel: "off",
      tools: [],
      messages: [],
    },
  });

  const continued = await agentRuntime.driver.submitUserInput({
    agentId: created.agentId,
    timing: "next_opportunity",
    clientInputId: "input-main-1",
    content: "Continue on main",
  });

  const forked = await agentRuntime.driver.submitUserInput({
    agentId: created.agentId,
    timing: "next_opportunity",
    clientInputId: "input-alt-1",
    content: "Fork from root",
    forkFromNodeId: created.nodeId,
  });

  const children = await agentRuntime.driver.getNodeChildren({
    agentId: created.agentId,
    nodeId: created.nodeId,
  });

  assert.deepEqual(children, [
    {
      branchId: created.branchId,
      nodeId: continued.nodeId,
      eventName: "user.event",
      eventKind: "input.recorded",
    },
    {
      branchId: created.branchId,
      nodeId: forked.nodeId,
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
