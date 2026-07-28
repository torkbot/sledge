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
- Durable queue work with leases, retries, dead-letter outcomes, and restart
  recovery
- Durable event streams through `tailEvents(...)` and `resumeEvents(...)`
- Process-local live signals for short-lived follow-up work

## Quick Start

```ts
import { Type } from "typebox";

import { createBetterSqliteLedger } from "@torkbot/sledge/better-sqlite3-ledger";
import {
  composeLedgerModels,
  defineLedgerShape,
  defineMaterialization,
  withMaterializations,
} from "@torkbot/sledge/ledger";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "@torkbot/sledge/runtime/node-runtime";

const databaseUrl = "./app.sqlite";

const ledgerShape = defineLedgerShape({
  moduleId: "app.users",
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
  signals: {},
  signalQueues: {},
});

const materializations = defineMaterialization(ledgerShape, {
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

const definedModel = withMaterializations(ledgerShape, materializations);

const usersModel = definedModel.register({
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

      if (row === null) {
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

      actions.enqueue(
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

const model = composeLedgerModels(usersModel);

await using ledger = createBetterSqliteLedger({
  databaseUrl,
  model,
  timing: {
    clock: new SystemRuntimeClock(),
  },
});

await using workers = await ledger.startWorkers({
  scheduler: new NodeRuntimeScheduler(),
});

await ledger.emit(ledgerShape.events["user.created"], {
  userId: "u_123",
  email: "alice@example.com",
});

const user = await ledger.query(definedModel.queries.userById, {
  userId: "u_123",
});
console.log(user);
```

## Lifecycle

### 1. Define the Ledger Shape

`defineLedgerShape(...)` requires a stable `moduleId` and defines durable
boundary contracts with TypeBox:

- `events`: facts appended to the event stream
- `queues`: durable work payloads
- `signals`: process-local, short-lived records emitted by queue handlers
- `signalQueues`: retryable work materialized from signals

All four fields are explicit. Use `{}` when a shape has no contracts in that
category. Plain event definitions create contracts owned by that module and
produce opaque event tokens such as
`ledgerShape.events["user.created"]`. Runtime APIs accept these tokens instead
of string names.

### 2. Define Materializations From Migrations

Call `defineMaterialization(ledgerShape, { namespace })` to define one
materialization namespace. The table schema is the outcome of the ordered
version chain; there is no separate current-schema DDL to keep in sync.

Each `.version(...)` callback receives a typed migration chain. Operations
append metadata and advance the schema type visible to later operations:

```ts
const materializations = defineMaterialization(ledgerShape, {
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

When helper code needs named types outside inline callbacks, derive them from
the materialization value instead of restating table shapes:

```ts
import type {
  MaterializationDatabaseFor,
  MaterializationImplementationRegistrationFor,
  MaterializationMigrationDatabaseFor,
  MaterializationReadDatabaseFor,
  MaterializationSchemaFor,
  MaterializationWriteDatabaseFor,
} from "@torkbot/sledge/ledger";

type AppSchema = MaterializationSchemaFor<typeof materializations>;
type AppReadDb = MaterializationReadDatabaseFor<
  typeof materializations,
  typeof ledgerShape.shape.events
>;
type AppWriteDb = MaterializationWriteDatabaseFor<typeof materializations>;
type AppDb = MaterializationDatabaseFor<
  typeof materializations,
  typeof ledgerShape.shape.events
>;
type AppMigrationDb = MaterializationMigrationDatabaseFor<
  typeof materializations,
  typeof ledgerShape.shape.events
>;
type AppImplementations = MaterializationImplementationRegistrationFor<
  typeof materializations,
  typeof ledgerShape.shape.events
