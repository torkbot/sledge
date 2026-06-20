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
  defineLedgerShape,
  defineMaterializationHistory,
  defineMaterializationSchema,
  defineMaterializations,
  withMaterializations,
} from "@torkbot/sledge/ledger";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "@torkbot/sledge/runtime/node-runtime";

const databaseUrl = "./app.sqlite";

const ledgerShape = defineLedgerShape({
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

const materializationSchema = defineMaterializationSchema({
  namespace: "app",
  version: 1,
  tables: {
    users: (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          email: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
  },
});

const materializationHistory = defineMaterializationHistory(
  materializationSchema,
  (m) => [
    m.migration(1, "create app tables", (s) => [
      s.createTable("users", (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
      ),
    ]),
  ],
);

const materializations = defineMaterializations({
  history: materializationHistory,
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

const model = definedModel.register({
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

await ledger.emit("user.created", {
  userId: "u_123",
  email: "alice@example.com",
});

const user = await ledger.query("userById", { userId: "u_123" });
console.log(user);
```

## Lifecycle

### 1. Define the Ledger Shape

`defineLedgerShape(...)` defines durable boundary contracts with TypeBox:

- `events`: facts appended to the event stream
- `queues`: durable work payloads
- `signals`: process-local, short-lived records emitted by queue handlers
- `signalQueues`: retryable work materialized from signals

All four fields are explicit. Use `{}` when a shape has no contracts in that
category.

### 2. Define Materialization Schemas

Call `defineMaterializationSchema(...)` to define the complete table schema for
one materialization namespace/version.

Each table key owns one table-local builder function:

```ts
defineMaterializationSchema({
  namespace: "app",
  version: 1,
  tables: {
    users: (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
  },
});
```

Semantic event refs are first-class columns and must point at real ledger events
when materializations are attached:

```ts
source: t.eventRef("user.created").notNull();
```

Foreign keys are declared in the optional second phase so relation builders can
see all inferred tables:

```ts
relations: (r) => ({
  sessionUser: r
    .foreignKey("sessions", ["userId"])
    .references("users", ["userId"]),
});
```

### 3. Define Migration History

Call `defineMaterializationHistory(...)` to describe the schema-change history
for the current materialization schema. The current DDL remains the canonical
typed shape for indexers and queries; the history records the ordered database
operations Sledge can later execute during hygiene.

```ts
const history = defineMaterializationHistory(schemaV2, (m) => [
  m.migration(1, "create users", (s) => [
    s.createTable("users", (t) =>
      t
        .columns({
          userId: t.text().notNull(),
        })
        .primaryKey(["userId"]),
    ),
  ]),
  m.migration(2, "add user email", (s) => [
    s.addColumn("users", "email", (t) => t.text()),
    s.data("backfill user email", async ({ db }) => {
      for await (const row of db
        .selectFrom("users")
        .select(["userId"])
        .stream()) {
        await db
          .updateTable("users")
          .set({ email: `${row.userId}@example.invalid` })
          .where("userId", "=", row.userId)
          .execute();
      }
    }),
    s.createIndex("usersByEmail", "users", ["email"]),
  ]),
]);
```

Migration steps are typed against the current schema's known tables, columns,
and semantic event references. Data migration steps receive a Sledge-owned
typed migration database facade, not a raw SQL handle, so future executors can
inject tenancy and storage-specific behavior before operations reach the
database. This slice records operation metadata but does not yet execute it.

Sledge validates that the history starts at version 1, versions are unique
positive integers, versions have no gaps, and the latest migration version
matches the current schema version.

### 4. Define Materializations

Call `defineMaterializations(...)` to collect migration history, indexer
contracts, and query contracts:

```ts
const materializations = defineMaterializations({
  history,
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

Attach materializations to the ledger shape with `withMaterializations(...)`:

```ts
const definedModel = withMaterializations(ledgerShape, materializations);
```

Ledgers without materialization tables can skip this step and call
`defineLedgerShape(...).register(...)` directly.

### 5. Register Orchestration

Call `definedModel.register(...)` to attach indexer implementations, query
implementations, event handlers, queue handlers, signal handlers, and
signal-queue handlers.

Indexer and query implementations receive sledge-owned facades:

- indexers can `insertInto(...).values(...).onConflict(...).doUpdateSet(...)`
- queries can `selectFrom(...).select(...).where(...).executeTakeFirst()`

They do not receive a raw storage handle. Event handlers can `index`, `enqueue`,
and `query`.

The low-level database engine and storage scope are internal implementation
details, not package exports.

Registration returns the model passed to a storage adapter. There is no
separate bind step.

### 6. Run Database Hygiene

Opening a ledger creates Sledge's internal tables and ensures the declared
materialization tables and indexes exist from the typed materialization schema.
This v2 slice records typed migration operation metadata, but does not yet run
versioned materialization migrations or data migration steps.

### 7. Open a Runtime

Use one adapter to open the ledger:

- `createBetterSqliteLedger(...)`
- `createTursoLedger(...)`

Adapters take a `databaseUrl`; Sledge owns the connections it opens. Plain
`:memory:` URLs are rejected because they cannot support the required
multi-connection read/write model.

## Runtime API

The opened ledger exposes:

- `emit(eventName, payload, options?)`
- `query(queryName, params)`
- `cancelWork({ ref, reason? })`
- `queryWork({ workId })`
- `listWork({ queueName?, sourceEventId?, states?, limit? })`
- `tailEvents({ last, signal })`
- `resumeEvents({ cursor, signal })`
- `onSignal(signalName, observer)`
- `startWorkers(options)`
- `close()`

Opening a ledger is passive. It initializes storage and can emit, query, tail,
resume, and observe signals, but it does not claim or process queue work until
`startWorkers(...)` is called.

## Work and Retries

Queue and signal queue handlers implicitly ack on normal return.

- Return or resolve: ack
- Throw: retry using the default retry delay
- `control.retry(error, { retryAtMs? })`: explicit retry timing
- `control.deadLetter(error)`: terminal durable queue failure

Handlers receive a lease with an `AbortSignal`; long-running handlers should
stop when that signal aborts during shutdown or restart.

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
