import { Type } from "typebox";
import { Value } from "typebox/value";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  RuntimeScheduledTask,
  RuntimeScheduler,
} from "../runtime/contracts.ts";
import type {
  LedgerCursor,
  MaterializationImplementationRegistration,
  QueueHandlerControl,
  WorkRef,
} from "./ledger.ts";
import type { DatabaseLedger } from "./database-ledger-engine.ts";
import {
  createEventRef,
  defineLedgerShape,
  defineMaterialization,
  WorkOperationTimeoutError,
  withMaterializations,
} from "./ledger.ts";

export const MessageReceivedSchema = Type.Object({
  type: Type.Literal("message.received"),
  text: Type.String(),
});

const DecisionAttemptedSchema = Type.Object({
  type: Type.Literal("decision.attempted"),
  sourceEventId: Type.Number(),
  attempt: Type.Number(),
});

export const IntentPlannedSchema = Type.Object({
  type: Type.Literal("intent.planned"),
  sourceEventId: Type.Number(),
});

const DispatchCompletedSchema = Type.Object({
  type: Type.Literal("dispatch.completed"),
  sourceEventId: Type.Number(),
});

const ControlledWorkRequestedSchema = Type.Object({
  availableAtMs: Type.Union([Type.Null(), Type.Number()]),
  workKey: Type.String(),
  partitionKey: Type.Union([Type.Null(), Type.String()]),
});

const ControlledWorkAttemptedSchema = Type.Object({
  attempt: Type.Number(),
  workKey: Type.String(),
});

const ControlledSignalWorkSchema = Type.Object({
  workKey: Type.String(),
  partitionKey: Type.String(),
});

const TimedWorkSchema = Type.Object({
  workKey: Type.String(),
  timeoutMs: Type.Number(),
});

const TimedWorkHandledSchema = Type.Object({
  workKey: Type.String(),
});

const EvaluateMessageQueueSchema = Type.Object({
  sourceEventId: Type.Number(),
  text: Type.String(),
});

const DispatchIntentQueueSchema = Type.Object({
  intentEventId: Type.Number(),
  sourceEventId: Type.Number(),
});

const ControlledWorkQueueSchema = Type.Object({
  workKey: Type.String(),
});

export const UpsertObservedIndexerInputSchema = Type.Object({
  sourceEventId: Type.Number(),
});

export const IncrementDecisionAttemptsIndexerInputSchema = Type.Object({
  sourceEventId: Type.Number(),
  attempt: Type.Number(),
});

export const SetPlannedIntentIndexerInputSchema = Type.Object({
  sourceEventId: Type.Number(),
  intentEventId: Type.Number(),
});

export const IncrementDispatchCountIndexerInputSchema = Type.Object({
  sourceEventId: Type.Number(),
  dispatchCount: Type.Number(),
});

export const DecisionAttemptsQueryParamsSchema = Type.Object({
  sourceEventId: Type.Number(),
});

export const DispatchCountQueryParamsSchema = Type.Object({
  sourceEventId: Type.Number(),
});

export const SeenSourceEventIdsQueryParamsSchema = Type.Object({});

export const CountQueryResultSchema = Type.Number();

export const SourceEventIdsResultSchema = Type.Array(Type.Number());

const JsonNullValuesQueryParamsSchema = Type.Object({
  sourceEventId: Type.Number(),
});

const JsonNullValuesQueryResultSchema = Type.Union([
  Type.Null(),
  Type.Object({
    nullableValue: Type.Union([
      Type.Null(),
      Type.Object({
        value: Type.String(),
      }),
    ]),
    requiredJsonNull: Type.Null(),
  }),
]);

const ledgerContractShape = defineLedgerShape({
  moduleId: "ledger.contract",
  events: {
    "message.received": MessageReceivedSchema,
    "decision.attempted": DecisionAttemptedSchema,
    "intent.planned": IntentPlannedSchema,
    "dispatch.completed": DispatchCompletedSchema,
    "controlled-work.requested": ControlledWorkRequestedSchema,
    "controlled-work.attempted": ControlledWorkAttemptedSchema,
    "controlled-signal-work.requested": ControlledSignalWorkSchema,
    "timed-work.requested": TimedWorkSchema,
    "timed-signal-work.requested": TimedWorkSchema,
    "timed-work.handled": TimedWorkHandledSchema,
  },
  queues: {
    "evaluate.message": EvaluateMessageQueueSchema,
    "dispatch.intent": DispatchIntentQueueSchema,
    "controlled-work.run": ControlledWorkQueueSchema,
    "controlled-signal-work.publish": ControlledSignalWorkSchema,
    "timed-work.run": TimedWorkSchema,
    "timed-signal-work.publish": TimedWorkSchema,
  },
  signals: {
    "controlled-work.signalled": ControlledSignalWorkSchema,
    "timed-work.signalled": TimedWorkSchema,
  },
  signalQueues: {
    "controlled-signal-work.run": ControlledWorkQueueSchema,
    "timed-signal-work.run": TimedWorkSchema,
  },
});

const ledgerContractMaterializations = defineMaterialization(
  ledgerContractShape,
  {
    namespace: "contract",
  },
)
  .version(1, "create contract projection", (s) =>
    s
      .createTable("contractProjection", (t) =>
        t
          .columns({
            sourceEventId: t.integer().notNull(),
            decisionAttempts: t.integer().notNull(),
            dispatchCount: t.integer().notNull(),
            plannedIntentEventId: t.integer(),
          })
          .primaryKey(["sourceEventId"]),
      )
      .createTable("jsonNullProjection", (t) =>
        t
          .columns({
            sourceEventId: t.integer().notNull(),
            nullableValue: t.json<{ readonly value: string } | null>(),
            requiredJsonNull: t.json<null>().notNull(),
          })
          .primaryKey(["sourceEventId"]),
      ),
  )
  .define({
    indexers: {
      upsertObserved: {
        sourceEvent: "message.received",
        input: UpsertObservedIndexerInputSchema,
      },
      upsertControlledObserved: {
        sourceEvent: "controlled-work.requested",
        input: UpsertObservedIndexerInputSchema,
      },
      insertJsonNulls: {
        sourceEvent: "message.received",
        input: UpsertObservedIndexerInputSchema,
      },
      incrementDecisionAttempts: {
        sourceEvent: "decision.attempted",
        input: IncrementDecisionAttemptsIndexerInputSchema,
      },
      setPlannedIntent: {
        sourceEvent: "intent.planned",
        input: SetPlannedIntentIndexerInputSchema,
      },
      incrementDispatchCount: {
        sourceEvent: "dispatch.completed",
        input: IncrementDispatchCountIndexerInputSchema,
      },
    },
    queries: {
      decisionAttempts: {
        params: DecisionAttemptsQueryParamsSchema,
        result: CountQueryResultSchema,
      },
      dispatchCount: {
        params: DispatchCountQueryParamsSchema,
        result: CountQueryResultSchema,
      },
      seenSourceEventIds: {
        params: SeenSourceEventIdsQueryParamsSchema,
        result: SourceEventIdsResultSchema,
      },
      jsonNullValues: {
        params: JsonNullValuesQueryParamsSchema,
        result: JsonNullValuesQueryResultSchema,
      },
    },
  });

const ledgerContractSchema = ledgerContractMaterializations.history.current;

const ledgerContractDefinition = withMaterializations(
  ledgerContractShape,
  ledgerContractMaterializations,
);

