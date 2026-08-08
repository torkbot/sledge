# @torkbot/sledge

A SQLite-backed event and work engine for building durable, restart-safe
workflows.

Sledge stores events and durable work, runs event handlers transactionally, and
lets applications define typed materialization tables without handing raw SQL
handles to indexer and query callbacks.

## What You Get

- Durable event append with producer idempotency through `dedupeKey`
- Event -> materialization -> work in one transaction
- Typed materialization schema, event refs, indexers, and queries
- Immutable module phases with ordered, query-backed application assembly
- Durable queue work with leases, retries, dead-letter outcomes, and restart
  recovery
- Durable event streams through `tailEvents(...)` and `resumeEvents(...)`
- Process-local live signals for short-lived follow-up work
- Owner-bound typed result capabilities for composing reusable ledger modules

## The Application Model

`defineModule(moduleId, callback)` creates a reusable module factory. Its scoped
`module` port declares contracts under that identity, links those declarations
to storage materializations and implementations, and reveals only the bounded
capabilities other code may use. The application definition installs those
contributions in durable order and exposes one capability tree:

```ts
import { defineLedger } from "@torkbot/sledge";
import { createBetterSqliteDriver } from "@torkbot/sledge/better-sqlite3";

const application = defineLedger((sledge) => {
  const users = sledge.install(defineUsersModule());
  const audit = sledge.install(defineAuditModule(users));

  return { audit, users };
});

await using opened = await application.open(
  createBetterSqliteDriver({ databaseUrl }),
);

await opened.ledger.emit(opened.capabilities.users.events.created, {
  userId: "u_123",
});
```

The callback runs once for every open. Its two methods are the complete
assembly vocabulary:

- `install(contribution)` installs one module and immediately returns its exact
  capabilities unchanged.
- `query(token, params)` reads the immutable installed prefix when later module
  choices depend on durable ledger state.

The object returned by the callback selects what consumers receive. Sledge
enforces application membership against the composed runtime graph rather than
rewriting that object in the type system.

The application owns assembly and opening. Its driver owns storage compilation,
connections, and migrations. Together they create temporary query-only prefix
views, validate the final graph, and open the one live ledger runtime.
Applications do not compose model handles or activate a partially prepared
value.

## Complete Example

```ts
import { Type } from "typebox";

import { defineLedger, defineModule } from "@torkbot/sledge";
import { createBetterSqliteDriver } from "@torkbot/sledge/better-sqlite3";
import { defineMaterialization } from "@torkbot/sledge/ledger";
import { NodeRuntimeScheduler } from "@torkbot/sledge/runtime/node-runtime";

const databaseUrl = "./app.sqlite";

const defineUsersModule = defineModule("app.users", (module) => {
  const declaration = module.declare({
    events: {
      "user.created": Type.Object({
        userId: Type.String(),
        email: Type.String(),
      }),
    },
    queues: {
      "welcome-email.send": Type.Object({
        userId: Type.String(),
        email: Type.String(),
      }),
    },
  });

  const materializations = defineMaterialization(declaration, {
    namespace: "app",
  })
    .version(1, "create app tables", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .define({
      indexers: {
        upsertUser: {
          sourceEvent: "user.created",
          input: Type.Object({
            userId: Type.String(),
            email: Type.String(),
          }),
        },
      },
      queries: {
        userById: {
          params: Type.Object({ userId: Type.String() }),
          result: Type.Union([
            Type.Null(),
            Type.Object({
              userId: Type.String(),
              email: Type.String(),
            }),
          ]),
        },
      },
    });

  const registered = module.link(declaration, materializations, {
    indexers: {
      upsertUser: async ({ input, event, db }) => {
        await db
          .insertInto("users")
          .values({
            userId: input.userId,
            email: input.email,
            source: event.ref,
          })
          .onConflict(["userId"])
          .doUpdateSet({
            email: input.email,
            source: event.ref,
          })
          .execute();
      },
    },
    queries: {
      userById: async ({ params, db }) => {
        const row = await db
          .selectFrom("users")
          .select(["userId", "email"])
          .where("userId", "=", params.userId)
          .executeTakeFirst();

        if (row === undefined) {
          return null;
        }

        return {
          userId: row.userId,
          email: row.email,
        };
      },
    },
    events: {
      "user.created": async ({ event, actions }) => {
        await actions.index("upsertUser", {
          userId: event.payload.userId,
          email: event.payload.email,
        });

        await actions.enqueue(
          "welcome-email.send",
          {
            userId: event.payload.userId,
            email: event.payload.email,
          },
          { workKey: `welcome-email:${event.payload.userId}` },
        );
      },
    },
    queues: {
      "welcome-email.send": async ({ work }) => {
        console.log("sending welcome email", work.payload.email);
      },
    },
  });

  return module.expose(registered, {
    events: registered.events,
    queries: registered.queries,
  });
});

const application = defineLedger((sledge) => {
  const users = sledge.install(defineUsersModule());

  return { users };
});
const runtimeScheduler = new NodeRuntimeScheduler();

await using opened = await application.open(
  createBetterSqliteDriver({ databaseUrl }),
);

await using workers = await opened.ledger.startWorkers({
  configureQueue: () => ({ maxInFlight: 8 }),
  scheduler: runtimeScheduler,
});

await opened.ledger.emit(opened.capabilities.users.events["user.created"], {
  userId: "u_123",
  email: "alice@example.com",
});

const user = await opened.ledger.query(
  opened.capabilities.users.queries.userById,
  {
    userId: "u_123",
  },
);
console.log(user);
```

Invocation-shaped hosts can process everything eligible now and then release
their runtime instead of keeping background workers resident:

```ts
const quiescence = await opened.ledger.runWorkersUntilQuiescent({
  configureQueue: () => ({ maxInFlight: 8 }),
  scheduler: runtimeScheduler,
  signal,
});

// A durable alarm or scheduler can arrange the next activation.
console.log(quiescence.nextEligibleAtMs);
```

Present quiescence means that no known queue work is eligible or executing at
the current runtime-clock instant. Delayed work remains durable and contributes
the returned `nextEligibleAtMs`.

## Migrating to 0.26

Version 0.26 finishes the application assembly design introduced in 0.25. The
application now opens itself with an injected storage driver, and Node timing is
the default. This is an intentional source-level break; there are no deprecated
aliases or compatibility adapters.

### Replace root composition with an application

In 0.24, callers retained every registered module so they could compose the
final model and then use those same handles as runtime capabilities:

