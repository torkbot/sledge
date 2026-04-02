import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "@sinclair/typebox";

import {
  bindAgentTool,
  createAgentContextWithRegisteredTools,
  createToolBindingResolver,
  executeToolOrUnboundError,
  registerAgentTool,
  toolRegistrationToDefinition,
} from "./tools.ts";

test("tool registration serializes to durable tool definition", () => {
  const tool = registerAgentTool({
    name: "search",
    label: "Search",
    description: "Search docs",
    parametersSchema: Type.Object({
      query: Type.String(),
    }),
  });

  const definition = toolRegistrationToDefinition(tool);

  assert.equal(definition.name, "search");
  assert.deepEqual(definition.parametersSchema, tool.parametersSchema);
});

test("createAgentContextWithRegisteredTools appends tool details to prompt", () => {
  const tool = registerAgentTool({
    name: "search",
    label: "Search",
    description: "Search docs",
    parametersSchema: Type.Object({
      query: Type.String(),
    }),
  });

  const context = createAgentContextWithRegisteredTools({
    systemPrompt: "You are concise.",
    model: {
      api: "anthropic",
      provider: "anthropic",
      id: "claude-sonnet-4-20250514",
    },
    thinkingLevel: "off",
    messages: [],
    tools: [tool],
  });

  assert.equal(context.tools.length, 1);
  assert.match(context.systemPrompt, /Available tools:/);
  assert.match(context.systemPrompt, /search/);
});

test("executeToolOrUnboundError returns deterministic error for unbound tool", async () => {
  const resolver = createToolBindingResolver({
    boundTools: [],
  });

  const result = await executeToolOrUnboundError({
    resolver,
    toolName: "search",
    params: { query: "x" },
    signal: AbortSignal.abort(),
  });

  assert.equal(result.content, "tool not bound at runtime: search");
});

test("bound tool execute receives schema-typed params", async () => {
  const tool = registerAgentTool({
    name: "search",
    label: "Search",
    description: "Search docs",
    parametersSchema: Type.Object({
      query: Type.String(),
    }),
  });

  const bound = bindAgentTool({
    tool,
    execute: async ({ params }) => {
      return {
        content: `result for ${params.query}`,
      };
    },
  });

  const resolver = createToolBindingResolver({
    boundTools: [bound],
  });

  const result = await executeToolOrUnboundError({
    resolver,
    toolName: "search",
    params: { query: "docs" },
    signal: AbortSignal.abort(),
  });

  assert.equal(result.content, "result for docs");
});