>;
```

Attach materializations to the ledger shape with `withMaterializations(...)`:

```ts
const definedModel = withMaterializations(ledgerShape, materializations);
```

Ledgers without materialization tables can skip this step and call
`defineLedgerShape(...).register(...)` directly.

### 3. Register Orchestration

Call `definedModel.register(...)` to attach indexer implementations, query
implementations, event handlers, queue handlers, signal handlers, and
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

Registration returns the model passed to a storage adapter. There is no
separate bind step.

### 4. Compose the Root Model

Every runtime receives one explicitly composed root model:

```ts
const model = composeLedgerModels(usersModel, auditModel, deliveryModel);
```

Modules can reuse an event contract by supplying another module's event token
as the definition value. The alias is a code-level name for the exact same
persisted event:

```ts
const auditShape = defineLedgerShape({
  moduleId: "app.audit",
  events: {
    userCreated: ledgerShape.events["user.created"],
  },
  queues: {},
  signals: {},
  signalQueues: {},
});
```

Query definitions work the same way: supplying
`definedModel.queries.userById` in another module's materialization query
definitions creates a local alias that routes to the owning module's query
implementation. The consuming module does not implement that alias.

Event and query references establish contract availability, not execution
order. For one append, Sledge runs contributions in
`composeLedgerModels(...)` order, left to right, inside the existing atomic
transaction. A query invoked during indexing sees committed state plus writes
performed earlier in that append, but never writes from later contributions.
Any failure rolls back the persisted event, projection writes, and queued work
from every module.

Indexer definitions, durable queue definitions, projection tables and indexes,
and materialization histories remain owned by their defining module. Consumers
reference source event tokens and define their own indexers or queues; queues
and indexers cannot be aliased across modules.

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

Composable models use a new canonical storage layout. Opening a database
created by a pre-composition Sledge release fails before any schema mutation.
Reset the database before adopting this API; this release intentionally does
not include a legacy migration or compatibility mode.

### 6. Open a Runtime

Use one adapter to open the ledger:

- `createBetterSqliteLedger(...)`
- `createTursoLedger(...)`

Adapters take a `databaseUrl` filesystem path and Sledge owns the database
connections it opens. SQLite in-memory URLs (`:memory:` and `file:...mode=memory`
forms) are rejected because they cannot provide Sledge's required
multi-connection read/write semantics through these adapters. SQLite URI strings
starting with `file:` are also rejected because the current drivers do not parse
them as SQLite URI filenames consistently. Pass a normal filesystem path for
local SQLite. The `better-sqlite3` adapter verifies that the opened database
actually enters WAL journal mode and rejects databases that cannot.

## Runtime API

The opened ledger exposes:

- `emit(eventToken, payload, options?)`
- `query(queryToken, params)`
- `cancelWork({ ref, reason? })`
- `queryWork({ workId })`
- `listWork({ queueName?, sourceEventId?, states?, limit? })`
- `tailEvents({ last, signal })`
- `resumeEvents({ cursor, signal })`
- `onSignal(signalToken, observer)`
- `startWorkers(options)`
- `close()`

Opening a ledger is passive. It initializes storage and can emit, query, tail,
resume, and observe signals, but it does not claim or process queue work until
`startWorkers(...)` is called.

The handle returned by `startWorkers(...)` exposes
`waitForIdle({ signal })`. It resolves once no pending, delayed, leased, or
executing work remains, including work blocked behind a partition head.
Retained dead and cancelled work does not prevent idle. The result describes
one instant; later emissions can make the workers active again. The wait rejects
if its signal aborts or the worker runtime closes or fails.

## Work and Retries

Queue and signal queue handlers implicitly ack on normal return.

- Return or resolve: ack
- Throw: retry using the default retry delay
- `control.retry(error, { retryAtMs? })`: explicit retry timing
- `control.deadLetter(error)`: terminal durable queue failure

Handlers receive a lease with an `AbortSignal`; long-running handlers should
stop when that signal aborts during shutdown or restart.

### Partitioned Work

Use `partitionKey` when work belongs to an ordered logical stream:

```ts
actions.enqueue(
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

Partitions do not coalesce work. Each enqueue remains a durable work item, so a
handler may treat a redundant wake as a no-op. Sledge stores no separate
partition registry: the key exists only on nonterminal work, successful work is
deleted, and terminal retained work releases the key. Reusing a key after all
of its work becomes terminal starts a fresh stream.

## Work Inspection and Cancellation

Sledge stores durable work rows for queued, leased, delayed-retry,
dead-lettered, and cancelled work. Successful work is deleted when it acks.

Use `workKey` when enqueueing work to get a durable `WorkRef` for cancellation:

```ts
actions.enqueue(
  "welcome-email.send",
  { userId: event.payload.userId, email: event.payload.email },
  { workKey: `welcome-email:${event.payload.userId}` },
);

const work = await ledger.listWork({
  states: ["pending", "delayed", "leased"],
  limit: 100,
});

const target = work.find((item) => item.ref !== null);

if (target?.ref === undefined || target.ref === null) {
  throw new Error("no keyed work to cancel");
}

await ledger.cancelWork({
  ref: target.ref,
  reason: "user requested cancellation",
});
```

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

## Package Exports

- `@torkbot/sledge/ledger`
- `@torkbot/sledge/better-sqlite3-ledger`
- `@torkbot/sledge/turso-ledger`
- `@torkbot/sledge/runtime/contracts`
- `@torkbot/sledge/runtime/node-runtime`
- `@torkbot/sledge/runtime/virtual-runtime`

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
