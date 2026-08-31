import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { createBetterSqliteDriver } from "../better-sqlite3.ts";
import {
  defineMaterialization,
  type EventToken,
  type LedgerWorkerQueue,
} from "../ledger/ledger.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { defineLedger, defineModule, type LedgerDriver } from "../sledge.ts";
import { createTursoDriver } from "../turso.ts";
import {
  CoalescingOperation,
  type EventPort,
  ForEach,
  MapAsync,
  SettlementSchema,
} from "./operators.ts";

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
  test(`${adapter.name} coalescing operators run one generation per key at a time`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-coalescing-operator-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(10_000);
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const executions: string[] = [];
    const continuations: string[] = [];
    const activeByKey = new Map<string, number>();
    let maximumActiveForA = 0;
    let aGenerations = 0;
    const Input = Type.Object({ key: Type.String({ minLength: 1 }) });
    const Output = Type.String({ minLength: 1 });
    const coalesce = new CoalescingOperation("coalesce", {
      input: Input,
      output: Output,
      timeoutMs: 1_000,
      queries: {},
      keyBy: (input) => input.key,
      run: async (input) => {
        const active = (activeByKey.get(input.key) ?? 0) + 1;
        activeByKey.set(input.key, active);
        maximumActiveForA = Math.max(
          maximumActiveForA,
          input.key === "a" ? active : 0,
        );
        executions.push(input.key);

        if (input.key === "a") {
          aGenerations += 1;
        }

        try {
          if (input.key === "a" && aGenerations === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }

          return input.key;
        } finally {
          activeByKey.set(input.key, active - 1);
        }
      },
    });
    const defineFlow = defineModule(
      `experimental.contract.coalescing-${adapter.name}`,
      (module) => {
        const requested = module.event("requested", Input);
        const completed = module.event("completed", Output);
        const settled = module.bind("coalesced", requested, coalesce, {
          continueWith: completed,
        });

        if (false) {
          // A coalescing operation always completes through an explicit typed
          // continuation; its settlement is the failure-observation seam.
          // @ts-expect-error missing required continuation event
          module.bind("missing-continuation", requested, coalesce);
        }

        const declaration = module.declare({
          events: { requested, completed, coalesced: settled },
        });
        const registered = module.link(declaration, null, {
          events: {
            completed: ({ event }) => {
              continuations.push(event.payload);
            },
          },
        });

        return module.expose(registered, { requested, completed, settled });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "operator.sqlite")),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 4 }),
      scheduler: runtime.scheduler,
    });

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "a",
    });
    await runtime.flush();
    await firstStarted.promise;

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "a",
    });
    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "a",
    });
    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "b",
    });
    await runtime.flush();
    releaseFirst.resolve();
    await driveUntilIdle(runtime, workers);

    assert.equal(maximumActiveForA, 1);
    assert.deepEqual(executions.sort(), ["a", "a", "b"]);
    assert.deepEqual(continuations.sort(), ["a", "a", "b"]);
  });

  test(`${adapter.name} coalescing operators reject ambiguous same-key payloads`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-coalescing-payload-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(20_000);
    const activeStarted = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    const Input = Type.Object({
      key: Type.String({ minLength: 1 }),
      revision: Type.Integer({ minimum: 1 }),
    });
    const Output = Type.Integer({ minimum: 1 });
    const refresh = new CoalescingOperation("refresh", {
      input: Input,
      output: Output,
      timeoutMs: 1_000,
      queries: {},
      keyBy: (input) => input.key,
      run: async (input) => {
        if (input.key === "active") {
          activeStarted.resolve();
          await releaseActive.promise;
        }

        return input.revision;
      },
    });
    const defineFlow = defineModule(
      `experimental.contract.coalescing-payload-${adapter.name}`,
      (module) => {
        const requested = module.event("requested", Input);
        const completed = module.event("completed", Output);
        const settled = module.bind("refreshed", requested, refresh, {
          continueWith: completed,
        });
        const declaration = module.declare({
          events: { requested, completed },
        });
        const registered = module.link(declaration, null, {});

        return module.expose(registered, { requested, settled });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "operator.sqlite")),
      runtime,
    );

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "document-1",
      revision: 1,
    });

    await assert.rejects(
      opened.ledger.emit(opened.capabilities.flow.requested, {
        key: "document-1",
        revision: 2,
      }),
      /payload does not match the pending item/,
    );

    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 2 }),
      scheduler: runtime.scheduler,
    });
    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "active",
      revision: 1,
    });
    await driveUntil(runtime, activeStarted.promise);

    await assert.rejects(
      opened.ledger.emit(opened.capabilities.flow.requested, {
        key: "active",
        revision: 2,
      }),
      /payload does not match the live generation/,
    );

    releaseActive.resolve();
    await driveUntilIdle(runtime, workers);
  });

  test(`${adapter.name} coalescing operators reject invalid runtime keys`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-coalescing-key-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(25_000);
    const Demand = Type.Object({ key: Type.String() });
    const invalid = new CoalescingOperation("invalid-key", {
      input: Demand,
      output: Type.String(),
      timeoutMs: 1_000,
      queries: {},
      // @ts-expect-error exercise an untyped caller crossing the runtime boundary
      keyBy: () => 42,
      run: (demand) => demand.key,
    });
    const application = defineLedger((sledge) => ({
      flow: sledge.install(
        defineModule(
          `experimental.contract.coalescing-key-${adapter.name}`,
          (module) => {
            const requested = module.event("requested", Demand);
            const completed = module.event("completed", Type.String());
            module.bind("invalid", requested, invalid, {
              continueWith: completed,
            });
            const declaration = module.declare({ events: {} });
            const registered = module.link(declaration, null, {});

            return module.expose(registered, { requested });
          },
        )(),
      ),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "operator.sqlite")),
      runtime,
    );

    await assert.rejects(
      opened.ledger.emit(opened.capabilities.flow.requested, { key: "a" }),
      /must produce a non-empty string coalescing key/,
    );
  });

  test(`${adapter.name} coalescing operations query authority and continue atomically`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-coalescing-continuation-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(30_000);
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const authorityObserved: boolean[] = [];
    const settlements: unknown[] = [];
    let orderedRuns = 0;
    const Demand = Type.Object({ key: Type.String({ minLength: 1 }) });
    const Completed = Type.String({ minLength: 1 });
    const application = defineLedger((sledge) => {
      const destination = sledge.install(
        defineModule(
          `experimental.contract.coalescing-destination-${adapter.name}`,
          (module) => {
            const completed = module.event("completed", Completed);
            const declaration = module.declare({ events: { completed } });
            const materialization = defineMaterialization(declaration, {
              namespace: "coalescing-destination",
            })
              .version(1, "record completed operations", (schema) =>
                schema.createTable("completed", (table) =>
                  table
                    .columns({ key: table.text().notNull() })
                    .primaryKey(["key"]),
                ),
              )
              .define({
                indexers: { recordCompleted: module.indexer(completed) },
                queries: {
                  isCompleted: {
                    params: Demand,
                    result: Type.Boolean(),
                  },
                },
              });
            const registered = module.link(declaration, materialization, {
              indexers: {
                recordCompleted: async ({ input, db }) => {
                  await db
                    .insertInto("completed")
                    .values({ key: input })
                    .onConflict(["key"])
                    .doNothing()
                    .execute();
                },
              },
              queries: {
                isCompleted: async ({ params, db }) => {
                  const row = await db
                    .selectFrom("completed")
                    .select(["key"])
                    .where("key", "=", params.key)
                    .executeTakeFirst();

                  return row !== null;
                },
              },
            });

            return module.expose(registered, {
              completed,
              isCompleted: registered.queries.isCompleted,
            });
          },
        )(),
      );
      const operation = new CoalescingOperation("run", {
        input: Demand,
        output: Completed,
        timeoutMs: 1_000,
        queries: { isCompleted: destination.isCompleted },
        keyBy: (demand) => demand.key,
        run: async (demand, context) => {
          const completed = await context.ledger.query(
            destination.isCompleted,
            demand,
          );
          authorityObserved.push(completed);

          if (demand.key === "failed") {
            throw new Error("operation failed");
          }

          if (demand.key === "ordered") {
            orderedRuns += 1;

            if (orderedRuns === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            }
          }

          return demand.key;
        },
      });
      assert.throws(
        () =>
          defineModule(
            `experimental.contract.coalescing-undeclared-query-${adapter.name}`,
            (module) => {
              const requested = module.event("requested", Demand);
              const continueWith = module.import(destination.completed);
              module.bind("run", requested, operation, { continueWith });
              const declaration = module.declare({ events: {} });
              const registered = module.link(declaration, null, {});

              return module.expose(registered, {});
            },
          )(),
        /coalescing operation run requires an undeclared query/,
      );
      const flow = sledge.install(
        defineModule(
          `experimental.contract.coalescing-flow-${adapter.name}`,
          (module) => {
            const requested = module.event("requested", Demand);
            const continueWith = module.import(destination.completed);
            const settled = module.bind("run", requested, operation, {
              continueWith,
            });
            const declaration = module.declare({
              events: { requested, run: settled },
              queries: { isCompleted: destination.isCompleted },
            });
            const registered = module.link(declaration, null, {
              events: {
                run: ({ event }) => {
                  settlements.push(event.payload);
                },
              },
            });

            return module.expose(registered, { requested });
          },
        )(),
      );

      return { destination, flow };
    });
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "operator.sqlite")),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 4 }),
      scheduler: runtime.scheduler,
    });

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "ordered",
    });
    await driveUntil(runtime, firstStarted.promise);
    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "ordered",
    });
    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "ordered",
    });
    releaseFirst.resolve();
    await driveUntilIdle(runtime, workers);

    assert.equal(orderedRuns, 2);
    assert.deepEqual(authorityObserved, [false, true]);

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "failed",
    });
    await driveUntilIdle(runtime, workers);

    assert.deepEqual(
      settlements.map(
        (settlement) =>
          Value.Decode(SettlementSchema(Completed), settlement).outcome,
      ),
      ["succeeded", "succeeded", "failed"],
    );
    assert.equal(
      await opened.ledger.query(opened.capabilities.destination.isCompleted, {
        key: "failed",
      }),
      false,
    );
  });

  test(`${adapter.name} coalescing operations preserve identity and propagate cancellation`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-coalescing-recovery-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(40_000);
    const firstStarted = Promise.withResolvers<void>();
    const attempts: { readonly attempt: number; readonly key: string }[] = [];
    const aborted: string[] = [];
    const continuations: string[] = [];
    const settlements: unknown[] = [];
    let recoveryRuns = 0;
    const Demand = Type.Object({ key: Type.String({ minLength: 1 }) });
    const Completed = Type.String({ minLength: 1 });
    const operation = new CoalescingOperation("recover", {
      input: Demand,
      output: Completed,
      timeoutMs: 5,
      queries: {},
      keyBy: (demand) => demand.key,
      run: async (demand, context) => {
        attempts.push({ key: context.key, attempt: context.attempt });

        if (demand.key === "recover") {
          recoveryRuns += 1;

          if (recoveryRuns === 1) {
            firstStarted.resolve();
            await waitForAbort(context.signal);
            aborted.push(demand.key);
            context.signal.throwIfAborted();
          }
        }

        if (demand.key === "timeout") {
          await waitForAbort(context.signal);
          aborted.push(demand.key);
          context.signal.throwIfAborted();
        }

        return demand.key;
      },
    });
    const defineFlow = defineModule(
      `experimental.contract.coalescing-recovery-${adapter.name}`,
      (module) => {
        const requested = module.event("requested", Demand);
        const completed = module.event("completed", Completed);
        const settled = module.bind("recover", requested, operation, {
          continueWith: completed,
        });
        const declaration = module.declare({
          events: { requested, completed, recover: settled },
        });
        const registered = module.link(declaration, null, {
          events: {
            completed: ({ event }) => {
              continuations.push(event.payload);
            },
            recover: ({ event }) => {
              settlements.push(event.payload);
            },
          },
        });

        return module.expose(registered, { requested });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "operator.sqlite")),
      runtime,
    );
    const firstWorkers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 1,
    });

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "recover",
    });
    await driveUntil(runtime, firstStarted.promise);
    await firstWorkers.close();

    await using recoveredWorkers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 1,
    });
    await driveUntilIdle(runtime, recoveredWorkers);

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.key, attempts[1]?.key);
    assert.deepEqual(
      attempts.map((attempt) => attempt.attempt),
      [1, 2],
    );
    assert.deepEqual(aborted, ["recover"]);
    assert.deepEqual(continuations, ["recover"]);

    await opened.ledger.emit(opened.capabilities.flow.requested, {
      key: "timeout",
    });
    await driveUntilIdle(runtime, recoveredWorkers);

    assert.deepEqual(aborted, ["recover", "timeout"]);
    assert.deepEqual(continuations, ["recover"]);
    assert.deepEqual(
      settlements.map(
        (settlement) =>
          Value.Decode(SettlementSchema(Completed), settlement).outcome,
      ),
      ["succeeded", "failed"],
    );
  });

  test(`${adapter.name} operator bindings compose, fan out, reuse behavior, and survive restart`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-operators-${adapter.name}-`),
    );
    const databaseUrl = join(directory.path, "operators.sqlite");
    const runtime = new VirtualRuntimeHarness(10_000);
    const executions: string[] = [];
    const effectKeys: string[] = [];
    const ordinaryHandlers: string[] = [];
    const summaryOrigins: string[] = [];
    const summaryDispatch: string[] = [];
    const Normalized = Type.Object({
      source: Type.String({ minLength: 1 }),
      value: Type.String({ minLength: 1 }),
    });
    const NormalizedSettlement = SettlementSchema(Normalized);
    const Summary = Type.Object({ summary: Type.String({ minLength: 1 }) });
    const normalize = new MapAsync("normalize", {
      input: Type.String({ minLength: 1 }),
      output: Normalized,
      timeoutMs: 1_000,
      map: (input) => {
        executions.push(`normalize:${input}`);
        return { source: input, value: input.trim().toUpperCase() };
      },
    });
    const lowercase = new MapAsync("lowercase", {
      input: Type.String({ minLength: 1 }),
      output: Type.String({ minLength: 1 }),
      timeoutMs: 1_000,
      map: (input) => {
        executions.push(`lowercase:${input}`);
        return input.toLowerCase();
      },
    });
    const summarize = new MapAsync("summarize", {
      input: Normalized,
      output: Summary,
      timeoutMs: 1_000,
      map: (input) => {
        executions.push(`summarize:${input.value}`);
        return { summary: `${input.source} -> ${input.value}` };
      },
    });
    const observe = new ForEach("observe", {
      input: Normalized,
      run: (input, context) => {
        effectKeys.push(context.key);

        if (effectKeys.length === 1) {
          throw new Error("retry terminal effect");
        }

        executions.push(`observe:${input.value}`);
      },
    });
    const defineFlow = defineModule(
      "experimental.contract.operator-bindings",
      (module) => {
        const requestedA = module.event(
          "requested_a",
          Type.String({ minLength: 1 }),
        );
        const requestedB = module.event(
          "requested_b",
          Type.String({ minLength: 1 }),
        );
        const normalizedA = module.bind("normalize_a", requestedA, normalize);
        const normalizedB = module.bind("normalize_b", requestedB, normalize);
        const loweredA = module.bind("lowercase_a", requestedA, lowercase);
        const summarizedA = module.bind("summarize_a", normalizedA, summarize);
        module.bind("observe_b", normalizedB, observe);
        const declaration = module.declare({
          events: {
            requested_a: requestedA,
            normalize_a: normalizedA,
            summarize_a: summarizedA,
          },
        });
        const materialization = defineMaterialization(declaration, {
          namespace: "operator-bindings",
        })
          .version(1, "record normalized values", (schema) =>
            schema.createTable("normalized", (table) =>
              table
                .columns({ value: table.text().notNull() })
                .primaryKey(["value"]),
            ),
          )
          .define({
            indexers: {
              recordNormalized: module.indexer(normalizedA),
              recordSummaryOrigin: module.indexer(summarizedA),
            },
            queries: {
              normalizedValues: {
                params: Type.Object({}),
                result: Type.Array(Type.String()),
              },
            },
          });
        const registered = module.link(declaration, materialization, {
          events: {
            requested_a: ({ event }) => {
              ordinaryHandlers.push(event.payload);
            },
            summarize_a: () => {
              summaryDispatch.push("handler");
            },
          },
          indexers: {
            recordNormalized: async ({ input, db }) => {
              if (input.outcome === "failed") {
                return;
              }

              await db
                .insertInto("normalized")
                .values({ value: input.value.value })
                .execute();
            },
            recordSummaryOrigin: async (context) => {
              const origin = await module.origin(context, requestedA);
              summaryOrigins.push(origin.payload);
              summaryDispatch.push("indexer");
            },
          },
          queries: {
            normalizedValues: async ({ db }) => {
              const rows = await db
                .selectFrom("normalized")
                .select(["value"])
                .execute();
              return rows.map((row) => row.value);
            },
          },
        });

        return module.expose(registered, {
          requestedA,
          requestedB,
          normalizedA,
          normalizedB,
          loweredA,
          summarizedA,
          normalizedValues: registered.queries.normalizedValues,
        });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));

    {
      await using opened = await application.open(
        adapter.createDriver(databaseUrl),
        runtime,
      );

      await opened.ledger.emit(opened.capabilities.flow.requestedA, " Alpha ");
      await opened.ledger.emit(opened.capabilities.flow.requestedB, " Beta ");
    }

    const configuredQueues: LedgerWorkerQueue[] = [];
    await using reopened = await application.open(
      adapter.createDriver(databaseUrl),
      runtime,
    );
    await using workers = await reopened.ledger.startWorkers({
      configureQueue: (queue) => {
        configuredQueues.push(queue);
        return { maxInFlight: queue.name === "observe_b" ? 1 : 3 };
      },
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 1,
      maxInFlight: 4,
    });

    await driveUntilIdle(runtime, workers);

    assert.deepEqual(configuredQueues.map((queue) => queue.name).sort(), [
      "lowercase_a",
      "normalize_a",
      "normalize_b",
      "observe_b",
      "summarize_a",
    ]);
    assert.deepEqual(executions.sort(), [
      "lowercase: Alpha ",
      "normalize: Alpha ",
      "normalize: Beta ",
      "observe:BETA",
      "summarize:ALPHA",
    ]);
    assert.deepEqual(ordinaryHandlers, [" Alpha "]);
    assert.deepEqual(summaryOrigins, [" Alpha "]);
    assert.deepEqual(summaryDispatch, ["indexer", "handler"]);
    assert.deepEqual(
      await reopened.ledger.query(
        reopened.capabilities.flow.normalizedValues,
        {},
      ),
      ["ALPHA"],
    );
    assert.equal(effectKeys.length, 2);
    assert.equal(effectKeys[0], effectKeys[1]);
    assert.match(
      effectKeys[0] ?? "",
      /^experimental\.contract\.operator-bindings:observe_b:\d+$/,
    );

    const events = await readEvents(reopened.ledger, 6);
    assert.deepEqual(
      events
        .filter(
          (entry) =>
            entry.event === reopened.capabilities.flow.normalizedA ||
            entry.event === reopened.capabilities.flow.normalizedB,
        )
        .map((entry) => {
          const settlement = Value.Decode(NormalizedSettlement, entry.payload);
          assert.equal(settlement.outcome, "succeeded");
          return settlement.outcome === "succeeded"
            ? settlement.value.value
            : "";
        })
        .sort(),
      ["ALPHA", "BETA"],
    );
    assert.deepEqual(
      events.find(
        (entry) => entry.event === reopened.capabilities.flow.loweredA,
      )?.payload,
      { outcome: "succeeded", value: " alpha " },
    );
    assert.deepEqual(
      events.find(
        (entry) => entry.event === reopened.capabilities.flow.summarizedA,
      )?.payload,
      {
        outcome: "succeeded",
        value: { summary: " Alpha  -> ALPHA" },
      },
    );
  });

  test(`${adapter.name} operator graphs consume owner-granted event observations`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-imported-operators-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(20_000);
    const keys: string[] = [];
    const double = new MapAsync("double", {
      input: Type.Integer(),
      output: Type.Integer(),
      timeoutMs: 1_000,
      map: (input, context) => {
        keys.push(context.key);
        return input * 2;
      },
    });
    const forbiddenContinuation = new CoalescingOperation(
      "forbidden-continuation",
      {
        input: Type.Integer(),
        output: Type.Integer(),
        timeoutMs: 1_000,
        queries: {},
        keyBy: String,
        run: (input) => input,
      },
    );
    const defineSource = defineModule(
      "experimental.contract.operator-source",
      (module) => {
        const declaration = module.declare({
          events: { requested: Type.Integer() },
        });
        const registered = module.link(declaration, null, {});

        return module.expose(registered, {
          requested: registered.events.requested,
          requestedObservation: module.observation(registered.events.requested),
        });
      },
    );
    const application = defineLedger((sledge) => {
      const source = sledge.install(defineSource());
      const firstFlow = sledge.install(
        defineModule("a", (module) => {
          const observed = module.import(source.requestedObservation);

          if (false) {
            module.bind("forbidden", observed, forbiddenContinuation, {
              // @ts-expect-error an observation is not continuation authority
              continueWith: observed,
            });
          }

          assert.throws(
            () =>
              module.bind("forbidden", observed, forbiddenContinuation, {
                continueWith: observed as unknown as EventPort<
                  ReturnType<typeof Type.Integer>,
                  string,
                  null,
                  true
                >,
              }),
            /event observation cannot be used as a continuation/,
          );
          const doubled = module.bind("b:c", observed, double);
          const declaration = module.declare({ events: {} });
          const registered = module.link(declaration, null, {});

          return module.expose(registered, { doubled });
        })(),
      );
      const secondFlow = sledge.install(
        defineModule("d", (module) => {
          const doubled = module.bind(
            "e",
            module.import(source.requestedObservation),
            double,
          );
          const declaration = module.declare({ events: {} });
          const registered = module.link(declaration, null, {});

          return module.expose(registered, { doubled });
        })(),
      );

      return { source, firstFlow, secondFlow };
    });
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "imported.sqlite")),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
      maxInFlight: 1,
    });

    await opened.ledger.emit(opened.capabilities.source.requested, 21);
    await driveUntilIdle(runtime, workers);

    const events = await readEvents(opened.ledger, 3);
    assert.deepEqual(
      events
        .filter(
          (entry) =>
            entry.event === opened.capabilities.firstFlow.doubled ||
            entry.event === opened.capabilities.secondFlow.doubled,
        )
        .map((entry) => entry.payload),
      [
        { outcome: "succeeded", value: 42 },
        { outcome: "succeeded", value: 42 },
      ],
    );
    assert.equal(new Set(keys).size, 2);
    assert(keys.some((key) => /^a:b:c:\d+$/.test(key)));
    assert(keys.some((key) => /^d:e:\d+$/.test(key)));
  });

  test(`${adapter.name} invalid mapped output becomes a durable failure`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-invalid-operator-output-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(30_000);
    const attempts: number[] = [];
    let downstreamCalls = 0;
    const mapExternalValue = new MapAsync("map-external-value", {
      input: Type.String(),
      output: Type.String(),
      timeoutMs: 1_000,
      map: (_input, context) => {
        attempts.push(context.attempt);

        // Simulate an untrusted integration returning a value that disagrees
        // with its declared TypeBox output contract.
        const externalValue: unknown = context.attempt === 1 ? 42 : "valid";
        return externalValue as string;
      },
    });
    const downstream = new MapAsync("downstream", {
      input: Type.String(),
      output: Type.String(),
      timeoutMs: 1_000,
      map: (input) => {
        downstreamCalls += 1;
        return input.toUpperCase();
      },
    });
    const defineFlow = defineModule(
      "experimental.contract.invalid-operator-output",
      (module) => {
        const requested = module.event("requested", Type.String());
        const mapped = module.bind(
          "map-external-value",
          requested,
          mapExternalValue,
        );
        const propagated = module.bind("downstream", mapped, downstream);
        const declaration = module.declare({ events: {} });

        if (false) {
          // Private operator events execute in the compiled graph but do not
          // become typed ordinary event tokens unless declaration promotes them.
          // @ts-expect-error mapped is private to the operator graph
          declaration.events["map-external-value"];
        }

        const registered = module.link(declaration, null, {});

        return module.expose(registered, { requested, mapped, propagated });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "invalid-output.sqlite")),
      runtime,
    );
    await opened.ledger.emit(opened.capabilities.flow.requested, "input");
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 1,
    });

    for (let step = 0; step < 20 && attempts.length === 0; step += 1) {
      await runtime.advanceByMs(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(attempts, [1]);
    await driveUntilIdle(runtime, workers);

    assert.deepEqual(attempts, [1]);
    assert.equal(downstreamCalls, 0);
    const events = await readEvents(opened.ledger, 3);
    const settlement = events.find(
      (entry) => entry.event === opened.capabilities.flow.mapped,
    )?.payload;
    assert.equal(
      Value.Decode(SettlementSchema(Type.String()), settlement).outcome,
      "failed",
    );
    assert.deepEqual(
      events.find(
        (entry) => entry.event === opened.capabilities.flow.propagated,
      )?.payload,
      settlement,
    );
  });

  test(`${adapter.name} operator timeout becomes a canonical durable failure`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-operator-timeout-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(40_000);
    const neverFinishes = new MapAsync("never-finishes", {
      input: Type.String(),
      output: Type.String(),
      timeoutMs: 5,
      map: async (_input, context) =>
        await new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        }),
    });
    const defineFlow = defineModule(
      "experimental.contract.operator-timeout",
      (module) => {
        const requested = module.event("requested", Type.String());
        const settled = module.bind("never-finishes", requested, neverFinishes);
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null, {});
        return module.expose(registered, { requested, settled });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "timeout.sqlite")),
      runtime,
    );
    await opened.ledger.emit(opened.capabilities.flow.requested, "input");
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
    });

    await driveUntilIdle(runtime, workers);

    const events = await readEvents(opened.ledger, 2);
    const settlement = Value.Decode(
      SettlementSchema(Type.String()),
      events.find((entry) => entry.event === opened.capabilities.flow.settled)
        ?.payload,
    );
    assert.equal(settlement.outcome, "failed");

    if (settlement.outcome === "failed") {
      assert.deepEqual(
        settlement.error.chain.map(({ name }) => name),
        ["UncaughtOperatorError", "WorkOperationTimeoutError"],
      );
    }
  });

  test(`${adapter.name} chained values satisfy the downstream runtime schema`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-operator-chain-schema-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(50_000);
    let downstreamCalls = 0;
    let effectCalls = 0;
    const produceEmpty = new MapAsync("produce-empty", {
      input: Type.String(),
      output: Type.String(),
      timeoutMs: 1_000,
      map: () => "",
    });
    const requireContent = new MapAsync("require-content", {
      input: Type.String({ minLength: 1 }),
      output: Type.String(),
      timeoutMs: 1_000,
      map: (input) => {
        downstreamCalls += 1;
        return input;
      },
    });
    const consumeContent = new ForEach("consume-content", {
      input: Type.String({ minLength: 1 }),
      run: () => {
        effectCalls += 1;
      },
    });
    const defineFlow = defineModule(
      "experimental.contract.operator-chain-schema",
      (module) => {
        const requested = module.event("requested", Type.String());
        const produced = module.bind("produce-empty", requested, produceEmpty);
        const validated = module.bind(
          "require-content",
          produced,
          requireContent,
        );
        module.bind("consume-content", produced, consumeContent);
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null, {});
        return module.expose(registered, { requested, produced, validated });
      },
    );
    const application = defineLedger((sledge) => ({
      flow: sledge.install(defineFlow()),
    }));
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "chain-schema.sqlite")),
      runtime,
    );
    await opened.ledger.emit(opened.capabilities.flow.requested, "input");
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
    });

    await driveUntilIdle(runtime, workers);

    const events = await readEvents(opened.ledger, 3);
    assert.equal(downstreamCalls, 0);
    assert.equal(effectCalls, 0);
    assert.equal(
      (await opened.ledger.listWork({ states: ["dead"] })).length,
      1,
    );
    assert.deepEqual(
      events.find((entry) => entry.event === opened.capabilities.flow.produced)
        ?.payload,
      { outcome: "succeeded", value: "" },
    );
    assert.equal(
      Value.Decode(
        SettlementSchema(Type.String()),
        events.find(
          (entry) => entry.event === opened.capabilities.flow.validated,
        )?.payload,
      ).outcome,
      "failed",
    );
  });
}

test("MapAsync requires a bounded positive integer timeout", () => {
  for (const timeoutMs of [0, -1, 1.5, 2_147_483_648]) {
    assert.throws(
      () =>
        new MapAsync("invalid-timeout", {
          input: Type.String(),
          output: Type.String(),
          timeoutMs,
          map: (input) => input,
        }),
      /operator timeoutMs must be a positive integer no greater than 2,147,483,647/,
    );
  }
});

test("operator graph rejects ambiguous ownership before opening storage", () => {
  const identity = new MapAsync("identity", {
    input: Type.String(),
    output: Type.String(),
    timeoutMs: 1_000,
    map: (input) => input,
  });
  const settlementConsumer = new MapAsync("settlement-consumer", {
    input: SettlementSchema(Type.String()),
    output: Type.String(),
    timeoutMs: 1_000,
    map: (input) =>
      input.outcome === "succeeded"
        ? input.value
        : (input.error.chain.at(0)?.message ?? "failed"),
  });

  if (false) {
    defineModule("experimental.contract.settlement-input", (module) => {
      const source = module.event("input", Type.String());
      const settled = module.bind("settled", source, identity);

      // @ts-expect-error operator settlements are unwrapped before mapping
      module.bind("invalid", settled, settlementConsumer);

      const declaration = module.declare({ events: {} });
      const registered = module.link(declaration, null, {});
      return module.expose(registered, {});
    });
  }

  let foreignPort!: EventPort<ReturnType<typeof Type.String>>;
  const captureForeign = defineModule(
    "experimental.contract.foreign-operator-graph",
    (module) => {
      foreignPort = module.event("input", Type.String());
      const declaration = module.declare({ events: {} });
      const registered = module.link(declaration, null, {});
      return module.expose(registered, { input: foreignPort });
    },
  );

  captureForeign();

  assert.throws(
    () =>
      defineModule("experimental.contract.invalid-operator-graph", (module) => {
        module.bind("duplicate", foreignPort, identity);
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null, {});
        return module.expose(registered, {});
      })(),
    /event port does not belong to this ledger module/,
  );
  assert.throws(
    () =>
      defineModule("experimental.contract.foreign-port-only", (module) => {
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null, {});

        return module.expose(registered, { input: foreignPort });
      })(),
    /event port does not belong to this ledger module/,
  );
  assert.throws(
    () =>
      defineModule(
        "experimental.contract.duplicate-operator-binding",
        (module) => {
          const source = module.event("input", Type.String());
          module.bind("duplicate", source, identity);
          module.bind("duplicate", source, identity);
          const declaration = module.declare({ events: {} });
          const registered = module.link(declaration, null, {});
          return module.expose(registered, {});
        },
      )(),
    /duplicate operator binding id duplicate/,
  );
  assert.throws(
    () =>
      defineModule("experimental.contract.source-event-collision", (module) => {
        module.event("input", Type.String());
        const declaration = module.declare({
          events: { input: Type.Integer() },
        });
        const registered = module.link(declaration, null, {});
        return module.expose(registered, {});
      })(),
    /ledger event input conflicts with an operator port/,
  );
  assert.throws(
    () =>
      defineModule("experimental.contract.output-event-collision", (module) => {
        const source = module.event("input", Type.String());
        module.bind("mapped", source, identity);
        const declaration = module.declare({
          events: { mapped: Type.Integer() },
        });
        const registered = module.link(declaration, null, {});
        return module.expose(registered, {});
      })(),
    /ledger event mapped conflicts with an operator port/,
  );
  assert.throws(
    () =>
      defineModule("experimental.contract.foreign-port-reveal", (module) => {
        const localPort = module.event("input", Type.String());
        const declaration = module.declare({
          events: { input: localPort },
        });
        const registered = module.link(declaration, null, {});
        return module.expose(registered, { input: foreignPort });
      })(),
    /event port does not belong to this ledger module/,
  );

  const arrayModule = defineModule(
    "experimental.contract.array-capability",
    (module) => {
      const input = module.event("input", Type.String());
      const declaration = module.declare({ events: { input } });
      const registered = module.link(declaration, null, {});

      return module.expose(registered, [input] as const);
    },
  )();
  const arrayEvent: EventToken = arrayModule.capabilities[0];

  assert(arrayEvent);

  interface InterfaceCapabilities {
    readonly input: EventPort<ReturnType<typeof Type.String>>;
  }

  const interfaceModule = defineModule(
    "experimental.contract.interface-capability",
    (module) => {
      const input = module.event("input", Type.String());
      const declaration = module.declare({ events: { input } });
      const registered = module.link(declaration, null, {});
      const capabilities: InterfaceCapabilities = { input };

      return module.expose(registered, capabilities);
    },
  )();
  const interfaceEvent: EventToken = interfaceModule.capabilities.input;

  assert(interfaceEvent);

  const inheritedNameModule = defineModule(
    "experimental.contract.inherited-binding-name",
    (module) => {
      const input = module.event("toString", Type.String());
      module.bind("__proto__", input, identity);
      const declaration = module.declare({ events: { toString: input } });
      const registered = module.link(declaration, null, {});

      return module.expose(registered, {});
    },
  );

  assert.doesNotThrow(() => inheritedNameModule());
  assert(Object.isFrozen(identity));
});

async function driveUntilIdle(
  runtime: VirtualRuntimeHarness,
  workers: {
    waitForIdle(input: { readonly signal: AbortSignal }): Promise<void>;
  },
): Promise<void> {
  const idle = workers.waitForIdle({ signal: AbortSignal.timeout(5_000) });
  let settled = false;
  idle.finally(() => {
    settled = true;
  });

  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    await runtime.advanceByMs(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  await idle;
}

async function driveUntil(
  runtime: VirtualRuntimeHarness,
  condition: Promise<void>,
): Promise<void> {
  let settled = false;
  condition.then(() => {
    settled = true;
  });

  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    await runtime.advanceByMs(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (!settled) {
    throw new Error("operator condition did not settle");
  }

  await condition;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function readEvents(
  ledger: {
    tailEvents(input: {
      readonly last: number;
      readonly signal: AbortSignal;
    }): AsyncIterable<{
      readonly event: {
        readonly event: unknown;
        readonly payload: unknown;
      };
    }>;
  },
  count: number,
): Promise<readonly { readonly event: unknown; readonly payload: unknown }[]> {
  const controller = new AbortController();
  const iterator = ledger
    .tailEvents({ last: count, signal: controller.signal })
    [Symbol.asyncIterator]();
  const events: { readonly event: unknown; readonly payload: unknown }[] = [];

  try {
    for (let index = 0; index < count; index += 1) {
      const next = await iterator.next();

      if (next.done) {
        throw new Error("operator event history ended unexpectedly");
      }

      events.push(next.value.event);
    }
  } finally {
    controller.abort();
    await iterator.return?.();
  }

  return events;
}
