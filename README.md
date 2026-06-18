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

## Example use-cases

- **Webhook ingestion** with producer idempotency (`dedupeKey`) and reliable downstream processing
- **Notification pipelines** (email/push/slack) with retries and dead-letter outcomes
- **Long-running tool/API jobs** that survive worker restarts
- **Outbox-style orchestration** without split-brain between writes and job enqueue
- **Client-side materialization** (browser/mobile/worker) by tailing events and resuming with an opaque cursor

---

## Quick start (copy/paste)

```ts
import { Type } from "typebox";

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

// Sledge schemas should describe JSON-compatible values. TypeBox codecs that
// transform between distinct runtime and storage domains are not supported.
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
      // call provider here
      console.log("sending welcome email", work.payload.email);
    },
  },
});

const clock = new SystemRuntimeClock();
const scheduler = new NodeRuntimeScheduler();

{
  await using ledger = createBetterSqliteLedger({
    databaseUrl: "./app.sqlite",
    boundModel: bindLedgerModel(registeredModel, {
      indexers: {
        upsertUser: async (scope, input) => {
          // Write to your own projection table(s)
          await scope
            .prepare(
              `INSERT INTO users (user_id, email)
               VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET email = excluded.email`,
            )
            .run(input.userId, input.email);
        },
      },
      queries: {
        userById: async (scope, params) => {
          // Read from your own projection table(s)
          const row = await scope
            .prepare(
              `SELECT user_id, email
               FROM users
               WHERE user_id = ?`,
            )
            .get(params.userId);

          if (row === undefined) {
            return null;
          }

          return {
            userId: row.user_id,
            email: row.email,
          };
        },
      },
    }),
    timing: {
      clock,
    },
  });

  await using workers = await ledger.startWorkers({
    scheduler,
  });

  const event = await ledger.emit("user.created", {
    userId: "u_123",
    email: "alice@example.com",
  });

  console.log(event.eventId);
}

db.close();
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

Event handlers can `index`, `enqueue`, and `query`.

### 3) `bindLedgerModel(...)`

You provide concrete implementations for indexers and queries. Sledge passes a
storage scope as the first argument and the typed input/params as the second
argument.

Query implementations are projection reads. They are not serialized behind
ledger mutations, so a long-running query cannot block unrelated durable writes.
Keep query implementations bounded to read-side state; avoid application
orchestration, attachment/network/model I/O, and re-entering ledger-backed write
paths from inside a query.

### 4) `create*Ledger(...)`

You choose a backend adapter and open the durable ledger:

- `createBetterSqliteLedger(...)`
- `createTursoLedger(...)`

Adapters take a `databaseUrl` and Sledge owns the database connections it opens.
Plain `:memory:` URLs are rejected because they cannot support more than one
connection. Use a real database file for local SQLite, or a backend-specific
shared-memory URL only where the driver can still provide the required
multi-connection read/write semantics. The `better-sqlite3` adapter verifies
that the opened database actually enters WAL journal mode and rejects databases
that cannot.

Sledge assumes a single process owns writes to a ledger database. Its
multi-connection support is for Sledge-managed read/write scopes inside that
runtime, not for competing writer processes. Cross-process consumers should use
durable event streams (`tailEvents` / `resumeEvents`) and work inspection APIs.
`onSignal(...)` is a live, process-local notification hook; signals are
transient and are not a durable distributed pub/sub channel.

The runtime exposes:

- `emit(eventName, payload, options?)`: append an event and return its durable envelope
- `query(queryName, params)`: run a model query implementation
- `cancelWork({ ref, reason? })`: durably mark non-terminal keyed work as cancelled
- `queryWork({ workId })`: inspect one durable work item by storage id
- `listWork({ queueName?, sourceEventId?, states?, limit? })`: inspect durable work items
- `tailEvents({ last, signal })`: read recent durable events and follow new ones
- `resumeEvents({ cursor, signal })`: continue an event stream from an opaque cursor
- `onSignal(signalName, observer)`: subscribe to live process-local signal notifications
- `startWorkers(options)`: start queue dispatch for this ledger handle
- `close()`: close the ledger runtime and the database connections owned by it

Opening a ledger is passive: it initializes storage and can emit, query, tail,
resume, and observe signals, but it does not claim or process queue work.

Sledge manages read and write scopes internally. Ambient `ledger.query(...)`
calls receive an ambient read scope. Event projection `actions.query(...)` and
`actions.index(...)` receive the same transaction-local scope as the event
append and work materialization transaction.

Start workers explicitly in the process that owns queue execution:

```ts
await using workers = await ledger.startWorkers({
  scheduler: new NodeRuntimeScheduler(),
  leaseMs: 1_000,
  defaultRetryDelayMs: 1_000,
  maxInFlight: 16,
  terminalWorkRetentionMs: 7 * 24 * 60 * 60 * 1_000,
});
```

---

## Work inspection and cancellation

Sledge stores durable work rows for queued, leased, delayed-retry, dead-lettered,
and cancelled work. Successful work is deleted when it acks. Terminal retained
work (`dead` and `cancelled`) is pruned when workers start according to
`terminalWorkRetentionMs`.

Event and signal handlers can assign a `workKey` when they enqueue work. Sledge
combines that key with the source event id, queue name, and signal flag into a
stable `WorkRef`. Use refs for cancellation; `workId` remains a storage-local
inspection id.

```ts
actions.enqueue(
  "welcome-email.send",
  { userId: event.payload.userId, email: event.payload.email },
  { workKey: `welcome-email:${event.payload.userId}` },
);

