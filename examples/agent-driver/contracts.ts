import { Type, type Static } from "@sinclair/typebox";

import type { QuerySchema } from "../../src/ledger/ledger.ts";

export const AgentInputTimingSchema = Type.Union([
  Type.Literal("next_opportunity"),
  Type.Literal("when_idle"),
]);

export type AgentInputTiming = Static<typeof AgentInputTimingSchema>;

export const PiAiThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

export const PiAiModelConfigSchema = Type.Object({
  api: Type.String(),
  provider: Type.String(),
  id: Type.String(),
});

export type PiAiModelConfig = Static<typeof PiAiModelConfigSchema>;

export const AgentMessageSchema = Type.Object({
  role: Type.Union([
    Type.Literal("system"),
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("toolResult"),
  ]),
  content: Type.Unknown(),
});

export type AgentMessage = Static<typeof AgentMessageSchema>;

export const AgentToolDefinitionSchema = Type.Object({
  name: Type.String(),
  label: Type.String(),
  description: Type.String(),
  inputSchemaJson: Type.String(),
});

export type AgentToolDefinition = Static<typeof AgentToolDefinitionSchema>;

export const AgentContextSchema = Type.Object({
  systemPrompt: Type.String(),
  model: PiAiModelConfigSchema,
  thinkingLevel: PiAiThinkingLevelSchema,
  tools: Type.Array(AgentToolDefinitionSchema),
  messages: Type.Array(AgentMessageSchema),
});

export type AgentContext = Static<typeof AgentContextSchema>;

export const AgentContextInitializedEventSchema = Type.Object({
  kind: Type.Literal("context.initialized"),
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.Null(),
  context: AgentContextSchema,
});

export const AgentTurnStateUpdatedEventSchema = Type.Object({
  kind: Type.Literal("turn.state.updated"),
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  phase: Type.Union([
    Type.Literal("idle"),
    Type.Literal("model_running"),
    Type.Literal("tools_running"),
  ]),
});

export const AgentEventSchema = Type.Union([
  AgentContextInitializedEventSchema,
  AgentTurnStateUpdatedEventSchema,
]);

export const UserInputRecordedEventSchema = Type.Object({
  kind: Type.Literal("input.recorded"),
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  timing: AgentInputTimingSchema,
  idempotencyKey: Type.String(),
  content: Type.String(),
  forkFromNodeId: Type.Optional(Type.String()),
});

export type UserInputRecordedEvent = Static<
  typeof UserInputRecordedEventSchema
>;

export const UserEventSchema = Type.Union([UserInputRecordedEventSchema]);

export const AgentDriverEventSchemas = {
  "agent.event": AgentEventSchema,
  "user.event": UserEventSchema,
} as const;

export type AgentDriverEvents = typeof AgentDriverEventSchemas;

export const AgentHeadQueryParamsSchema = Type.Object({
  agentId: Type.String(),
});

export const AgentHeadQueryResultSchema = Type.Union([
  Type.Null(),
  Type.Object({
    agentId: Type.String(),
    nodeId: Type.String(),
    parentNodeId: Type.Union([Type.Null(), Type.String()]),
    eventName: Type.Union([
      Type.Literal("agent.event"),
      Type.Literal("user.event"),
    ]),
    eventKind: Type.String(),
  }),
]);

export const AgentHeadQuerySchema: QuerySchema<
  typeof AgentHeadQueryParamsSchema,
  typeof AgentHeadQueryResultSchema
> = {
  params: AgentHeadQueryParamsSchema,
  result: AgentHeadQueryResultSchema,
};

export const AgentPendingInputsQueryParamsSchema = Type.Object({
  agentId: Type.String(),
});

export const AgentPendingInputsQueryResultSchema = Type.Object({
  nextOpportunity: Type.Array(UserInputRecordedEventSchema),
  whenIdle: Type.Array(UserInputRecordedEventSchema),
});

export const AgentPendingInputsQuerySchema: QuerySchema<
  typeof AgentPendingInputsQueryParamsSchema,
  typeof AgentPendingInputsQueryResultSchema
> = {
  params: AgentPendingInputsQueryParamsSchema,
  result: AgentPendingInputsQueryResultSchema,
};

export const AgentNodeChildrenQueryParamsSchema = Type.Object({
  agentId: Type.String(),
  nodeId: Type.String(),
});

export const AgentNodeChildrenQueryResultSchema = Type.Array(
  Type.Object({
    nodeId: Type.String(),
    eventName: Type.Union([
      Type.Literal("agent.event"),
      Type.Literal("user.event"),
    ]),
    eventKind: Type.String(),
  }),
);

export const AgentNodeChildrenQuerySchema: QuerySchema<
  typeof AgentNodeChildrenQueryParamsSchema,
  typeof AgentNodeChildrenQueryResultSchema
> = {
  params: AgentNodeChildrenQueryParamsSchema,
  result: AgentNodeChildrenQueryResultSchema,
};

export const AgentMessagesQueryParamsSchema = Type.Object({
  agentId: Type.String(),
});

export const AgentMessagesQueryResultSchema = Type.Object({
  headNodeId: Type.String(),
  messages: Type.Array(AgentMessageSchema),
});

export const AgentMessagesQuerySchema: QuerySchema<
  typeof AgentMessagesQueryParamsSchema,
  typeof AgentMessagesQueryResultSchema
> = {
  params: AgentMessagesQueryParamsSchema,
  result: AgentMessagesQueryResultSchema,
};

export const AgentNodeExistsQueryParamsSchema = Type.Object({
  agentId: Type.String(),
  nodeId: Type.String(),
});

export const AgentNodeExistsQueryResultSchema = Type.Boolean();

export const AgentNodeExistsQuerySchema: QuerySchema<
  typeof AgentNodeExistsQueryParamsSchema,
  typeof AgentNodeExistsQueryResultSchema
> = {
  params: AgentNodeExistsQueryParamsSchema,
  result: AgentNodeExistsQueryResultSchema,
};

export const AgentDriverQuerySchemas = {
  "agent.head": AgentHeadQuerySchema,
  "agent.pending-inputs": AgentPendingInputsQuerySchema,
  "agent.node.children": AgentNodeChildrenQuerySchema,
  "agent.messages": AgentMessagesQuerySchema,
  "agent.node.exists": AgentNodeExistsQuerySchema,
} as const;

export type AgentDriverQueries = typeof AgentDriverQuerySchemas;
