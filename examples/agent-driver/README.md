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
        inputSchemaJson:
          '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}',
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
- Runtime owns lineage/node details (`branchId`, `nodeId`, `parentNodeId`).

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

Forking is expressed by `forkFromNodeId` on input submission. This is explicit, auditable, and tied to a concrete historical anchor.

### 5) Event-first architecture

The runtime is modeled as durable events + queries, not hidden in-memory state. External consumers can tail and resume from opaque cursors.

---

## User-facing API surface

- `initializeAgent(...)`
- `submitUserInput(...)`
- `getBranchHead(...)`
- `getPendingInputs(...)`
- `getNodeChildren(...)`
- `getMessages(...)`
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
- `branchId`
- `nodeId`
- `parentNodeId`

This supports deterministic graph reconstruction and branch introspection.

---

## Query contracts consumers can use

- `agent.branch.head`
  - latest node for `(agentId, branchId)`
  - driver defaults branch to `main`
- `agent.pending-inputs`
  - pending `next_opportunity` and `when_idle` buffers for branch
  - driver defaults branch to `main`
- `agent.node.children`
  - child nodes for `(agentId, nodeId)`

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

An agent with tools should wire durable tool definitions to concrete runtime handlers.

At runtime boundary (`openAgentDriverRuntime(...)`), provide handlers keyed by tool name. The orchestration layer resolves durable tool calls against this registry during `agent.advance`.

```ts
const runtime = openAgentDriverRuntime({
  database,
  timing,
  llm,
  toolHandlers: {
    search: async ({ query, signal }) => {
      return {
        content: [{ type: "text", text: `result for: ${query}` }],
      };
    },
  },
});
```

If a tool is declared in context but has no runtime handler, the call should fail predictably and be materialized as tool error events.

---

## Operational convention

Run one active writer runtime per backing ledger database.

SQLite will still serialize write transactions under contention, but this example's behavior and performance assumptions are based on single-writer operation.
