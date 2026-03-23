# Agent driver example (sledge-backed)

This example captures the **intended user-facing API** for driving a durable agent on top of sledge.

It intentionally stops short of implementing the full ledger model and `agent.advance` work handler. The goal is to lock the API, event contracts, and query contracts first, then implement orchestration against those tests.

## Why this shape

The driver exposes one user input concept with timing semantics:

- `next_opportunity`: flush all pending inputs of this class at the next model/tool boundary
- `when_idle`: enqueue and consume one item per idle transition

These are intentionally separate timing queues:

1. `next_opportunity` buffer drains fully on the next eligible opportunity.
2. `when_idle` queue drains one item each time the agent reaches idle.

A `next_opportunity` input is never blocked behind queued `when_idle` items.

## Public API experience

The public API surface in `api.ts` is designed for application code:

- `createAgent(...)`
- `submitUserInput(...)`
- `getBranchHead(...)`
- `getPendingInputs(...)`
- `getNodeChildren(...)`
- `tailEvents(...)`
- `resumeEvents(...)`

### Example usage

```ts
const driver = createAgentDriver(ledger);

await driver.createAgent({
  agentId: "agent:1",
  branchId: "main",
  rootNodeId: "node:root",
  context: {
    systemPrompt: "You are concise and careful.",
    model: {
      provider: "anthropic",
      model: "claude-4.1",
      thinkingLevel: "medium",
    },
    tools: ["search", "read_file"],
  },
});

await driver.submitUserInput({
  agentId: "agent:1",
  branchId: "main",
  nodeId: "node:2",
  parentNodeId: "node:root",
  mode: "continue",
  timing: "next_opportunity",
  clientInputId: "input:001",
  content: "Draft a release note from the changelog.",
});
```

## Event contracts users can consume

Consumers can project external state by reading `tailEvents`/`resumeEvents`:

- `agent.event`
  - `context.initialized`
  - `turn.state.updated` (planned lifecycle event scaffold)
- `user.event`
  - `input.recorded`

All events include `agentId`, branch identity, and graph parent references (`nodeId` + `parentNodeId`) for branch/fork reconstruction.

## Query contracts users can consume

The scaffold defines query contracts for common app reads:

- `agent.branch.head`: latest node for an `(agentId, branchId)`
- `agent.pending-inputs`: pending `next_opportunity` and `when_idle` inputs for a branch
- `agent.node.children`: children for a given `(agentId, nodeId)`

## pi-ai anticipation

The context contract already models pi-ai-facing metadata:

- `context.model.provider`
- `context.model.model`
- `context.model.thinkingLevel`

This keeps agent setup aligned with future pi-ai-backed model invocation while the orchestration handler is implemented later.