```ts
const model = composeLedgerModules(usersModule, auditModule);

await using ledger = await createBetterSqliteLedger({
  model,
  databaseUrl,
  timing,
});

await ledger.emit(usersModule.events.created, payload);
```

Define modules with `defineModule(...)`. Install their revealed contributions
inside `defineLedger(...)`, return the application capability tree, then ask
that application to open with a driver:

```ts
const application = defineLedger((sledge) => {
  const users = sledge.install(defineUsersModule());
  const audit = sledge.install(defineAuditModule(users));

  return { audit, users };
});

await using opened = await application.open(
  createBetterSqliteDriver({ databaseUrl }),
);

await opened.ledger.emit(opened.capabilities.users.events.created, payload);
```

The application owns the registered module handles. Consumers receive only the
capabilities deliberately returned by the callback; they do not need to retain
or propagate a parallel model graph.

### Replace hand-built module contributions

In 0.25, each factory repeated its module id across primitives and declaration,
then returned a structural `{ module, capabilities }` object. In 0.26,
`defineModule(...)` binds that identity once and passes a fresh scoped owner to
the factory:

```ts
const defineUsersModule = defineModule("app.users", (module) => {
  const declaration = module.declare({
    events: {
      created: Type.Object({ userId: Type.String() }),
    },
  });
  const registered = module.link(declaration, null, {});

  return module.expose(registered, {
    events: registered.events,
  });
});
```

`module.link(...)` accepts only declarations minted by that exact factory
invocation. This gives Sledge a private seam for module-owned plumbing without
making declarations mutable or allowing values to leak between invocations.
That private provenance follows the linked value into registration, so
`module.expose(...)` also rejects a registered module that bypassed the scoped
link.

The callback must synchronously return its one `module.expose(...)` result.
That call verifies the registered module's owner, revokes the construction
port, and produces the only value accepted by `sledge.install(...)`. Module
dependencies remain ordinary, explicit factory arguments:

```ts
const defineAuditModule = defineModule(
  "app.audit",
  (module, users: UsersPort) => {
    const declaration = module.declare({
      events: { userCreated: users.events.created },
    });
    const registered = module.link(declaration, null, {
      events: {
        userCreated: ({ event }) => console.log(event.payload.userId),
      },
    });

    return module.expose(registered, { events: registered.events });
  },
);

const users = sledge.install(defineUsersModule());
const audit = sledge.install(defineAuditModule(users));
```

### Replace prepared-model resolution with assembly queries

`defineLedgerModel(...)`, `prepare(...)`, and `extend(...)` are removed. Install
the registry contribution, query that installed prefix, then install the modules
selected by userspace policy:

```ts
const application = defineLedger(async (sledge) => {
  const registry = sledge.install(defineModuleRegistry());
  const descriptors = await sledge.query(
    registry.queries.configuredModules,
    {},
  );
  const configured = [];

  for (const descriptor of descriptors) {
    const defineConfiguredModule = await loadModule(descriptor);
    configured.push(sledge.install(defineConfiguredModule()));
  }

  return { configured, registry };
});
```

Each query observes the immutable module prefix installed at that point. A
later install creates the next prefix. Sledge drains every started query before
opening the final runtime, and an abandoned query failure rejects the open.

### Update imports and opened values

| Before                                           | 0.26                                                  |
| ------------------------------------------------ | ----------------------------------------------------- |
| `composeLedgerModules(...)`                      | `defineLedger(...)` plus `sledge.install(...)`        |
| `defineLedgerModel(...)`                         | An async `defineLedger(...)` callback                 |
| `prepare(...)` / `extend(...)`                   | `sledge.query(...)` / `sledge.install(...)`           |
| `defineSledge(...)`                              | `defineLedger(...)`                                   |
| `{ module, capabilities }`                       | `defineModule(...)` plus `module.expose(...)`         |
| `createBetterSqliteSledge({ application, ... })` | `application.open(createBetterSqliteDriver({ ... }))` |
| `createTursoSledge({ application, ... })`        | `application.open(createTursoDriver({ ... }))`        |
| A required production `timing` input             | Node timing by default; an optional test override     |
| Registered module handles used as public API     | `OpenedLedger.capabilities`                           |

The root `defineLedger` export is now the application entry point. Low-level
ledger declarations remain under `@torkbot/sledge/ledger`, and the two driver
factories keep their adapter subpaths.

### Preserve the durable graph

The application API does not change the durable storage layout. Existing
databases remain valid when the application installs the same module ids in the
same order as the 0.24 composed root. Changing that set or order is still a
durable model change requiring an intentional migration or reset.

A fresh database has no ledger-owned registry state to query. Its first open
must install the complete initial graph from code or external bootstrap input.
Later opens may query an installed registry prefix to reconstruct that exact
graph.

## Experimental Operators

`@torkbot/sledge/experimental/operators` contributes three small dataflow
primitives to the ordinary module interface. An operator is immutable reusable
behavior; a binding installs that behavior as one independently durable node.
Operator ports may be revealed through acyclic plain records and arrays. These
capability values are module-authored data in the same trust domain as the
ledger composition; class instances, prototype accessors, cyclic graphs, and
adversarially forged ports are outside this experimental contract.

```ts
import { defineModule } from "@torkbot/sledge";
import {
  CoalescingOperation,
  ForEach,
  MapAsync,
} from "@torkbot/sledge/experimental/operators";

const extractMemory = new MapAsync("extract-memory", {
  input: CompactionRequest,
  output: ExtractedMemory,
  timeoutMs: 30_000,
  map: async (request, { key, signal }) =>
    memoryExtractor(request, { idempotencyKey: key, signal }),
});

const recordMetric = new ForEach("record-metric", {
  input: ExtractedMemory,
  run: async (memory, { key, signal }) =>
    metrics.record(memory, { idempotencyKey: key, signal }),
});

const defineCompactionFlow = defineModule("app.compaction-flow", (module) => {
  const requested = module.event("requested", CompactionRequest);
  const memory = module.bind(
    "extract-compaction-memory",
    requested,
    extractMemory,
  );

  module.bind("record-compaction-metric", memory, recordMetric);

  const declaration = module.declare({
    // Listing a port here makes it available to ordinary handlers,
    // materializations, and queries in this module. Unlisted ports remain
    // private but are still compiled into the ledger model.
    events: { requested, "extract-compaction-memory": memory },
  });
  const registered = module.link(declaration, null, {});

  return module.expose(registered, { requested, memory });
});
```

