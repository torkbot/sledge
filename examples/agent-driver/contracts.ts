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

/**
 * pi-ai model descriptor persisted in durable agent context.
 *
 * Mirrors the core fields exposed by pi-ai model instances.
 */
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

export const AgentContextSchema = Type.Object({
  systemPrompt: Type.String(),
  model: PiAiModelConfigSchema,
  thinkingLevel: PiAiThinkingLevelSchema,
  tools: Type.Array(Type.String()),
  messages: Type.Array(AgentMessageSchema),
});

export type AgentContext = Static<typeof AgentContextSchema>;

export const AgentContextInitializedEventSchema = Type.Object({
  kind: Type.Literal("context.initialized"),
  agentId: Type.String(),
  branchId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.Null(),
  context: AgentContextSchema,
});

export type AgentContextInitializedEvent = Static<
  typeof AgentContextInitializedEventSchema
>;

export const AgentTurnStateUpdatedEventSchema = Type.Object({
  kind: Type.Literal("turn.state.updated"),
  agentId: Type.String(),
  branchId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  phase: Type.Union([
    Type.Literal("idle"),
    Type.Literal("model_running"),
    Type.Literal("tools_running"),
  ]),
});

export type AgentTurnStateUpdatedEvent = Static<
  typeof AgentTurnStateUpdatedEventSchema
>;

export const AgentEventSchema = Type.Union([
  AgentContextInitializedEventSchema,
  AgentTurnStateUpdatedEventSchema,
]);

export type AgentEvent = Static<typeof AgentEventSchema>;

export const UserInputRecordedEventSchema = Type.Object({
  kind: Type.Literal("input.recorded"),
  agentId: Type.String(),
  branchId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  timing: AgentInputTimingSchema,
  clientInputId: Type.String(),
  content: Type.String(),
  forkFromNodeId: Type.Optional(Type.String()),
});

export type UserInputRecordedEvent = Static<
  typeof UserInputRecordedEventSchema
>;

export const UserEventSchema = Type.Union([UserInputRecordedEventSchema]);

export type UserEvent = Static<typeof UserEventSchema>;

export const AgentDriverEventSchemas = {
  "agent.event": AgentEventSchema,
  "user.event": UserEventSchema,
} as const;

export type AgentDriverEvents = typeof AgentDriverEventSchemas;

export const AgentBranchHeadQueryParamsSchema = Type.Object({
  agentId: Type.String(),
  branchId: Type.String(),
});

export const AgentBranchHeadQueryResultSchema = Type.Union([
  Type.Null(),
  Type.Object({
    agentId: Type.String(),
    branchId: Type.String(),
    nodeId: Type.String(),
    parentNodeId: Type.Union([Type.Null(), Type.String()]),
    eventName: Type.Union([
      Type.Literal("agent.event"),
      Type.Literal("user.event"),
    ]),
    eventKind: Type.String(),
  }),
]);

export const AgentBranchHeadQuerySchema: QuerySchema<
  typeof AgentBranchHeadQueryParamsSchema,
  typeof AgentBranchHeadQueryResultSchema
> = {
  params: AgentBranchHeadQueryParamsSchema,
  result: AgentBranchHeadQueryResultSchema,
};

export const AgentPendingInputsQueryParamsSchema = Type.Object({
  agentId: Type.String(),
  branchId: Type.String(),
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
    branchId: Type.String(),
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

export const AgentDriverQuerySchemas = {
  "agent.branch.head": AgentBranchHeadQuerySchema,
  "agent.pending-inputs": AgentPendingInputsQuerySchema,
  "agent.node.children": AgentNodeChildrenQuerySchema,
} as const;

export type AgentDriverQueries = typeof AgentDriverQuerySchemas;
