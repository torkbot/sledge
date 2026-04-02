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

export const AgentInputBatchClaimedEventSchema = Type.Object({
  kind: Type.Literal("input.batch.claimed"),
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  turnId: Type.String(),
  inputNodeIds: Type.Array(Type.String()),
});

export const AgentTurnModelRequestedEventSchema = Type.Object({
  kind: Type.Literal("turn.model.requested"),
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  turnId: Type.String(),
});

export const AgentEventSchema = Type.Union([
  AgentContextInitializedEventSchema,
  AgentTurnStateUpdatedEventSchema,
  AgentInputBatchClaimedEventSchema,
  AgentTurnModelRequestedEventSchema,
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

export const AGENT_EVENT_NAME = "agent.event" as const;
export const USER_EVENT_NAME = "user.event" as const;

export const AgentDriverEventSchemas = {
  [AGENT_EVENT_NAME]: AgentEventSchema,
  [USER_EVENT_NAME]: UserEventSchema,
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

export const AgentRuntimeStateQueryParamsSchema = Type.Object({
  agentId: Type.String(),
});

export const AgentRuntimeStateQueryResultSchema = Type.Object({
  exists: Type.Boolean(),
  phase: Type.Union([
    Type.Literal("idle"),
    Type.Literal("model_running"),
    Type.Literal("tools_running"),
  ]),
  headNodeId: Type.Union([Type.Null(), Type.String()]),
  nextOpportunityCount: Type.Number(),
  whenIdleCount: Type.Number(),
  hasMessages: Type.Boolean(),
});

export const AgentRuntimeStateQuerySchema: QuerySchema<
  typeof AgentRuntimeStateQueryParamsSchema,
  typeof AgentRuntimeStateQueryResultSchema
> = {
  params: AgentRuntimeStateQueryParamsSchema,
  result: AgentRuntimeStateQueryResultSchema,
};

export const AGENT_HEAD_QUERY_NAME = "agent.head" as const;
export const AGENT_PENDING_INPUTS_QUERY_NAME = "agent.pending-inputs" as const;
export const AGENT_NODE_CHILDREN_QUERY_NAME = "agent.node.children" as const;
export const AGENT_MESSAGES_QUERY_NAME = "agent.messages" as const;
export const AGENT_NODE_EXISTS_QUERY_NAME = "agent.node.exists" as const;
export const AGENT_RUNTIME_STATE_QUERY_NAME = "agent.runtime-state" as const;

export const AgentDriverQuerySchemas = {
  [AGENT_HEAD_QUERY_NAME]: AgentHeadQuerySchema,
  [AGENT_PENDING_INPUTS_QUERY_NAME]: AgentPendingInputsQuerySchema,
  [AGENT_NODE_CHILDREN_QUERY_NAME]: AgentNodeChildrenQuerySchema,
  [AGENT_MESSAGES_QUERY_NAME]: AgentMessagesQuerySchema,
  [AGENT_NODE_EXISTS_QUERY_NAME]: AgentNodeExistsQuerySchema,
  [AGENT_RUNTIME_STATE_QUERY_NAME]: AgentRuntimeStateQuerySchema,
} as const;

export type AgentDriverQueries = typeof AgentDriverQuerySchemas;
