import type Database from "better-sqlite3";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createBetterSqliteLedger } from "../../src/ledger/better-sqlite3-ledger.ts";
import {
  defineLedgerModel,
  type LedgerTiming,
} from "../../src/ledger/ledger.ts";
import type {
  LedgerCursor,
  LedgerStreamEvent,
} from "../../src/ledger/ledger.ts";
import { createAgentDriver, type AgentDriver } from "./api.ts";
import { executeAgentAdvance } from "./agent-advance.ts";
import {
  AGENT_EVENT_NAME,
  AGENT_HEAD_QUERY_NAME,
  AGENT_MESSAGES_QUERY_NAME,
  AGENT_NODE_CHILDREN_QUERY_NAME,
  AGENT_NODE_EXISTS_QUERY_NAME,
  AGENT_PENDING_INPUTS_QUERY_NAME,
  AGENT_RUNTIME_STATE_QUERY_NAME,
  AGENT_TURN_QUERY_NAME,
  AgentDriverEventSchemas,
  AgentDriverQuerySchemas,
  USER_EVENT_NAME,
  UserInputRecordedEventSchema,
  type AgentDriverEvents,
} from "./contracts.ts";

/**
 * Minimal pi-ai contract we expect to integrate with from the orchestrator.
 */
export interface PiAiGateway {
  runTurn(input: {
    readonly agentId: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly outputText: string;
  }>;
}

export interface AgentToolHandlers {
  readonly [toolName: string]: (input: {
    readonly params: unknown;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly content: unknown;
  }>;
}

/**
 * Input dependencies for opening the agent runtime.
 *
 * Operational convention: run one active writer runtime per database.
 * This example does not enforce writer leasing.
 */
export type OpenAgentDriverRuntimeInput = {
  readonly database: Database.Database;
  readonly timing: LedgerTiming;
  readonly llm: PiAiGateway;
  readonly toolHandlers: AgentToolHandlers;
};

export type AgentDriverRuntime = AsyncDisposable & {
  readonly driver: AgentDriver;
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
  resumeEvents(input: {
    readonly cursor: LedgerCursor;
    readonly signal: AbortSignal;
  }): AsyncIterable<LedgerStreamEvent<AgentDriverEvents>>;
  close(): Promise<void>;
};

const AgentNodeProjectionSchema = Type.Object({
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.Union([Type.Null(), Type.String()]),
  eventName: Type.Union([
    Type.Literal("agent.event"),
    Type.Literal("user.event"),
  ]),
  eventKind: Type.String(),
  payloadJson: Type.String(),
});

const AgentHeadProjectionSchema = Type.Object({
  agentId: Type.String(),
  nodeId: Type.String(),
  parentNodeId: Type.Union([Type.Null(), Type.String()]),
  eventName: Type.Union([
    Type.Literal("agent.event"),
    Type.Literal("user.event"),
  ]),
  eventKind: Type.String(),
});

const AgentChildProjectionSchema = Type.Object({
  agentId: Type.String(),
  parentNodeId: Type.String(),
  nodeId: Type.String(),
  eventName: Type.Union([
    Type.Literal("agent.event"),
    Type.Literal("user.event"),
  ]),
  eventKind: Type.String(),
});

const AgentMessagesProjectionSchema = Type.Object({
  agentId: Type.String(),
  headNodeId: Type.String(),
  messagesJson: Type.String(),
});

const AgentRuntimeStateProjectionSchema = Type.Object({
  agentId: Type.String(),
  phase: Type.Union([
    Type.Null(),
    Type.Literal("idle"),
    Type.Literal("model_running"),
    Type.Literal("tools_running"),
  ]),
  hasMessages: Type.Union([Type.Null(), Type.Boolean()]),
});

const DeletePendingInputsProjectionSchema = Type.Object({
  agentId: Type.String(),
  inputNodeIds: Type.Array(Type.String()),
});

const TurnRequestedProjectionSchema = Type.Object({
  agentId: Type.String(),
  turnId: Type.String(),
  requestNodeId: Type.String(),
});

const TurnCompletedProjectionSchema = Type.Object({
  agentId: Type.String(),
  turnId: Type.String(),
  completionNodeId: Type.String(),
  outputText: Type.String(),
});

const TurnFailedProjectionSchema = Type.Object({
  agentId: Type.String(),
  turnId: Type.String(),
  failureNodeId: Type.String(),
  error: Type.String(),
});

const AppendAssistantMessageProjectionSchema = Type.Object({
  agentId: Type.String(),
  headNodeId: Type.String(),
  outputText: Type.String(),
});

export const AGENT_ADVANCE_QUEUE_NAME = "agent.advance" as const;
export const AGENT_RUN_MODEL_QUEUE_NAME = "agent.run-model" as const;

const AgentAdvanceQueueSchema = Type.Object({
  agentId: Type.String(),
});

const AgentRunModelQueueSchema = Type.Object({
  agentId: Type.String(),
  turnId: Type.String(),
});

const WRITE_NODE_INDEXER_NAME = "writeNode" as const;
const UPSERT_HEAD_INDEXER_NAME = "upsertHead" as const;
const WRITE_CHILD_INDEXER_NAME = "writeChild" as const;
const WRITE_PENDING_INPUT_INDEXER_NAME = "writePendingInput" as const;
const DELETE_PENDING_INPUTS_INDEXER_NAME = "deletePendingInputs" as const;
const UPSERT_TURN_REQUESTED_INDEXER_NAME = "upsertTurnRequested" as const;
const MARK_TURN_COMPLETED_INDEXER_NAME = "markTurnCompleted" as const;
const MARK_TURN_FAILED_INDEXER_NAME = "markTurnFailed" as const;
const UPSERT_MESSAGES_INDEXER_NAME = "upsertMessages" as const;
const APPEND_ASSISTANT_MESSAGE_INDEXER_NAME = "appendAssistantMessage" as const;
const UPSERT_RUNTIME_STATE_INDEXER_NAME = "upsertRuntimeState" as const;

const AgentMessagesArraySchema = Type.Array(
  Type.Object({
    role: Type.Union([
      Type.Literal("system"),
      Type.Literal("user"),
      Type.Literal("assistant"),
      Type.Literal("toolResult"),
    ]),
    content: Type.Unknown(),
  }),
);

const AgentHeadRowSchema = Type.Object({
  agent_id: Type.String(),
  node_id: Type.String(),
  parent_node_id: Type.Union([Type.Null(), Type.String()]),
  event_name: Type.Union([
    Type.Literal(AGENT_EVENT_NAME),
    Type.Literal(USER_EVENT_NAME),
  ]),
  event_kind: Type.String(),
});

const PendingInputRowSchema = Type.Object({
  node_id: Type.String(),
  parent_node_id: Type.String(),
  timing: Type.Union([
    Type.Literal("next_opportunity"),
    Type.Literal("when_idle"),
  ]),
  idempotency_key: Type.String(),
  content: Type.String(),
  fork_from_node_id: Type.Union([Type.Null(), Type.String()]),
});

const AgentChildRowSchema = Type.Object({
  node_id: Type.String(),
  event_name: Type.Union([
    Type.Literal(AGENT_EVENT_NAME),
    Type.Literal(USER_EVENT_NAME),
  ]),
  event_kind: Type.String(),
});

const AgentMessagesRowSchema = Type.Object({
  head_node_id: Type.String(),
  messages_json: Type.String(),
});

const AgentNodeExistsRowSchema = Type.Object({
  node_id: Type.String(),
});

const AgentRuntimeStateRowSchema = Type.Object({
  head_node_id: Type.Union([Type.Null(), Type.String()]),
  phase: Type.Union([
    Type.Literal("idle"),
    Type.Literal("model_running"),
    Type.Literal("tools_running"),
  ]),
  has_messages: Type.Integer({ minimum: 0, maximum: 1 }),
  next_opportunity_count: Type.Number(),
  when_idle_count: Type.Number(),
});

const AgentTurnRowSchema = Type.Object({
  agent_id: Type.String(),
  turn_id: Type.String(),
  request_node_id: Type.String(),
  status: Type.Union([
    Type.Literal("requested"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  last_node_id: Type.String(),
  output_text: Type.Union([Type.Null(), Type.String()]),
  error_text: Type.Union([Type.Null(), Type.String()]),
});

function decodeRow<const TRowSchema extends TSchema>(
  schema: TRowSchema,
  row: unknown,
): Static<TRowSchema> {
  return Value.Decode(schema, row);
}

function decodeJsonWithSchema<const TJsonSchema extends TSchema>(
  value: string,
  schema: TJsonSchema,
): Static<TJsonSchema> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new Error("invalid JSON payload", {
      cause: error,
    });
  }

  return Value.Decode(schema, parsed);
}

function summarizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

function buildModelPrompt(messages: readonly { content: unknown }[]): string {
  if (messages.length === 0) {
    return "";
  }

  return messages
    .map((message) => summarizeMessageContent(message.content))
    .join("\n\n");
}

export function openAgentDriverRuntime(
  input: OpenAgentDriverRuntimeInput,
): AgentDriverRuntime {
  input.database.exec(`
    CREATE TABLE IF NOT EXISTS agent_nodes (
      agent_id TEXT NOT NULL,
      node_id TEXT PRIMARY KEY,
      parent_node_id TEXT,
      event_name TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_heads (
      agent_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      parent_node_id TEXT,
      event_name TEXT NOT NULL,
      event_kind TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_children (
      agent_id TEXT NOT NULL,
      parent_node_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      PRIMARY KEY (agent_id, parent_node_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS agent_pending_inputs (
      agent_id TEXT NOT NULL,
      node_id TEXT PRIMARY KEY,
      parent_node_id TEXT NOT NULL,
      timing TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      content TEXT NOT NULL,
      fork_from_node_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      agent_id TEXT PRIMARY KEY,
      head_node_id TEXT NOT NULL,
      messages_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runtime_state (
      agent_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      has_messages INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_turns (
      agent_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      request_node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      last_node_id TEXT NOT NULL,
      output_text TEXT,
      error_text TEXT,
      PRIMARY KEY (agent_id, turn_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_nodes_by_agent ON agent_nodes(agent_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_agent_pending_inputs_by_agent ON agent_pending_inputs(agent_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_agent_children_by_parent ON agent_children(agent_id, parent_node_id, node_id);
  `);

  const model = defineLedgerModel({
    events: AgentDriverEventSchemas,
    queues: {
      [AGENT_ADVANCE_QUEUE_NAME]: AgentAdvanceQueueSchema,
      [AGENT_RUN_MODEL_QUEUE_NAME]: AgentRunModelQueueSchema,
    },
    indexers: {
      [WRITE_NODE_INDEXER_NAME]: AgentNodeProjectionSchema,
      [UPSERT_HEAD_INDEXER_NAME]: AgentHeadProjectionSchema,
      [WRITE_CHILD_INDEXER_NAME]: AgentChildProjectionSchema,
      [WRITE_PENDING_INPUT_INDEXER_NAME]: UserInputRecordedEventSchema,
      [DELETE_PENDING_INPUTS_INDEXER_NAME]: DeletePendingInputsProjectionSchema,
      [UPSERT_TURN_REQUESTED_INDEXER_NAME]: TurnRequestedProjectionSchema,
      [MARK_TURN_COMPLETED_INDEXER_NAME]: TurnCompletedProjectionSchema,
      [MARK_TURN_FAILED_INDEXER_NAME]: TurnFailedProjectionSchema,
      [UPSERT_MESSAGES_INDEXER_NAME]: AgentMessagesProjectionSchema,
      [APPEND_ASSISTANT_MESSAGE_INDEXER_NAME]:
        AppendAssistantMessageProjectionSchema,
      [UPSERT_RUNTIME_STATE_INDEXER_NAME]: AgentRuntimeStateProjectionSchema,
    },
    queries: AgentDriverQuerySchemas,
    register(builder) {
      builder.project(AGENT_EVENT_NAME, async ({ event, actions }) => {
        await actions.index(WRITE_NODE_INDEXER_NAME, {
          agentId: event.payload.agentId,
          nodeId: event.payload.nodeId,
          parentNodeId: event.payload.parentNodeId,
          eventName: AGENT_EVENT_NAME,
          eventKind: event.payload.kind,
          payloadJson: JSON.stringify(event.payload),
        });

        await actions.index(UPSERT_HEAD_INDEXER_NAME, {
          agentId: event.payload.agentId,
          nodeId: event.payload.nodeId,
          parentNodeId: event.payload.parentNodeId,
          eventName: AGENT_EVENT_NAME,
          eventKind: event.payload.kind,
        });

        if (event.payload.parentNodeId !== null) {
          await actions.index(WRITE_CHILD_INDEXER_NAME, {
            agentId: event.payload.agentId,
            parentNodeId: event.payload.parentNodeId,
            nodeId: event.payload.nodeId,
            eventName: AGENT_EVENT_NAME,
            eventKind: event.payload.kind,
          });
        }

        if (event.payload.kind === "context.initialized") {
          await actions.index(UPSERT_MESSAGES_INDEXER_NAME, {
            agentId: event.payload.agentId,
            headNodeId: event.payload.nodeId,
            messagesJson: JSON.stringify(event.payload.context.messages),
          });

          await actions.index(UPSERT_RUNTIME_STATE_INDEXER_NAME, {
            agentId: event.payload.agentId,
            phase: "idle",
            hasMessages: event.payload.context.messages.length > 0,
          });
        }

        if (event.payload.kind === "turn.state.updated") {
          await actions.index(UPSERT_RUNTIME_STATE_INDEXER_NAME, {
            agentId: event.payload.agentId,
            phase: event.payload.phase,
            hasMessages: null,
          });
        }

        if (event.payload.kind === "input.batch.claimed") {
          await actions.index(DELETE_PENDING_INPUTS_INDEXER_NAME, {
            agentId: event.payload.agentId,
            inputNodeIds: event.payload.inputNodeIds,
          });
        }

        if (event.payload.kind === "turn.model.requested") {
          await actions.index(UPSERT_TURN_REQUESTED_INDEXER_NAME, {
            agentId: event.payload.agentId,
            turnId: event.payload.turnId,
            requestNodeId: event.payload.nodeId,
          });
        }

        if (event.payload.kind === "turn.model.completed") {
          await actions.index(MARK_TURN_COMPLETED_INDEXER_NAME, {
            agentId: event.payload.agentId,
            turnId: event.payload.turnId,
            completionNodeId: event.payload.nodeId,
            outputText: event.payload.outputText,
          });

          await actions.index(APPEND_ASSISTANT_MESSAGE_INDEXER_NAME, {
            agentId: event.payload.agentId,
            headNodeId: event.payload.nodeId,
            outputText: event.payload.outputText,
          });

          await actions.index(UPSERT_RUNTIME_STATE_INDEXER_NAME, {
            agentId: event.payload.agentId,
            phase: null,
            hasMessages: true,
          });
        }

        if (event.payload.kind === "turn.model.failed") {
          await actions.index(MARK_TURN_FAILED_INDEXER_NAME, {
            agentId: event.payload.agentId,
            turnId: event.payload.turnId,
            failureNodeId: event.payload.nodeId,
            error: event.payload.error,
          });
        }
      });

      builder.project(USER_EVENT_NAME, async ({ event, actions }) => {
        await actions.index(WRITE_NODE_INDEXER_NAME, {
          agentId: event.payload.agentId,
          nodeId: event.payload.nodeId,
          parentNodeId: event.payload.parentNodeId,
          eventName: USER_EVENT_NAME,
          eventKind: event.payload.kind,
          payloadJson: JSON.stringify(event.payload),
        });

        await actions.index(UPSERT_HEAD_INDEXER_NAME, {
          agentId: event.payload.agentId,
          nodeId: event.payload.nodeId,
          parentNodeId: event.payload.parentNodeId,
          eventName: USER_EVENT_NAME,
          eventKind: event.payload.kind,
        });

        await actions.index(WRITE_CHILD_INDEXER_NAME, {
          agentId: event.payload.agentId,
          parentNodeId: event.payload.parentNodeId,
          nodeId: event.payload.nodeId,
          eventName: USER_EVENT_NAME,
          eventKind: event.payload.kind,
        });

        await actions.index(WRITE_PENDING_INPUT_INDEXER_NAME, event.payload);
      });

      builder.materialize(AGENT_EVENT_NAME, ({ event, actions }) => {
        actions.enqueue(AGENT_ADVANCE_QUEUE_NAME, {
          agentId: event.payload.agentId,
        });

        if (event.payload.kind === "turn.model.requested") {
          actions.enqueue(AGENT_RUN_MODEL_QUEUE_NAME, {
            agentId: event.payload.agentId,
            turnId: event.payload.turnId,
          });
        }
      });

      builder.materialize(USER_EVENT_NAME, ({ event, actions }) => {
        actions.enqueue(AGENT_ADVANCE_QUEUE_NAME, {
          agentId: event.payload.agentId,
        });
      });

      builder.handle(AGENT_ADVANCE_QUEUE_NAME, async ({ work, actions }) => {
        const state = await actions.query(AGENT_RUNTIME_STATE_QUERY_NAME, {
          agentId: work.payload.agentId,
        });

        const execution = executeAgentAdvance({
          agentId: work.payload.agentId,
          workId: work.workId,
          state,
        });

        for (const effect of execution.effects) {
          actions.emit(effect.eventName, effect.payload, {
            dedupeKey: effect.dedupeKey,
          });
        }

        return execution.outcome;
      });

      builder.handle(
        AGENT_RUN_MODEL_QUEUE_NAME,
        async ({ work, lease, actions }) => {
          const runtimeState = await actions.query(
            AGENT_RUNTIME_STATE_QUERY_NAME,
            {
              agentId: work.payload.agentId,
            },
          );

          if (!runtimeState.exists) {
            return {
              outcome: "dead_letter",
              error: `model run requested for unknown agent: ${work.payload.agentId}`,
            } as const;
          }

          if (runtimeState.phase !== "model_running") {
            // Stale delivery or already transitioned; safe no-op.
            return {
              outcome: "ack",
            } as const;
          }

          const turn = await actions.query(AGENT_TURN_QUERY_NAME, {
            agentId: work.payload.agentId,
            turnId: work.payload.turnId,
          });

          if (turn === null) {
            return {
              outcome: "dead_letter",
              error: `model run requested for missing turn: ${work.payload.agentId}/${work.payload.turnId}`,
            } as const;
          }

          if (turn.status === "completed") {
            return {
              outcome: "ack",
            } as const;
          }

          if (turn.status === "failed") {
            return {
              outcome: "dead_letter",
              error: `model run requested for failed turn: ${work.payload.agentId}/${work.payload.turnId}`,
            } as const;
          }

          const transcript = await actions.query(AGENT_MESSAGES_QUERY_NAME, {
            agentId: work.payload.agentId,
          });

          const prompt = buildModelPrompt(transcript.messages);

          try {
            await using hold = lease.hold();

            const completion = await input.llm.runTurn({
              agentId: work.payload.agentId,
              prompt,
              signal: hold.signal,
            });

            const completionNodeId = `agent-event/${work.workId}/model-completed`;

            actions.emit(
              AGENT_EVENT_NAME,
              {
                kind: "turn.model.completed",
                agentId: work.payload.agentId,
                nodeId: completionNodeId,
                parentNodeId: turn.requestNodeId,
                turnId: work.payload.turnId,
                outputText: completion.outputText,
              },
              {
                dedupeKey: `agent:${work.payload.agentId}:run-model:${work.workId}:completed`,
              },
            );

            return {
              outcome: "ack",
            } as const;
          } catch (error: unknown) {
            const message =
              error instanceof Error
                ? error.message
                : "unknown error while running model turn";

            const failureNodeId = `agent-event/${work.workId}/model-failed`;

            actions.emit(
              AGENT_EVENT_NAME,
              {
                kind: "turn.model.failed",
                agentId: work.payload.agentId,
                nodeId: failureNodeId,
                parentNodeId: turn.requestNodeId,
                turnId: work.payload.turnId,
                error: message,
              },
              {
                dedupeKey: `agent:${work.payload.agentId}:run-model:${work.workId}:failed`,
              },
            );

            return {
              outcome: "retry",
              error: message,
            } as const;
          }
        },
      );
    },
  });

  const ledger = createBetterSqliteLedger({
    database: input.database,
    boundModel: model.bind({
      indexers: {
        writeNode: async (row) => {
          input.database
            .prepare(
              `INSERT OR REPLACE INTO agent_nodes
                 (agent_id, node_id, parent_node_id, event_name, event_kind, payload_json)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.agentId,
              row.nodeId,
              row.parentNodeId,
              row.eventName,
              row.eventKind,
              row.payloadJson,
            );
        },
        upsertHead: async (row) => {
          input.database
            .prepare(
              `INSERT INTO agent_heads
                 (agent_id, node_id, parent_node_id, event_name, event_kind)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(agent_id)
               DO UPDATE SET
                 node_id = excluded.node_id,
                 parent_node_id = excluded.parent_node_id,
                 event_name = excluded.event_name,
                 event_kind = excluded.event_kind`,
            )
            .run(
              row.agentId,
              row.nodeId,
              row.parentNodeId,
              row.eventName,
              row.eventKind,
            );
        },
        writeChild: async (row) => {
          input.database
            .prepare(
              `INSERT OR REPLACE INTO agent_children
                 (agent_id, parent_node_id, node_id, event_name, event_kind)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              row.agentId,
              row.parentNodeId,
              row.nodeId,
              row.eventName,
              row.eventKind,
            );
        },
        writePendingInput: async (payload) => {
          input.database
            .prepare(
              `INSERT OR REPLACE INTO agent_pending_inputs
                 (agent_id, node_id, parent_node_id, timing, idempotency_key, content, fork_from_node_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              payload.agentId,
              payload.nodeId,
              payload.parentNodeId,
              payload.timing,
              payload.idempotencyKey,
              payload.content,
              payload.forkFromNodeId ?? null,
            );
        },
        deletePendingInputs: async (row) => {
          const deleteByNodeId = input.database.prepare(
            `DELETE FROM agent_pending_inputs
             WHERE agent_id = ?
               AND node_id = ?`,
          );

          for (const inputNodeId of row.inputNodeIds) {
            deleteByNodeId.run(row.agentId, inputNodeId);
          }
        },
        upsertTurnRequested: async (row) => {
          input.database
            .prepare(
              `INSERT INTO agent_turns
                 (agent_id, turn_id, request_node_id, status, last_node_id, output_text, error_text)
               VALUES (?, ?, ?, 'requested', ?, NULL, NULL)
               ON CONFLICT(agent_id, turn_id)
               DO UPDATE SET
                 request_node_id = excluded.request_node_id,
                 status = 'requested',
                 last_node_id = excluded.last_node_id,
                 output_text = NULL,
                 error_text = NULL`,
            )
            .run(row.agentId, row.turnId, row.requestNodeId, row.requestNodeId);
        },
        markTurnCompleted: async (row) => {
          input.database
            .prepare(
              `UPDATE agent_turns
               SET status = 'completed',
                   last_node_id = ?,
                   output_text = ?,
                   error_text = NULL
               WHERE agent_id = ?
                 AND turn_id = ?`,
            )
            .run(row.completionNodeId, row.outputText, row.agentId, row.turnId);
        },
        markTurnFailed: async (row) => {
          input.database
            .prepare(
              `UPDATE agent_turns
               SET status = 'failed',
                   last_node_id = ?,
                   output_text = NULL,
                   error_text = ?
               WHERE agent_id = ?
                 AND turn_id = ?`,
            )
            .run(row.failureNodeId, row.error, row.agentId, row.turnId);
        },
        upsertMessages: async (row) => {
          input.database
            .prepare(
              `INSERT INTO agent_messages (agent_id, head_node_id, messages_json)
               VALUES (?, ?, ?)
               ON CONFLICT(agent_id)
               DO UPDATE SET
                 head_node_id = excluded.head_node_id,
                 messages_json = excluded.messages_json`,
            )
            .run(row.agentId, row.headNodeId, row.messagesJson);
        },
        appendAssistantMessage: async (row) => {
          const existing = input.database
            .prepare(
              `SELECT messages_json
               FROM agent_messages
               WHERE agent_id = ?`,
            )
            .get(row.agentId) as { messages_json: string } | undefined;

          const currentMessages =
            existing === undefined
              ? []
              : decodeJsonWithSchema(
                  existing.messages_json,
                  AgentMessagesArraySchema,
                );

          const nextMessages = [
            ...currentMessages,
            {
              role: "assistant",
              content: row.outputText,
            },
          ];

          input.database
            .prepare(
              `INSERT INTO agent_messages (agent_id, head_node_id, messages_json)
               VALUES (?, ?, ?)
               ON CONFLICT(agent_id)
               DO UPDATE SET
                 head_node_id = excluded.head_node_id,
                 messages_json = excluded.messages_json`,
            )
            .run(row.agentId, row.headNodeId, JSON.stringify(nextMessages));
        },
        upsertRuntimeState: async (row) => {
          input.database
            .prepare(
              `INSERT INTO agent_runtime_state (agent_id, phase, has_messages)
               VALUES (?, COALESCE(?, 'idle'), COALESCE(?, 0))
               ON CONFLICT(agent_id)
               DO UPDATE SET
                 phase = COALESCE(excluded.phase, agent_runtime_state.phase),
                 has_messages = COALESCE(
                   excluded.has_messages,
                   agent_runtime_state.has_messages
                 )`,
            )
            .run(
              row.agentId,
              row.phase,
              row.hasMessages === null ? null : row.hasMessages ? 1 : 0,
            );
        },
      },
      queries: {
        [AGENT_HEAD_QUERY_NAME]: async (params) => {
          const rawRow = input.database
            .prepare(
              `SELECT
                 agent_id,
                 node_id,
                 parent_node_id,
                 event_name,
                 event_kind
               FROM agent_heads
               WHERE agent_id = ?`,
            )
            .get(params.agentId);

          if (rawRow === undefined) {
            return null;
          }

          const row = decodeRow(AgentHeadRowSchema, rawRow);

          return Value.Decode(
            AgentDriverQuerySchemas[AGENT_HEAD_QUERY_NAME].result,
            {
              agentId: row.agent_id,
              nodeId: row.node_id,
              parentNodeId: row.parent_node_id,
              eventName: row.event_name,
              eventKind: row.event_kind,
            },
          );
        },
        [AGENT_PENDING_INPUTS_QUERY_NAME]: async (params) => {
          const rawRows = input.database
            .prepare(
              `SELECT
                 node_id,
                 parent_node_id,
                 timing,
                 idempotency_key,
                 content,
                 fork_from_node_id
               FROM agent_pending_inputs
               WHERE agent_id = ?
               ORDER BY rowid ASC`,
            )
            .all(params.agentId);

          const nextOpportunity: Static<typeof UserInputRecordedEventSchema>[] =
            [];
          const whenIdle: Static<typeof UserInputRecordedEventSchema>[] = [];

          for (const rawRow of rawRows) {
            const row = decodeRow(PendingInputRowSchema, rawRow);
            const item = Value.Decode(UserInputRecordedEventSchema, {
              kind: "input.recorded",
              agentId: params.agentId,
              nodeId: row.node_id,
              parentNodeId: row.parent_node_id,
              timing: row.timing,
              idempotencyKey: row.idempotency_key,
              content: row.content,
              forkFromNodeId: row.fork_from_node_id ?? undefined,
            });

            if (row.timing === "next_opportunity") {
              nextOpportunity.push(item);
            } else {
              whenIdle.push(item);
            }
          }

          return Value.Decode(
            AgentDriverQuerySchemas[AGENT_PENDING_INPUTS_QUERY_NAME].result,
            {
              nextOpportunity,
              whenIdle,
            },
          );
        },
        [AGENT_NODE_CHILDREN_QUERY_NAME]: async (params) => {
          const rawRows = input.database
            .prepare(
              `SELECT
                 node_id,
                 event_name,
                 event_kind
               FROM agent_children
               WHERE agent_id = ?
                 AND parent_node_id = ?
               ORDER BY rowid ASC`,
            )
            .all(params.agentId, params.nodeId);

          const children = rawRows.map((rawRow) => {
            const row = decodeRow(AgentChildRowSchema, rawRow);

            return {
              nodeId: row.node_id,
              eventName: row.event_name,
              eventKind: row.event_kind,
            };
          });

          return Value.Decode(
            AgentDriverQuerySchemas[AGENT_NODE_CHILDREN_QUERY_NAME].result,
            children,
          );
        },
        [AGENT_MESSAGES_QUERY_NAME]: async (params) => {
          const rawRow = input.database
            .prepare(
              `SELECT
                 head_node_id,
                 messages_json
               FROM agent_messages
               WHERE agent_id = ?`,
            )
            .get(params.agentId);

          if (rawRow === undefined) {
            throw new Error(`messages not found for agent: ${params.agentId}`);
          }

          const row = decodeRow(AgentMessagesRowSchema, rawRow);

          return Value.Decode(
            AgentDriverQuerySchemas[AGENT_MESSAGES_QUERY_NAME].result,
            {
              headNodeId: row.head_node_id,
              messages: decodeJsonWithSchema(
                row.messages_json,
                AgentMessagesArraySchema,
              ),
            },
          );
        },
        [AGENT_NODE_EXISTS_QUERY_NAME]: async (params) => {
          const rawRow = input.database
            .prepare(
              `SELECT node_id
               FROM agent_nodes
               WHERE agent_id = ?
                 AND node_id = ?
               LIMIT 1`,
            )
            .get(params.agentId, params.nodeId);

          if (rawRow === undefined) {
            return false;
          }

          decodeRow(AgentNodeExistsRowSchema, rawRow);

          return true;
        },
        [AGENT_RUNTIME_STATE_QUERY_NAME]: async (params) => {
          const rawRow = input.database
            .prepare(
              `SELECT
                 h.node_id AS head_node_id,
                 COALESCE(rs.phase, 'idle') AS phase,
                 COALESCE(rs.has_messages, 0) AS has_messages,
                 SUM(
                   CASE
                     WHEN p.timing = 'next_opportunity' THEN 1
                     ELSE 0
                   END
                 ) AS next_opportunity_count,
                 SUM(
                   CASE
                     WHEN p.timing = 'when_idle' THEN 1
                     ELSE 0
                   END
                 ) AS when_idle_count
               FROM agent_heads h
               LEFT JOIN agent_runtime_state rs ON rs.agent_id = h.agent_id
               LEFT JOIN agent_pending_inputs p ON p.agent_id = h.agent_id
               WHERE h.agent_id = ?
               GROUP BY h.node_id, rs.phase, rs.has_messages`,
            )
            .get(params.agentId);

          if (rawRow === undefined) {
            return Value.Decode(
              AgentDriverQuerySchemas[AGENT_RUNTIME_STATE_QUERY_NAME].result,
              {
                exists: false,
                phase: "idle",
                headNodeId: null,
                nextOpportunityCount: 0,
                whenIdleCount: 0,
                hasMessages: false,
              },
            );
          }

          const row = decodeRow(AgentRuntimeStateRowSchema, rawRow);

          return Value.Decode(
            AgentDriverQuerySchemas[AGENT_RUNTIME_STATE_QUERY_NAME].result,
            {
              exists: true,
              phase: row.phase,
              headNodeId: row.head_node_id,
              nextOpportunityCount: row.next_opportunity_count,
              whenIdleCount: row.when_idle_count,
              hasMessages: row.has_messages === 1,
            },
          );
        },
        [AGENT_TURN_QUERY_NAME]: async (params) => {
          const rawRow = input.database
            .prepare(
              `SELECT
                 agent_id,
                 turn_id,
                 request_node_id,
                 status,
                 last_node_id,
                 output_text,
                 error_text
               FROM agent_turns
               WHERE agent_id = ?
                 AND turn_id = ?`,
            )
            .get(params.agentId, params.turnId);

          if (rawRow === undefined) {
            return null;
          }

          const row = decodeRow(AgentTurnRowSchema, rawRow);

          return Value.Decode(
            AgentDriverQuerySchemas[AGENT_TURN_QUERY_NAME].result,
            {
              agentId: row.agent_id,
              turnId: row.turn_id,
              requestNodeId: row.request_node_id,
              status: row.status,
              lastNodeId: row.last_node_id,
              outputText: row.output_text ?? undefined,
              error: row.error_text ?? undefined,
            },
          );
        },
      },
    }),
    timing: input.timing,
  });

  const driver = createAgentDriver(ledger);

  return {
    driver,
    tailEvents: (streamInput) => {
      return driver.tailEvents(streamInput);
    },
    resumeEvents: (streamInput) => {
      return driver.resumeEvents(streamInput);
    },
    close: async () => {
      await ledger.close();
    },
    [Symbol.asyncDispose]: async () => {
      await ledger.close();
    },
  };
}
