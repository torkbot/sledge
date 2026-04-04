import Database from "better-sqlite3";
import assert from "node:assert/strict";
import test from "node:test";

import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import {
  openAgentDriverRuntime,
  type AgentDriverRuntime,
  type PiAiGateway,
} from "./runtime.ts";

function createPiAiStub(): PiAiGateway {
  return {
    runTurn: async () => {
      return {
        outputText: "stub",
      };
    },
  };
}

function createContext() {
  return {
    systemPrompt: "You are concise.",
    model: {
      api: "anthropic",
      provider: "anthropic",
      id: "claude-sonnet-4-20250514",
    },
    thinkingLevel: "off" as const,
    tools: [],
    messages: [],
  };
}

function createOpenedRuntime(): AgentDriverRuntime {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  return openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
    llm: createPiAiStub(),
    toolBindings: [],
  });
}

function runAgentDriverContractSuite(suiteName: string): void {
  test(`${suiteName}: unknown agent queries are deterministic`, async () => {
    await using runtime = createOpenedRuntime();

    const head = await runtime.driver.getHead({
      agentId: "missing",
    });

    assert.equal(head, null);

    const pending = await runtime.driver.getPendingInputs({
      agentId: "missing",
    });

    assert.deepEqual(pending, {
      nextOpportunity: [],
      whenIdle: [],
    });

    const state = await runtime.driver.getRuntimeState({
      agentId: "missing",
    });

    assert.deepEqual(state, {
      exists: false,
      phase: "idle",
      headNodeId: null,
      nextOpportunityCount: 0,
      whenIdleCount: 0,
      hasMessages: false,
    });

    const children = await runtime.driver.getNodeChildren({
      agentId: "missing",
      nodeId: "n1",
    });

    assert.deepEqual(children, []);

    await assert.rejects(
      runtime.driver.getMessages({
        agentId: "missing",
      }),
      /messages not found for agent: missing/,
    );
  });

  test(`${suiteName}: initializeAgent is one-shot per agentId`, async () => {
    await using runtime = createOpenedRuntime();

    const created = await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    assert.equal(created.agentId, "agent-1");

    await assert.rejects(
      runtime.driver.initializeAgent({
        agentId: "agent-1",
        context: createContext(),
      }),
      /agent already initialized: agent-1/,
    );
  });

  test(`${suiteName}: initializeAgent writes expected head and runtime state`, async () => {
    await using runtime = createOpenedRuntime();

    const created = await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    const head = await runtime.driver.getHead({
      agentId: "agent-1",
    });

    assert.deepEqual(head, {
      agentId: "agent-1",
      nodeId: created.nodeId,
      parentNodeId: null,
      eventName: "agent.event",
      eventKind: "context.initialized",
    });

    const state = await runtime.driver.getRuntimeState({
      agentId: "agent-1",
    });

    assert.equal(state.exists, true);
    assert.equal(state.phase, "idle");
    assert.equal(state.headNodeId, created.nodeId);
  });

  test(`${suiteName}: submitUserInput rejects unknown agent`, async () => {
    await using runtime = createOpenedRuntime();

    await assert.rejects(
      runtime.driver.submitUserInput({
        agentId: "missing",
        timing: "next_opportunity",
        idempotencyKey: "input-1",
        content: "hello",
      }),
      /cannot submit input for unknown agent: missing/,
    );
  });

  test(`${suiteName}: submitUserInput defaults parent to current head`, async () => {
    await using runtime = createOpenedRuntime();

    const created = await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    const submitted = await runtime.driver.submitUserInput({
      agentId: "agent-1",
      timing: "next_opportunity",
      idempotencyKey: "input-1",
      content: "hello",
    });

    assert.equal(submitted.parentNodeId, created.nodeId);
  });

  test(`${suiteName}: fork validation rejects missing parent`, async () => {
    await using runtime = createOpenedRuntime();

    await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    await assert.rejects(
      runtime.driver.submitUserInput({
        agentId: "agent-1",
        timing: "next_opportunity",
        idempotencyKey: "input-1",
        content: "fork",
        forkFromNodeId: "missing-parent",
      }),
      /cannot fork from missing parent node: agent-1\/missing-parent/,
    );
  });

  test(`${suiteName}: fork writes sibling child nodes`, async () => {
    await using runtime = createOpenedRuntime();

    const created = await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    const continued = await runtime.driver.submitUserInput({
      agentId: "agent-1",
      timing: "next_opportunity",
      idempotencyKey: "input-main-1",
      content: "continue",
    });

    const forked = await runtime.driver.submitUserInput({
      agentId: "agent-1",
      timing: "next_opportunity",
      idempotencyKey: "input-alt-1",
      content: "fork",
      forkFromNodeId: created.nodeId,
    });

    const children = await runtime.driver.getNodeChildren({
      agentId: "agent-1",
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

  test(`${suiteName}: dedupe key prevents duplicate pending work`, async () => {
    await using runtime = createOpenedRuntime();

    await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    await runtime.driver.submitUserInput({
      agentId: "agent-1",
      timing: "next_opportunity",
      idempotencyKey: "duplicate-key",
      content: "first",
    });

    await runtime.driver.submitUserInput({
      agentId: "agent-1",
      timing: "next_opportunity",
      idempotencyKey: "duplicate-key",
      content: "second",
    });

    const pending = await runtime.driver.getPendingInputs({
      agentId: "agent-1",
    });

    assert.equal(pending.nextOpportunity.length, 1);
    assert.equal(pending.nextOpportunity[0]?.idempotencyKey, "duplicate-key");
  });

  test(`${suiteName}: waitForIdle resolves immediately for idle agents`, async () => {
    await using runtime = createOpenedRuntime();

    await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    const signal = new AbortController().signal;
    await runtime.driver.waitForIdle({
      agentId: "agent-1",
      signal,
    });
  });

  test(`${suiteName}: waitForIdle rejects unknown agent`, async () => {
    await using runtime = createOpenedRuntime();

    const signal = new AbortController().signal;

    await assert.rejects(
      runtime.driver.waitForIdle({
        agentId: "missing",
        signal,
      }),
      /cannot wait for unknown agent: missing/,
    );
  });

  test(`${suiteName}: tailEvents and resumeEvents stream durable events`, async () => {
    await using runtime = createOpenedRuntime();

    const created = await runtime.driver.initializeAgent({
      agentId: "agent-1",
      context: createContext(),
    });

    await runtime.driver.submitUserInput({
      agentId: created.agentId,
      timing: "next_opportunity",
      idempotencyKey: "input-stream-1",
      content: "hello stream",
    });

    const tailSignal = new AbortController().signal;
    const stream = runtime.driver.tailEvents({
      last: 10,
      signal: tailSignal,
    });

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    assert.equal(first.done, false);

    if (first.done) {
      throw new Error("expected one event from tail stream");
    }

    const resumeSignal = new AbortController().signal;
    const resumed = runtime.driver.resumeEvents({
      cursor: first.value.cursor,
      signal: resumeSignal,
    });

    const resumedIterator = resumed[Symbol.asyncIterator]();
    const resumedFirst = await resumedIterator.next();

    assert.equal(resumedFirst.done, false);
  });

  test(
    `${suiteName}: end-to-end turn lifecycle in-ledger (guiding-light)`,
    {
      skip: "waiting on true claimed input ids + turn completion->idle transition",
    },
    async () => {
      await using runtime = createOpenedRuntime();

      const created = await runtime.driver.initializeAgent({
        agentId: "agent-1",
        context: {
          ...createContext(),
          messages: [
            {
              role: "user",
              content: "hello",
            },
          ],
        },
      });

      await runtime.driver.submitUserInput({
        agentId: created.agentId,
        timing: "next_opportunity",
        idempotencyKey: "input-e2e-1",
        content: "answer this",
      });

      const waitController = new AbortController();
      await runtime.driver.waitForIdle({
        agentId: created.agentId,
        signal: waitController.signal,
      });

      const messages = await runtime.driver.getMessages({
        agentId: created.agentId,
      });
      const pending = await runtime.driver.getPendingInputs({
        agentId: created.agentId,
      });
      const runtimeState = await runtime.driver.getRuntimeState({
        agentId: created.agentId,
      });

      assert.equal(messages.messages.at(-1)?.role, "assistant");
      assert.equal(messages.messages.at(-1)?.content, "stub");
      assert.equal(pending.nextOpportunity.length, 0);
      assert.equal(pending.whenIdle.length, 0);
      assert.equal(runtimeState.phase, "idle");
    },
  );
}

runAgentDriverContractSuite("agent driver api contract");
