import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { IsUnion, Type } from "typebox";
import { Value } from "typebox/value";

import { createBetterSqliteDriver } from "../better-sqlite3.ts";
import { defineMaterialization } from "../ledger.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { defineLedger, defineModule, type LedgerDriver } from "../sledge.ts";
import { defineResult } from "../stdlib.ts";
import { createTursoDriver } from "../turso.ts";
import { defineAll } from "./all.ts";
import { defineRace } from "./race.ts";
import { defineThen } from "./then.ts";

const OutputSchema = Type.Object({ value: Type.String({ minLength: 1 }) });
const FailureSchema = Type.Object({ reason: Type.String({ minLength: 1 }) });
const DerivedFailureSchema = Type.Object({
  reason: Type.String({ minLength: 1 }),
});
const FinalFailureSchema = Type.Object({
  reason: Type.String({ minLength: 1 }),
});

type AlphaResultPort = ReturnType<
  ReturnType<typeof defineProducer<"experimental.contract.alpha">>
>["capabilities"]["result"];

function defineAlphaGroup(source: AlphaResultPort) {
  return defineAll("experimental.contract.alpha-group", [source]);
}

if (false) {
  defineLedger(async (sledge) => {
    const alpha = sledge.install(
      defineProducer("experimental.contract.alpha")(),
    );
    const group = sledge.install(defineAlphaGroup(alpha.result)());
    await sledge.query(group.queries.state, {
      // @ts-expect-error query parameter inference remains anchored to the token
      memberRef: alpha.result.ref("alpha"),
    });

    return { alpha, group };
  });
}

const adapters: readonly {
  readonly name: string;
  createDriver(databaseUrl: string): LedgerDriver;
}[] = [
  {
    name: "better-sqlite3",
    createDriver: (databaseUrl) => createBetterSqliteDriver({ databaseUrl }),
  },
  {
    name: "turso",
    createDriver: (databaseUrl) => createTursoDriver({ databaseUrl }),
  },
];

