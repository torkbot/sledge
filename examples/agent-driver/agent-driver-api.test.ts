import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";

import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { createBetterSqliteLedger } from "../../src/ledger/better-sqlite3-ledger.ts";
import { defineLedgerModel } from "../../src/ledger/ledger.ts";
import { createAgentDriver } from "./api.ts";
import {
  AgentDriverEventSchemas,
  AgentDriverQuerySchemas,
  type UserInputRecordedEvent,
} from "./contracts.ts";

type BranchHead = {
  readonly agentId: string;
  readonly branchId: string;
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly eventName: "agent.event" | "user.event";
  readonly eventKind: string;
};

function createBranchKey(agentId: string, branchId: string): string {
  return `${agentId}::${branchId}`;
}

function createChildKey(agentId: string, nodeId: string): string {
  return `${agentId}::${nodeId}`;
}

function cloneRecordedInput(
  input: UserInputRecordedEvent,
): UserInputRecordedEvent {
  return {
    ...input,
  };
}

function cloneBranchHead(head: BranchHead): BranchHead {
  return {
    ...head,
  };
}

function createAgentDriverTestHarness() {
  const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
  const database = new Database(":memory:");

  const branchHeads = new Map<string, BranchHead>();
  const nextOpportunityInputs = new Map<string, UserInputRecordedEvent[]>();
  const whenIdleInputs = new Map<string, UserInputRecordedEvent[]>();
  const nodeChildren = new Map<
    string,
    Array<{
      readonly branchId: string;
      readonly nodeId: string;
      readonly eventName: "agent.event" | "user.event";
      readonly eventKind: string;
    }>
  >();

  const model = defineLedgerModel({
    events: AgentDriverEventSchemas,
    queues: {},
    indexers: {
      recordBranchHead: AgentDriverQuerySchemas["agent.branch.head"].result,
      recordPendingInput: AgentDriverEventSchemas["user.event"],
      recordNodeChild: AgentDriverQuerySchemas["agent.node.children"].result,
    },
    queries: AgentDriverQuerySchemas,
    register(builder) {
      builder.project("agent.event", async ({ event, actions }) => {
        const payload = event.payload;

        if (payload.kind === "context.initialized") {
          const branchKey = createBranchKey(payload.agentId, payload.branchId);

          const head: BranchHead = {
            agentId: payload.agentId,
            branchId: payload.branchId,
            nodeId: payload.nodeId,
            parentNodeId: payload.parentNodeId,
            eventName: "agent.event",
            eventKind: payload.kind,
          };

          branchHeads.set(branchKey, head);
          await actions.index("recordBranchHead", head);

          return;
        }

        const branchKey = createBranchKey(payload.agentId, payload.branchId);
        const head: BranchHead = {
          agentId: payload.agentId,
          branchId: payload.branchId,
          nodeId: payload.nodeId,
          parentNodeId: payload.parentNodeId,
          eventName: "agent.event",
          eventKind: payload.kind,
        };

        branchHeads.set(branchKey, head);
        await actions.index("recordBranchHead", head);
      });

      builder.project("user.event", async ({ event, actions }) => {
        const payload = event.payload;
        const branchKey = createBranchKey(payload.agentId, payload.branchId);

        const head: BranchHead = {
          agentId: payload.agentId,
          branchId: payload.branchId,
          nodeId: payload.nodeId,
          parentNodeId: payload.parentNodeId,
          eventName: "user.event",
          eventKind: payload.kind,
        };

        branchHeads.set(branchKey, head);
        await actions.index("recordBranchHead", head);

        const childKey = createChildKey(payload.agentId, payload.parentNodeId);
        const childEntries = nodeChildren.get(childKey) ?? [];

        childEntries.push({
          branchId: payload.branchId,
          nodeId: payload.nodeId,
          eventName: "user.event",
          eventKind: payload.kind,
        });

        nodeChildren.set(childKey, childEntries);
        await actions.index("recordNodeChild", childEntries);

        if (payload.timing === "next_opportunity") {
          const existing = nextOpportunityInputs.get(branchKey) ?? [];
          existing.push(cloneRecordedInput(payload));
          nextOpportunityInputs.set(branchKey, existing);
          await actions.index("recordPendingInput", payload);
          return;
        }

        const existing = whenIdleInputs.get(branchKey) ?? [];
        existing.push(cloneRecordedInput(payload));
        whenIdleInputs.set(branchKey, existing);
        await actions.index("recordPendingInput", payload);
      });
    },
  });

  const ledger = createBetterSqliteLedger({
    database,
    boundModel: model.bind({
      indexers: {
        recordBranchHead: async () => undefined,
        recordPendingInput: async () => undefined,
        recordNodeChild: async () => undefined,
      },
      queries: {
        "agent.branch.head": async (params) => {
          const key = createBranchKey(params.agentId, params.branchId);
          const head = branchHeads.get(key);

          if (head === undefined) {
            return null;
          }

          return cloneBranchHead(head);
        },
        "agent.pending-inputs": async (params) => {
          const key = createBranchKey(params.agentId, params.branchId);

          return {
            nextOpportunity: (nextOpportunityInputs.get(key) ?? []).map(
              (item) => {
                return cloneRecordedInput(item);
              },
            ),
            whenIdle: (whenIdleInputs.get(key) ?? []).map((item) => {
              return cloneRecordedInput(item);
            }),
          };
        },
        "agent.node.children": async (params) => {
          const key = createChildKey(params.agentId, params.nodeId);
          const children = nodeChildren.get(key) ?? [];

          return children.map((child) => {
            return {
              ...child,
            };
          });
        },
      },
    }),
    timing: {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
    },
  });

  return {
    runtime,
    ledger,
    driver: createAgentDriver(ledger),
  };
}

