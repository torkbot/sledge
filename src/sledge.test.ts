import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Type,
  type Static,
  type TObject,
  type TString,
  type TSchema,
} from "typebox";

import { createBetterSqliteStorageRuntime } from "./ledger/better-sqlite3-ledger.ts";
import { defineMaterialization, type QueryToken } from "./ledger/ledger.ts";
import { createTursoStorageRuntime } from "./ledger/turso-ledger.ts";
import { createBetterSqliteDriver } from "./better-sqlite3.ts";
import { createTursoDriver } from "./turso.ts";
import { VirtualRuntimeHarness } from "./runtime/virtual-runtime.ts";
import {
  defineLedger,
  defineModule,
  type ApplicationLedger,
  type OpenedLedger,
  type LedgerApplication,
  type LedgerApplicationCapabilities,
} from "./sledge.ts";

const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
const timing = {
  clock: runtime.clock,
  scheduler: runtime.scheduler,
};

if (false) {
  const verifyConcreteQuery = (
    ledger: ApplicationLedger,
    query: QueryToken<"typecheck", "lookup", TObject<{ id: TString }>, TString>,
  ) => {
    const result: Promise<string> = ledger.query(query, { id: "record-1" });
    void result;

    // @ts-expect-error the token requires its declared id parameter
    ledger.query(query, {});

    // @ts-expect-error the token's id parameter is a string
    ledger.query(query, { id: 1 });
  };
  const queryGenerically = <
    const TModuleId extends string,
    const TName extends string,
    const TParamsSchema extends TSchema,
    const TResultSchema extends TSchema,
  >(
    ledger: ApplicationLedger,
    query: QueryToken<TModuleId, TName, TParamsSchema, TResultSchema>,
    params: Static<TParamsSchema>,
  ): Promise<Static<TResultSchema>> => ledger.query(query, params);

  void verifyConcreteQuery;
  void queryGenerically;

  void (async () => {
    const application = defineLedger((sledge) => ({
      source: sledge.install(defineSourceModule()),
    }));
    const opened = await application.open(
      createBetterSqliteDriver({ databaseUrl: "typecheck-only.sqlite" }),
      timing,
    );
    const foreign = defineRegistryModule();

    await opened.ledger.emit(opened.capabilities.source.events.created, {
      id: "owned",
    });
    await opened.ledger.emit(foreign.capabilities.events.configured, {
      moduleIds: [],
    });

    const reshapedApplication = defineLedger((sledge) => {
      const source = sledge.install(defineSourceModule());

      return { events: source.events };
    });
    const reshaped = await reshapedApplication.open(
      createBetterSqliteDriver({
        databaseUrl: "typecheck-only-reshaped.sqlite",
      }),
      timing,
    );
    await reshaped.ledger.emit(reshaped.capabilities.events.created, {
      id: "owned-through-subtree",
    });

    await reshaped.ledger.emit(reshaped.capabilities.events.created, {
      // @ts-expect-error payload inference remains anchored to the exact token
      moduleIds: [],
    });
  })();

  defineLedger((sledge) => {
    const source = sledge.install(defineSourceModule());
    const defineComposedModule = defineModule(
      "contract.composed",
      (module, sourceToCompose: typeof source) => {
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null, {});

        return module.expose(registered, { source: sourceToCompose });
      },
    );
    const composed = sledge.install(defineComposedModule(source));

    return { composed };
  });

  defineLedger((sledge) => {
    const foreign = defineRegistryModule();
    const defineForeignTokenModule = defineModule(
      "contract.foreign-token",
      (
        module,
        query: typeof foreign.capabilities.queries.configuredModuleIds,
      ) => {
        const declaration = module.declare({ events: {} });
        const registered = module.link(declaration, null, {});

        return module.expose(registered, { query });
      },
    );
    const installed = sledge.install(
      defineForeignTokenModule(
        foreign.capabilities.queries.configuredModuleIds,
      ),
    );

    return { installed };
  });
}

