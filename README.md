# @torkbot/sledge

A SQLite-backed event and work engine for building durable, restart-safe
workflows.

Sledge stores events and durable work, runs event handlers transactionally, and
lets applications define typed projection tables without handing raw SQL handles
to indexer and query callbacks.

## What You Get

- Durable event append with producer idempotency through `dedupeKey`
- Event -> projection -> work materialization in one transaction
- Typed projection schema, event refs, indexers, and queries
- Durable queue work with leases, retries, dead-letter outcomes, and restart
  recovery
- Durable event streams through `tailEvents(...)` and `resumeEvents(...)`
- Process-local live signals for short-lived follow-up work

## Quick Start

```ts
import Database from "better-sqlite3";
import { Type } from "typebox";

import { createBetterSqliteLedger } from "@torkbot/sledge/better-sqlite3-ledger";
import { defineLedgerShape } from "@torkbot/sledge/ledger";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "@torkbot/sledge/runtime/node-runtime";

const databaseUrl = "./app.sqlite";

// Projection migrations are still explicit in this v2 slice.
// Indexer/query callbacks below do not receive this database handle.
const db = new Database(databaseUrl);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    source INTEGER NOT NULL
  );
`);
db.close();

const definedModel = defineLedgerShape({
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
}).withProjections(
  {
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
  },
  {
    indexers: {
      upsertUser: (i) =>
        i
          .sourceEvent("user.created")
          .input(
            Type.Object({
              userId: Type.String(),
              email: Type.String(),
            }),
          )
          .write(async ({ input, event, db }) => {
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
          }),
    },
    queries: {
      userById: (q) =>
        q
          .params(Type.Object({ userId: Type.String() }))
          .result(
            Type.Union([
              Type.Null(),
              Type.Object({
                userId: Type.String(),
                email: Type.String(),
              }),
            ]),
          )
          .read(async ({ params, db }) => {
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
          }),
    },
  },
);

const model = definedModel.register({
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

### 2. Attach Projections

Call `.withProjections({ tables, relations }, { indexers, queries })` to attach
projection tables and access callbacks to the ledger shape.

Each table key owns one table-local builder function:

```ts
{
  tables: {
    users: (t) =>
      t
        .columns({
          userId: t.text().notNull(),
          source: t.eventRef("user.created").notNull(),
        })
        .primaryKey(["userId"]),
  },
}
```

Those table builders are scoped to the ledger event names, so semantic event refs
must point at real events:

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

The access callbacks receive sledge-owned facades:

- indexers can `insertInto(...).values(...).onConflict(...).doUpdateSet(...)`
- queries can `selectFrom(...).select(...).where(...).executeTakeFirst()`

They do not receive a raw storage handle.

Ledgers without projection tables can skip this step and call
`defineLedgerShape(...).register(...)` directly.

### 3. Register Orchestration

Call `definedModel.register(...)` to attach event, queue, signal, and
signal-queue handlers. Event handlers can `index`, `enqueue`, and `query`.

Registration returns the model passed to a storage adapter. There is no
separate bind step: projection access definitions already compiled the indexer
and query implementations.

### 4. Run Database Hygiene

This v2 slice records projection metadata and typed relations, but does not yet
run projection migrations. Applications must still create/update projection
tables before opening the runtime. The intended lifecycle is internal migrations
first, then projection migrations, then runtime.

### 5. Open a Runtime

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
- `@torkbot/sledge/database-ledger-engine`
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