`MapAsync` turns each source event into private work and emits one durable
settlement. A returned value produces `{ outcome: "succeeded", value }`. A
thrown value, output-schema violation, or operator timeout produces
`{ outcome: "failed", error }`; mapper code does not need a `try`/`catch`.
`timeoutMs` is required so every asynchronous mapping has an explicit bound.

`CoalescingOperation` handles stateful demand such as refreshing an index or
compacting a conversation lane. The source event must be a canonical demand
signal: events coalesced into the same live generation or pending successor
must have the same decoded payload. The operation may query installed ledger
projections for current authoritative state instead of carrying a stale
snapshot in the trigger.

```ts
const compactLane = new CoalescingOperation("compact-lane", {
  input: Type.Object({ laneId: Type.String({ minLength: 1 }) }),
  output: CompactedEpoch,
  timeoutMs: 30_000,
  queries: { conversationPrefix },
  keyBy: (request) => request.laneId,
  run: async (request, { key, attempt, signal, ledger }) => {
    const prefix = await ledger.query(conversationPrefix, {
      laneId: request.laneId,
    });

    return await compact(prefix, { idempotencyKey: key, attempt, signal });
  },
});

const requested = module.event("compaction-requested", CompactionRequest);
const epochProduced = module.import(conversationEvents.epochProduced);
const settled = module.bind("compact-lane", requested, compactLane, {
  continueWith: epochProduced,
});
```

One generation per key holds a valid lease at a time, including across workers
and processes. Demand arriving after a generation is claimed collapses into at
most one pending successor. Different keys remain concurrent subject to the
queue's worker-level concurrency configuration. Every admitted generation is
at least once, so external effects must use the stable `key` for idempotency or
fencing.
Successful output is emitted directly to the typed continuation event in the
same transaction that completes the generation. The returned settlement port
also records failures without requiring the continuation protocol to model a
failure outcome.

Same-key events with different payloads fail the enclosing event transaction
while a generation or its pending successor remains live; Sledge cannot choose
whether first, latest, or merged data is correct. After all work for that key
completes, a later event starts a new stream and may carry a different payload.
Emit a smaller semantic demand event and query current state when the operation
runs.

Cancellation and lease loss revoke ownership; they cannot forcibly stop
JavaScript already executing in an attempt. A signal-ignoring attempt may
therefore overlap a later valid attempt, as with any at-least-once durable work.
Operations must propagate `signal`, and external writes that cannot be made
idempotent must reject stale attempt keys with application-level fencing.

Bindings compose settlements automatically. A downstream `MapAsync` or
`ForEach` receives the successful value rather than the wrapper. An upstream
failure flows unchanged through downstream `MapAsync` bindings without calling
their mapper, so one failure remains one portable graph outcome rather than a
nested series of wrappers.

`module.indexer(port)` binds a materialization indexer directly to an operator
port. The port supplies both event identity and settlement schema, and Sledge
dispatches the indexer before the port's ordinary event handler. Authors do not
repeat `sourceEvent`, repeat `input`, or write a handler whose only purpose is
calling `actions.index(...)`.

Inside that indexer, `module.origin(context, requested)` follows the compiled
operator graph and returns the typed ancestor event. Module authors do not
reconstruct event refs, parse work identities, or write private causation
queries.

`ForEach` is a terminal sink: it retries an external effect but emits no output
event. Both operators receive a stable idempotency key, attempt number, and
active signal. Storage and worker interruptions may replay work, so external
effects remain at-least-once. Per-operator retry policy is deliberately not
part of this experimental interface.

Sledge serializes every operator exception with the same flat cause-chain wire
shape. `serializeException(...)` accepts any thrown JavaScript value and
`rehydrateException(...)` returns ordinary `Error` instances linked by
`cause`; rehydration does not depend on application-specific error classes.

The operator name identifies reusable behavior in diagnostics. The binding id
is the durable queue and output-event identity. Reusing one operator under two
binding ids shares implementation but never execution state.

Bindings compile with the rest of their module into ordinary Sledge events,
handlers, and queues. There is no second kind of module, workflow interpreter,
or generic protocol event. This also lets one module combine dataflow bindings
with its own handlers and materializations. The experimental surface remains
deliberately small: `MapAsync`, `ForEach`, and `CoalescingOperation` each exist
because a distinct application pressure justified their durable semantics.

## Module and Application Phases

Sledge separates module definition, module construction, application assembly,
and the opened runtime. `defineModule(...)` creates a reusable factory around
one stable identity. Each invocation receives a fresh library-owned port,
returns new values as capabilities become valid, and finishes by revealing one
installable contribution. Application assembly then uses a second small scoped
interface: install a module, query the installed prefix when discovery needs
durable state, and expose the capabilities the opened application should
reveal.

Sledge does not define plugins, plugin manifests, or module loading policy. A
userspace registry may store plugin descriptors, package ids, feature flags, or
any other configuration. Sledge only supplies the phase boundaries needed to
query that registry and build one final ledger model safely.

| Phase                      | Produced by                      | Capability added                                          |
| -------------------------- | -------------------------------- | --------------------------------------------------------- |
| Module factory             | `defineModule(...)`              | Reusable definition bound to one stable module identity   |
| `LedgerModuleDefinition`   | Invoking the module factory      | Scoped identity, declaration, linking, and one reveal     |
| `DeclaredLedgerModule`     | `module.declare(...)`            | Durable contract tokens and a typed logical shape         |
| Linked implementation      | `module.link(...)`               | Storage contract and implementations; ready to reveal     |
| `LedgerModuleContribution` | `module.expose(...)`             | Bounded capabilities with private installation provenance |
| `LedgerApplication`        | `defineLedger(...)`              | A reusable, storage-independent assembly definition       |
| `OpenedLedger`             | `await application.open(driver)` | Per-open capabilities plus the owning ledger runtime      |

There is no public composed, prepared, sealed, or activated model. Those are
adapter-owned implementation phases. Returning from the callback finishes
assembly, revokes its scoped methods, and lets the adapter open the exact
installed graph.

### 1. Declare Durable Contracts

`module.declare(...)` uses the factory's stable `moduleId` and declares durable
boundary contracts with TypeBox:

- `events`: facts appended to the event stream
- `queries`: query tokens imported from installed modules for use by this
  module's handlers
- `queues`: durable work payloads
- `signals`: process-local, short-lived records emitted by queue handlers
- `signalQueues`: retryable work materialized from signals

`events` is required. Omit `queries`, `queues`, `signals`, or `signalQueues`
when the module does not define contracts in that category. Imported queries
do not give the module ownership of another projection; they name an explicit
read capability that its private durable work may invoke. Plain event definitions
create contracts owned by that module and produce opaque event tokens such as
`declaration.events["user.created"]`. Runtime APIs accept these tokens
instead of string names.