for (const driver of ["better-sqlite3", "turso"] as const) {
  test(`${driver} projectionless modules import queries for private durable work`, async () => {
    await using fixture = await createFixture(driver, "imported-query");
    const observations: (readonly string[] | null)[] = [];
    const errors: unknown[] = [];
    const application = defineLedger((sledge) => {
      const registry = sledge.install(defineRegistryModule());
      const consumer = sledge.install(
        defineModule("contract.query-consumer", (module) => {
          const declaration = module.declare({
            events: { requested: Type.Null() },
            queries: {
              configuredModuleIds: registry.queries.configuredModuleIds,
            },
            queues: { read: Type.Null() },
          });
          const registered = module.link(declaration, null, {
            events: {
              requested: ({ actions }) => {
                actions.enqueue("read", null);
              },
            },
            queues: {
              read: async ({ actions }) => {
                try {
                  observations.push(
                    await actions.query("configuredModuleIds", {}),
                  );
                } catch (error: unknown) {
                  errors.push(error);
                }
              },
            },
          });

          return module.expose(registered, { events: registered.events });
        })(),
      );

      return { consumer, registry };
    });
    await using opened = await fixture.open(application);

    await opened.ledger.emit(opened.capabilities.registry.events.configured, {
      moduleIds: ["alpha", "beta"],
    });
    await opened.ledger.emit(
      opened.capabilities.consumer.events.requested,
      null,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: () => ({ maxInFlight: 1 }),
      scheduler: runtime.scheduler,
    });
    await runtime.flush();
    await workers.waitForIdle({ signal: AbortSignal.timeout(2_000) });

    assert.deepEqual(errors, []);
    assert.deepEqual(observations, [["alpha", "beta"]]);
  });

  test(`${driver} opens a fresh Sledge application with its installed modules`, async () => {
    await using fixture = await createFixture(driver, "fresh");
    const application = defineLedger((sledge) => {
      const source = sledge.install(defineSourceModule());

      return { source };
    });

    await using opened = await fixture.open(application);
    const committed = await opened.ledger.emit(
      opened.capabilities.source.events.created,
      { id: "event-1" },
    );

    assert.equal(committed.payload.id, "event-1");
  });

  test(`${driver} constructs application capabilities for each concurrent open`, async () => {
    await using firstFixture = await createFixture(driver, "concurrent-first");
    await using secondFixture = await createFixture(
      driver,
      "concurrent-second",
    );
    const application = defineLedger((sledge) => {
      const source = sledge.install(defineSourceModule());

      return { source };
    });
    const [first, second] = await Promise.all([
      firstFixture.open(application),
      secondFixture.open(application),
    ]);

    try {
      assert.notEqual(first.capabilities.source, second.capabilities.source);
      await assert.rejects(
        first.ledger.emit(second.capabilities.source.events.created, {
          id: "foreign",
        }),
        /unknown event token/,
      );
      await Promise.all([
        first.ledger.emit(first.capabilities.source.events.created, {
          id: "first",
        }),
        second.ledger.emit(second.capabilities.source.events.created, {
          id: "second",
        }),
      ]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test(`${driver} discovers later modules through installed ledger queries`, async () => {
    await using fixture = await createFixture(driver, "discovery");
    const bootstrap = defineLedger((sledge) => {
      const registry = sledge.install(defineRegistryModule());
      const discovered = sledge.install(defineDiscoveredModule());

      return { discovered, registry };
    });

    {
      await using opened = await fixture.open(bootstrap);
      await opened.ledger.emit(opened.capabilities.registry.events.configured, {
        moduleIds: [opened.capabilities.discovered.moduleId],
      });
    }

    let queryAfterDefinition!: () => Promise<readonly string[] | null>;
    let installAfterDefinition!: () => void;
    const application = defineLedger(async (sledge) => {
      const registry = sledge.install(defineRegistryModule());
      queryAfterDefinition = async () =>
        await sledge.query(registry.queries.configuredModuleIds, {});
      installAfterDefinition = () => {
        sledge.install(defineUnexpectedModule());
      };
      const moduleIds = await sledge.query(
        registry.queries.configuredModuleIds,
        {},
      );
      assert.deepEqual(moduleIds, ["contract.discovered"]);

      const discovered = sledge.install(defineDiscoveredModule());
      assert.equal(moduleIds.includes(discovered.moduleId), true);
      assert.equal(await sledge.query(discovered.queries.status, {}), "ready");

      return { discovered, registry };
    });

    await using opened = await fixture.open(application);
    await assert.rejects(queryAfterDefinition(), /assembly has already closed/);
    assert.throws(installAfterDefinition, /assembly has already closed/);

    const invoked = await opened.ledger.emit(
      opened.capabilities.discovered.events.invoked,
      { value: "resolved" },
    );
    assert.equal(invoked.payload.value, "resolved");
  });

  test(`${driver} refuses query discovery before a durable root exists`, async () => {
    await using fixture = await createFixture(driver, "unowned");
    const application = defineLedger(async (sledge) => {
      const registry = sledge.install(defineRegistryModule());
      await sledge.query(registry.queries.configuredModuleIds, {});

      return { registry };
    });

    await assert.rejects(
      fixture.open(application),
      /cannot prepare an unowned database/,
    );
  });

  test(`${driver} validates the final installed graph against the durable root`, async () => {
    await using fixture = await createFixture(driver, "root-drift");
    const owningApplication = defineLedger((sledge) => {
      const registry = sledge.install(defineRegistryModule());
      const discovered = sledge.install(defineDiscoveredModule());

      return { discovered, registry };
    });

    {
      await using opened = await fixture.open(owningApplication);
      await opened.ledger.listWork();
    }

    const incompleteApplication = defineLedger((sledge) => {
      const registry = sledge.install(defineRegistryModule());

      return { registry };
    });

    await assert.rejects(
      fixture.open(incompleteApplication),
      /database belongs to composed ledger root.*received \["contract.model-registry"\]/,
    );
  });

  test(`${driver} rejects a non-prefix discovery graph before migrations`, async () => {
    await using fixture = await createFixture(driver, "invalid-prefix");
    const owningApplication = defineLedger((sledge) => ({
      discovered: sledge.install(defineDiscoveredModule()),
      registry: sledge.install(defineRegistryModule()),
    }));

    {
      await using opened = await fixture.open(owningApplication);
      await opened.ledger.listWork();
    }

    const invalidApplication = defineLedger(async (sledge) => {
      const unexpected = sledge.install(defineUnexpectedModule());
      await sledge.query(unexpected.queries.status, {});

      return { unexpected };
    });

    await assert.rejects(
      fixture.open(invalidApplication),
      /prepared modules must be an ordered prefix/,
    );
    assert.equal(
      await fixture.hasTable(
        "sledge::contract.unexpected::table::unexpectedState",
      ),
      false,
    );
  });
}

test("an application opens through an inert driver with Node timing by default", async () => {
  await using fixture = await createFixture("better-sqlite3", "node-timing");
  const driver = createBetterSqliteDriver({
    databaseUrl: fixture.databaseUrl,
  });
  const application = defineLedger((sledge) => ({
    source: sledge.install(defineSourceModule()),
  }));

  assert(Object.isFrozen(application));
  assert(Object.isFrozen(driver));

  await using opened = await application.open(driver);
  const committed = await opened.ledger.emit(
    opened.capabilities.source.events.created,
    { id: "default-node-timing" },
  );

  assert.equal(committed.payload.id, "default-node-timing");
});

test("a Sledge application requires at least one installed module", async () => {
  await using fixture = await createFixture("better-sqlite3", "empty");
  const application = defineLedger(() => ({}));

  await assert.rejects(
    fixture.open(application),
    /must install at least one module/,
  );
});

test("a Sledge application rejects duplicate module ids", async () => {
  await using fixture = await createFixture("better-sqlite3", "duplicate");
  const application = defineLedger((sledge) => {
    sledge.install(defineSourceModule());
    sledge.install(defineSourceModule());

    return {};
  });

  await assert.rejects(
    fixture.open(application),
    /duplicate ledger module id contract.application-source/,
  );
});

test("a Sledge application rejects hand-assembled module contributions", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "raw-contribution",
  );
  const source = defineSourceModule();
  const application = defineLedger((sledge) => {
    // This adapter models JavaScript without TypeScript's contribution brand.
    // The private factory registry remains the runtime source of authenticity.
    const unsafeInstall = sledge.install as unknown as (
      contribution: object,
    ) => object;
    unsafeInstall({
      capabilities: source.capabilities,
    });

    return {};
  });

  await assert.rejects(
    fixture.open(application),
    /invalid ledger module contribution/,
  );
});

test("a failed module factory does not authenticate its leaked contribution", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "failed-contribution",
  );
  let leaked: object | undefined;
  const defineFailingModule = defineModule(
    "contract.failed-contribution",
    (module) => {
      const declaration = module.declare({ events: {} });
      const implemented = module.link(declaration, null, {});
      leaked = module.expose(implemented, {});

      throw new Error("failure after reveal");
    },
  );

  assert.throws(defineFailingModule, /failure after reveal/);
  const leakedContribution = leaked;
  assert(leakedContribution !== undefined);

  const application = defineLedger((sledge) => {
    const unsafeInstall = sledge.install as unknown as (
      contribution: object,
    ) => object;
    unsafeInstall(leakedContribution);

    return {};
  });

  await assert.rejects(
    fixture.open(application),
    /invalid ledger module contribution/,
  );
});

