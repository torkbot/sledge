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
import { type EventPort, ForEach, MapAsync } from "./operators.ts";

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
  test(`${adapter.name} operator bindings compose, fan out, reuse behavior, and survive restart`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-operators-${adapter.name}-`),
    );
    const databaseUrl = join(directory.path, "operators.sqlite");
    const runtime = new VirtualRuntimeHarness(10_000);
    const executions: string[] = [];
    const effectKeys: string[] = [];
    const ordinaryHandlers: string[] = [];
    const Normalized = Type.Object({
      source: Type.String({ minLength: 1 }),
      value: Type.String({ minLength: 1 }),
    });
    const normalize = new MapAsync("normalize", {
      input: Type.String({ minLength: 1 }),
      output: Normalized,
      map: (input) => {
        executions.push(`normalize:${input}`);
        return { source: input, value: input.trim().toUpperCase() };
      },
    });
    const lowercase = new MapAsync("lowercase", {
      input: Type.String({ minLength: 1 }),
      output: Type.String({ minLength: 1 }),
      map: (input) => {
        executions.push(`lowercase:${input}`);
        return input.toLowerCase();
      },
    });
    const summarize = new MapAsync("summarize", {
      input: Normalized,
      output: Type.Object({ summary: Type.String({ minLength: 1 }) }),
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
              recordNormalized: {
                sourceEvent: "normalize_a",
                input: Normalized,
              },
            },
            queries: {
              normalizedValues: {
                params: Type.Object({}),
                result: Type.Array(Type.String()),
              },
            },
          });
        const registered = module.link(declaration, materialization).register({
          events: {
            requested_a: ({ event }) => {
              ordinaryHandlers.push(event.payload);
            },
            normalize_a: async ({ event, actions }) => {
              await actions.index("recordNormalized", event.payload);
            },
          },
          indexers: {
            recordNormalized: async ({ input, db }) => {
              await db
                .insertInto("normalized")
                .values({ value: input.value })
                .execute();
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
        .map((entry) => Value.Decode(Normalized, entry.payload).value)
        .sort(),
      ["ALPHA", "BETA"],
    );
    assert.deepEqual(
      events.find(
        (entry) => entry.event === reopened.capabilities.flow.loweredA,
      )?.payload,
      " alpha ",
    );
    assert.deepEqual(
      events.find(
        (entry) => entry.event === reopened.capabilities.flow.summarizedA,
      )?.payload,
      { summary: " Alpha  -> ALPHA" },
    );
  });

  test(`${adapter.name} operator graphs consume events revealed by ordinary modules`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-imported-operators-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(20_000);
    const keys: string[] = [];
    const double = new MapAsync("double", {
      input: Type.Integer(),
      output: Type.Integer(),
      map: (input, context) => {
        keys.push(context.key);
        return input * 2;
      },
    });
    const defineSource = defineModule(
      "experimental.contract.operator-source",
      (module) => {
        const declaration = module.declare({
          events: { requested: Type.Integer() },
        });
        const registered = module.link(declaration, null).register({});

        return module.expose(registered, {
          requested: registered.events.requested,
        });
      },
    );
    const application = defineLedger((sledge) => {
      const source = sledge.install(defineSource());
      const firstFlow = sledge.install(
        defineModule("a", (module) => {
          const doubled = module.bind(
            "b:c",
            module.import(source.requested),
            double,
          );
          const declaration = module.declare({ events: {} });
          const registered = module.link(declaration, null).register({});

          return module.expose(registered, { doubled });
        })(),
      );
      const secondFlow = sledge.install(
        defineModule("d", (module) => {
          const doubled = module.bind(
            "e",
            module.import(source.requested),
            double,
          );
          const declaration = module.declare({ events: {} });
          const registered = module.link(declaration, null).register({});

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
      [42, 42],
    );
    assert.equal(new Set(keys).size, 2);
    assert(keys.some((key) => /^a:b:c:\d+$/.test(key)));
    assert(keys.some((key) => /^d:e:\d+$/.test(key)));
  });

  test(`${adapter.name} invalid mapped output retries without failing the worker`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-invalid-operator-output-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(30_000);
    const attempts: number[] = [];
    const mapExternalValue = new MapAsync("map-external-value", {
      input: Type.String(),
      output: Type.String(),
      map: (_input, context) => {
        attempts.push(context.attempt);

        // Simulate an untrusted integration returning a value that disagrees
        // with its declared TypeBox output contract.
        const externalValue: unknown = context.attempt === 1 ? 42 : "valid";
        return externalValue as string;
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
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null).register({});

        return module.expose(registered, { requested, mapped });
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

    assert.deepEqual(attempts, [1, 2]);
    const events = await readEvents(opened.ledger, 2);
    assert.equal(
      events.find((entry) => entry.event === opened.capabilities.flow.mapped)
        ?.payload,
      "valid",
    );
  });
}

test("operator graph rejects ambiguous ownership before opening storage", () => {
  const identity = new MapAsync("identity", {
    input: Type.String(),
    output: Type.String(),
    map: (input) => input,
  });
  let foreignPort!: EventPort<ReturnType<typeof Type.String>>;
  const captureForeign = defineModule(
    "experimental.contract.foreign-operator-graph",
    (module) => {
      foreignPort = module.event("input", Type.String());
      const declaration = module.declare({ events: {} });
      const registered = module.link(declaration, null).register({});
      return module.expose(registered, { input: foreignPort });
    },
  );

  captureForeign();

  assert.throws(
    () =>
      defineModule("experimental.contract.invalid-operator-graph", (module) => {
        module.bind("duplicate", foreignPort, identity);
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null).register({});
        return module.expose(registered, {});
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
          const registered = module.link(declaration, null).register({});
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
        const registered = module.link(declaration, null).register({});
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
        const registered = module.link(declaration, null).register({});
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
        const registered = module.link(declaration, null).register({});
        return module.expose(registered, { input: foreignPort });
      })(),
    /event port does not belong to this ledger module/,
  );

  const symbolCapability = Symbol("symbol capability");
  const symbolModule = defineModule(
    "experimental.contract.symbol-capability",
    (module) => {
      const input = module.event("input", Type.String());
      const declaration = module.declare({ events: { input } });
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, {
        input,
        [symbolCapability]: "preserved",
      });
    },
  )();

  assert.equal(symbolModule.capabilities[symbolCapability], "preserved");

  const arrayModule = defineModule(
    "experimental.contract.array-capability",
    (module) => {
      const input = module.event("input", Type.String());
      const declaration = module.declare({ events: { input } });
      const registered = module.link(declaration, null).register({});

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
      const registered = module.link(declaration, null).register({});
      const capabilities: InterfaceCapabilities = { input };

      return module.expose(registered, capabilities);
    },
  )();
  const interfaceEvent: EventToken = interfaceModule.capabilities.input;

  assert(interfaceEvent);

  let accessorPort!: EventPort<ReturnType<typeof Type.String>>;
  const accessorModule = defineModule(
    "experimental.contract.accessor-capability",
    (module) => {
      accessorPort = module.event("input", Type.String());
      const declaration = module.declare({ events: { input: accessorPort } });
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, {
        get input() {
          return accessorPort;
        },
      });
    },
  )();

  assert.notEqual(accessorModule.capabilities.input, accessorPort);

  const inheritedNameModule = defineModule(
    "experimental.contract.inherited-binding-name",
    (module) => {
      const input = module.event("toString", Type.String());
      module.bind("__proto__", input, identity);
      const declaration = module.declare({ events: { toString: input } });
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, {});
    },
  );

  assert.doesNotThrow(() => inheritedNameModule());

  class ClassCapabilities {
    readonly #label = "class capability";
    readonly input: EventPort<ReturnType<typeof Type.String>>;

    constructor(input: EventPort<ReturnType<typeof Type.String>>) {
      this.input = input;
    }

    readLabel(): string {
      return this.#label;
    }
  }

  let classPort!: EventPort<ReturnType<typeof Type.String>>;
  const classModule = defineModule(
    "experimental.contract.class-capability",
    (module) => {
      classPort = module.event("input", Type.String());
      const declaration = module.declare({ events: { input: classPort } });
      const registered = module.link(declaration, null).register({});

      return module.expose(registered, new ClassCapabilities(classPort));
    },
  )();
  const classEvent: EventToken = classModule.capabilities.input;

  assert(classModule.capabilities instanceof ClassCapabilities);
  assert.notEqual(classEvent, classPort);
  assert.equal(classModule.capabilities.readLabel(), "class capability");
  assert(Object.isFrozen(classModule.capabilities));

  const cyclicModule = defineModule(
    "experimental.contract.cyclic-capability",
    (module) => {
      const input = module.event("input", Type.String());
      const declaration = module.declare({ events: { input } });
      const registered = module.link(declaration, null).register({});
      const capabilities: { input: typeof input; self?: unknown } = { input };
      capabilities.self = capabilities;

      return module.expose(registered, capabilities);
    },
  )();

  assert.equal(cyclicModule.capabilities.self, cyclicModule.capabilities);
  assert(Object.isFrozen(cyclicModule.capabilities));
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
