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
- **Signals** for short-lived work created inside queue handlers
- **Configurable contention behavior** (`maxBusyRetries`, `maxBusyRetryDelayMs`)

## Example use-cases

- **Webhook ingestion** with producer idempotency (`dedupeKey`) and reliable downstream processing
- **Notification pipelines** (email/push/slack) with retries and dead-letter outcomes
- **Long-running tool/API jobs** that survive worker restarts
- **Outbox-style orchestration** without split-brain between writes and job enqueue
- **Client-side materialization** (browser/mobile/worker) by tailing events and resuming with an opaque cursor

---

## Quick start (copy/paste)

```ts
import Database from "better-sqlite3";
import { Type } from "@sinclair/typebox";

import {
  bindLedgerModel,
  defineLedgerModel,
  registerLedgerModel,
} from "@torkbot/sledge/ledger";
import { createBetterSqliteLedger } from "@torkbot/sledge/better-sqlite3-ledger";
import {
  NodeRuntimeScheduler,
  SystemRuntimeClock,
} from "@torkbot/sledge/runtime/node-runtime";

const definedModel = defineLedgerModel({
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
});

const registeredModel = registerLedgerModel(definedModel, {
  events: {
    "user.created": async ({ event, actions }) => {
      await actions.index("upsertUser", {
        userId: event.payload.userId,
        email: event.payload.email,
      });

      actions.enqueue("welcome-email.send", {
        userId: event.payload.userId,
        email: event.payload.email,
      });
    },
  },
  queues: {
    "welcome-email.send": async ({ work }) => {
      // call provider here
      console.log("sending welcome email", work.payload.email);

      return { outcome: "ack" } as const;
    },
  },
});

const db = new Database("./app.sqlite");
const clock = new SystemRuntimeClock();
const scheduler = new NodeRuntimeScheduler();

const ledger = createBetterSqliteLedger({
  database: db,
  boundModel: bindLedgerModel(registeredModel, {
    indexers: {
      upsertUser: async () => {
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
- `signals`: short-lived records emitted from queue handlers
- `queues`: durable work payloads
- `signalQueues`: work payloads materialized from signals
- `indexers`: projection write contracts
- `queries`: projection read contracts

### 2) `registerLedgerModel(...)`

You attach orchestration handlers keyed by event/signal/queue names.

### 3) `bindLedgerModel(...)`

You provide concrete implementations for indexers and queries.

### 4) `create*Ledger(...)`

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

Signal queue handlers return only:

- `{ outcome: "ack" }`
- `{ outcome: "retry", error, retryAtMs? }`

Signals do not dead-letter in the public handler contract.

## Signals

Use a signal when a handler needs to create short-lived follow-up work.

For example, a response handler might need to publish a “response started” notice. If the process crashes before the notice is published, sledge should retry it. After it is published, the notice does not need to stay in event history.

Signals are only emitted from normal queue handlers with `actions.emitSignal(...)`. A signal can create `signalQueues`, but it cannot write indexes.

```ts
const definedModel = defineLedgerModel({
  events: {
    "response.requested": Type.Object({
      responseId: Type.String(),
    }),
  },
  signals: {
    "response.notice": Type.Object({
      responseId: Type.String(),
      message: Type.String(),
    }),
  },
  queues: {
    "response.generate": Type.Object({
      responseId: Type.String(),
    }),
  },
  signalQueues: {
    "response.notice.publish": Type.Object({
      responseId: Type.String(),
      message: Type.String(),
    }),
  },
  indexers: {},
  queries: {},
});

const model = registerLedgerModel(definedModel, {
  events: {
    "response.requested": ({ event, actions }) => {
      actions.enqueue("response.generate", {
        responseId: event.payload.responseId,
      });
    },
  },
  queues: {
    "response.generate": async ({ work, actions }) => {
      actions.emitSignal("response.notice", {
        responseId: work.payload.responseId,
        message: "response started",
      });

      return { outcome: "ack" } as const;
    },
  },
  signals: {
    "response.notice": ({ event, actions }) => {
      actions.enqueueSignal("response.notice.publish", {
        responseId: event.payload.responseId,
        message: event.payload.message,
      });
    },
  },
  signalQueues: {
    "response.notice.publish": async ({ work }) => {
      await notifier.publish(work.payload);

      return { outcome: "ack" } as const;
    },
  },
});
```

Sledge keeps a signal while its work is pending or retrying. When the work acks, sledge deletes the signal and the completed signal work in the same transaction. `dedupeKey` values are shared across durable events and signals, so they must be globally unique while any matching row exists.

You can also watch signals live:

```ts
using notices = ledger.onSignal("response.notice", (signal) => {
  socket.send(signal.payload.message);
});
```

This is a live notification only. It does not have a cursor, and sledge does not retry observer callbacks. For work that must be retried before cleanup, use a `signalQueue`.

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

## Event consumers (tail + resume)

You can materialize ledger events outside the process (for example, to browser state) with two APIs:

- `tailEvents({ last, signal })`: `tail -f -n <last>` semantics
- `resumeEvents({ cursor, signal })`: continue from a previously persisted opaque cursor

```ts
const controller = new AbortController();

for await (const item of ledger.tailEvents({
  last: 100,
  signal: controller.signal,
})) {
  const event = item.event;
  const cursor = item.cursor;

  // apply event to external read model
  // persist cursor for reconnect/resume
}

// Later (e.g. reconnect):
const resumeController = new AbortController();

for await (const item of ledger.resumeEvents({
  cursor: persistedCursor,
  signal: resumeController.signal,
})) {
  // continue exactly after persisted cursor
}
```

Cursor values are opaque by contract. Persist and reuse them as-is.

## Long-running handlers

For long operations, keep the lease alive while working:

```ts
register: {
  queues: {
    "some.queue": async ({ lease }) => {
      await using hold = lease.hold();

      // long-running async work

      return { outcome: "ack" } as const;
    },
  },
};
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
- Publishing uses GitHub Actions OIDC trusted publishing (`.github/workflows/release.yml`), so no long-lived npm token is required.
- Configure npm trusted publishing for `@torkbot/sledge` to trust this repository/workflow before first publish.
- Node version is pinned via `engines.node` because runtime code uses explicit resource management (`using` / `await using`).