Module construction has no standalone equivalent. `module.declare(...)` and
`module.link(...)` are scoped to the current factory invocation so identity and
construction ownership cannot drift across primitives and contracts.

```ts
const declaration = module.declare({
  events: {
    requested: Type.Object({ laneId: Type.String() }),
  },
  queries: {
    conversationPrefix: conversations.queries.prefixByLane,
  },
  queues: {
    select: Type.Object({ laneId: Type.String() }),
  },
});

const registered = module.link(declaration, null, {
  events: {
    requested: ({ event, actions }) => {
      actions.enqueue("select", event.payload);
    },
  },
  queues: {
    select: async ({ work, actions }) => {
      const prefix = await actions.query("conversationPrefix", {
        laneId: work.payload.laneId,
      });

      // Continue with an ordinary caller-owned event.
    },
  },
});
```

An event may declare a durable result alongside its payload:

```ts
const defineDecisionsModule = defineModule("decisions", (module) => {
  const declaration = module.declare({
    events: {
      recorded: {
        payload: Type.Object({
          decisionId: Type.String(),
        }),
        outcome: Type.Object({
          revision: Type.Integer({ minimum: 1 }),
        }),
      },
      "decision.observed": Type.Object({
        decisionId: Type.String(),
        revision: Type.Integer({ minimum: 1 }),
      }),
    },
    queues: {
      "decisions.record": Type.Object({
        decisionId: Type.String(),
      }),
    },
  });
  const registered = module.link(declaration, null, {
    events: {
      recorded: () => ({ revision: 1 }),
    },
  });

  return module.expose(registered, { events: registered.events });
});
```

The event's owning handler returns that outcome after applying its projection
changes. Sledge validates and persists the result in the same transaction as
the event. `ledger.emit(...)` then returns the ordinary durable event envelope
plus its typed `outcome`. A deduplicated emission returns the original event,
payload, and outcome rather than evaluating the handler again.

### 2. Link Storage Materializations

Call `defineMaterialization(declaration, { namespace })` to define one
materialization namespace. The table schema is the outcome of the ordered
version chain; there is no separate current-schema DDL to keep in sync.

Each `.version(...)` callback receives a typed migration chain. Operations
append metadata and advance the schema type visible to later operations:

```ts
import type {
  MaterializationDatabaseFor,
  MaterializationImplementationRegistrationFor,
  MaterializationMigrationDatabaseFor,
  MaterializationReadDatabaseFor,
  MaterializationSchemaFor,
  MaterializationWriteDatabaseFor,
} from "@torkbot/sledge/ledger";

const defineUsersModule = defineModule("app.users", (module) => {
  const declaration = module.declare({
    events: {
      "user.created": Type.Object({
        userId: Type.String(),
        email: Type.String(),
      }),
    },
  });

  const materializations = defineMaterialization(declaration, {
    namespace: "app",
  })
    .version(1, "create users", (s) =>
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    )
    .version(2, "add user email", (s) =>
      s
        .addColumn("users", "email", (t) => t.text())
        .createIndex("usersByEmail", "users", ["email"])
        .data("backfill user email", async ({ db }) => {
          const events = await db.scanEvents("user.created").execute();

          for (const event of events) {
            await db
              .updateTable("users")
              .set({ email: event.payload.email })
              .where("userId", "=", event.payload.userId)
              .execute();
          }
        }),
    )
    .define({
      indexers: {
        upsertUser: {
          sourceEvent: "user.created",
          input: Type.Object({ userId: Type.String() }),
        },
      },
      queries: {
        userById: {
          params: Type.Object({ userId: Type.String() }),
          result: Type.Null(),
        },
      },
    });

  type AppSchema = MaterializationSchemaFor<typeof materializations>;
  type AppReadDb = MaterializationReadDatabaseFor<
    typeof materializations,
    typeof declaration.shape.events
  >;
  type AppWriteDb = MaterializationWriteDatabaseFor<typeof materializations>;
  type AppDb = MaterializationDatabaseFor<
    typeof materializations,
    typeof declaration.shape.events
  >;
  type AppMigrationDb = MaterializationMigrationDatabaseFor<
    typeof materializations,
    typeof declaration.shape.events
  >;
  type AppImplementations = MaterializationImplementationRegistrationFor<
    typeof materializations,
    typeof declaration.shape.events
  >;

  const registered = module.link(declaration, materializations, {
    indexers: { upsertUser: () => undefined },
    queries: { userById: () => null },
  });

  return module.expose(registered, {
    events: registered.events,
    queries: registered.queries,
  });
});
```

Semantic event refs are first-class columns and must point at real ledger
events:

```ts
source: t.eventRef("user.created").notNull();
```

Foreign keys are migration operations. Because operations advance the carried
schema type, the relation builder sees tables created earlier in the chain:

```ts
.version(1, "create session tables", (s) =>
  s
    .createTable("users", (t) =>
      t.columns({ userId: t.text().notNull() }).primaryKey(["userId"]),
    )
    .createTable("sessions", (t) =>
      t
        .columns({
          sessionId: t.text().notNull(),
          userId: t.text().notNull(),
        })
        .primaryKey(["sessionId"]),
    )
    .addForeignKey("sessionUser", (r) =>
      r.foreignKey("sessions", ["userId"]).references("users", ["userId"]),
    ),
)
```

Data migration steps are typed against the schema state at that point in the
chain. They can also read or scan typed ledger events with `readEvent(...)`,
`readEvents(...)`, and `scanEvents(...)` without seeing the internal `events`
table. Data migrations receive a Sledge-owned typed database facade, not a raw
SQL handle, so executors can inject tenancy and storage-specific behavior
before operations reach the database.

Sledge validates that materialization histories start at version 1, versions
are unique positive integers, versions have no gaps, and later operations only
reference schema objects available at that point in the chain.

When helper code needs named types, derive them inside the same module factory
from its local materialization and declaration values, as above, instead of
restating table shapes. `module.link(...)` binds the declaration,
materializations, and their implementations as one operation. There is no
intermediate public value that exists only to accept registration.

The link phase is explicit even when a module owns no projection:

```ts
const defineNotificationsModule = defineModule(
  "app.notifications",
  (module) => {
    const declaration = module.declare({ events: {} });
    const registered = module.link(declaration, null, {});

    return module.expose(registered, {});
  },
);
```

`null` means the module intentionally has no materialization history. The empty
registration says that this module has no handlers. A declaration cannot
participate in a model until its storage contract and implementations have
been linked.

