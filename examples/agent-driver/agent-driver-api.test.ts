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

test("initializeAgent initializes agent head and emits context event", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  await using agentRuntime = openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    llm: createPiAiStub(),
    toolHandlers: {},
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
      tools: [
        {
          name: "search",
          label: "Search",
          description: "Search documentation",
          inputSchemaJson:
            '{"type":"object","properties":{"query":{"type":"string"}}}',
        },
      ],
      messages: [],
    },
  });

  assert.equal(created.agentId, "agent-1");

  const head = await agentRuntime.driver.getHead({
    agentId: created.agentId,
  });

  assert.deepEqual(head, {
    agentId: created.agentId,
    nodeId: created.nodeId,
    parentNodeId: null,
    eventName: "agent.event",
    eventKind: "context.initialized",
  });

  const runtimeState = await agentRuntime.driver.getRuntimeState({
    agentId: created.agentId,
  });

  assert.deepEqual(runtimeState, {
    exists: true,
    phase: "idle",
    headNodeId: created.nodeId,
    nextOpportunityCount: 0,
    whenIdleCount: 0,
    hasMessages: false,
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
    toolHandlers: {},
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
    idempotencyKey: "input-1",
    content: "Apply at next boundary",
  });

  await agentRuntime.driver.submitUserInput({
    agentId: created.agentId,
    timing: "when_idle",
    idempotencyKey: "input-2",
    content: "Queue for idle",
  });

  const pending = await agentRuntime.driver.getPendingInputs({
    agentId: created.agentId,
  });

  assert.equal(pending.nextOpportunity.length, 1);
  assert.equal(pending.nextOpportunity[0]?.idempotencyKey, "input-1");
  assert.equal(pending.whenIdle.length, 1);
  assert.equal(pending.whenIdle[0]?.idempotencyKey, "input-2");

  const runtimeState = await agentRuntime.driver.getRuntimeState({
    agentId: created.agentId,
  });

  assert.equal(runtimeState.nextOpportunityCount, 1);
  assert.equal(runtimeState.whenIdleCount, 1);
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
    toolHandlers: {},
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
    idempotencyKey: "input-main-1",
    content: "Continue on main",
  });

  const forked = await agentRuntime.driver.submitUserInput({
    agentId: created.agentId,
    timing: "next_opportunity",
    idempotencyKey: "input-alt-1",
    content: "Fork from root",
    forkFromNodeId: created.nodeId,
  });

  const children = await agentRuntime.driver.getNodeChildren({
    agentId: created.agentId,
    nodeId: created.nodeId,
  });

  assert.deepEqual(children, [
    {
      nodeId: continued.nodeId,
      eventName: "user.event",
      eventKind: "input.recorded",
    },
    {
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
    toolHandlers: {},
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
    idempotencyKey: "input-stream-1",
    content: "hello stream",
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