test("a Sledge application must install a module before querying", async () => {
  await using fixture = await createFixture("better-sqlite3", "query-empty");
  const registry = defineRegistryModule();
  const application = defineLedger(async (sledge) => {
    await sledge.query(registry.capabilities.queries.configuredModuleIds, {});

    return {};
  });

  await assert.rejects(
    fixture.open(application),
    /must install at least one module before querying/,
  );
});

test("assembly queries accept tokens only from installed modules", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "query-ownership",
  );
  const owningApplication = defineLedger((sledge) => ({
    source: sledge.install(defineSourceModule()),
  }));

  {
    await using opened = await fixture.open(owningApplication);
    await opened.ledger.listWork();
  }

  const foreignRegistry = defineRegistryModule();
  const invalidApplication = defineLedger(async (sledge) => {
    const source = sledge.install(defineSourceModule());
    await sledge.query(
      foreignRegistry.capabilities.queries.configuredModuleIds,
      {},
    );

    return { source };
  });

  await assert.rejects(fixture.open(invalidApplication), /unknown query token/);
});

test("an abandoned assembly query failure rejects the open", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "abandoned-query-failure",
  );
  const bootstrap = defineLedger((sledge) => ({
    query: sledge.install(defineQueryModule(() => "ready")),
  }));

  {
    await using opened = await fixture.open(bootstrap);
    await opened.ledger.listWork();
  }

  const application = defineLedger((sledge) => {
    const query = sledge.install(
      defineQueryModule(() => {
        throw new Error("configured query failure");
      }),
    );
    void sledge.query(query.queries.status, {});

    return { query };
  });

  await assert.rejects(fixture.open(application), /configured query failure/);
});