### 3. Link Implementations

Pass the registration to `module.link(...)` to attach indexer implementations,
query implementations, event handlers, queue handlers, signal handlers, and
signal-queue handlers.

Indexer and query implementations receive sledge-owned facades:

- indexers can `selectFrom(...)`, `readEvent(ref)`, `insertInto(...)`,
  `updateTable(...)`, and `deleteFrom(...)`
- queries can `selectFrom(...)` and `readEvent(ref)`, but cannot mutate
  materialization tables
- reads support typed predicates, null predicates, typed `whereAny([...])`
  disjunction groups, typed single-column and composite
  `innerJoin(...).selectFrom(...)` table joins, typed single-column and
  composite `leftJoin(...).selectFrom(...)` optional-row joins, typed
  `whereNotExists(...)` anti-joins, typed aggregate reads with `count(...)`,
  `countNotNull(...)`, `min(...)`, and `max(...)`, `orderBy(...)`, explicit
  nullable-column `orderByNulls(...)`, domain-specific `orderByList(...)`
  value ordering, `limit(...)`,
  `execute()`, `executeTakeFirst()`, and `stream()`
- reads can compose typed candidate streams with `unionFrom(...)`,
  `unionValue(...)`, and `unionAll(...)` without exposing raw SQL
- reads can stream historical events with `scanEvents(eventName)` and retained
  signals with `scanSignals(signalName)`, filter by typed top-level scalar
  payload fields, choose event-id ordering, read event-id bounds, and group
  latest semantic event refs by string payload keys without exposing the
  internal `events` table
- writes return affected-row metadata and support typed integer `add(...)`,
  bounded `decrementIfPositive(...)`, `MAX(...)`, `COALESCE(...)`, and upsert
  `excluded` expressions without raw SQL
- inserts can bind one typed row or an array of typed rows, including conflict
  handling, so migration backfills can batch projection writes without raw SQL

Semantic event refs can be hydrated one at a time with `readEvent(ref)` or in
batches with `readEvents(refs)`. Batch reads preserve the input order and avoid
one storage round trip per row:

```ts
const events = await db.readEvents(rows.map((row) => row.source));
```

When the refs already live in one materialization table, select their events
in the same storage statement:

```ts
const events = await db
  .selectFrom("pendingInputs")
  .selectEvent("source")
  .where("laneId", "=", laneId)
  .orderBy("sequence", "asc")
  .execute();
```

`selectEvent(...)` accepts non-null `eventRef(...)` columns and returns typed,
schema-decoded event envelopes. It preserves the projection row order and one
result per projection row, including duplicate refs. A ref whose event is
missing or belongs to a different event contract is reported as storage
corruption instead of being silently omitted.

Application-defined row priority can be expressed without raw `CASE` SQL:

```ts
const docs = await db
  .selectFrom("profileDocs")
  .select(["docId", "version", "content"])
  .orderByList("docId", ["SOUL", "IDENTITY", "USER"])
  .execute();
```

Aggregate reads return a single typed object keyed by the declared aliases:

```ts
const summary = await db
  .selectFrom("toolCalls")
  .aggregate()
  .count("totalToolCallCount")
  .countNotNull("completedToolCallCount", "resultMessageJson")
  .min("firstToolCallAtMs", "createdAtMs")
  .max("latestToolCallAtMs", "createdAtMs")
  .where("runId", "=", params.runId)
  .execute();
```

They do not receive a raw storage handle. Event handlers can `index`, `enqueue`,
and `query`.

The low-level database engine and storage scope are internal implementation
details, not package exports.

Linking returns a frozen, inert module. Its durable identity cannot be rewritten
after contracts have been namespaced. It exposes the exact event, query, and
signal tokens that consumers use, but it cannot touch storage or start work.

### 4. Reveal Modules and Define the Application

`defineModule(moduleId, callback)` returns a frozen, synchronous factory. Every
factory invocation receives a fresh `LedgerModuleDefinition` with exactly four
public capabilities:

- `moduleId` exposes the stable literal identity to reusable primitives.
- `declare(contracts)` declares contracts under that identity.
- `link(declaration, materializations, implementations)` adds the storage
  contract and implementations to a declaration created by that exact factory
  invocation.
- `expose(registered, capabilities)` verifies a Sledge-registered module has
  that identity, revokes the scoped port, and returns one authentic
  `LedgerModuleContribution`.

The module object is created and controlled by Sledge. A library-owned
contribution carrier keeps the implementation in a private field while exposing
only its capabilities. A retained module object is unusable after the factory
returns, a second reveal fails, and `sledge.install(...)` rejects a
hand-assembled contribution at runtime as well as at compile time.

Declaration, linking, and exposure form a capability-narrowing flow.
Materializations remain ordinary values passed into `module.link(...)`, and
every phase returns a new value rather than mutating the previous one.
Reusable userspace primitives can accept the narrower
`LedgerModuleOwner` interface when they need identity but should not receive
declaration, linking, or reveal authority.

`defineLedger(...)` installs revealed contributions in deterministic order and
returns the application-level capability tree:

```ts
import { defineLedger } from "@torkbot/sledge";

const application = defineLedger((sledge) => {
  const users = sledge.install(defineUsersModule());
  const audit = sledge.install(defineAuditModule(users));
  const delivery = sledge.install(defineDeliveryModule(users));

  return { audit, delivery, users };
});
```

`install(...)` immediately returns that contribution's exact capability type.
The registered module stays inside assembly, so callers neither retain model
handles nor perform a final composition step. The same application definition
is reusable: every open runs it again and receives the capability tree returned
by that run. Concurrent opens never share assembly state.

Module factories may declare ordinary arguments after the injected module
owner and consume capabilities installed earlier in the same assembly, as
`defineAuditModule(users)` does above. Capabilities remain the exact userspace
types returned by their modules; Sledge does not recursively rewrite arbitrary
objects to encode application membership.

Ledger ownership is enforced where Sledge has authoritative information. When
a module declares an imported event or query token, final graph composition
requires the exact owning module and token. Assembly queries and opened-ledger
operations resolve tokens against the exact runtime graph and reject unknown
token identities. Contributions normally created inside the callback receive
fresh token identities on every open, so those tokens cannot cross openings. A
contribution deliberately created outside the callback and reused across opens
also deliberately reuses its token identities. The callback may return any
selected capability subtree without changing those rules.

