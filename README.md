# @torkbot/sledge

A SQLite-backed event and work engine for building durable, restart-safe workflows.

If you need to reliably turn events into background work (without losing consistency during crashes/retries), this package gives you the core runtime.

## Who this is for

Use `@torkbot/sledge` when you want:

- durable event append + background work orchestration,
- retries and restart recovery by default,
- strong runtime validation at I/O boundaries,
- a small API surface you can adapt to your own schema and storage layout.

## What you get

- **Event log** (`events` table)
- **Durable work queue** (`work` table)
- **Transactional flow:** append event -> project -> materialize work in one transaction
- **Lease-based execution** for queue handlers
- **Idempotent producer retries** via `dedupeKey`
- **Configurable contention behavior** (`maxBusyRetries`, `maxBusyRetryDelayMs`)

## Example use-cases

- **Webhook ingestion** with producer idempotency (`dedupeKey`) and reliable downstream processing
- **Notification pipelines** (email/push/slack) with retries and dead-letter outcomes
- **Long-running tool/API jobs** that survive worker restarts
- **Outbox-style orchestration** without split-brain between writes and job enqueue

---

## Quick start (copy/paste)

```ts
import Database from "better-sqlite3";
import { Type } from "@sinclair/typebox";

import { defineLedgerModel } from "@torkbot/sledge/ledger";
import { createBetterSqliteLedger } from "@torkbot/sledge/better-sqlite3-ledger";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "@torkbot/sledge/runtime/node-runtime";

const model = defineLedgerModel({
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

  indexers: {
    upsertUser: Type.Object({
      userId: Type.String(),
      email: Type.String(),
    }),
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

  register(builder) {
    // Event -> projection
    builder.project("user.created", async ({ event, actions }) => {
      await actions.index("upsertUser", {
        userId: event.payload.userId,
        email: event.payload.email,
      });
    });

    // Event -> queued work
    builder.materialize("user.created", ({ event, actions }) => {
      actions.enqueue("welcome-email.send", {
        userId: event.payload.userId,
        email: event.payload.email,
      });
    });

    // Queue handler
    builder.handle("welcome-email.send", async ({ work }) => {
      // call provider here
      console.log("sending welcome email", work.payload.email);

      return { outcome: "ack" } as const;
    });
  },
});

const db = new Database("./app.sqlite");
const clock = new SystemRuntimeClock();
const scheduler = new NodeRuntimeScheduler();

const ledger = createBetterSqliteLedger({
  database: db,
  boundModel: model.bind({
    indexers: {
      upsertUser: async (input) => {
        // Write to your own projection table(s)
      },
    },
    queries: {
      userById: async () => {
        // Read from your own projection table(s)
        return null;
      },
    },
  }),
  timing: {
    clock,
    scheduler,
  },
});

await ledger.emit("user.created", {
  userId: "u_123",
  email: "alice@example.com",
});

await ledger.close();
```

---

## How to think about the API

### 1) `defineLedgerModel(...)`

You define contracts, not implementation details:

- `events`: facts appended to the event stream
- `queues`: durable work payloads
- `indexers`: projection write contracts
- `queries`: projection read contracts
- `register(builder)`: orchestration glue

### 2) `model.bind(...)`

You provide concrete implementations for indexers and queries.

### 3) `create*Ledger(...)`

You choose backend adapter and start the runtime:

- `createBetterSqliteLedger(...)`
- `createTursoLedger(...)`

The runtime exposes:

- `emit(eventName, payload, options?)`
- `query(queryName, params)`
- `close()`

---

## Handler outcomes

Queue handlers must return one of:

- `{ outcome: "ack" }`
- `{ outcome: "retry", error, retryAtMs? }`
- `{ outcome: "dead_letter", error }`

If a handler throws, the runtime treats it as a retry.

## Dedupe and idempotency

Use `dedupeKey` in `emit(...)` for producer retries.

```ts
await ledger.emit(
  "user.created",
  { userId: "u_123", email: "alice@example.com" },
  { dedupeKey: "provider-event:abc-123" },
);
```

Same key => same durable event winner, no duplicate downstream materialization.

## Long-running handlers

For long operations, keep the lease alive while working:

```ts
builder.handle("some.queue", async ({ lease }) => {
  await using hold = lease.hold();

  // long-running async work

  return { outcome: "ack" } as const;
});
```

## Runtime tuning knobs

Available options when creating a ledger:

- `leaseMs`
- `defaultRetryDelayMs`
- `maxInFlight`
- `maxBusyRetries`
- `maxBusyRetryDelayMs`

Start simple; tune only when you observe contention/throughput issues.

---

## Package exports

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

## Publishing notes

- The package is published as compiled JavaScript in `dist/` (with `.d.ts` types).
- Source remains strict TypeScript in `src/`.
- `prepublishOnly` runs `node --run build` automatically.
- Node version is pinned via `engines.node` because runtime code uses explicit resource management (`using` / `await using`).