for (const adapter of adapters) {
  test(`${adapter.name} runs the experimental result algebra across restart`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-experimental-${adapter.name}-`),
    );
    const databaseUrl = join(directory.path, "algebra.sqlite");
    const runtime = new VirtualRuntimeHarness(1_000_000);
    const attempts = new Map<string, number>();
    const application = createAlgebraApplication(attempts);

    {
      await using opened = await application.open(
        adapter.createDriver(databaseUrl),
        { clock: runtime.clock, scheduler: runtime.scheduler },
      );
      await using workers = await opened.ledger.startWorkers({
        scheduler: runtime.scheduler,
        defaultRetryDelayMs: 10,
        maxInFlight: 8,
      });
      const failureSchema = opened.capabilities.flattened.result.failureSchema;

      assert.equal(IsUnion(failureSchema), true);

      if (!IsUnion(failureSchema)) {
        throw new Error("chained then failure schema was not a union");
      }

      assert.equal(
        failureSchema.anyOf.length,
        3,
        JSON.stringify(failureSchema),
      );
      assert.equal(
        failureSchema.anyOf.some((schema) => IsUnion(schema)),
        false,
      );
      const alphaOneRef = opened.capabilities.alpha.result.ref("one");
      const betaOneRef = opened.capabilities.beta.result.ref("one");
      const restartAllRef = opened.capabilities.all.result.ref("restart");

      await opened.ledger.emit(opened.capabilities.all.events.opened, {
        ref: restartAllRef,
        members: { alpha: alphaOneRef, beta: betaOneRef },
      });
      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: alphaOneRef,
        outcome: "succeeded",
        value: { value: "alpha" },
      });
      await drainWorkers(runtime, workers);

      assert.deepEqual(
        await opened.ledger.query(opened.capabilities.all.queries.state, {
          ref: restartAllRef,
        }),
        {
          kind: "pending",
          members: { alpha: alphaOneRef, beta: betaOneRef },
        },
      );
      assert.deepEqual(
        await opened.ledger.query(opened.capabilities.derived.queries.state, {
          ref: opened.capabilities.derived.refFor(alphaOneRef),
        }),
        {
          kind: "succeeded",
          sourceRef: alphaOneRef,
          output: { value: "ALPHA" },
        },
      );

      const restartRetrySourceRef =
        opened.capabilities.alpha.result.ref("restart-retry");

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: restartRetrySourceRef,
        outcome: "succeeded",
        value: { value: "restart-retry" },
      });
      await waitForAttempt(runtime, attempts, "restart-retry", 1);

      assert.deepEqual(
        await opened.ledger.query(opened.capabilities.derived.queries.state, {
          ref: opened.capabilities.derived.refFor(restartRetrySourceRef),
        }),
        { kind: "pending", sourceRef: restartRetrySourceRef },
      );
    }

    {
      await using opened = await application.open(
        adapter.createDriver(databaseUrl),
        { clock: runtime.clock, scheduler: runtime.scheduler },
      );
      await using workers = await opened.ledger.startWorkers({
        scheduler: runtime.scheduler,
        defaultRetryDelayMs: 10,
        maxInFlight: 8,
      });
      const alphaOneRef = opened.capabilities.alpha.result.ref("one");
      const betaOneRef = opened.capabilities.beta.result.ref("one");
      const restartAllRef = opened.capabilities.all.result.ref("restart");
      const restartRetrySourceRef =
        opened.capabilities.alpha.result.ref("restart-retry");

      assert.deepEqual(
        await opened.ledger.query(opened.capabilities.derived.queries.state, {
          ref: opened.capabilities.derived.refFor(restartRetrySourceRef),
        }),
        { kind: "pending", sourceRef: restartRetrySourceRef },
      );

      await runtime.advanceByMs(10);

      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.derived.queries.state, {
              ref: opened.capabilities.derived.refFor(restartRetrySourceRef),
            }),
          "succeeded",
        ),
        {
          kind: "succeeded",
          sourceRef: restartRetrySourceRef,
          output: { value: "RESTART-RETRY" },
        },
      );
      assert.equal(attempts.get("restart-retry"), 2);

      await opened.ledger.emit(opened.capabilities.beta.events.settled, {
        ref: betaOneRef,
        outcome: "cancelled",
      });
      const restartedAll = await waitForState(
        runtime,
        () =>
          opened.ledger.query(opened.capabilities.all.queries.state, {
            ref: restartAllRef,
          }),
        "settled",
      );

      assert.deepEqual(restartedAll, {
        kind: "settled",
        settlement: {
          ref: restartAllRef,
          outcome: "cancelled",
        },
      });
      await drainWorkers(runtime, workers);

      const historicalRaceRef = opened.capabilities.race.result.ref("history");

      const historicalRaceOpened = await opened.ledger.emit(
        opened.capabilities.race.events.opened,
        {
          ref: historicalRaceRef,
          members: { beta: betaOneRef, alpha: alphaOneRef },
        },
      );
      const historicalRace = await waitForState(
        runtime,
        () =>
          opened.ledger.query(opened.capabilities.race.queries.state, {
            ref: historicalRaceRef,
          }),
        "settled",
      );

      assert.deepEqual(historicalRace, {
        kind: "settled",
        settlement: {
          ref: historicalRaceRef,
          outcome: "succeeded",
          value: {
            winner: "alpha",
            ref: alphaOneRef,
          },
        },
      });
      assert.equal(
        await readLatestEventId(opened.ledger),
        historicalRaceOpened.eventId + 1,
        "a historical race appends only its opening and terminal facts",
      );

      const nestedAllRef = opened.capabilities.nestedAll.result.ref("nested");

      await opened.ledger.emit(opened.capabilities.nestedAll.events.opened, {
        ref: nestedAllRef,
        members: { previous: restartAllRef, alpha: alphaOneRef },
      });
      const nestedAll = await waitForState(
        runtime,
        () =>
          opened.ledger.query(opened.capabilities.nestedAll.queries.state, {
            ref: nestedAllRef,
          }),
        "settled",
      );

      assert.deepEqual(nestedAll, {
        kind: "settled",
        settlement: {
          ref: nestedAllRef,
          outcome: "cancelled",
        },
      });

      const lateAlphaRef = opened.capabilities.alpha.result.ref("late");
      const lateBetaRef = opened.capabilities.beta.result.ref("late");
      const lateRaceRef = opened.capabilities.race.result.ref("late");

      await opened.ledger.emit(opened.capabilities.race.events.opened, {
        ref: lateRaceRef,
        members: { alpha: lateAlphaRef, beta: lateBetaRef },
      });
      await opened.ledger.emit(opened.capabilities.beta.events.settled, {
        ref: lateBetaRef,
        outcome: "failed",
        error: { reason: "late beta failed" },
      });
      const raceBeforeLoser = await waitForState(
        runtime,
        () =>
          opened.ledger.query(opened.capabilities.race.queries.state, {
            ref: lateRaceRef,
          }),
        "settled",
      );

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: lateAlphaRef,
        outcome: "succeeded",
        value: { value: "too late" },
      });
      await drainWorkers(runtime, workers);

      assert.deepEqual(
        await opened.ledger.query(opened.capabilities.race.queries.state, {
          ref: lateRaceRef,
        }),
        raceBeforeLoser,
      );

      const concurrentAlphaRef =
        opened.capabilities.alpha.result.ref("concurrent");
      const concurrentBetaRef =
        opened.capabilities.beta.result.ref("concurrent");
      const concurrentRaceRef =
        opened.capabilities.race.result.ref("concurrent");

      await opened.ledger.emit(opened.capabilities.race.events.opened, {
        ref: concurrentRaceRef,
        members: { alpha: concurrentAlphaRef, beta: concurrentBetaRef },
      });
      const [concurrentAlpha, concurrentBeta] = await Promise.all([
        opened.ledger.emit(opened.capabilities.alpha.events.settled, {
          ref: concurrentAlphaRef,
          outcome: "succeeded",
          value: { value: "concurrent" },
        }),
        opened.ledger.emit(opened.capabilities.beta.events.settled, {
          ref: concurrentBetaRef,
          outcome: "failed",
          error: { reason: "concurrent beta failed" },
        }),
      ]);
      const alphaWon = concurrentAlpha.eventId < concurrentBeta.eventId;

      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.race.queries.state, {
              ref: concurrentRaceRef,
            }),
          "settled",
        ),
        {
          kind: "settled",
          settlement: alphaWon
            ? {
                ref: concurrentRaceRef,
                outcome: "succeeded",
                value: {
                  winner: "alpha",
                  ref: concurrentAlphaRef,
                },
              }
            : {
                ref: concurrentRaceRef,
                outcome: "failed",
                error: {
                  winner: "beta",
                  ref: concurrentBetaRef,
                },
              },
        },
      );

      const mixedAllRef = opened.capabilities.all.result.ref("mixed");

      await opened.ledger.emit(opened.capabilities.all.events.opened, {
        ref: mixedAllRef,
        members: {
          cancelled: betaOneRef,
          failed: lateBetaRef,
          succeeded: alphaOneRef,
        },
      });
      const mixedAll = await waitForState(
        runtime,
        () =>
          opened.ledger.query(opened.capabilities.all.queries.state, {
            ref: mixedAllRef,
          }),
        "settled",
      );

      assert.equal(
        mixedAll?.kind === "settled" ? mixedAll.settlement.outcome : null,
        "failed",
      );

      const hydratedAlphaRef =
        opened.capabilities.alpha.result.ref("hydrated-alpha");
      const hydratedBetaRef =
        opened.capabilities.beta.result.ref("hydrated-beta");
      const hydratedGroupRef = opened.capabilities.all.result.ref("hydrated");

      await opened.ledger.emit(opened.capabilities.all.events.opened, {
        ref: hydratedGroupRef,
        members: {
          alpha: hydratedAlphaRef,
          beta: hydratedBetaRef,
        },
      });
      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: hydratedAlphaRef,
        outcome: "succeeded",
        value: { value: "alpha-value" },
      });
      await opened.ledger.emit(opened.capabilities.beta.events.settled, {
        ref: hydratedBetaRef,
        outcome: "succeeded",
        value: { value: "beta-value" },
      });

      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.hydrated.queries.state, {
              ref: opened.capabilities.hydrated.refFor(hydratedGroupRef),
            }),
          "succeeded",
        ),
        {
          kind: "succeeded",
          sourceRef: hydratedGroupRef,
          output: { value: "alpha-value+beta-value" },
        },
      );

      const accessSourceRef = opened.capabilities.alpha.result.ref("access");

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: accessSourceRef,
        outcome: "succeeded",
        value: { value: "access" },
      });
      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.derived.queries.state, {
              ref: opened.capabilities.derived.refFor(accessSourceRef),
            }),
          "succeeded",
        ),
        {
          kind: "succeeded",
          sourceRef: accessSourceRef,
          output: { value: "ACCESS" },
        },
      );

      const retrySourceRef = opened.capabilities.alpha.result.ref("retry");
      const retryDerivedRef =
        opened.capabilities.derived.refFor(retrySourceRef);

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: retrySourceRef,
        outcome: "succeeded",
        value: { value: "retry" },
      });
      await waitForAttempt(runtime, attempts, "retry", 1);
      assert.deepEqual(
        await opened.ledger.query(opened.capabilities.derived.queries.state, {
          ref: retryDerivedRef,
        }),
        { kind: "pending", sourceRef: retrySourceRef },
      );

      await runtime.advanceByMs(10);
      const retried = await waitForState(
        runtime,
        () =>
          opened.ledger.query(opened.capabilities.derived.queries.state, {
            ref: retryDerivedRef,
          }),
        "succeeded",
      );

      assert.deepEqual(retried, {
        kind: "succeeded",
        sourceRef: retrySourceRef,
        output: { value: "RETRY" },
      });
      assert.equal(attempts.get("retry"), 2);

      const timeoutSourceRef = opened.capabilities.alpha.result.ref("timeout");

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: timeoutSourceRef,
        outcome: "succeeded",
        value: { value: "timeout" },
      });
      await waitForAttempt(runtime, attempts, "timeout", 1);
      await runtime.advanceByMs(5);

      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.derived.queries.state, {
              ref: opened.capabilities.derived.refFor(timeoutSourceRef),
            }),
          "failed",
        ),
        {
          kind: "failed",
          sourceRef: timeoutSourceRef,
          error: { reason: "operation timed out" },
        },
      );

      const terminalSourceRef =
        opened.capabilities.alpha.result.ref("terminal");

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: terminalSourceRef,
        outcome: "succeeded",
        value: { value: "terminal" },
      });
      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.derived.queries.state, {
              ref: opened.capabilities.derived.refFor(terminalSourceRef),
            }),
          "failed",
        ),
        {
          kind: "failed",
          sourceRef: terminalSourceRef,
          error: { reason: "terminal rejection" },
        },
      );

      const failedSourceRef = opened.capabilities.alpha.result.ref("failed");

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: failedSourceRef,
        outcome: "failed",
        error: { reason: "source failed" },
      });
      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.derived.queries.state, {
              ref: opened.capabilities.derived.refFor(failedSourceRef),
            }),
          "failed",
        ),
        {
          kind: "failed",
          sourceRef: failedSourceRef,
          error: { reason: "source failed" },
        },
      );
      assert.equal(attempts.has("failed"), false);

      const cancelledSourceRef =
        opened.capabilities.alpha.result.ref("cancelled");

      await opened.ledger.emit(opened.capabilities.alpha.events.settled, {
        ref: cancelledSourceRef,
        outcome: "cancelled",
      });
      assert.deepEqual(
        await waitForState(
          runtime,
          () =>
            opened.ledger.query(opened.capabilities.derived.queries.state, {
              ref: opened.capabilities.derived.refFor(cancelledSourceRef),
            }),
          "cancelled",
        ),
        { kind: "cancelled", sourceRef: cancelledSourceRef },
      );
      assert.equal(attempts.has("cancelled"), false);

      await assert.rejects(
        opened.ledger.emit(opened.capabilities.all.events.opened, {
          ref: opened.capabilities.all.result.ref("duplicate"),
          members: { first: alphaOneRef, second: alphaOneRef },
        }),
        /composition member ref .* is duplicated/,
      );
      await assert.rejects(
        opened.ledger.emit(opened.capabilities.all.events.opened, {
          ref: opened.capabilities.all.result.ref("empty"),
          members: {},
        }),
      );
      await assert.rejects(
        opened.ledger.emit(opened.capabilities.all.events.opened, {
          ref: opened.capabilities.all.result.ref("empty-key"),
          members: { "": alphaOneRef },
        }),
      );

      if (false) {
        await opened.ledger.emit(opened.capabilities.all.events.opened, {
          ref: opened.capabilities.all.result.ref("foreign"),
          members: {
            // @ts-expect-error only refs from admitted sources are accepted
            foreign: opened.capabilities.foreign.result.ref("foreign"),
          },
        });
      }
    }
  });
}

test("experimental compositions require distinct, non-empty sources", () => {
  const producer = defineProducer("experimental.contract.single")();
  const other = defineProducer("experimental.contract.other")();
  const sameModuleFacade = {
    ...other.capabilities.result,
    moduleId: producer.capabilities.result.moduleId,
  };
  const sameEventFacade = {
    ...producer.capabilities.result,
    moduleId: other.capabilities.result.moduleId,
  };

  assert.throws(
    () =>
      // @ts-expect-error untyped callers must also be rejected at construction
      defineRace("experimental.contract.empty", []),
    /race requires at least one result source/,
  );
  assert.throws(
    () =>
      defineAll("experimental.contract.same-event", [
        producer.capabilities.result,
        sameEventFacade,
      ]),
    /unique terminal events/,
  );
  assert.throws(
    () =>
      defineAll("experimental.contract.same-module", [
        producer.capabilities.result,
        sameModuleFacade,
      ]),
    /result sources must come from distinct modules/,
  );
});

function createAlgebraApplication(attempts: Map<string, number>) {
  return defineLedger((sledge) => {
    const alpha = sledge.install(
      defineProducer("experimental.contract.alpha")(),
    );
    const beta = sledge.install(defineProducer("experimental.contract.beta")());
    const foreign = sledge.install(
      defineProducer("experimental.contract.foreign")(),
    );
    const schemaSource = sledge.install(
      defineProducer("experimental.contract.schema-source")(),
    );
    const schemaMiddle = sledge.install(
      defineThen("experimental.contract.schema-middle", schemaSource.result, {
        resultSchema: OutputSchema,
        failureSchema: DerivedFailureSchema,
        execute: async ({ value }) => ({ outcome: "succeeded", value }),
      })(),
    );
    const flattened = sledge.install(
      defineThen("experimental.contract.flattened-then", schemaMiddle.result, {
        resultSchema: OutputSchema,
        failureSchema: FinalFailureSchema,
        execute: async ({ value }) => ({ outcome: "succeeded", value }),
      })(),
    );
    const all = sledge.install(
      defineAll("experimental.contract.all", [alpha.result, beta.result])(),
    );
    const race = sledge.install(
      defineRace("experimental.contract.race", [alpha.result, beta.result])(),
    );
    const nestedAll = sledge.install(
      defineAll("experimental.contract.nested-all", [
        all.result,
        alpha.result,
      ])(),
    );
    const hydrated = sledge.install(
      defineThen("experimental.contract.hydrated-all", all.result, {
        resultSchema: OutputSchema,
        failureSchema: Type.Never(),
        reads: [alpha.result, beta.result],
        execute: async ({ value, ledger }) => {
          const alphaMember = value.members.alpha;
          const betaMember = value.members.beta;

          if (alphaMember === undefined || betaMember === undefined) {
            throw new Error("hydration group lost a named member");
          }

          const [alphaResult, betaResult] = await Promise.all([
            ledger.read(
              alpha.result,
              Value.Decode(alpha.result.refSchema, alphaMember.ref),
            ),
            ledger.read(
              beta.result,
              Value.Decode(beta.result.refSchema, betaMember.ref),
            ),
          ]);

          if (
            alphaResult?.outcome !== "succeeded" ||
            betaResult?.outcome !== "succeeded"
          ) {
            throw new Error("successful all result lost a member value");
          }

          return {
            outcome: "succeeded",
            value: {
              value: `${alphaResult.value.value}+${betaResult.value.value}`,
            },
          };
        },
      })(),
    );
    const derived = sledge.install(
      defineThen("experimental.contract.then", alpha.result, {
        resultSchema: OutputSchema,
        failureSchema: DerivedFailureSchema,
        access: {
          events: {},
          queries: { sourceState: alpha.result.reader.query },
        },
        execute: async ({
          sourceRef,
          value,
          attempt,
          signal,
          ledger,
          withTimeout,
        }) => {
          attempts.set(value.value, attempt);
          signal.throwIfAborted();
          if (value.value === "access") {
            const sourceState = await ledger.query(
              alpha.result.reader.query,
              alpha.result.reader.params(sourceRef),
            );
            const sourceObservation = alpha.result.reader.observe(
              sourceState,
              sourceRef,
            );

            assert.equal(sourceObservation?.outcome, "succeeded");
          }

          if (
            (value.value === "retry" || value.value === "restart-retry") &&
            attempt === 1
          ) {
            throw new Error("retry once");
          }

          if (value.value === "terminal") {
            return {
              outcome: "failed",
              error: { reason: "terminal rejection" },
            };
          }

          if (value.value === "timeout") {
            try {
              await withTimeout(5, async (operationSignal) => {
                await rejectWhenAborted(operationSignal);
              });
            } catch {
              signal.throwIfAborted();
              return {
                outcome: "failed",
                error: { reason: "operation timed out" },
              };
            }

            throw new Error("timed operation completed without aborting");
          }

          const output = await withTimeout(100, async (operationSignal) => {
            operationSignal.throwIfAborted();
            return { value: value.value.toUpperCase() };
          });

          return { outcome: "succeeded", value: output };
        },
      })(),
    );
    return {
      all,
      alpha,
      beta,
      derived,
      flattened,
      foreign,
      hydrated,
      nestedAll,
      race,
    };
  });
}

function defineProducer<const TModuleId extends string>(moduleId: TModuleId) {
  return defineModule(moduleId, (module) => {
    const result = defineResult(module, {
      resultSchema: OutputSchema,
      failureSchema: FailureSchema,
    });
    const SettledSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("succeeded"),
        value: OutputSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("failed"),
        error: FailureSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]);
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([Type.Null(), SettledSchema]);
    const declaration = module.declare({ events: { settled: SettledSchema } });
    const materialization = defineMaterialization(declaration, {
      namespace: "producer",
    })
      .version(1, "record terminal results", (schema) =>
        schema.createTable("results", (table) =>
          table
            .columns({
              ref: table.text().notNull(),
              source: table.eventRef("settled").notNull(),
            })
            .primaryKey(["ref"]),
        ),
      )
      .define({
        indexers: {
          settle: { sourceEvent: "settled", input: SettledSchema },
        },
        queries: {
          state: { params: StateParamsSchema, result: StateResultSchema },
        },
      });
    const registered = module.link(declaration, materialization).register({
      events: {
        settled: async ({ event, actions }) => {
          await actions.index("settle", event.payload);
        },
      },
      indexers: {
        settle: async ({ input: settlement, event, db }) => {
          await db
            .insertInto("results")
            .values({ ref: settlement.ref, source: event.ref })
            .execute();
        },
      },
      queries: {
        state: async ({ params, db }) => {
          const result = await db
            .selectFrom("results")
            .selectEvent("source")
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          return result?.payload ?? null;
        },
      },
    });
    const resultPort = result
      .fromEvent(registered.events.settled, (payload) => {
        if (payload.outcome === "succeeded") {
          return {
            ref: payload.ref,
            outcome: payload.outcome,
            value: payload.value,
          };
        }

        if (payload.outcome === "failed") {
          return {
            ref: payload.ref,
            outcome: payload.outcome,
            error: payload.error,
          };
        }

        return { ref: payload.ref, outcome: payload.outcome };
      })
      .readFrom(registered.queries.state, {
        observe: (state) => {
          if (state === null) {
            return null;
          }

          if (state.outcome === "succeeded") {
            return {
              ref: state.ref,
              outcome: state.outcome,
              value: state.value,
            };
          }

          if (state.outcome === "failed") {
            return {
              ref: state.ref,
              outcome: state.outcome,
              error: state.error,
            };
          }

          return { ref: state.ref, outcome: state.outcome };
        },
      });

    return module.expose(registered, {
      events: { settled: registered.events.settled },
      result: resultPort,
    });
  });
}

async function waitForState<TState>(
  runtime: VirtualRuntimeHarness,
  read: () => Promise<TState>,
  kind: string,
): Promise<TState> {
  let latest!: TState;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    await runtime.flush();
    latest = await read();

    if (
      typeof latest === "object" &&
      latest !== null &&
      "kind" in latest &&
      latest.kind === kind
    ) {
      return latest;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(`experimental algebra did not reach ${kind}`);
}

async function waitForAttempt(
  runtime: VirtualRuntimeHarness,
  attempts: ReadonlyMap<string, number>,
  key: string,
  expected: number,
): Promise<void> {
  for (let check = 0; check < 200; check += 1) {
    await runtime.flush();

    if (attempts.get(key) === expected) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(
    `experimental algebra did not run ${key} attempt ${expected}`,
  );
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();

  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

async function readLatestEventId(ledger: {
  tailEvents(input: {
    readonly last: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<{ readonly event: { readonly eventId: number } }>;
}): Promise<number> {
  const controller = new AbortController();
  const iterator = ledger
    .tailEvents({ last: 1, signal: controller.signal })
    [Symbol.asyncIterator]();

  try {
    const latest = await iterator.next();

    if (latest.done) {
      throw new Error("expected at least one durable event");
    }

    return latest.value.event.eventId;
  } finally {
    controller.abort();
    await iterator.return?.();
  }
}

async function drainWorkers(
  runtime: VirtualRuntimeHarness,
  workers: {
    waitForIdle(input: { readonly signal: AbortSignal }): Promise<void>;
  },
): Promise<void> {
  const controller = new AbortController();
  let settled = false;
  const idle = workers.waitForIdle({ signal: controller.signal }).then(() => {
    settled = true;
  });

  try {
    for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
      await runtime.flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (!settled) {
      throw new Error("experimental algebra workers did not become idle");
    }

    await idle;
  } finally {
    controller.abort();
  }
}