const ledgerContractImplementations = {
  indexers: {
    upsertObserved: async ({ input, db }) => {
      await db
        .insertInto("contractProjection")
        .values({
          sourceEventId: input.sourceEventId,
          decisionAttempts: 0,
          dispatchCount: 0,
          plannedIntentEventId: null,
        })
        .onConflict(["sourceEventId"])
        .doNothing()
        .execute();
    },
    upsertControlledObserved: async ({ input, db }) => {
      await db
        .insertInto("contractProjection")
        .values({
          sourceEventId: input.sourceEventId,
          decisionAttempts: 0,
          dispatchCount: 0,
          plannedIntentEventId: null,
        })
        .onConflict(["sourceEventId"])
        .doNothing()
        .execute();
    },
    insertJsonNulls: async ({ input, db }) => {
      await db
        .insertInto("jsonNullProjection")
        .values({
          sourceEventId: input.sourceEventId,
          nullableValue: null,
          requiredJsonNull: null,
        })
        .execute();
    },
    incrementDecisionAttempts: async ({ input, db }) => {
      await db
        .insertInto("contractProjection")
        .values({
          sourceEventId: input.sourceEventId,
          decisionAttempts: input.attempt,
          dispatchCount: 0,
          plannedIntentEventId: null,
        })
        .onConflict(["sourceEventId"])
        .doUpdateSet({
          decisionAttempts: input.attempt,
        })
        .execute();
    },
    setPlannedIntent: async ({ input, db }) => {
      await db
        .insertInto("contractProjection")
        .values({
          sourceEventId: input.sourceEventId,
          decisionAttempts: 0,
          dispatchCount: 0,
          plannedIntentEventId: input.intentEventId,
        })
        .onConflict(["sourceEventId"])
        .doUpdateSet({
          plannedIntentEventId: input.intentEventId,
        })
        .execute();
    },
    incrementDispatchCount: async ({ input, db }) => {
      await db
        .insertInto("contractProjection")
        .values({
          sourceEventId: input.sourceEventId,
          decisionAttempts: 0,
          dispatchCount: input.dispatchCount,
          plannedIntentEventId: null,
        })
        .onConflict(["sourceEventId"])
        .doUpdateSet({
          dispatchCount: input.dispatchCount,
        })
        .execute();
    },
  },
  queries: {
    decisionAttempts: async ({ params, db }) => {
      const row = await db
        .selectFrom("contractProjection")
        .select(["decisionAttempts"])
        .where("sourceEventId", "=", params.sourceEventId)
        .executeTakeFirst();

      return row?.decisionAttempts ?? 0;
    },
    dispatchCount: async ({ params, db }) => {
      const row = await db
        .selectFrom("contractProjection")
        .select(["dispatchCount"])
        .where("sourceEventId", "=", params.sourceEventId)
        .executeTakeFirst();

      return row?.dispatchCount ?? 0;
    },
    seenSourceEventIds: async ({ db }) => {
      const rows = await db
        .selectFrom("contractProjection")
        .select(["sourceEventId"])
        .execute();

      return rows.map((row) => row.sourceEventId).sort((a, b) => a - b);
    },
    jsonNullValues: async ({ params, db }) => {
      return await db
        .selectFrom("jsonNullProjection")
        .select(["nullableValue", "requiredJsonNull"])
        .where("sourceEventId", "=", params.sourceEventId)
        .whereNull("nullableValue")
        .whereNotNull("requiredJsonNull")
        .executeTakeFirst();
    },
  },
} satisfies MaterializationImplementationRegistration<
  typeof ledgerContractSchema,
  typeof ledgerContractMaterializations.indexers,
  typeof ledgerContractMaterializations.queries
>;

type LedgerContractEvents = typeof ledgerContractShape.shape.events;
type LedgerContractQueries = typeof ledgerContractDefinition.model.queries;
type LedgerContractSignals = typeof ledgerContractShape.shape.signals;
type LedgerContractModel = ReturnType<typeof ledgerContractDefinition.register>;

type LedgerContractTokenEnvelope = {
  readonly causationEventId: number | null;
  readonly dedupeKey: string | null;
  readonly event: object;
  readonly eventId: number;
  readonly payload: unknown;
  readonly tsMs: number;
};

type LedgerContractTokenStreamEvent = {
  readonly cursor: LedgerCursor;
  readonly event: LedgerContractTokenEnvelope;
};

export function createLedgerContractHarnessLedger(
  ledger: object,
): DatabaseLedger<
  LedgerContractEvents,
  LedgerContractQueries,
  LedgerContractSignals
> {
  const runtime = ledger as {
    cancelWork(input: {
      readonly reason?: string;
      readonly ref: string;
    }): Promise<unknown>;
    emit(
      event: object,
      payload: unknown,
      options?: { readonly dedupeKey?: string },
    ): Promise<LedgerContractTokenEnvelope>;
    listWork(input?: {
      readonly limit?: number;
      readonly queueName?: string;
      readonly sourceEventId?: number;
      readonly states?: readonly string[];
    }): Promise<readonly unknown[]>;
    query(query: object, params: unknown): Promise<unknown>;
    onSignal(
      signal: object,
      observer: (signal: LedgerContractTokenEnvelope) => void | Promise<void>,
    ): unknown;
    tailEvents(input: {
      readonly last: number;
      readonly signal: AbortSignal;
    }): AsyncIterable<LedgerContractTokenStreamEvent>;
    resumeEvents(input: {
      readonly cursor: LedgerCursor;
      readonly signal: AbortSignal;
    }): AsyncIterable<LedgerContractTokenStreamEvent>;
  };

  return new Proxy(ledger, {
    get: (target, property, receiver) => {
      if (property === "emit") {
        return (
          eventName: keyof LedgerContractEvents,
          payload: unknown,
          options?: { readonly dedupeKey?: string },
        ) => {
          return runtime.emit(
            ledgerContractShape.events[eventName],
            payload,
            options,
          );
        };
      }

      if (property === "cancelWork") {
        return runtime.cancelWork.bind(runtime);
      }

      if (property === "query") {
        return (queryName: keyof LedgerContractQueries, params: unknown) => {
          return runtime.query(
            ledgerContractDefinition.queries[queryName],
            params,
          );
        };
      }

      if (property === "listWork") {
        return runtime.listWork.bind(runtime);
      }

      if (property === "onSignal") {
        return (
          signalName: keyof LedgerContractSignals,
          observer: (signal: unknown) => void | Promise<void>,
        ) => {
          return runtime.onSignal(
            ledgerContractShape.signals[signalName],
            async (signal) => {
              await observer(createLedgerContractEnvelope(signal, signalName));
            },
          );
        };
      }

      if (property === "tailEvents" || property === "resumeEvents") {
        return (streamInput: {
          readonly last?: number;
          readonly cursor?: LedgerCursor;
          readonly signal: AbortSignal;
        }) => {
          const source =
            property === "tailEvents"
              ? runtime.tailEvents(
                  streamInput as {
                    readonly last: number;
                    readonly signal: AbortSignal;
                  },
                )
              : runtime.resumeEvents(
                  streamInput as {
                    readonly cursor: LedgerCursor;
                    readonly signal: AbortSignal;
                  },
                );

          return mapLedgerContractEventStream(source);
        };
      }

      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as DatabaseLedger<
    LedgerContractEvents,
    LedgerContractQueries,
    LedgerContractSignals
  >;
}

function createLedgerContractEnvelope(
  envelope: LedgerContractTokenEnvelope,
  eventName: string,
): object {
  return {
    causationEventId: envelope.causationEventId,
    dedupeKey: envelope.dedupeKey,
    eventId: envelope.eventId,
    eventName,
    payload: envelope.payload,
    ref: createEventRef(eventName, envelope.eventId),
    tsMs: envelope.tsMs,
  };
}

async function* mapLedgerContractEventStream(
  source: AsyncIterable<LedgerContractTokenStreamEvent>,
): AsyncIterable<{
  readonly cursor: LedgerContractTokenStreamEvent["cursor"];
  readonly event: object;
}> {
  for await (const item of source) {
    const eventName = Object.entries(ledgerContractShape.events).find(
      ([, token]) => token === item.event.event,
    )?.[0];

    if (eventName === undefined) {
      throw new Error("ledger contract received an unknown event token");
    }

    yield {
      cursor: item.cursor,
      event: createLedgerContractEnvelope(item.event, eventName),
    };
  }
}

export type LedgerContractDecisionMode =
  | "ack"
  | "retry_once"
  | "dead_letter"
  | "throw_once"
  | "block_until_abort";

export type LedgerContractControlledWorkGate = {
  readonly entered: Promise<void>;
  release(): void;
};

export type LedgerContractControlledWorkOutcome =
  | { readonly kind: "ack" }
  | { readonly kind: "retry"; readonly retryAtMs: number }
  | { readonly kind: "dead_letter" };

export type LedgerContractControlledWork = {
  prepare(workKey: string): LedgerContractControlledWorkGate;
  prepareAttempt(
    workKey: string,
    attempt: number,
    outcome: LedgerContractControlledWorkOutcome,
  ): LedgerContractControlledWorkGate;
  run(
    workKey: string,
    attempt: number,
  ): Promise<LedgerContractControlledWorkOutcome>;
  startedWorkKeys(): readonly string[];
  releaseAll(): void;
};

export type LedgerContractTimedWorkSettlement =
  | {
      readonly status: "completed";
      readonly value: string;
    }
  | {
      readonly status: "rejected";
      readonly error: unknown;
      readonly operationWasInvoked: boolean;
    };

export type LedgerContractTimedWorkGate = {
  readonly entered: Promise<{
    readonly leaseSignal: AbortSignal;
    readonly operationSignal: AbortSignal;
  }>;
  readonly settled: Promise<LedgerContractTimedWorkSettlement>;
  resolve(value: string): void;
  reject(error: unknown): void;
};

export type LedgerContractTimedWork = {
  prepare(workKey: string): LedgerContractTimedWorkGate;
  run(
    workKey: string,
    timeoutMs: number,
    leaseSignal: AbortSignal,
    control: Pick<QueueHandlerControl, "withTimeout">,
  ): Promise<void>;
  releaseAll(): void;
};

export class LedgerContractPausableScheduler implements RuntimeScheduler {
  readonly #scheduler: RuntimeScheduler;
  #paused = false;

  constructor(scheduler: RuntimeScheduler) {
    this.#scheduler = scheduler;
  }

  pause(): void {
    this.#paused = true;
  }

  scheduleOnce(delayMs: number, task: () => void): RuntimeScheduledTask {
    return this.#scheduler.scheduleOnce(delayMs, () => {
      if (!this.#paused) {
        task();
      }
    });
  }

  scheduleRepeating(everyMs: number, task: () => void): RuntimeScheduledTask {
    return this.#scheduler.scheduleRepeating(everyMs, () => {
      if (!this.#paused) {
        task();
      }
    });
  }
}

