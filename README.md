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
const runtimeScheduler = new NodeRuntimeScheduler();

await using ledger = createBetterSqliteLedger({
  databaseUrl,
  model,
  timing: {
    clock: new SystemRuntimeClock(),
    scheduler: runtimeScheduler,
  },
});

await using workers = await ledger.startWorkers({
  scheduler: runtimeScheduler,
});

await ledger.emit(usersModel.events["user.created"], {
  userId: "u_123",
  email: "alice@example.com",
});

const user = await ledger.query(usersModel.queries.userById, {
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

`events` is required. Omit `queues`, `signals`, or `signalQueues` when the
module does not define contracts in that category. Plain event definitions
create contracts owned by that module and produce opaque event tokens such as
`ledgerShape.events["user.created"]`. Runtime APIs accept these tokens instead
of string names.

An event may declare a durable result alongside its payload:

```ts
const decisionsShape = defineLedgerShape({
  moduleId: "decisions",
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
```

The event's owning handler returns that outcome after applying its projection
changes. Sledge validates and persists the result in the same transaction as
the event. `ledger.emit(...)` then returns the ordinary durable event envelope
plus its typed `outcome`. A deduplicated emission returns the original event,
payload, and outcome rather than evaluating the handler again.

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

Registration returns the model passed to a storage adapter. There is no
separate bind step.

### 4. Compose the Root Model

Every runtime receives one explicitly composed root model:

```ts
const model = composeLedgerModels(usersModel, auditModel, deliveryModel);
```

Registered modules retain the exact event, query, and signal token maps created
during definition. A module factory can therefore return its registered module
directly: consumers use its public tokens as capabilities, while the
composition root passes the same value to `composeLedgerModels(...)`.
Generic module factories preserve those aliased event payload and query types
without widening the referenced module's identity.

Modules can reuse an event contract by supplying another module's event token
as the definition value. The alias is a code-level name for the exact same
persisted event:

```ts
const auditShape = defineLedgerShape({
  moduleId: "app.audit",
  events: {
    userCreated: usersModel.events["user.created"],
  },
});
```

Query definitions work the same way: supplying
`usersModel.queries.userById` in another module's materialization query
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

The first open records the composed root's ordered module ids. Every later
runtime opening that database must supply the exact same modules in the same
composition order. Sledge rejects mismatched roots before schema mutation or
work dispatch so rolling processes cannot apply different handler
contributions to one logical ledger.

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
- `expireHistory({ through })`
- `onSignal(signalToken, observer)`
- `startWorkers(options)`
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
const decisions = decisionsShape.register({
  events: {
    recorded: () => {
      return {
        revision: 1,
      };
    },
    "decision.observed": () => {},
  },
  queues: {
    "decisions.record": async ({ work, actions, ledger }) => {
      const committed = await ledger.emit(
        decisionsShape.events.recorded,
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

actions.enqueue(
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

`partitionKey` alone does not coalesce work. Each enqueue remains a durable work
item unless the caller also supplies `coalescingKey`. Sledge stores no separate
partition registry: the key exists only on nonterminal work, successful work is
deleted, and terminal retained work releases the key. Reusing a key after all
of its work becomes terminal starts a fresh stream.

## Work Inspection and Cancellation

Sledge stores durable work rows for queued, leased, delayed-retry,
dead-lettered, and cancelled work. Successful work is deleted when it acks.

Use `workKey` when enqueueing independently addressable work to get a durable
`WorkRef` for cancellation:

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
changes made by another process. Opening a version 2 database upgrades its
storage protocol to version 3 after establishing the history boundary. Older
Sledge runtimes then reject the database instead of exposing expired events.

Expiration is a logical stream boundary. It does not delete event rows,
reclaim storage, or change projections, deduplication, and event-reference
reads. Those physical retention policies can build on this durable boundary
without being embedded in event consumption.

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
