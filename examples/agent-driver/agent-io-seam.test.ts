import Database from "better-sqlite3";
import assert from "node:assert/strict";
import test from "node:test";

import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { openAgentDriverRuntime } from "./runtime.ts";

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
    messages: [
      {
        role: "user" as const,
        content: "hello",
      },
    ],
  };
}

test("io seam emits model request and accepts completion result", async () => {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  await using opened = openAgentDriverRuntime({
    database,
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  const created = await opened.driver.initializeAgent({
    agentId: "agent-1",
    context: createContext(),
  });

  await opened.driver.submitUserInput({
    agentId: created.agentId,
    timing: "next_opportunity",
    idempotencyKey: "input-1",
    content: "answer",
  });

  await runtime.flush();

  const requestController = new AbortController();
  const requests = opened.io.tailRequests({
    last: 20,
    signal: requestController.signal,
  });

  const iterator = requests[Symbol.asyncIterator]();
  const first = await iterator.next();

  assert.equal(first.done, false);
  if (first.done) {
    throw new Error("expected at least one io request");
  }

  assert.deepEqual(first.value.request.kind, "model.request");

  await iterator.return?.();
  requestController.abort();

  await opened.io.reportResult({
    kind: "model.completed",
    agentId: first.value.request.agentId,
    turnId: first.value.request.turnId,
    requestId: first.value.request.requestId,
    outputText: "stubbed io result",
  });

  await runtime.flush();

  const messages = await opened.driver.getMessages({
    agentId: created.agentId,
  });

  assert.equal(messages.messages.at(-1)?.role, "assistant");
  assert.equal(messages.messages.at(-1)?.content, "stubbed io result");

  const state = await opened.driver.getRuntimeState({
    agentId: created.agentId,
  });

  assert.equal(state.phase, "idle");
});