export function createLedgerContractControlledWork(): LedgerContractControlledWork {
  const gates = new Map<
    string,
    {
      readonly entered: PromiseWithResolvers<void>;
      readonly outcome: LedgerContractControlledWorkOutcome;
      readonly release: PromiseWithResolvers<void>;
    }
  >();
  const startedWorkKeys: string[] = [];

  const prepareAttempt = (
    workKey: string,
    attempt: number,
    outcome: LedgerContractControlledWorkOutcome,
  ): LedgerContractControlledWorkGate => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attemptKey = `${workKey}:${attempt}`;

    if (gates.has(attemptKey)) {
      throw new Error(`controlled work was already prepared: ${attemptKey}`);
    }

    gates.set(attemptKey, { entered, outcome, release });

    return {
      entered: entered.promise,
      release: () => release.resolve(),
    };
  };

  return {
    prepare: (workKey) => prepareAttempt(workKey, 1, { kind: "ack" }),
    prepareAttempt,
    run: async (workKey, attempt) => {
      const attemptKey = `${workKey}:${attempt}`;
      const gate = gates.get(attemptKey);

      if (gate === undefined) {
        throw new Error(`controlled work was not prepared: ${attemptKey}`);
      }

      startedWorkKeys.push(workKey);
      gate.entered.resolve();
      await gate.release.promise;
      return gate.outcome;
    },
    startedWorkKeys: () => [...startedWorkKeys],
    releaseAll: () => {
      for (const gate of gates.values()) {
        gate.release.resolve();
      }
    },
  };
}

export function createLedgerContractTimedWork(): LedgerContractTimedWork {
  const gates = new Map<
    string,
    {
      readonly entered: PromiseWithResolvers<{
        readonly leaseSignal: AbortSignal;
        readonly operationSignal: AbortSignal;
      }>;
      readonly operation: PromiseWithResolvers<string>;
      readonly settled: PromiseWithResolvers<LedgerContractTimedWorkSettlement>;
    }
  >();

  return {
    prepare: (workKey) => {
      if (gates.has(workKey)) {
        throw new Error(`timed work was already prepared: ${workKey}`);
      }

      const entered = Promise.withResolvers<{
        readonly leaseSignal: AbortSignal;
        readonly operationSignal: AbortSignal;
      }>();
      const operation = Promise.withResolvers<string>();
      const settled =
        Promise.withResolvers<LedgerContractTimedWorkSettlement>();

      gates.set(workKey, {
        entered,
        operation,
        settled,
      });

      return {
        entered: entered.promise,
        settled: settled.promise,
        resolve: (value) => operation.resolve(value),
        reject: (error) => operation.reject(error),
      };
    },
    run: async (workKey, timeoutMs, leaseSignal, control) => {
      const gate = gates.get(workKey);

      if (gate === undefined) {
        throw new Error(`timed work was not prepared: ${workKey}`);
      }

      let operationWasInvoked = false;

      try {
        const value = await control.withTimeout(timeoutMs, async (signal) => {
          operationWasInvoked = true;
          gate.entered.resolve({
            leaseSignal,
            operationSignal: signal,
          });

          return await gate.operation.promise;
        });

        gate.settled.resolve({
          status: "completed",
          value,
        });
      } catch (error: unknown) {
        gate.settled.resolve({
          status: "rejected",
          error,
          operationWasInvoked,
        });
      }
    },
    releaseAll: () => {
      for (const gate of gates.values()) {
        gate.operation.resolve("released");
      }
    },
  };
}

export type LedgerContractHarness = {
  readonly ledger: DatabaseLedger<
    LedgerContractEvents,
    LedgerContractQueries,
    LedgerContractSignals
  >;

  nowMs(): number;
  advanceByMs(ms: number): Promise<void>;
  flush(): Promise<void>;
  waitForIdle(): Promise<void>;

  restart(): Promise<void>;
  restartWorkers(input: { readonly maxInFlight: number }): Promise<void>;
  startCompetingWorkers(input: { readonly maxInFlight: number }): Promise<void>;
  stopCompetingWorkers(): Promise<void>;
  pausePrimaryScheduler(): void;
  stopPrimaryWorkers(): Promise<void>;
  stop(): Promise<void>;

  setDecisionMode(mode: LedgerContractDecisionMode): void;
  setMaterializationFailureText(text: string | null): void;
  prepareControlledWork(workKey: string): LedgerContractControlledWorkGate;
  prepareControlledWorkAttempt(
    workKey: string,
    attempt: number,
    outcome: LedgerContractControlledWorkOutcome,
  ): LedgerContractControlledWorkGate;
  prepareTimedWork(workKey: string): LedgerContractTimedWorkGate;
  getStartedControlledWorkKeys(): readonly string[];

  getDecisionAttempts(sourceEventId: number): Promise<number>;
  getDispatchCount(sourceEventId: number): Promise<number>;
  getSeenSourceEventIds(): Promise<readonly number[]>;
};

