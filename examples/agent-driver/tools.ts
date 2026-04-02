import { type Static, type TSchema } from "@sinclair/typebox";

import type { AgentContext, AgentToolDefinition } from "./contracts.ts";

export type RegisteredAgentTool<TParameters extends TSchema = TSchema> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parametersSchema: TParameters;
};

export type AgentToolExecuteResult = {
  readonly content: unknown;
};

export type BoundAgentTool<TParameters extends TSchema = TSchema> =
  RegisteredAgentTool<TParameters> & {
    execute(input: {
      readonly params: Static<TParameters>;
      readonly signal: AbortSignal;
    }): Promise<AgentToolExecuteResult>;
  };

export function registerAgentTool<const TParameters extends TSchema>(input: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parametersSchema: TParameters;
}): RegisteredAgentTool<TParameters> {
  return input;
}

export function bindAgentTool<const TParameters extends TSchema>(input: {
  readonly tool: RegisteredAgentTool<TParameters>;
  readonly execute: (input: {
    readonly params: Static<TParameters>;
    readonly signal: AbortSignal;
  }) => Promise<AgentToolExecuteResult>;
}): BoundAgentTool<TParameters> {
  return {
    ...input.tool,
    execute: input.execute,
  };
}

export function toolRegistrationToDefinition(
  tool: RegisteredAgentTool,
): AgentToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
  };
}

export function appendRegisteredToolsToSystemPrompt(input: {
  readonly systemPrompt: string;
  readonly tools: readonly RegisteredAgentTool[];
}): string {
  if (input.tools.length === 0) {
    return input.systemPrompt;
  }

  const lines: string[] = [input.systemPrompt, "", "Available tools:"];

  for (const tool of input.tools) {
    lines.push(`- ${tool.name} (${tool.label}): ${tool.description}`);
    lines.push(`  parametersSchema: ${JSON.stringify(tool.parametersSchema)}`);
  }

  return lines.join("\n");
}

export function createAgentContextWithRegisteredTools(input: {
  readonly systemPrompt: string;
  readonly model: AgentContext["model"];
  readonly thinkingLevel: AgentContext["thinkingLevel"];
  readonly messages: AgentContext["messages"];
  readonly tools: readonly RegisteredAgentTool[];
}): AgentContext {
  return {
    systemPrompt: appendRegisteredToolsToSystemPrompt({
      systemPrompt: input.systemPrompt,
      tools: input.tools,
    }),
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    tools: input.tools.map(toolRegistrationToDefinition),
    messages: input.messages,
  };
}

export function createToolBindingResolver(input: {
  readonly boundTools: readonly BoundAgentTool[];
}) {
  const boundByName = new Map<string, BoundAgentTool>();

  for (const tool of input.boundTools) {
    boundByName.set(tool.name, tool);
  }

  return (toolName: string): BoundAgentTool | null => {
    return boundByName.get(toolName) ?? null;
  };
}

export async function executeToolOrUnboundError(input: {
  readonly resolver: ReturnType<typeof createToolBindingResolver>;
  readonly toolName: string;
  readonly params: unknown;
  readonly signal: AbortSignal;
}): Promise<AgentToolExecuteResult> {
  const tool = input.resolver(input.toolName);

  if (tool === null) {
    return {
      content: `tool not bound at runtime: ${input.toolName}`,
    };
  }

  return await tool.execute({
    params: input.params,
    signal: input.signal,
  });
}