TypeScript still infers event payloads, outcomes, query parameters, and query
results from the token passed to an operation. Application membership itself is
a runtime graph invariant rather than a recursive property of every capability
value. Graph-wide `tailEvents(...)` and `resumeEvents(...)` streams have no
token argument from which to infer a narrower installed event union, so their
application-level event payloads are broadly typed. Modules retain their exact
event tokens for typed emits, queries, outcomes, and application-side narrowing.

Installation order is durable and semantic. For one append, Sledge runs module
contributions from left to right in that order inside one atomic transaction.
A query during indexing sees committed state plus earlier writes from the same
append, never later writes. Any failure rolls back the event, projection
writes, and queued work from every module.

Modules may reuse another installed module's exact event or query tokens when
declaring their own contracts. Those aliases establish contract availability;
they do not duplicate persisted events, query implementations, or storage
ownership. Indexers, queues, projection schema, and migrations remain owned by
the module that defines them.

#### Discover Modules From Ledger Queries

An application can query its installed prefix before choosing later modules:

```ts
const application = defineLedger(async (sledge) => {
  const registry = sledge.install(defineModuleRegistry());
  const descriptors = await sledge.query(
    registry.queries.configuredModules,
    {},
  );

  for (const descriptor of descriptors) {
    const defineConfiguredModule = await loadConfiguredModule(descriptor);
    sledge.install(defineConfiguredModule());
  }

  return { registry };
});
```

Calling `query(...)` forms a phase boundary. Sledge prepares an immutable,
query-only view of every module installed so far, runs the typed query, and
keeps append, workers, streams, signals, and the public ledger API unavailable.
Installing more modules creates the next prefix; another query observes that
expanded prefix. Repeated queries without another install reuse the prepared
view.

The application—not Sledge—interprets descriptors, loads code, applies trust
policy, and decides when discovery is complete. Sledge has no built-in concept
of plugins. A plugin registry, feature flags, tenant configuration, or another
design can all be built from the same `install` and `query` phases.

Assembly methods are scoped to one open and revoked as soon as the definition
returns. Sledge drains queries that began legitimately before opening the
owning runtime, so a retained closure cannot overlap or re-enter it. Every
started query must succeed: an abandoned rejection fails the open rather than
becoming an unobserved background error.

On an existing database, every queried prefix must match the beginning of the
stored module order. The final installed graph must match that durable root
exactly. Changing the set or order is a durable model change requiring an
intentional migration or reset; it is not runtime hot-plugging.

A fresh database has no durable facts or root from which to discover modules.
Its first open must install the complete initial graph from code or external
bootstrap input without querying. Later opens may reconstruct that same graph
from ledger queries. Querying an unowned database fails before migrations run,
so Sledge never guesses a bootstrap or root-evolution policy.

### 5. Run Database Hygiene

Opening a ledger creates Sledge's internal tables and ensures the declared
materialization tables and indexes exist from the migration-derived current
schema. Startup records applied namespace versions and runs pending migration
steps through Sledge-owned typed facades. A fresh namespace creates the current
schema in one pass, then replays data migration steps. Existing namespaces
apply supported incremental DDL and data steps. SQLite cannot add foreign-key
constraints incrementally, so
`addForeignKey(...)` migrations are rejected after a namespace has already been
created.

Module identity namespaces projection tables, projection indexes, durable
queues, and materialization histories in SQLite, so independently defined
modules can use the same local names without physical collisions.

The first open records the application's ordered module ids. Every later
runtime opening that database must supply the exact same modules in the same
installation order. Query-backed prefixes are checked before their module
migrations, and the completed graph is checked exactly before the runtime
opens. Rolling processes therefore cannot apply different handler
contributions to one logical ledger.

### 6. Open a Runtime

Create a driver, then pass it to the application:

```ts
await using opened = await application.open(
  createBetterSqliteDriver({ databaseUrl }),
);
```

`createBetterSqliteDriver(...)` and `createTursoDriver(...)` return inert,
storage-specific drivers. `application.open(driver)` runs assembly against that
driver and returns an `OpenedLedger` containing the per-open `capabilities` and
the owning `ledger` runtime.

On Node.js, `open(...)` supplies `SystemRuntimeClock` and
`NodeRuntimeScheduler` automatically. Deterministic tests may pass one coherent
`LedgerTiming` override as the second argument:

```ts
import { VirtualRuntimeHarness } from "@torkbot/sledge/runtime/virtual-runtime";

const runtime = new VirtualRuntimeHarness(1_900_000_000_000);

await using opened = await application.open(
  createBetterSqliteDriver({ databaseUrl }),
  runtime,
);
```

Drivers take a `databaseUrl` filesystem path and Sledge owns the database
connections they open. SQLite in-memory URLs (`:memory:` and `file:...mode=memory`
forms) are rejected because they cannot provide Sledge's required
multi-connection read/write semantics through these adapters. SQLite URI strings
starting with `file:` are also rejected because the current drivers do not parse
them as SQLite URI filenames consistently. Pass a normal filesystem path for
local SQLite. The `better-sqlite3` adapter verifies that the opened database
actually enters WAL journal mode and rejects databases that cannot.

Durable Object runtimes already own their SQLite connection. Use the dedicated
adapter without exposing a filesystem path:

```ts
import { createDurableObjectDriver } from "@torkbot/sledge/durable-object";

await using opened = await application.open(
  createDurableObjectDriver({
    databaseIdentity: state.id.toString(),
    storage: state.storage,
  }),
  timing,
);
```

The Durable Object remains the exclusive database and transaction owner.
Sledge closes only its logical adapter state; it never closes the host-owned
SQLite database.

## Runtime API

The opened ledger exposes:

- `emit(eventToken, payload, options?)`
- `query(queryToken, params)`
- `cancelWork({ ref, reason? })`
- `queryWork({ workId })`
- `listWork({ queueName?, sourceEventId?, states?, limit? })`
- `tailEvents({ last, signal })`
- `resumeEvents({ cursor, signal })`
- `expireHistory({ through })`
- `onSignal(signalToken, observer)`
- `startWorkers(options)`
- `runWorkersUntilQuiescent(options)`
- `close()`

`close()` stops new ledger operations, drains Sledge-owned writes and readers,
checkpoints committed WAL frames into the main SQLite file, truncates the WAL,
and releases the writer connection. Repeated calls share the same completion
and outcome. Close independently opened database connections first: if another
connection keeps the checkpoint busy, `close()` reports the failure after still
releasing Sledge's writer.

Opening a ledger is passive. It initializes storage and can emit, query, tail,
resume, and observe signals, but it does not claim or process queue work until
`startWorkers(...)` is called.