type LedgerContractHarnessFactory = () => Promise<LedgerContractHarness>;

export function createLedgerContractModel(input: {
  readDecisionMode(): LedgerContractDecisionMode;
  readMaterializationFailureText(): string | null;
  nowMs(): number;
  runControlledWork(
    workKey: string,
    attempt: number,
  ): Promise<LedgerContractControlledWorkOutcome>;
  runTimedWork(
    workKey: string,
    timeoutMs: number,
    leaseSignal: AbortSignal,
    control: Pick<QueueHandlerControl, "withTimeout">,
  ): Promise<void>;
}): LedgerContractModel {
  return ledgerContractDefinition.register({
    indexers: ledgerContractImplementations.indexers,
    queries: ledgerContractImplementations.queries,
    events: {
      "message.received": async ({ event, actions }) => {
        await actions.index("upsertObserved", {
          sourceEventId: event.eventId,
        });
        await actions.index("insertJsonNulls", {
          sourceEventId: event.eventId,
        });

        if (
          input.readMaterializationFailureText() !== null &&
          event.payload.text === input.readMaterializationFailureText()
        ) {
          throw new Error("configured materialization failure");
        }

        actions.enqueue("evaluate.message", {
          sourceEventId: event.eventId,
          text: event.payload.text,
        });
      },
      "decision.attempted": async ({ event, actions }) => {
        await actions.index("incrementDecisionAttempts", {
          sourceEventId: event.payload.sourceEventId,
          attempt: event.payload.attempt,
        });
      },
      "intent.planned": async ({ event, actions }) => {
        await actions.index("setPlannedIntent", {
          sourceEventId: event.payload.sourceEventId,
          intentEventId: event.eventId,
        });

        actions.enqueue("dispatch.intent", {
          intentEventId: event.eventId,
          sourceEventId: event.payload.sourceEventId,
        });
      },
      "dispatch.completed": async ({ event, actions }) => {
        const dispatchCount = await actions.query("dispatchCount", {
          sourceEventId: event.payload.sourceEventId,
        });

        await actions.index("incrementDispatchCount", {
          sourceEventId: event.payload.sourceEventId,
          dispatchCount: dispatchCount + 1,
        });
      },
      "controlled-work.requested": async ({ event, actions }) => {
        await actions.index("upsertControlledObserved", {
          sourceEventId: event.eventId,
        });

        const enqueueOptions: {
          availableAtMs?: number;
          partitionKey?: string;
          workKey: string;
        } = {
          workKey: event.payload.workKey,
        };

        if (event.payload.availableAtMs !== null) {
          enqueueOptions.availableAtMs = event.payload.availableAtMs;
        }

        if (event.payload.partitionKey !== null) {
          enqueueOptions.partitionKey = event.payload.partitionKey;
        }

        actions.enqueue(
          "controlled-work.run",
          {
            workKey: event.payload.workKey,
          },
          enqueueOptions,
        );
      },
      "controlled-signal-work.requested": ({ event, actions }) => {
        actions.enqueue("controlled-signal-work.publish", event.payload, {
          workKey: event.payload.workKey,
        });
      },
      "timed-work.requested": ({ event, actions }) => {
        actions.enqueue("timed-work.run", event.payload, {
          workKey: event.payload.workKey,
        });
      },
      "timed-signal-work.requested": ({ event, actions }) => {
        actions.enqueue("timed-signal-work.publish", event.payload, {
          workKey: event.payload.workKey,
        });
      },
      "timed-work.handled": () => {},
    },
    queues: {
      "evaluate.message": async ({ work, lease, actions, control }) => {
        actions.emit("decision.attempted", {
          type: "decision.attempted",
          sourceEventId: work.sourceEventId,
          attempt: work.attempt,
        });

        const mode = input.readDecisionMode();

        switch (mode) {
          case "ack":
            actions.emit(
              "intent.planned",
              {
                type: "intent.planned",
                sourceEventId: work.sourceEventId,
              },
              {
                dedupeKey: `intent:${work.sourceEventId}`,
              },
            );
            return;

          case "retry_once":
            if (work.attempt === 1) {
              return control.retry("retry once", {
                retryAtMs: input.nowMs() + 200,
              });
            }

            actions.emit(
              "intent.planned",
              {
                type: "intent.planned",
                sourceEventId: work.sourceEventId,
              },
              {
                dedupeKey: `intent:${work.sourceEventId}`,
              },
            );
            return;

          case "dead_letter":
            return control.deadLetter("configured dead letter");

          case "throw_once":
            if (work.attempt === 1) {
              throw new Error("configured throw");
            }

            actions.emit(
              "intent.planned",
              {
                type: "intent.planned",
                sourceEventId: work.sourceEventId,
              },
              {
                dedupeKey: `intent:${work.sourceEventId}`,
              },
            );
            return;

          case "block_until_abort": {
            if (!lease.signal.aborted) {
              await new Promise<void>((resolve) => {
                const onAbort = () => {
                  lease.signal.removeEventListener("abort", onAbort);
                  resolve();
                };

                lease.signal.addEventListener("abort", onAbort);
              });
            }

            return control.retry("aborted", {
              retryAtMs: input.nowMs(),
            });
          }
        }
      },
      "dispatch.intent": async ({ work, actions }) => {
        actions.emit("dispatch.completed", {
          type: "dispatch.completed",
          sourceEventId: work.payload.sourceEventId,
        });
      },
      "controlled-work.run": async ({ work, actions, control }) => {
        const outcome = await input.runControlledWork(
          work.payload.workKey,
          work.attempt,
        );

        actions.emit("controlled-work.attempted", {
          attempt: work.attempt,
          workKey: work.payload.workKey,
        });

        switch (outcome.kind) {
          case "ack":
            return;
          case "retry":
            return control.retry("configured controlled retry", {
              retryAtMs: outcome.retryAtMs,
            });
          case "dead_letter":
            return control.deadLetter("configured controlled dead letter");
        }
      },
      "controlled-signal-work.publish": async ({ work, actions }) => {
        await actions.emitSignal("controlled-work.signalled", work.payload, {
          dedupeKey: `controlled-signal:${work.sourceEventId}`,
        });
      },
      "timed-work.run": async ({ work, lease, actions, control }) => {
        await input.runTimedWork(
          work.payload.workKey,
          work.payload.timeoutMs,
          lease.signal,
          control,
        );

        actions.emit("timed-work.handled", {
          workKey: work.payload.workKey,
        });
      },
      "timed-signal-work.publish": async ({ work, actions }) => {
        await actions.emitSignal("timed-work.signalled", work.payload, {
          dedupeKey: `timed-signal:${work.sourceEventId}`,
        });
      },
    },
    signals: {
      "controlled-work.signalled": ({ event, actions }) => {
        actions.enqueueSignal(
          "controlled-signal-work.run",
          {
            workKey: event.payload.workKey,
          },
          {
            partitionKey: event.payload.partitionKey,
            workKey: event.payload.workKey,
          },
        );
      },
      "timed-work.signalled": ({ event, actions }) => {
        actions.enqueueSignal("timed-signal-work.run", event.payload, {
          workKey: event.payload.workKey,
        });
      },
    },
    signalQueues: {
      "controlled-signal-work.run": async ({ work, control }) => {
        const outcome = await input.runControlledWork(
          work.payload.workKey,
          work.attempt,
        );

        switch (outcome.kind) {
          case "ack":
            return;
          case "retry":
            return control.retry("configured controlled signal retry", {
              retryAtMs: outcome.retryAtMs,
            });
          case "dead_letter":
            throw new Error("controlled signal work cannot dead-letter");
        }
      },
      "timed-signal-work.run": async ({ work, lease, control }) => {
        await input.runTimedWork(
          work.payload.workKey,
          work.payload.timeoutMs,
          lease.signal,
          control,
        );
      },
    },
  });
}