test("opening waits for an abandoned in-flight assembly query", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "abandoned-query-settlement",
  );
  const bootstrap = defineLedger((sledge) => ({
    query: sledge.install(defineQueryModule(() => "ready")),
  }));

  {
    await using opened = await fixture.open(bootstrap);
    await opened.ledger.listWork();
  }

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const application = defineLedger((sledge) => {
    const query = sledge.install(
      defineQueryModule(async () => {
        entered.resolve();
        await release.promise;
        return "ready" as const;
      }),
    );
    void sledge.query(query.queries.status, {});

    return { query };
  });
  const opening = fixture.open(application);
  let settled = false;
  void opening.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await entered.promise;
  assert.equal(settled, false);

  release.resolve();
  await using opened = await opening;
  assert.equal(settled, true);
  await opened.ledger.listWork();
});

const defineSourceModule = defineModule(
  "contract.application-source",
  (module) => {
    const declaration = module.declare({
      events: {
        created: Type.Object({ id: Type.String({ minLength: 1 }) }),
      },
    });
    const registered = module.link(declaration, null, {});

    return module.expose(registered, {
      events: registered.events,
    });
  },
);

function defineRegistryModule() {
  return defineRegistryModuleFactory();
}

const defineRegistryModuleFactory = defineModule(
  "contract.model-registry",
  (module) => {
    const declaration = module.declare({
      events: {
        configured: Type.Object({ moduleIds: Type.Array(Type.String()) }),
      },
    });
    const materialization = defineMaterialization(declaration, {
      namespace: "registry",
    })
      .version(1, "create model registry", (schema) =>
        schema.createTable("configuration", (table) =>
          table
            .columns({
              singleton: table.integer().notNull(),
              moduleIds: table.json<string[]>().notNull(),
            })
            .primaryKey(["singleton"]),
        ),
      )
      .define({
        indexers: {
          storeConfiguration: {
            sourceEvent: "configured",
            input: Type.Object({ moduleIds: Type.Array(Type.String()) }),
          },
        },
        queries: {
          configuredModuleIds: {
            params: Type.Object({}),
            result: Type.Union([Type.Null(), Type.Array(Type.String())]),
          },
        },
      });
    const registered = module.link(declaration, materialization, {
      events: {
        configured: async ({ event, actions }) => {
          await actions.index("storeConfiguration", event.payload);
        },
      },
      indexers: {
        storeConfiguration: async ({ input, db }) => {
          await db
            .insertInto("configuration")
            .values({ singleton: 1, moduleIds: input.moduleIds })
            .onConflict(["singleton"])
            .doUpdateSet({ moduleIds: input.moduleIds })
            .execute();
        },
      },
      queries: {
        configuredModuleIds: async ({ db }) => {
          const configured = await db
            .selectFrom("configuration")
            .select(["moduleIds"])
            .where("singleton", "=", 1)
            .executeTakeFirst();

          return configured?.moduleIds ?? null;
        },
      },
    });

    return module.expose(registered, {
      events: registered.events,
      queries: registered.queries,
    });
  },
);