Worker capacity is configured per queue through
`configureQueue({ moduleId, name, kind })`. A saturated queue is excluded from
claim selection, so slow terminal effects cannot block unrelated queues with
free capacity. Optional top-level `maxInFlight` remains a combined process
safety ceiling.

The handle returned by `startWorkers(...)` exposes
`waitForIdle({ signal })`. It resolves once no pending, delayed, leased, or
executing work remains for a queue known to that worker version, including work
blocked behind a partition head. Work for an unknown queue remains durable and
does not prevent that worker from becoming idle; this keeps older processes
from claiming or terminalizing work introduced by a newer rolling deployment.
Retained dead and cancelled work does not prevent idle. The result describes
one instant; later emissions can make the workers active again. The wait
rejects if its signal aborts or the worker runtime closes or fails.

## Work and Retries

Queue and signal queue handlers implicitly ack on normal return.

- Return or resolve: ack
- Throw: retry using the default retry delay
- `control.deferUntil(availableAtMs)`: successful durable deferral to an
  absolute runtime-clock timestamp
- `control.retry(error, { retryAtMs? })`: explicit retry timing
- `control.deadLetter(error)`: terminal durable queue failure
- `control.withTimeout(timeoutMs, operation)`: run an operation under a
  worker-scheduled timeout

Handlers receive a lease with an `AbortSignal`; long-running handlers should
stop when that signal aborts during shutdown or restart.

Durable queue handlers also receive a capability-scoped `ledger` port. It can
immediately emit event tokens and run query tokens referenced by the handler's
module:

```ts
const defineDecisionsModule = defineModule("decisions", (module) => {
  const declaration = module.declare({
    events: {
      recorded: {
        payload: Type.Object({ decisionId: Type.String() }),
        outcome: Type.Object({
          revision: Type.Integer({ minimum: 1 }),
        }),
      },
      "decision.observed": Type.Object({
        decisionId: Type.String(),
        revision: Type.Integer({ minimum: 1 }),
      }),
    },
    queues: {
      "decisions.record": Type.Object({ decisionId: Type.String() }),
    },
  });
  const registered = module.link(declaration, null, {
    events: {
      recorded: () => ({ revision: 1 }),
      "decision.observed": () => {},
    },
    queues: {
      "decisions.record": async ({ work, actions, ledger }) => {
        const committed = await ledger.emit(
          declaration.events.recorded,
          {
            decisionId: work.payload.decisionId,
          },
          {
            dedupeKey: `decision:${work.payload.decisionId}`,
          },
        );

        actions.emit("decision.observed", {
          decisionId: work.payload.decisionId,
          revision: committed.outcome.revision,
        });
      },
    },
  });

  return module.expose(registered, { events: registered.events });
});
```

`ledger.emit(...)` commits before its promise resolves, so the handler can use a
result-bearing event outcome or query its updated projection before continuing.
By contrast, `actions.emit(...)` remains staged until the handler settles, then
commits atomically with the resulting acknowledgement, deferral, retry, or
dead-letter disposition while the attempt still owns its lease. Staged events
describe the attempt; they are not a success-only rollback buffer. The scoped
port does not expose worker control, storage access, or undeclared module
capabilities.

Events emitted through either queue port carry engine-authored
`causationWork` metadata containing the source module ID, local queue name,
durable work ID, and attempt number. Event handlers and replay readers can use
that metadata to require a specific queue authority before accepting a
correctness-sensitive fact. Public `ledger.emit(...)` calls carry
`causationWork: null`; callers cannot supply or impersonate queue provenance.

Use `control.withTimeout(...)` when one operation inside a handler needs a
shorter lifetime than the work lease:

```ts
queues: {
  "tools.execute": async ({ work, actions, control }) => {
    try {
      const result = await control.withTimeout(30_000, async (signal) => {
        return await executeTool(work.payload, { signal });
      });

      actions.emit("tool.completed", result);
    } catch (error: unknown) {
      actions.emit("tool.failed", {
        callId: work.payload.callId,
        reason:
          error instanceof WorkOperationTimeoutError
            ? "timed_out"
            : String(error),
      });
    }
  },
},
```

Sledge schedules the timeout through the worker's `RuntimeScheduler`. The
operation receives one child signal that aborts before `withTimeout(...)`
rejects, whether the timeout expires or the active lease is cancelled. Timeout
rejections use `WorkOperationTimeoutError`; uncaught errors retain the normal
retry behavior, while handlers may catch them and choose another outcome.
Timeout durations must be positive integer milliseconds no greater than
`2,147,483,647`.

Timeout cancellation cannot forcibly stop JavaScript. An operation that ignores
its signal may continue after the handler stops awaiting it.
`control.withTimeout(...)` is a deterministic timing primitive, not an execution
sandbox: the operation retains anything captured by its closure. Pass only the
capabilities it should retain, propagate the signal, and use application-level
idempotency for external side effects.

### Deferred Work

Use `control.deferUntil(...)` when a durable queue handler has run successfully
but the same logical work should become eligible again at an absolute deadline:

```ts
queues: {
  "agent-lane.wake": async ({ work, control }) => {
    const pending = await readPendingStimuli(work.payload.laneId);

    if (pending.length < 20) {
      return control.deferUntil(pending[0].receivedAtMs + 5_000);
    }

    await runAgentTurn(pending);
  },
},
```

The timestamp uses the ledger's injected `RuntimeClock`; it must be finite, and
a timestamp at or before the current clock time is immediately eligible. Sledge
stores the deadline durably and schedules dispatch through the worker's
`RuntimeScheduler`, so restart preserves the remaining delay and virtual-time
tests can advance directly to it. Deferred and partition-blocked work remains
non-idle.

Deferral is not retry. The claimed attempt completes successfully, its staged
events commit with that attempt's authenticated provenance, and the durable row
becomes a clean successor with `attempt: 0`, `lastError: null`, and a handler
attempt of `1` when next claimed. Without an already-pending coalesced
successor, the row keeps its physical work ID, payload, source event, and
partition position. Addressable work receives a fresh `WorkRef`, retiring the
claimed generation's ref; unaddressable work remains without one.

If an event created a same-key coalesced successor while the handler was active,
that newer row wins: Sledge preserves its work ID, payload, source event, and
`WorkRef`, sets its availability to the earlier of its existing timestamp and
the deferred timestamp, and removes the old partition head. Cancelling the
claimed generation fences a later deferral disposition without cancelling the
successor. If the event arrives after deferral commits, its input replaces the
deferred generation with a new work ID and `WorkRef`; its payload, source event,
and partition win while availability remains the earlier of the activity and
deferral timestamps. The result is independent of transaction order.