async function withHarness(
  create: LedgerContractHarnessFactory,
  run: (harness: LedgerContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await create();

  try {
    await run(harness);
  } finally {
    await harness.stop();
  }
}

async function waitFor(
  harness: LedgerContractHarness,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  stepMs: number,
): Promise<void> {
  let elapsedMs = 0;

  while (elapsedMs <= timeoutMs) {
    await harness.flush();

    if (await predicate()) {
      return;
    }

    await harness.advanceByMs(stepMs);
    elapsedMs += stepMs;
  }

  assert.fail(`condition not met after ${timeoutMs}ms`);
}

export function runLedgerContractSuite(input: {
  readonly suiteName: string;
  readonly create: LedgerContractHarnessFactory;
}): void {
  test(input.suiteName, async (t) => {
    const observeControlledAttempt = async (
      harness: LedgerContractHarness,
      workKey: string,
      attempt: number,
      release: () => void,
    ): Promise<void> => {
      const abortController = new AbortController();
      const iterator = harness.ledger
        .tailEvents({
          last: 1,
          signal: abortController.signal,
        })
        [Symbol.asyncIterator]();

      try {
        const history = await iterator.next();
        assert.equal(history.done, false);

        release();

        while (true) {
          const item = await iterator.next();

          if (item.done) {
            assert.fail(
              `controlled attempt was not observed: ${workKey}:${attempt}`,
            );
          }

          if (item.value.event.eventName !== "controlled-work.attempted") {
            continue;
          }

          const payload = Value.Decode(
            ControlledWorkAttemptedSchema,
            item.value.event.payload,
          );

          if (payload.workKey === workKey && payload.attempt === attempt) {
            return;
          }
        }
      } finally {
        abortController.abort();
        await iterator.return?.();
      }
    };

    const readSingleSourceEventId = async (
      harness: LedgerContractHarness,
    ): Promise<number> => {
      const sourceEventIds = await harness.getSeenSourceEventIds();
      const sourceEventId = sourceEventIds[0];

      assert.ok(sourceEventId !== undefined);

      return sourceEventId;
    };

    const emitTimedWork = async (
      harness: LedgerContractHarness,
      kind: "durable" | "signal",
      workKey: string,
      timeoutMs: number,
    ): Promise<void> => {
      if (kind === "durable") {
        await harness.ledger.emit("timed-work.requested", {
          workKey,
          timeoutMs,
        });
      } else {
        await harness.ledger.emit("timed-signal-work.requested", {
          workKey,
          timeoutMs,
        });
      }

      await harness.flush();
    };

    const readLatestEvent = async (
      harness: LedgerContractHarness,
    ): Promise<{
      readonly eventName: string;
      readonly payload: unknown;
    }> => {
      const abortController = new AbortController();
      const iterator = harness.ledger
        .tailEvents({
          last: 1,
          signal: abortController.signal,
        })
        [Symbol.asyncIterator]();

      try {
        const item = await iterator.next();

        if (item.done) {
          assert.fail("expected one historical event");
        }

        return {
          eventName: item.value.event.eventName,
          payload: item.value.event.payload,
        };
      } finally {
        abortController.abort();
        await iterator.return?.();
      }
    };

    await t.test(
      "withTimeout returns values and preserves operation failures",
      async () => {
        await withHarness(input.create, async (harness) => {
          const completed = harness.prepareTimedWork("timed-completed");

          await emitTimedWork(harness, "durable", "timed-completed", 100);
          const completedEntry = await completed.entered;
          completed.resolve("completed value");

          assert.deepEqual(await completed.settled, {
            status: "completed",
            value: "completed value",
          });

          await harness.advanceByMs(100);
          assert.equal(completedEntry.operationSignal.aborted, false);

          const failed = harness.prepareTimedWork("timed-failed");
          const expectedError = new Error("operation failed");

          await emitTimedWork(harness, "durable", "timed-failed", 100);
          const failedEntry = await failed.entered;
          failed.reject(expectedError);

          assert.deepEqual(await failed.settled, {
            status: "rejected",
            error: expectedError,
            operationWasInvoked: true,
          });
          assert.equal(failedEntry.operationSignal.aborted, false);

          await harness.advanceByMs(100);
          assert.equal(failedEntry.operationSignal.aborted, false);
          await harness.waitForIdle();

          const latestEvent = await readLatestEvent(harness);
          assert.equal(latestEvent.eventName, "timed-work.handled");
          assert.deepEqual(
            Value.Decode(TimedWorkHandledSchema, latestEvent.payload),
            {
              workKey: "timed-failed",
            },
          );
        });
      },
    );

    for (const kind of ["durable", "signal"] as const) {
      await t.test(
        `withTimeout aborts the ${kind} queue operation signal before rejecting`,
        async () => {
          await withHarness(input.create, async (harness) => {
            const workKey = `timed-${kind}-deadline`;
            const gate = harness.prepareTimedWork(workKey);

            await emitTimedWork(harness, kind, workKey, 100);
            const entered = await gate.entered;
            let didSettle = false;
            void gate.settled.then(() => {
              didSettle = true;
            });

            await harness.advanceByMs(99);
            assert.equal(entered.operationSignal.aborted, false);
            assert.equal(didSettle, false);

            await harness.advanceByMs(1);
            const settled = await gate.settled;

            assert.equal(settled.status, "rejected");

            if (settled.status !== "rejected") {
              assert.fail("expected timed work to reject");
            }

            assert.equal(settled.operationWasInvoked, true);
            assert.equal(entered.operationSignal.aborted, true);
            assert.ok(settled.error instanceof WorkOperationTimeoutError);
            assert.equal(settled.error.timeoutMs, 100);
            assert.equal(entered.operationSignal.reason, settled.error);
            assert.equal(entered.leaseSignal.aborted, false);

            await harness.waitForIdle();

            if (kind === "durable") {
              const latestEvent = await readLatestEvent(harness);
              assert.equal(latestEvent.eventName, "timed-work.handled");
              assert.deepEqual(
                Value.Decode(TimedWorkHandledSchema, latestEvent.payload),
                {
                  workKey,
                },
              );
            }
          });
        },
      );

      await t.test(
        `withTimeout preserves ${kind} queue lease cancellation`,
        async () => {
          await withHarness(input.create, async (harness) => {
            const workKey = `timed-${kind}-cancelled`;
            const queueName =
              kind === "durable" ? "timed-work.run" : "timed-signal-work.run";
            const gate = harness.prepareTimedWork(workKey);

            await emitTimedWork(harness, kind, workKey, 500);
            const entered = await gate.entered;
            const [work] = await harness.ledger.listWork({
              queueName,
              states: ["leased"],
            });

            if (work?.ref === null || work === undefined) {
              throw new Error(`expected leased ${kind} timed work`);
            }

            const cancelled = await harness.ledger.cancelWork({
              ref: work.ref,
              reason: "contract cancellation",
            });
            assert.equal(cancelled.status, "cancelled");

            const settled = await gate.settled;
            assert.equal(settled.status, "rejected");

            if (settled.status !== "rejected") {
              assert.fail("expected cancelled timed work to reject");
            }

            assert.equal(settled.operationWasInvoked, true);
            assert.equal(entered.operationSignal.aborted, true);
            assert.equal(entered.leaseSignal.aborted, true);
            assert.equal(
              entered.operationSignal.reason,
              entered.leaseSignal.reason,
            );
            assert.equal(entered.operationSignal.reason, settled.error);
            assert.equal(
              settled.error instanceof WorkOperationTimeoutError,
              false,
            );

            await harness.advanceByMs(500);
            assert.equal(
              entered.operationSignal.reason,
              entered.leaseSignal.reason,
            );
            await harness.waitForIdle();
          });
        },
      );
    }

    await t.test(
      "withTimeout rejects invalid durations without invoking the operation",
      async () => {
        await withHarness(input.create, async (harness) => {
          for (const timeoutMs of [0, -1, 1.5, 2_147_483_648]) {
            const workKey = `timed-invalid-${String(timeoutMs)}`;
            const gate = harness.prepareTimedWork(workKey);

            await emitTimedWork(harness, "durable", workKey, timeoutMs);
            const settled = await gate.settled;

            assert.equal(settled.status, "rejected");

            if (settled.status !== "rejected") {
              assert.fail("expected invalid timeout to reject");
            }

            assert.equal(settled.operationWasInvoked, false);
          }

          await harness.waitForIdle();
        });
      },
    );

    await t.test(
      "partitioned work is serial while other partitions remain concurrent",
      async () => {
        await withHarness(input.create, async (harness) => {
          const first = harness.prepareControlledWork("lane-a-1");
          const second = harness.prepareControlledWork("lane-a-2");
          const other = harness.prepareControlledWork("lane-b-1");

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "lane-a-1",
            partitionKey: "lane-a",
          });
          await harness.flush();
          await first.entered;

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "lane-a-2",
            partitionKey: "lane-a",
          });
          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "lane-b-1",
            partitionKey: "lane-b",
          });
          await harness.flush();
          await other.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "lane-a-1",
            "lane-b-1",
          ]);

          first.release();
          await harness.flush();
          await second.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "lane-a-1",
            "lane-b-1",
            "lane-a-2",
          ]);

          second.release();
          other.release();
        });
      },
    );

    await t.test(
      "competing worker runtimes preserve partition exclusivity",
      async () => {
        await withHarness(input.create, async (harness) => {
          await harness.restartWorkers({ maxInFlight: 1 });

          const first = harness.prepareControlledWork("runtime-a-1");
          const successor = harness.prepareControlledWork("runtime-a-2");
          const other = harness.prepareControlledWork("runtime-b-1");

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "runtime-a-1",
            partitionKey: "runtime-a",
          });
          await harness.flush();
          await first.entered;

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "runtime-a-2",
            partitionKey: "runtime-a",
          });
          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "runtime-b-1",
            partitionKey: "runtime-b",
          });

          await harness.startCompetingWorkers({ maxInFlight: 1 });
          await harness.flush();
          await other.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "runtime-a-1",
            "runtime-b-1",
          ]);

          await observeControlledAttempt(
            harness,
            "runtime-a-1",
            1,
            first.release,
          );
          await harness.flush();
          await successor.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "runtime-a-1",
            "runtime-b-1",
            "runtime-a-2",
          ]);

          await observeControlledAttempt(
            harness,
            "runtime-a-2",
            1,
            successor.release,
          );
          other.release();
          await harness.stopCompetingWorkers();
        });
      },
    );

    await t.test(
      "lease recovery retries the partition head and fences its stale attempt",
      async () => {
        await withHarness(input.create, async (harness) => {
          await harness.restartWorkers({ maxInFlight: 1 });

          const staleAttempt = harness.prepareControlledWorkAttempt(
            "lease-head",
            1,
            { kind: "ack" },
          );
          const recoveredAttempt = harness.prepareControlledWorkAttempt(
            "lease-head",
            2,
            { kind: "ack" },
          );
          const successor = harness.prepareControlledWork("lease-tail");

          const headEvent = await harness.ledger.emit(
            "controlled-work.requested",
            {
              availableAtMs: null,
              workKey: "lease-head",
              partitionKey: "lease-lane",
            },
          );
          const successorEvent = await harness.ledger.emit(
            "controlled-work.requested",
            {
              availableAtMs: null,
              workKey: "lease-tail",
              partitionKey: "lease-lane",
            },
          );
          await harness.flush();
          await staleAttempt.entered;

          harness.pausePrimaryScheduler();
          await harness.advanceByMs(1_001);
          await harness.startCompetingWorkers({ maxInFlight: 1 });
          await harness.flush();
          await recoveredAttempt.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "lease-head",
            "lease-head",
          ]);

          staleAttempt.release();
          await harness.stopPrimaryWorkers();

          const activeWork = await harness.ledger.listWork({
            queueName: "controlled-work.run",
            states: ["leased", "pending"],
          });
          const recoveredHead = activeWork.find(
            (work) => work.sourceEventId === headEvent.eventId,
          );
          const blockedSuccessor = activeWork.find(
            (work) => work.sourceEventId === successorEvent.eventId,
          );

          assert.equal(recoveredHead?.attempt, 2);
          assert.equal(recoveredHead?.state, "leased");
          assert.equal(blockedSuccessor?.attempt, 0);
          assert.equal(blockedSuccessor?.state, "pending");

          recoveredAttempt.release();
          await harness.stopCompetingWorkers();
          await harness.startCompetingWorkers({ maxInFlight: 1 });
          await harness.flush();
          await successor.entered;

          const abortController = new AbortController();
          const iterator = harness.ledger
            .tailEvents({
              last: 3,
              signal: abortController.signal,
            })
            [Symbol.asyncIterator]();
          const recentEvents = [];

          try {
            for (let index = 0; index < 3; index += 1) {
              const item = await iterator.next();
              assert.equal(item.done, false);
              recentEvents.push(item.value.event);
            }
          } finally {
            abortController.abort();
            await iterator.return?.();
          }

          const attemptEvents = recentEvents
            .filter((event) => event.eventName === "controlled-work.attempted")
            .map((event) =>
              Value.Decode(ControlledWorkAttemptedSchema, event.payload),
            );

          assert.deepEqual(attemptEvents, [
            {
              attempt: 2,
              workKey: "lease-head",
            },
          ]);

          successor.release();
          await harness.stopCompetingWorkers();
        });
      },
    );

    await t.test(
      "an empty partition key rolls back event materialization",
      async () => {
        await withHarness(input.create, async (harness) => {
          await assert.rejects(
            harness.ledger.emit("controlled-work.requested", {
              availableAtMs: null,
              workKey: "invalid-partition",
              partitionKey: "",
            }),
          );

          assert.deepEqual(await harness.getSeenSourceEventIds(), []);
          assert.deepEqual(await harness.ledger.listWork(), []);
        });
      },
    );

    await t.test(
      "cancelling a delayed partition head releases its due successor",
      async () => {
        await withHarness(input.create, async (harness) => {
          const successor = harness.prepareControlledWork("cancel-tail");
          const head = await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: harness.nowMs() + 200,
            workKey: "cancel-head",
            partitionKey: "cancel-lane",
          });

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "cancel-tail",
            partitionKey: "cancel-lane",
          });
          await harness.flush();
          const [headWork] = await harness.ledger.listWork({
            sourceEventId: head.eventId,
          });

          if (headWork?.ref === null || headWork === undefined) {
            throw new Error("expected delayed partition head ref");
          }

          const cancelled = await harness.ledger.cancelWork({
            ref: headWork.ref,
          });

          assert.equal(cancelled.status, "cancelled");

          await harness.advanceByMs(0);
          await successor.entered;
          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "cancel-tail",
          ]);

          successor.release();
        });
      },
    );

    await t.test("malformed work refs are rejected", async () => {
      await withHarness(input.create, async (harness) => {
        await assert.rejects(
          harness.ledger.cancelWork({
            ref: "controlled-work.run" as WorkRef,
          }),
        );
      });
    });

    await t.test(
      "a partition retry survives restart and blocks its successor",
      async () => {
        await withHarness(input.create, async (harness) => {
          const retryAtMs = harness.nowMs() + 200;
          const firstAttempt = harness.prepareControlledWorkAttempt(
            "retry-head",
            1,
            { kind: "retry", retryAtMs },
          );
          const secondAttempt = harness.prepareControlledWorkAttempt(
            "retry-head",
            2,
            { kind: "ack" },
          );
          const successor = harness.prepareControlledWork("retry-tail");
          const other = harness.prepareControlledWork("retry-other");
          const kick = harness.prepareControlledWork("retry-kick");

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "retry-head",
            partitionKey: "retry-lane",
          });
          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "retry-tail",
            partitionKey: "retry-lane",
          });
          await harness.flush();
          await firstAttempt.entered;

          await observeControlledAttempt(
            harness,
            "retry-head",
            1,
            firstAttempt.release,
          );

          await harness.restart();

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "retry-other",
            partitionKey: "other-lane",
          });
          await harness.flush();
          await other.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "retry-head",
            "retry-other",
          ]);

          await harness.advanceByMs(199);
          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "retry-head",
            "retry-other",
          ]);

          await harness.advanceByMs(1);
          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "retry-kick",
            partitionKey: "kick-lane",
          });
          await harness.flush();
          await secondAttempt.entered;
          await kick.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "retry-head",
            "retry-other",
            "retry-head",
            "retry-kick",
          ]);

          await observeControlledAttempt(
            harness,
            "retry-head",
            2,
            secondAttempt.release,
          );
          await harness.flush();
          await successor.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "retry-head",
            "retry-other",
            "retry-head",
            "retry-kick",
            "retry-tail",
          ]);

          successor.release();
          other.release();
          kick.release();
        });
      },
    );

    await t.test(
      "dead-lettered partitions release successors and can be reused",
      async () => {
        await withHarness(input.create, async (harness) => {
          const head = harness.prepareControlledWorkAttempt("dead-head", 1, {
            kind: "dead_letter",
          });
          const successor = harness.prepareControlledWork("dead-tail");
          const reused = harness.prepareControlledWork("dead-reused");

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "dead-head",
            partitionKey: "dead-lane",
          });
          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "dead-tail",
            partitionKey: "dead-lane",
          });
          await harness.flush();
          await head.entered;

          await observeControlledAttempt(harness, "dead-head", 1, head.release);
          await harness.flush();
          await successor.entered;

          await observeControlledAttempt(
            harness,
            "dead-tail",
            1,
            successor.release,
          );
          await harness.waitForIdle();

          const retainedDeadWork = await harness.ledger.listWork({
            states: ["dead"],
          });
          assert.equal(retainedDeadWork.length, 1);

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "dead-reused",
            partitionKey: "dead-lane",
          });
          await harness.flush();
          await reused.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "dead-head",
            "dead-tail",
            "dead-reused",
          ]);

          reused.release();
        });
      },
    );

    await t.test(
      "unpartitioned due work can overtake an earlier delayed item",
      async () => {
        await withHarness(input.create, async (harness) => {
          const delayed = harness.prepareControlledWork("unpartitioned-delay");
          const due = harness.prepareControlledWork("unpartitioned-due");

          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: harness.nowMs() + 200,
            workKey: "unpartitioned-delay",
            partitionKey: null,
          });
          await harness.ledger.emit("controlled-work.requested", {
            availableAtMs: null,
            workKey: "unpartitioned-due",
            partitionKey: null,
          });
          await harness.flush();
          await due.entered;

          assert.deepEqual(harness.getStartedControlledWorkKeys(), [
            "unpartitioned-due",
          ]);

          due.release();
          delayed.release();
        });
      },
    );

    await t.test("waitForIdle includes partition-blocked work", async () => {
      await withHarness(input.create, async (harness) => {
        const head = await harness.ledger.emit("controlled-work.requested", {
          availableAtMs: harness.nowMs() + 200,
          workKey: "idle-head",
          partitionKey: "idle-lane",
        });
        const successor = await harness.ledger.emit(
          "controlled-work.requested",
          {
            availableAtMs: null,
            workKey: "idle-tail",
            partitionKey: "idle-lane",
          },
        );
        await harness.flush();

        let idleResolved = false;
        const idle = harness.waitForIdle().then(() => {
          idleResolved = true;
        });

        const barrier = harness.prepareControlledWork("idle-barrier");
        await harness.ledger.emit("controlled-work.requested", {
          availableAtMs: null,
          workKey: "idle-barrier",
          partitionKey: "idle-barrier",
        });
        await harness.flush();
        await barrier.entered;
        await observeControlledAttempt(
          harness,
          "idle-barrier",
          1,
          barrier.release,
        );

        await harness.ledger.listWork();
        assert.equal(idleResolved, false);
        const work = await harness.ledger.listWork();
        const headWork = work.find(
          (item) => item.sourceEventId === head.eventId,
        );
        const successorWork = work.find(
          (item) => item.sourceEventId === successor.eventId,
        );

        if (
          headWork?.ref === null ||
          headWork === undefined ||
          successorWork?.ref === null ||
          successorWork === undefined
        ) {
          throw new Error("expected partition work refs");
        }

        await harness.ledger.cancelWork({
          ref: successorWork.ref,
        });
        await harness.ledger.cancelWork({
          ref: headWork.ref,
        });

        await idle;
        assert.equal(idleResolved, true);
      });
    });

    await t.test(
      "signal queue work shares partition ordering semantics",
      async () => {
        await withHarness(input.create, async (harness) => {
          const first = harness.prepareControlledWork("signal-a-1");
          const successor = harness.prepareControlledWork("signal-a-2");
          const other = harness.prepareControlledWork("signal-b-1");
          const observedSignals = new Map<string, PromiseWithResolvers<void>>([
            ["signal-a-1", Promise.withResolvers<void>()],
            ["signal-a-2", Promise.withResolvers<void>()],
            ["signal-b-1", Promise.withResolvers<void>()],
          ]);
          const waitForObservedSignal = (workKey: string): Promise<void> => {
            const observedSignal = observedSignals.get(workKey);
            assert.ok(observedSignal !== undefined);
            return observedSignal.promise;
          };
          const subscription = harness.ledger.onSignal(
            "controlled-work.signalled",
            (signal) => {
              const observedSignal = observedSignals.get(
                signal.payload.workKey,
              );
              assert.ok(observedSignal !== undefined);
              observedSignal.resolve();
            },
          );

          try {
            await harness.ledger.emit("controlled-signal-work.requested", {
              workKey: "signal-a-1",
              partitionKey: "signal-a",
            });
            await harness.flush();
            await waitForObservedSignal("signal-a-1");
            await harness.flush();
            await first.entered;

            await harness.ledger.emit("controlled-signal-work.requested", {
              workKey: "signal-a-2",
              partitionKey: "signal-a",
            });
            await harness.flush();
            await waitForObservedSignal("signal-a-2");

            await harness.ledger.emit("controlled-signal-work.requested", {
              workKey: "signal-b-1",
              partitionKey: "signal-b",
            });
            await harness.flush();
            await waitForObservedSignal("signal-b-1");
            await harness.flush();
            await other.entered;

            assert.deepEqual(harness.getStartedControlledWorkKeys(), [
              "signal-a-1",
              "signal-b-1",
            ]);

            first.release();
            await harness.flush();
            await successor.entered;

            assert.deepEqual(harness.getStartedControlledWorkKeys(), [
              "signal-a-1",
              "signal-b-1",
              "signal-a-2",
            ]);

            successor.release();
            other.release();
          } finally {
            subscription[Symbol.dispose]();
          }
        });
      },
    );

    await t.test("append event materializes and processes work", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("ack");

        await harness.ledger.emit("message.received", {
          type: "message.received",
          text: "hello",
        });

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          25,
        );

        const sourceEventId = await readSingleSourceEventId(harness);

        await waitFor(
          harness,
          async () => (await harness.getDispatchCount(sourceEventId)) === 1,
          2_000,
          25,
        );

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);
      });
    });

    await t.test(
      "nullable JSON null round trips through SQL null semantics",
      async () => {
        await withHarness(input.create, async (harness) => {
          const event = await harness.ledger.emit("message.received", {
            type: "message.received",
            text: "json null contract",
          });

          assert.deepEqual(
            await harness.ledger.query("jsonNullValues", {
              sourceEventId: event.eventId,
            }),
            {
              nullableValue: null,
              requiredJsonNull: null,
            },
          );
        });
      },
    );

    await t.test("dedupe key prevents duplicate downstream work", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("ack");

        await harness.ledger.emit(
          "message.received",
          {
            type: "message.received",
            text: "hello",
          },
          {
            dedupeKey: "same-message",
          },
        );

        await harness.ledger.emit(
          "message.received",
          {
            type: "message.received",
            text: "hello",
          },
          {
            dedupeKey: "same-message",
          },
        );

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          25,
        );

        const sourceEventId = await readSingleSourceEventId(harness);

        await waitFor(
          harness,
          async () => (await harness.getDispatchCount(sourceEventId)) === 1,
          2_000,
          25,
        );

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);
      });
    });

    await t.test("materialization failure rolls back event write", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("ack");
        harness.setMaterializationFailureText("boom");

        await assert.rejects(
          harness.ledger.emit("message.received", {
            type: "message.received",
            text: "boom",
          }),
        );

        await harness.flush();
        assert.equal((await harness.getSeenSourceEventIds()).length, 0);
      });
    });

    await t.test("retry outcome respects deterministic retryAtMs", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("retry_once");

        await harness.ledger.emit("message.received", {
          type: "message.received",
          text: "hello",
        });

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          1,
        );

        const sourceEventId = await readSingleSourceEventId(harness);

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          1,
        );

        await harness.advanceByMs(1);
        await harness.flush();

        assert.ok(
          (await harness.getDecisionAttempts(sourceEventId)) < 2,
          "retry should not execute immediately",
        );

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 2,
          2_000,
          1,
        );

        await waitFor(
          harness,
          async () => (await harness.getDispatchCount(sourceEventId)) === 1,
          2_000,
          1,
        );

        assert.equal(await harness.getDispatchCount(sourceEventId), 1);
      });
    });

    await t.test("dead letter outcome is terminal", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("dead_letter");

        await harness.ledger.emit("message.received", {
          type: "message.received",
          text: "hello",
        });

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          25,
        );

        const sourceEventId = await readSingleSourceEventId(harness);
        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);

        await harness.advanceByMs(5_000);
        await harness.flush();

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);
        assert.equal(await harness.getDispatchCount(sourceEventId), 0);
      });
    });

    await t.test("thrown handler failure falls back to retry", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("throw_once");

        await harness.ledger.emit("message.received", {
          type: "message.received",
          text: "hello",
        });

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          25,
        );

        const sourceEventId = await readSingleSourceEventId(harness);

        await harness.advanceByMs(1_000);

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 2,
          2_000,
          25,
        );

        await waitFor(
          harness,
          async () => (await harness.getDispatchCount(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDispatchCount(sourceEventId), 1);
      });
    });

    await t.test("restart rehydrates immediate pending work", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("ack");

        await harness.ledger.emit("message.received", {
          type: "message.received",
          text: "hello",
        });

        await harness.restart();

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          25,
        );

        const sourceEventId = await readSingleSourceEventId(harness);

        await waitFor(
          harness,
          async () => (await harness.getDispatchCount(sourceEventId)) === 1,
          2_000,
          25,
        );

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);
      });
    });

    await t.test("restart preserves delayed retry schedule", async () => {
      await withHarness(input.create, async (harness) => {
        harness.setDecisionMode("retry_once");

        await harness.ledger.emit("message.received", {
          type: "message.received",
          text: "hello",
        });

        await waitFor(
          harness,
          async () => (await harness.getSeenSourceEventIds()).length === 1,
          2_000,
          25,
        );

        const sourceEventId = await readSingleSourceEventId(harness);
        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);

        await harness.restart();

        await harness.flush();
        assert.equal(await harness.getDecisionAttempts(sourceEventId), 1);

        await harness.advanceByMs(200);

        await waitFor(
          harness,
          async () => (await harness.getDecisionAttempts(sourceEventId)) === 2,
          2_000,
          25,
        );

        await waitFor(
          harness,
          async () => (await harness.getDispatchCount(sourceEventId)) === 1,
          2_000,
          25,
        );

        assert.equal(await harness.getDispatchCount(sourceEventId), 1);
      });
    });

    await t.test(
      "restart aborts in flight handler and work is resumable",
      async () => {
        await withHarness(input.create, async (harness) => {
          harness.setDecisionMode("block_until_abort");

          await harness.ledger.emit("message.received", {
            type: "message.received",
            text: "hello",
          });

          await waitFor(
            harness,
            async () => (await harness.getSeenSourceEventIds()).length === 1,
            2_000,
            25,
          );

          const sourceEventId = await readSingleSourceEventId(harness);
          assert.equal(await harness.getDecisionAttempts(sourceEventId), 0);

          await harness.restart();
          harness.setDecisionMode("ack");

          await waitFor(
            harness,
            async () =>
              (await harness.getDecisionAttempts(sourceEventId)) === 2,
            2_000,
            25,
          );

          await waitFor(
            harness,
            async () => (await harness.getDispatchCount(sourceEventId)) === 1,
            2_000,
            25,
          );
        });
      },
    );

    await t.test(
      "long-running handler lease is renewed automatically",
      async () => {
        await withHarness(input.create, async (harness) => {
          harness.setDecisionMode("block_until_abort");

          await harness.ledger.emit("message.received", {
            type: "message.received",
            text: "hello",
          });

          await waitFor(
            harness,
            async () => (await harness.getSeenSourceEventIds()).length === 1,
            2_000,
            25,
          );

          const sourceEventId = await readSingleSourceEventId(harness);

          assert.equal(await harness.getDecisionAttempts(sourceEventId), 0);

          await harness.advanceByMs(5_000);
          await harness.flush();

          assert.equal(await harness.getDecisionAttempts(sourceEventId), 0);
          assert.equal(await harness.getDispatchCount(sourceEventId), 0);

          await harness.restart();
          harness.setDecisionMode("ack");

          await waitFor(
            harness,
            async () => (await harness.getDispatchCount(sourceEventId)) === 1,
            2_000,
            25,
          );

          assert.ok((await harness.getDecisionAttempts(sourceEventId)) >= 1);
        });
      },
    );
  });
}