const defineDiscoveredModule = defineModule("contract.discovered", (module) => {
  const declaration = module.declare({
    events: {
      invoked: Type.Object({ value: Type.String() }),
    },
  });
  const materialization = defineMaterialization(declaration, {
    namespace: "state",
  })
    .version(1, "initialize discovered state", (schema) =>
      schema.createTable("discovery", (table) =>
        table.columns({ id: table.integer().notNull() }).primaryKey(["id"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        status: {
          params: Type.Object({}),
          result: Type.Literal("ready"),
        },
      },
    });
  const registered = module.link(declaration, materialization, {
    queries: {
      status: () => "ready" as const,
    },
  });

  return module.expose(registered, {
    events: registered.events,
    moduleId: registered.moduleId,
    queries: registered.queries,
  });
});

const defineUnexpectedModule = defineModule("contract.unexpected", (module) => {
  const declaration = module.declare({ events: {} });
  const materialization = defineMaterialization(declaration, {
    namespace: "unexpected",
  })
    .version(1, "initialize unexpected state", (schema) =>
      schema.createTable("unexpectedState", (table) =>
        table.columns({ id: table.integer().notNull() }).primaryKey(["id"]),
      ),
    )
    .define({
      indexers: {},
      queries: {
        status: {
          params: Type.Object({}),
          result: Type.Literal("unexpected"),
        },
      },
    });
  const registered = module.link(declaration, materialization, {
    queries: { status: () => "unexpected" as const },
  });

  return module.expose(registered, { queries: registered.queries });
});

const defineQueryModule = defineModule(
  "contract.query",
  (module, run: () => "ready" | Promise<"ready">) => {
    const declaration = module.declare({ events: {} });
    const materialization = defineMaterialization(declaration, {
      namespace: "state",
    })
      .version(1, "initialize query state", (schema) =>
        schema.createTable("queryState", (table) =>
          table.columns({ id: table.integer().notNull() }).primaryKey(["id"]),
        ),
      )
      .define({
        indexers: {},
        queries: {
          status: {
            params: Type.Object({}),
            result: Type.Literal("ready"),
          },
        },
      });
    const registered = module.link(declaration, materialization, {
      queries: { status: run },
    });

    return module.expose(registered, { queries: registered.queries });
  },
);

async function createFixture(
  driver: "better-sqlite3" | "turso",
  name: string,
): Promise<{
  readonly databaseUrl: string;
  [Symbol.asyncDispose](): Promise<void>;
  hasTable(tableName: string): Promise<boolean>;
  open<TApplication extends LedgerApplication<object>>(
    application: TApplication,
  ): Promise<OpenedLedger<LedgerApplicationCapabilities<TApplication>>>;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), `sledge-application-${driver}-${name}-`),
  );
  const databaseUrl = join(directory, "ledger.sqlite");

  return {
    databaseUrl,
    hasTable: async (tableName) => {
      const storage =
        driver === "better-sqlite3"
          ? createBetterSqliteStorageRuntime(databaseUrl)
          : await createTursoStorageRuntime(databaseUrl);

      try {
        const table = await storage.read(
          async (database) =>
            await database
              .prepare(
                `SELECT name
                 FROM sqlite_master
                 WHERE type = 'table' AND name = ?`,
              )
              .get(tableName),
        );

        return table !== undefined;
      } finally {
        await storage.close();
      }
    },
    open: async <TApplication extends LedgerApplication<object>>(
      application: TApplication,
    ) => {
      if (driver === "better-sqlite3") {
        return await application.open(
          createBetterSqliteDriver({ databaseUrl }),
          timing,
        );
      }

      return await application.open(createTursoDriver({ databaseUrl }), timing);
    },
    [Symbol.asyncDispose]: async () => {
      await rm(directory, { force: true, recursive: true });
    },
  };
}
