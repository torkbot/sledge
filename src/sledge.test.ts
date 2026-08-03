import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { createBetterSqliteStorageRuntime } from "./ledger/better-sqlite3-ledger.ts";
import { defineMaterialization, linkLedgerModule } from "./ledger/ledger.ts";
import { createTursoStorageRuntime } from "./ledger/turso-ledger.ts";
import { createBetterSqliteDriver } from "./better-sqlite3-ledger.ts";
import { createTursoDriver } from "./turso-ledger.ts";
import { VirtualRuntimeHarness } from "./runtime/virtual-runtime.ts";
import {
  defineLedger,
  defineModule,
  type OpenedLedger,
  type LedgerApplication,
  type LedgerApplicationCapabilities,
  type LedgerApplicationModules,
} from "./sledge.ts";

const runtime = new VirtualRuntimeHarness(1_900_000_000_000);
const timing = {
  clock: runtime.clock,
  scheduler: runtime.scheduler,
};

if (false) {
  void (async () => {
    const application = defineLedger((sledge) =>
      sledge.expose({
        source: sledge.install(defineSourceModule()),
      }),
    );
    const opened = await application.open(
      createBetterSqliteDriver({ databaseUrl: "typecheck-only.sqlite" }),
      timing,
    );
    const foreign = defineRegistryModule();

    await opened.ledger.emit(opened.capabilities.source.events.created, {
      id: "owned",
    });
    // @ts-expect-error opened ledgers accept tokens only from installed modules
    await opened.ledger.emit(foreign.capabilities.events.configured, {
      moduleIds: [],
    });

    const reshapedApplication = defineLedger((sledge) => {
      const source = sledge.install(defineSourceModule());

      return sledge.expose({ events: source.events });
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
  })();

  const firstApplication = defineLedger((sledge) =>
    sledge.expose({
      source: sledge.install(defineSourceModule()),
    }),
  );
  const firstCapabilities = null as unknown as LedgerApplicationCapabilities<
    typeof firstApplication
  >;

  defineLedger((sledge) => {
    const source = sledge.install(defineSourceModule());

    // @ts-expect-error capabilities installed by another application cannot be revealed
    return sledge.expose({ firstCapabilities, source });
  });

  defineLedger((sledge) => {
    const source = sledge.install(defineSourceModule());
    const schemaLike = {
      "~kind": "custom" as const,
      foreign: firstCapabilities,
    };

    // @ts-expect-error schema-like wrappers cannot hide another application's capabilities
    return sledge.expose({ schemaLike, source });
  });

  defineLedger((sledge) => {
    const source = sledge.install(defineSourceModule());
    const callable = Object.assign(() => "ready", {
      foreign: firstCapabilities,
    });

    // @ts-expect-error callable leaves cannot carry hidden capability properties
    return sledge.expose({ callable, source });
  });

  defineLedger((sledge) => {
    const defineLaunderingModule = defineModule(
      "contract.laundering",
      (module, foreign: typeof firstCapabilities) => {
        const declaration = module.declare({ events: {} });
        const registered = linkLedgerModule(declaration, null).register({});

        return module.expose(registered, { foreign });
      },
    );
    const laundering = sledge.install(
      // @ts-expect-error install cannot rebind capabilities from another application
      defineLaunderingModule(firstCapabilities),
    );

    return sledge.expose({ laundering });
  });

  defineLedger((sledge) => {
    const source = sledge.install(defineSourceModule());
    const defineComposedModule = defineModule(
      "contract.composed",
      (module, sourceToCompose: typeof source) => {
        const declaration = module.declare({ events: {} });
        const registered = linkLedgerModule(declaration, null).register({});

        return module.expose(registered, { source: sourceToCompose });
      },
    );
    const composed = sledge.install(defineComposedModule(source));

    return sledge.expose({ composed });
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
        const registered = linkLedgerModule(declaration, null).register({});

        return module.expose(registered, { query });
      },
    );
    const installed = sledge.install(
      // @ts-expect-error raw tokens must belong to the contributed module
      defineForeignTokenModule(
        foreign.capabilities.queries.configuredModuleIds,
      ),
    );

    return sledge.expose({ installed });
  });
}

