# Agent driver example (sledge-backed)

A durable, ledger-backed agent model built on top of `@torkbot/sledge`.

This example is for teams that want explicit control over agent orchestration state, event history, and replay/resume behavior while integrating with `pi-ai` model execution.

---

## Quick usage

```ts
const driver = createAgentDriver(ledger);

const created = await driver.initializeAgent({
  agentId: "agent:001",
  context: {
    systemPrompt: "You are concise and careful.",
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
        description: "Search internal docs",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
    messages: [],
  },
});

await driver.submitUserInput({
  agentId: created.agentId,
  timing: "next_opportunity",
  idempotencyKey: "input:001",
  content: "Draft a release note from the changelog.",
});

// Explicit fork from historical node:
await driver.submitUserInput({
  agentId: created.agentId,
  timing: "when_idle",
  idempotencyKey: "input:002",
  content: "Try a different angle.",
  forkFromNodeId: created.nodeId,
});

const transcript = await driver.getMessages({
  agentId: created.agentId,
});

console.log(transcript.messages);
```

---

## Key design decisions

### 1) Caller owns `agentId`; runtime owns graph topology

- Caller must provide durable domain identity (`agentId`) at initialization.
- Runtime owns node topology details (`nodeId`, `parentNodeId`).

This keeps API intent-focused and prevents callers from constructing invalid graph topology.

### 2) One-shot initialization

`initializeAgent({ agentId, context })` is one-shot for that identity.

- First initialize creates root context node.
- Re-initialize for existing identity should fail predictably.

This avoids ambiguous "ensure then maybe set context" races.

### 3) One user input concept, two timing policies

`submitUserInput(...)` supports:

- `next_opportunity`: flush all pending inputs of this class at next eligible model/tool boundary
- `when_idle`: queue FIFO and consume one input per idle transition

`next_opportunity` is never blocked behind `when_idle` backlog.

### 4) Forking is explicit and local

Forking is expressed by `forkFromNodeId` on input submission. This is explicit, auditable, and tied to a concrete historical anchor. The runtime validates that the parent node exists for the same agent before recording the forked input.

### 5) Event-first architecture

The runtime is modeled as durable events + queries, not hidden in-memory state. External consumers can tail and resume from opaque cursors.

---

## User-facing API surface

- `initializeAgent(...)`
- `submitUserInput(...)`
- `getHead(...)`
- `getPendingInputs(...)`
- `getNodeChildren(...)`
- `getMessages(...)`
- `getRuntimeState(...)`
- `waitForIdle(...)`
- `tailEvents(...)`
- `resumeEvents(...)`

---

## Event contracts consumers can tail/resume

- `agent.event`
  - `context.initialized`
  - `turn.state.updated`
- `user.event`
  - `input.recorded`

All events include:

- `agentId`
- `nodeId`
- `parentNodeId`

This supports deterministic graph reconstruction and fork introspection.

---

## Query contracts consumers can use

- `agent.head`
  - latest node for `agentId`
- `agent.pending-inputs`
  - pending `next_opportunity` and `when_idle` buffers for agent
- `agent.node.children`
  - child nodes for `(agentId, nodeId)`
- `agent.messages`
  - current message transcript snapshot for agent

---

## pi-ai alignment

Persisted context tracks key pi-ai model inputs:

- `context.model.api`
- `context.model.provider`
- `context.model.id`
- `context.thinkingLevel`
- `context.messages`

This keeps the orchestration model aligned with pi-ai loop execution requirements.

## Tool hookup pattern

Use a two-phase tool model:

1. **Register tool metadata + parameters schema** (for durable context and model-facing tool contracts).
2. **Bind runtime handlers** (for executable side effects).

```ts
import { Type } from "@sinclair/typebox";
import {
  bindAgentTool,
  createAgentContextWithRegisteredTools,
  registerAgentTool,
} from "./tools.ts";

const searchTool = registerAgentTool({
  name: "search",
  label: "Search",
  description: "Search internal docs",
  parametersSchema: Type.Object({
    query: Type.String(),
  }),
});

const context = createAgentContextWithRegisteredTools({
  systemPrompt: "You are concise and careful.",
  model,
  thinkingLevel: "medium",
  messages: [],
  tools: [searchTool],
});

const runtime = openAgentDriverRuntime({
  database,
  timing,
});

// Non-deterministic side subscribes to I/O requests and reports results.
for await (const item of runtime.io.tailRequests({
  last: 0,
  signal,
})) {
  if (item.request.kind === "model.request") {
    await runtime.io.reportResult({
      kind: "model.completed",
      agentId: item.request.agentId,
      turnId: item.request.turnId,
      requestId: item.request.requestId,
      outputText: "result text",
    });
  }
}
```

Handlers are strongly typed from the TypeBox parameters schema. If a tool is registered but unbound at runtime, execution should return a deterministic tool error response.

---

## Operational convention

Run one active writer runtime per backing ledger database.

SQLite will still serialize write transactions under contention, but this example's behavior and performance assumptions are based on single-writer operation.
