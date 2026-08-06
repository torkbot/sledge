import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { createBetterSqliteDriver } from "../better-sqlite3.ts";
import {
  defineMaterialization,
  type EventToken,
  type QueryToken,
} from "../ledger.ts";
import { VirtualRuntimeHarness } from "../runtime/virtual-runtime.ts";
import { defineLedger, defineModule, type LedgerDriver } from "../sledge.ts";
import { createTursoDriver } from "../turso.ts";
import {
  defineEventInvocation,
  type EventInvocationLedgerPort,
} from "./event-invocation.ts";

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
  test(`${adapter.name} event invocation reuses domain source and terminal facts`, async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), `sledge-event-invocation-${adapter.name}-`),
    );
    const runtime = new VirtualRuntimeHarness(4_000_000);
    const attempts: string[] = [];
    const retained: {
      port: EventInvocationLedgerPort<EventToken, QueryToken> | null;
    } = { port: null };
    const application = defineLedger((sledge) => {
      const domain = sledge.install(defineDomainModule()());

      sledge.install(
        defineEventInvocation("experimental.contract.event-invocation", {
          source: domain.events.requested,
          terminal: domain.events.completed,
          inputSchema: Type.Object({
            key: Type.String({ minLength: 1 }),
            value: Type.String({ minLength: 1 }),
          }),
          derive: ({ payload }) =>
            payload.values.map((value, index) => ({
              key:
                payload.batchId === "duplicate"
                  ? payload.batchId
                  : `${payload.batchId}:${index}`,
              input: {
                key: `${payload.batchId}:${index}`,
                value,
              },
            })),
          access: {
            events: {},
            queries: { result: domain.queries.result },
          },
          filter: async ({ key, ledger }) =>
            (await ledger.query(domain.queries.result, { key })) === null,
          execute: async ({ input, key, attempt, ledger }) => {
            retained.port = ledger;
            attempts.push(`${key}:${attempt}`);
            return {
              key: input.key,
              value: input.value.toUpperCase(),
            };
          },
        })(),
      );

      return { domain };
    });
    await using opened = await application.open(
      adapter.createDriver(join(directory.path, "event-invocation.sqlite")),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 16 }),
      scheduler: runtime.scheduler,
    });

    await opened.ledger.emit(opened.capabilities.domain.events.requested, {
      batchId: "batch",
      values: ["alpha", "beta"],
    });
    await drainWorkers(runtime, workers);

    const events = [];
    const streamController = new AbortController();
    const eventIterator = opened.ledger
      .tailEvents({ last: 10, signal: streamController.signal })
      [Symbol.asyncIterator]();

    try {
      for (let index = 0; index < 3; index += 1) {
        const next = await eventIterator.next();

        if (next.done) {
          throw new Error("event invocation history ended unexpectedly");
        }

        events.push(next.value);
      }
    } finally {
      streamController.abort();
      await eventIterator.return?.();
    }

    assert.deepEqual(
      events.map((event) => event.event.eventId),
      [1, 2, 3],
    );
    assert.equal(
      events.filter(
        (event) =>
          event.event.event === opened.capabilities.domain.events.completed,
      ).length,
      2,
    );

    assert.deepEqual(
      await opened.ledger.query(opened.capabilities.domain.queries.result, {
        key: "batch:0",
      }),
      { key: "batch:0", value: "ALPHA" },
    );
    assert.deepEqual(
      await opened.ledger.query(opened.capabilities.domain.queries.result, {
        key: "batch:1",
      }),
      { key: "batch:1", value: "BETA" },
    );

    await opened.ledger.emit(opened.capabilities.domain.events.requested, {
      batchId: "batch",
      values: ["alpha", "beta"],
    });
    await drainWorkers(runtime, workers);

    assert.equal(
      await latestEventId(opened.ledger),
      4,
      "obsolete work must acknowledge explicitly without emitting terminals",
    );
    assert.deepEqual(attempts.sort(), ["batch:0:1", "batch:1:1"]);

    await assert.rejects(
      opened.ledger.emit(opened.capabilities.domain.events.requested, {
        batchId: "duplicate",
        values: ["alpha", "beta"],
      }),
      /produced duplicate work:duplicate/,
    );
    assert.equal(
      await latestEventId(opened.ledger),
      4,
      "a duplicate fan-out identity must roll back the source event",
    );
    const retainedPort = retained.port;

    if (retainedPort === null) {
      throw new Error("event invocation did not retain its attempt port");
    }

    await assert.rejects(
      retainedPort.query(opened.capabilities.domain.queries.result, {
        key: "batch:0",
      }),
      /no longer active/,
    );
  });
}

async function latestEventId(ledger: {
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

    return latest.done ? 0 : latest.value.event.eventId;
  } finally {
    controller.abort();
    await iterator.return?.();
  }
}

function defineDomainModule() {
  return defineModule(
    "experimental.contract.event-invocation-domain",
    (module) => {
      const RequestedSchema = Type.Object({
        batchId: Type.String({ minLength: 1 }),
        values: Type.Array(Type.String({ minLength: 1 })),
      });
      const CompletedSchema = Type.Object({
        key: Type.String({ minLength: 1 }),
        value: Type.String({ minLength: 1 }),
      });
      const declaration = module.declare({
        events: {
          requested: RequestedSchema,
          completed: CompletedSchema,
        },
      });
      const materialization = defineMaterialization(declaration, {
        namespace: "event-invocation-domain",
      })
        .version(1, "record domain completions", (schema) =>
          schema.createTable("completions", (table) =>
            table
              .columns({
                key: table.text().notNull(),
                source: table.eventRef("completed").notNull(),
              })
              .primaryKey(["key"]),
          ),
        )
        .define({
          indexers: {
            complete: {
              sourceEvent: "completed",
              input: CompletedSchema,
            },
          },
          queries: {
            result: {
              params: Type.Object({ key: Type.String({ minLength: 1 }) }),
              result: Type.Union([Type.Null(), CompletedSchema]),
            },
          },
        });
      const registered = module.link(declaration, materialization).register({
        events: {
          completed: async ({ event, actions }) => {
            if (
              event.causationWork?.moduleId !==
                "experimental.contract.event-invocation" ||
              event.causationWork.queueName !== "execute"
            ) {
              throw new Error(
                "completion did not come from its event invocation",
              );
            }

            await actions.index("complete", event.payload);
          },
        },
        indexers: {
          complete: async ({ input, event, db }) => {
            await db
              .insertInto("completions")
              .values({ key: input.key, source: event.ref })
              .execute();
          },
        },
        queries: {
          result: async ({ params, db }) => {
            const row = await db
              .selectFrom("completions")
              .selectEvent("source")
              .where("key", "=", params.key)
              .executeTakeFirst();

            return row?.payload ?? null;
          },
        },
      });

      return module.expose(registered, {
        events: registered.events,
        queries: registered.queries,
      });
    },
  );
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
      throw new Error("event invocation workers did not become idle");
    }

    await idle;
  } finally {
    controller.abort();
  }
}
