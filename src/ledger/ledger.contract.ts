import { Type } from "typebox";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  Ledger,
  MaterializationImplementationRegistration,
} from "./ledger.ts";
import {
  defineLedgerShape,
  defineMaterialization,
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

const EvaluateMessageQueueSchema = Type.Object({
  sourceEventId: Type.Number(),
  text: Type.String(),
});

const DispatchIntentQueueSchema = Type.Object({
  intentEventId: Type.Number(),
  sourceEventId: Type.Number(),
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

const ledgerContractShape = defineLedgerShape({
  events: {
    "message.received": MessageReceivedSchema,
    "decision.attempted": DecisionAttemptedSchema,
    "intent.planned": IntentPlannedSchema,
    "dispatch.completed": DispatchCompletedSchema,
  },
  queues: {
    "evaluate.message": EvaluateMessageQueueSchema,
    "dispatch.intent": DispatchIntentQueueSchema,
  },
  signals: {},
  signalQueues: {},
});

const ledgerContractMaterializations = defineMaterialization(
  ledgerContractShape,
  {
    namespace: "contract",
  },
)
  .version(1, "create contract projection", (s) =>
    s.createTable("contractProjection", (t) =>
      t
        .columns({
          sourceEventId: t.integer().notNull(),
          decisionAttempts: t.integer().notNull(),
          dispatchCount: t.integer().notNull(),
          plannedIntentEventId: t.integer(),
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
  },
} satisfies MaterializationImplementationRegistration<
  typeof ledgerContractSchema,
  typeof ledgerContractMaterializations.indexers,
  typeof ledgerContractMaterializations.queries
>;

type LedgerContractEvents = typeof ledgerContractShape.shape.events;
type LedgerContractQueries = typeof ledgerContractDefinition.model.queries;
type LedgerContractModel = ReturnType<typeof ledgerContractDefinition.register>;

export type LedgerContractDecisionMode =
  | "ack"
  | "retry_once"
  | "dead_letter"
  | "throw_once"
  | "block_until_abort";

export type LedgerContractHarness = {
  readonly ledger: Ledger<LedgerContractEvents, LedgerContractQueries>;

  nowMs(): number;
  advanceByMs(ms: number): Promise<void>;
  flush(): Promise<void>;

  restart(): Promise<void>;
  stop(): Promise<void>;

  setDecisionMode(mode: LedgerContractDecisionMode): void;
  setMaterializationFailureText(text: string | null): void;

  getDecisionAttempts(sourceEventId: number): Promise<number>;
  getDispatchCount(sourceEventId: number): Promise<number>;
  getSeenSourceEventIds(): Promise<readonly number[]>;
};

type LedgerContractHarnessFactory = () => Promise<LedgerContractHarness>;

export function createLedgerContractModel(input: {
  readDecisionMode(): LedgerContractDecisionMode;
  readMaterializationFailureText(): string | null;
  nowMs(): number;
}): LedgerContractModel {
  return ledgerContractDefinition.register({
    indexers: ledgerContractImplementations.indexers,
    queries: ledgerContractImplementations.queries,
    events: {
      "message.received": async ({ event, actions }) => {
        await actions.index("upsertObserved", {
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
    const readSingleSourceEventId = async (
      harness: LedgerContractHarness,
    ): Promise<number> => {
      const sourceEventIds = await harness.getSeenSourceEventIds();
      const sourceEventId = sourceEventIds[0];

      assert.ok(sourceEventId !== undefined);

      return sourceEventId;
    };

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