for (const driver of ["better-sqlite3", "turso"] as const) {
  test(`${driver} opens a fresh Sledge application with its installed modules`, async () => {
    await using fixture = await createFixture(driver, "fresh");
    const application = defineLedger((sledge) => {
      const source = sledge.install(defineSourceModule());

      return sledge.expose({ source });
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

      return sledge.expose({ source });
    });
    const [first, second] = await Promise.all([
      firstFixture.open(application),
      secondFixture.open(application),
    ]);

    try {
      assert.notEqual(first.capabilities.source, second.capabilities.source);
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

      return sledge.expose({ discovered, registry });
    });

    {
      await using opened = await fixture.open(bootstrap);
      await opened.ledger.emit(opened.capabilities.registry.events.configured, {
        moduleIds: [opened.capabilities.discovered.moduleId],
      });
    }

    let queryAfterDefinition!: () => Promise<readonly string[] | null>;
    let installAfterDefinition!: () => void;
    let exposeAfterDefinition!: () => void;
    const application = defineLedger(async (sledge) => {
      const registry = sledge.install(defineRegistryModule());
      queryAfterDefinition = async () =>
        await sledge.query(registry.queries.configuredModuleIds, {});
      installAfterDefinition = () => {
        sledge.install(defineUnexpectedModule());
      };
      exposeAfterDefinition = () => {
        sledge.expose({});
      };

      const moduleIds = await sledge.query(
        registry.queries.configuredModuleIds,
        {},
      );
      assert.deepEqual(moduleIds, ["contract.discovered"]);

      const discovered = sledge.install(defineDiscoveredModule());
      assert.equal(moduleIds.includes(discovered.moduleId), true);
      assert.equal(await sledge.query(discovered.queries.status, {}), "ready");

      return sledge.expose({ discovered, registry });
    });

    await using opened = await fixture.open(application);
    await assert.rejects(queryAfterDefinition(), /assembly has already closed/);
    assert.throws(installAfterDefinition, /assembly has already closed/);
    assert.throws(exposeAfterDefinition, /assembly has already closed/);

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

      return sledge.expose({ registry });
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

      return sledge.expose({ discovered, registry });
    });

    {
      await using opened = await fixture.open(owningApplication);
      await opened.ledger.listWork();
    }

    const incompleteApplication = defineLedger((sledge) => {
      const registry = sledge.install(defineRegistryModule());

      return sledge.expose({ registry });
    });

    await assert.rejects(
      fixture.open(incompleteApplication),
      /database belongs to composed ledger root.*received \["contract.model-registry"\]/,
    );
  });

  test(`${driver} rejects a non-prefix discovery graph before migrations`, async () => {
    await using fixture = await createFixture(driver, "invalid-prefix");
    const owningApplication = defineLedger((sledge) =>
      sledge.expose({
        discovered: sledge.install(defineDiscoveredModule()),
        registry: sledge.install(defineRegistryModule()),
      }),
    );

    {
      await using opened = await fixture.open(owningApplication);
      await opened.ledger.listWork();
    }

    const invalidApplication = defineLedger(async (sledge) => {
      const unexpected = sledge.install(defineUnexpectedModule());
      await sledge.query(unexpected.queries.status, {});

      return sledge.expose({ unexpected });
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
  const application = defineLedger((sledge) =>
    sledge.expose({
      source: sledge.install(defineSourceModule()),
    }),
  );

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
  const application = defineLedger((sledge) => sledge.expose({}));

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

    return sledge.expose({});
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
      module: source.module,
      capabilities: source.capabilities,
    });

    return sledge.expose({});
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
    // @ts-expect-error query tokens become valid only after their contribution is installed
    await sledge.query(registry.capabilities.queries.configuredModuleIds, {});

    return sledge.expose({});
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
  const owningApplication = defineLedger((sledge) =>
    sledge.expose({
      source: sledge.install(defineSourceModule()),
    }),
  );

  {
    await using opened = await fixture.open(owningApplication);
    await opened.ledger.listWork();
  }

  const foreignRegistry = defineRegistryModule();
  const invalidApplication = defineLedger(async (sledge) => {
    const source = sledge.install(defineSourceModule());
    await sledge.query(
      // @ts-expect-error the registry contribution was never installed
      foreignRegistry.capabilities.queries.configuredModuleIds,
      {},
    );

    return sledge.expose({ source });
  });

  await assert.rejects(fixture.open(invalidApplication), /unknown query token/);
});

test("an abandoned assembly query failure rejects the open", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "abandoned-query-failure",
  );
  const bootstrap = defineLedger((sledge) =>
    sledge.expose({
      query: sledge.install(defineQueryModule(() => "ready")),
    }),
  );

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

    return sledge.expose({ query });
  });

  await assert.rejects(fixture.open(application), /configured query failure/);
});

test("opening waits for an abandoned in-flight assembly query", async () => {
  await using fixture = await createFixture(
    "better-sqlite3",
    "abandoned-query-settlement",
  );
  const bootstrap = defineLedger((sledge) =>
    sledge.expose({
      query: sledge.install(defineQueryModule(() => "ready")),
    }),
  );

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

    return sledge.expose({ query });
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
    const registered = linkLedgerModule(declaration, null).register({});

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
    const registered = linkLedgerModule(declaration, materialization).register({
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
  const registered = linkLedgerModule(declaration, materialization).register({
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
  const registered = linkLedgerModule(declaration, materialization).register({
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
    const registered = linkLedgerModule(declaration, materialization).register({
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
  ): Promise<
    OpenedLedger<
      LedgerApplicationCapabilities<TApplication>,
      LedgerApplicationModules<TApplication>
    >
  >;
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