const currentWork = await ledger.listWork({
  states: ["pending", "delayed", "leased"],
  limit: 100,
});

const target = currentWork.find((work) => work.ref !== null);

if (target?.ref === undefined || target.ref === null) {
  throw new Error("no keyed work to cancel");
}

const result = await ledger.cancelWork({
  ref: target.ref,
  reason: "user requested cancellation",
});

if (result.status === "cancelled") {
  console.log(result.work.state); // "cancelled"
}
```

Cancellation is terminal. Once `cancelWork(...)` succeeds for a non-terminal
work item, Sledge will not dispatch that work again, including after process
restart. If the work is currently leased by this ledger's active worker handle,
Sledge also aborts that lease's `AbortSignal` as a live-delivery fast path.

`queryWork(...)` and `listWork(...)` read only committed work state; they do not
expose rows staged by in-flight event materialization that may later roll back.

## Handler behavior

Queue and signal queue handlers implicitly ack on normal return.

- Return (or resolve) => ack
- Throw => retry using default retry delay
- Use `control.retry(error, { retryAtMs? })` for explicit retry timing
- Durable queue handlers may call `control.deadLetter(error)`
- Signal queue handlers do not support dead-letter

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

Use `dedupeKey` in `emit(...)` for producer retries. `emit(...)` returns the
winning durable event envelope. With a duplicate key, the existing event envelope
is returned and downstream materialization is not replayed.

```ts
const event = await ledger.emit(
  "user.created",
  { userId: "u_123", email: "alice@example.com" },
  { dedupeKey: "provider-event:abc-123" },
);

console.log(event.eventId);
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

Long-running handlers are automatically lease-renewed for the full handler duration.

Use `lease.signal` for cooperative cancellation on shutdown/restart:

```ts
register: {
  queues: {
    "some.queue": async ({ lease }) => {
      while (!lease.signal.aborted) {
        // long-running async work
        break;
      }
    },
  },
};
```

## Runtime tuning knobs

Available options when starting workers:

- `leaseMs`
- `defaultRetryDelayMs`
- `maxInFlight`

Start simple; tune only when you observe contention/throughput issues.

## Typed projection access exploration

Sledge v2 is exploring a stricter separation between ledger shape, projection
schema, access definitions, storage hygiene, and runtime use. The current
exploratory surface splits the TypeBox ledger shape from relational projection
DDL, then binds typed projection indexers and queries back into the existing
runtime model.

```ts
import { Type } from "typebox";

import {
  bindProjectedLedgerModel,
  defineLedgerShape,
  registerProjectedLedgerModel,
} from "@torkbot/sledge/projected-ledger";

const definedModel = defineLedgerShape({
  events: {
    "user.created": Type.Object({
      userId: Type.String(),
      email: Type.String(),
    }),
  },
  queues: {},
  signals: {},
  signalQueues: {},
}).withProjections(
  (p) =>
    p.schema({
      users: (t) =>
        t
          .columns({
            userId: t.text().notNull(),
            email: t.text().notNull(),
            source: t.eventRef("user.created").notNull(),
          })
          .primaryKey(["userId"]),
    }),
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
const registeredModel = registerProjectedLedgerModel(definedModel, {
  events: {
    "user.created": async ({ event, actions }) => {
      await actions.index("upsertUser", {
        userId: event.payload.userId,
        email: event.payload.email,
      });
    },
  },
});
const boundModel = bindProjectedLedgerModel(registeredModel);
```

The intended v2 lifecycle is:

1. Define the ledger shape with TypeBox event, queue, signal, and signal-queue
   contracts.
2. Attach projection schema with table-local relational builders through
   `withProjections(...)`, so event refs are checked against the ledger shape.
3. Define named indexers and queries in the same `withProjections(...)` call
   using a sledge-owned access facade inferred from the projection schema.
4. Establish a storage connection.
5. Run database hygiene explicitly: internal migrations first, then projection
   migrations.
6. Open a tenant-scoped runtime ledger.

The access facade compiles a deliberately small insert/upsert/select DSL to the
current storage scope, so callbacks in this path do not receive raw SQL handles.
Projection migrations and a Postgres runtime are still future work.

---

## Package exports

- `@torkbot/sledge/ledger`
- `@torkbot/sledge/projections`
- `@torkbot/sledge/projected-ledger`
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