test("createAgent emits context.initialized and sets branch head", async () => {
  const harness = createAgentDriverTestHarness();

  await using ledger = harness.ledger;

  await harness.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are helpful.",
      model: {
        provider: "openai",
        model: "gpt-4.1",
      },
      tools: ["search"],
    },
  });

  const head = await harness.driver.getBranchHead({
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

test("submitUserInput dedupes by clientInputId and splits timing queues", async () => {
  const harness = createAgentDriverTestHarness();

  await using ledger = harness.ledger;

  await harness.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are helpful.",
      model: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "low",
      },
      tools: [],
    },
  });

  await harness.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-1",
    parentNodeId: "node-root",
    mode: "continue",
    timing: "next_opportunity",
    clientInputId: "input-1",
    content: "First message",
  });

  await harness.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-1-duplicate",
    parentNodeId: "node-root",
    mode: "continue",
    timing: "next_opportunity",
    clientInputId: "input-1",
    content: "Duplicate delivery should no-op",
  });

  await harness.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-2",
    parentNodeId: "node-1",
    mode: "continue",
    timing: "when_idle",
    clientInputId: "input-2",
    content: "Second message",
  });

  const pending = await harness.driver.getPendingInputs({
    agentId: "agent-1",
    branchId: "main",
  });

  assert.equal(pending.nextOpportunity.length, 1);
  assert.equal(pending.nextOpportunity[0]?.clientInputId, "input-1");
  assert.equal(pending.whenIdle.length, 1);
  assert.equal(pending.whenIdle[0]?.clientInputId, "input-2");
});

test("fork mode creates sibling children from same parent node", async () => {
  const harness = createAgentDriverTestHarness();

  await using ledger = harness.ledger;

  await harness.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are helpful.",
      model: {
        provider: "openai",
        model: "gpt-4.1",
      },
      tools: [],
    },
  });

  await harness.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-main-1",
    parentNodeId: "node-root",
    mode: "continue",
    timing: "next_opportunity",
    clientInputId: "input-main-1",
    content: "Continue on main",
  });

  await harness.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "branch-alt",
    nodeId: "node-alt-1",
    parentNodeId: "node-root",
    mode: "fork",
    timing: "next_opportunity",
    clientInputId: "input-alt-1",
    content: "Fork from root",
  });

  const children = await harness.driver.getNodeChildren({
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

test("tailEvents and resumeEvents expose consumable stream with opaque cursor", async () => {
  const harness = createAgentDriverTestHarness();

  await using ledger = harness.ledger;

  await harness.driver.createAgent({
    agentId: "agent-1",
    branchId: "main",
    rootNodeId: "node-root",
    context: {
      systemPrompt: "You are helpful.",
      model: {
        provider: "anthropic",
        model: "claude-4.1",
      },
      tools: ["search", "read"],
    },
  });

  await harness.driver.submitUserInput({
    agentId: "agent-1",
    branchId: "main",
    nodeId: "node-1",
    parentNodeId: "node-root",
    mode: "continue",
    timing: "next_opportunity",
    clientInputId: "input-1",
    content: "Summarize the changelog",
  });

  const abortController = new AbortController();
  const iterator = harness.driver
    .tailEvents({
      last: 2,
      signal: abortController.signal,
    })
    [Symbol.asyncIterator]();

  const first = await iterator.next();
  const second = await iterator.next();

  assert.equal(first.done, false);
  assert.equal(second.done, false);

  if (first.done || second.done) {
    throw new Error("expected stream events from backlog");
  }

  assert.equal(typeof first.value.cursor, "string");
  assert.equal(typeof second.value.cursor, "string");

  const resumeAbortController = new AbortController();
  const resumedIterator = harness.driver
    .resumeEvents({
      cursor: first.value.cursor,
      signal: resumeAbortController.signal,
    })
    [Symbol.asyncIterator]();

  const resumed = await resumedIterator.next();

  assert.equal(resumed.done, false);

  if (resumed.done) {
    throw new Error("expected resumed event");
  }

  assert.equal(resumed.value.event.eventName, "user.event");

  abortController.abort();
  resumeAbortController.abort();

  await harness.runtime.flush();
});