### Coalesced Work

Use `coalescingKey` when many durable events request the same logical work and
only the earliest requested availability matters:

```ts
const deadlineAtMs = event.payload.oldestPendingAtMs + 5_000;
const availableAtMs =
  event.payload.pendingCount >= 20 ? event.tsMs : deadlineAtMs;

const workRef = await actions.enqueue(
  "agent-lane.wake",
  { laneId: event.payload.laneId },
  {
    availableAtMs,
    coalescingKey: event.payload.laneId,
    partitionKey: event.payload.laneId,
  },
);
```

For one physical queue, repeated enqueues with the same non-empty
`coalescingKey` converge on one live, unattempted work item. The first request
creates it; later requests preserve its original payload, source event, and
`WorkRef` while setting `availableAtMs` to the earlier of the stored and
requested times. A request with a different decoded payload or
`partitionKey` fails its enclosing event transaction.

Because coalescing may reuse an identity already stored by an earlier event,
`actions.enqueue(...)` is asynchronous. The resolved `workRef` above is the
identity of the physical work that actually won, not a speculative candidate.

Claiming work ends that coalescing generation. Requests arriving after claim
create or promote one unattempted successor instead of changing the active
attempt or its retry backoff. Give both generations the same `partitionKey`
when they must not execute concurrently. If the active handler defers, its
deadline composes with that successor as described above; an already-earlier
successor is never delayed.

`coalescingKey` is available only to durable event `actions.enqueue(...)`.
It is mutually exclusive with `workKey`; coalesced work already receives a
Sledge-generated `WorkRef` for inspection and cancellation. Successful,
cancelled, and dead-lettered work release the identity for reuse. Delayed and
partition-blocked coalesced work remains non-idle and survives restart.

### Partitioned Work

Use `partitionKey` when work belongs to an ordered logical stream:

```ts
await actions.enqueue(
  "agent-lane.wake",
  { laneId: event.payload.laneId },
  { partitionKey: event.payload.laneId },
);
```

For one queue, work with the same non-empty partition key executes one item at
a time in enqueue order. A delayed or retrying head blocks later items in that
partition, including across lease recovery, process restarts, and competing
worker runtimes. Dead-lettering or cancelling the head releases its successor.
Different partitions can execute concurrently, and work without a
`partitionKey` retains the existing unconstrained scheduling behavior.

`partitionKey` alone does not coalesce work. Each enqueue remains a durable work
item unless the caller also supplies `coalescingKey`. Sledge stores no separate
partition registry: the key exists only on nonterminal work, successful work is
deleted, and terminal retained work releases the key. Reusing a key after all
of its work becomes terminal starts a fresh stream.

## Work Inspection and Cancellation

Sledge stores durable work rows for queued, leased, delayed-retry,
dead-lettered, and cancelled work. Successful work is deleted when it acks.

Use `workKey` or `coalescingKey` when enqueueing addressable work. Awaiting the
enqueue returns its durable `WorkRef` directly:

```ts
const WelcomeEmailScheduledOutcomeSchema = Type.Object({
  workRef: WorkRefSchema,
});

// In the owning event handler:
const workRef = await actions.enqueue("welcome-email.send", event.payload, {
  workKey: `welcome-email:${event.payload.userId}`,
});

return { workRef };

// In application or queue orchestration code, after emitting that
// result-bearing event:
const scheduled = await ledger.emit(
  emailModule.events["welcome-email.requested"],
  request,
);

await ledger.cancelWork({
  ref: scheduled.outcome.workRef,
  reason: "user requested cancellation",
});
```

Declare `WelcomeEmailScheduledOutcomeSchema` as the event's outcome. Event
handlers cannot call the public ledger recursively, so carry the `WorkRef` out
through an outcome or projection and cancel it from ordinary application or
queue orchestration code. The exported `WorkRefSchema` lets TypeBox validation
preserve the opaque `WorkRef` type at that ledger boundary.

An enqueue with neither `workKey` nor `coalescingKey` resolves to `null`. Its
work is intentionally anonymous and cannot later be cancelled by identity.
Sledge transaction-tracks enqueue promises even when a handler does not use
the result, but await the operation whenever its `WorkRef` contributes to an
event outcome or projection.

`WorkRef` is an opaque string generated and persisted by Sledge. Store and
round-trip the value exactly as returned; do not construct or parse it. Its
representation remains private to the runtime, so work from different modules
remains independently addressable even when the modules use the same local
queue name and `workKey`.

Cancellation is terminal. Cancelled work will not dispatch again, including
after process restart.

## Event Streams

Use durable event streams for external materialization:

```ts
for await (const item of ledger.tailEvents({
  last: 100,
  signal: abortController.signal,
})) {
  await applyEvent(item.event);
  await saveCursor(item.cursor);
}

for await (const item of ledger.resumeEvents({
  cursor: savedCursor,
  signal: abortController.signal,
})) {
  await applyEvent(item.event);
}
```

Cursor values are opaque. Persist and reuse them as-is.

`expireHistory({ through: cursor })` durably advances the earliest stream
position Sledge will serve. The cursor itself remains resumable; an earlier
cursor causes `resumeEvents(...)` to reject with
`LedgerHistoryExpiredError`, and `tailEvents(...)` omits events at or before
the boundary. Repeating the call with the same or an older cursor is a
successful no-op, so competing retention owners cannot move the boundary
backward.

Event streams discover appends and expiration from other handles immediately
within the same process and poll through the injected `RuntimeScheduler` for
changes made by another process.

Expiration is a logical stream boundary. It does not delete event rows,
reclaim storage, or change projections, deduplication, and event-reference
reads. Those physical retention policies can build on this durable boundary
without being embedded in event consumption.

## Package Exports

- `@torkbot/sledge`
- `@torkbot/sledge/ledger`
- `@torkbot/sledge/better-sqlite3`
- `@torkbot/sledge/turso`
- `@torkbot/sledge/runtime/contracts`
- `@torkbot/sledge/runtime/node-runtime`
- `@torkbot/sledge/runtime/virtual-runtime`
- `@torkbot/sledge/experimental/operators`

## Development

```bash
node --run typecheck
node --run test
node --run build
node --run lint
```

## Publishing Notes

- The package is published as compiled JavaScript in `dist/` with `.d.ts`
  types.
- Source remains strict TypeScript in `src/`.
- `prepublishOnly` runs `node --run build` automatically.
- Publishing uses GitHub Actions OIDC trusted publishing.
- Node version is pinned via `engines.node` because runtime code uses explicit
  resource management (`using` / `await using`).
