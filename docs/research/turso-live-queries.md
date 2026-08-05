# Turso live-change primitives and Sledge

Research date: 2026-07-27

## Bottom line

The current Turso Database engine gives Sledge substantially more than raw
SQLite, but `@tursodatabase/database` does **not** currently expose a local live
query, watch, subscription, or commit-notification API.

The similarly named features solve adjacent problems:

- Live materialized views incrementally maintain stored query results inside the
  transaction that changes their base tables. They do not notify a waiting
  JavaScript consumer.
- Change Data Capture (CDC) writes an ordered, transaction-aware change log to a
  table. It does not provide a blocking wait for the next row.
- Experimental multi-process WAL makes commits visible and coordinates readers,
  writers, and checkpoints across local processes. It does not expose a wakeup
  when another process commits.
- `@tursodatabase/sync` has a Cloud-backed long-polling `pull()` operation. This
  is the only current TypeScript surface found that can wait for remote changes
  without repeatedly querying an application table, but adopting it would
  change Sledge from a local embedded database into a push/pull replicated
  system.

For Sledge's intended single-owner runtime, the clean deterministic design is
therefore still for Sledge to wake its own waiters from the state transitions it
commits. The database does not need to rediscover writes that Sledge itself just
made. If independent local processes are allowed to write the same database,
current Turso does not provide the notification primitive needed to make that
mode polling-free.

## What the current Turso features actually provide

| Capability                    | Current semantics                                                                                                                                                                                                                                                                                    | JavaScript availability                                                                                     | Relevance to Sledge                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live materialized views       | The view is incrementally updated in the same transaction as its base tables; commit and rollback include both. The feature remains experimental and supports a restricted query surface.                                                                                                            | Enable the `views` experimental feature and issue `CREATE MATERIALIZED VIEW`. There is no subscription API. | Could accelerate some projections eventually, but it is not a wake mechanism and does not replace Sledge's event-aware materialization semantics.                                                          |
| CDC                           | `PRAGMA capture_data_changes_conn(...)` records committed insert/update/delete operations. CDC v2 assigns a transaction ID and emits one `change_type = 2` COMMIT record. Rolled-back changes are absent. CDC and MVCC are mutually exclusive on the same connection.                                | Available through SQL/PRAGMA in `@tursodatabase/database`; there is no typed watcher.                       | It is a durable cursorable log, but Sledge already owns a more semantic durable event log. Consuming CDC would still require querying it after some other wakeup.                                          |
| Multi-process WAL             | Multiple processes coordinate a single writer, checkpointer, reader snapshots, and WAL frame index through a memory-mapped `.tshm` file. Stable snapshots and cross-process visibility are provided. The feature is experimental, local-filesystem-only, and cannot currently be combined with MVCC. | `multiprocess_wal` is present in the published `0.7.1` `DatabaseOpts` experimental-feature union.           | Removes the old “one OS process can open the file” restriction, but supplies visibility rather than notification. It does not remove Sledge's need to poll if Sledge accepts independent process writers.  |
| Turso Sync pull               | `pull()` may make one HTTP request that the server holds until remote changes appear or `longPollTimeoutMs` expires, then applies the changes locally and returns whether anything changed. Local writes require an explicit `push()`.                                                               | `@tursodatabase/sync@0.7.1`.                                                                                | This is an adapter-native remote wake source, but it introduces remote authority, push/pull lifecycle, network failure, and conflict semantics. It is not a drop-in improvement to a local ledger runtime. |
| Safe async transaction handle | `transactionAsync()` owns the connection for the full `BEGIN`/`COMMIT` window, passes a transaction-scoped handle, commits on callback success, and rolls back on failure. `batch(..., mode)` can also be atomic.                                                                                    | `@tursodatabase/database@0.7.1`.                                                                            | Lets Sledge put transaction ownership in the driver instead of managing transaction-control SQL through its generic database facade. This is a useful modernization independent of notifications.          |

Primary sources:

- [Turso materialized-view reference](https://docs.turso.tech/sql-reference/statements/create-materialized-view)
- [Turso CDC reference](https://docs.turso.tech/tursodb/cdc)
- [Turso multi-process access reference](https://docs.turso.tech/sql-reference/multiprocess-access)
- [Turso Sync usage](https://docs.turso.tech/sync/usage)
- [`@tursodatabase/database` 0.7.1 JavaScript types](https://github.com/tursodatabase/turso/blob/v0.7.1/bindings/javascript/packages/common/types.ts)
- [`transactionAsync()` implementation and contract at 0.7.1](https://github.com/tursodatabase/turso/blob/v0.7.1/bindings/javascript/packages/common/promise.ts)

## No local notification API yet

The strongest evidence is the published API itself: the `0.7.1` declaration
surface contains queries, async iteration over query rows, transactions,
batches, interruption, and connection lifecycle, but no watch, subscribe,
notification, or live-query method.

Turso's current repository README does list “query subscriptions” under its
experimental incremental-computation work. However, no corresponding
documentation, feature flag, JavaScript type, or binding implementation was
found at the inspected main commit. This is evidence of upstream intent, not a
released capability Sledge can consume.

The Turso repository also still has an open backlog issue asking for data-change
notification hooks based on SQLite's `sqlite3_update_hook()`. It has no linked
implementation. Even a same-connection update hook would not by itself promise
cross-connection or cross-process notification.

Sources:

- [`@tursodatabase/database` 0.7.1 package](https://www.npmjs.com/package/@tursodatabase/database/v/0.7.1)
- [Current Turso README experimental-feature list](https://github.com/tursodatabase/turso/blob/e4ac0f309b999395e67d574e24bae6e2f0a65a73/README.md#L60-L66)
- [Open Turso issue #1055: “Data change notification hooks?”](https://github.com/tursodatabase/turso/issues/1055)

“Live materialized view” should not be read as “live query subscription.” The
view is live in the sense that its stored contents remain transactionally
current. A consumer still runs a normal `SELECT` to observe those contents.

## What dropping `better-sqlite3` would buy Sledge

Replacing the dual `better-sqlite3` / Turso storage implementations with the
Turso engine alone would buy:

- One asynchronous storage behavior instead of maintaining a synchronous native
  SQLite adapter and an asynchronous Turso adapter.
- A core that yields during long work and pending I/O rather than blocking the
  embedding Node thread.
- Driver-owned async transaction scopes and atomic batches.
- Access, when deliberately enabled, to concurrent writes through MVCC,
  transaction-aware CDC, live materialized views, encryption, pluggable storage
  backends, and experimental multi-process WAL.
- A path to Turso Sync if Sledge later chooses an explicitly replicated storage
  mode.

Turso 0.7 says the engine is running in production at multiple organizations
and removed its previous blanket beta warning, but it is still pre-1.0 and the
project recommends independent backups.

Sources:

- [Turso 0.7.0 release overview](https://turso.tech/blog/turso-0.7.0)
- [Turso TypeScript SDK reference](https://docs.turso.tech/sdk/ts/reference)
- [Turso 0.7.1 release](https://github.com/tursodatabase/turso/releases/tag/v0.7.1)

It would **not** buy:

- A local `LISTEN`/`NOTIFY` equivalent.
- A JavaScript live-query/watch API.
- A deterministic cross-process wake mechanism.
- A reason to use CDC for Sledge's own events; duplicating the ledger into CDC
  adds write amplification and another cursor model while still needing a
  notification.

## Implication for deterministic waits

### Single Sledge owner

`waitForIdle()` and “wait for the first matching event” can be deterministic and
notification-driven without any Turso-specific live-query feature:

1. The Sledge transaction commits events and/or work.
2. After successful commit, the owning runtime advances an in-process revision
   and wakes registered condition waiters.
3. Waiters re-evaluate against durable state and the runtime's in-flight handler
   state.
4. Future-dated work remains scheduled through Sledge's injected scheduler.

There is no missed-wakeup race if waiter registration and revision rechecking
use the standard observe-register-recheck protocol. Virtual time is involved
only when work is intentionally delayed, not to poll storage.

This design requires an actual ownership invariant: every write that can affect
the worker or event conditions must pass through that runtime. A second ledger
runtime over the same database silently violates the premise.

### Independent local writers

Experimental multi-process WAL does not close this gap. It lets another process
commit and guarantees that a later statement can observe the commit, but current
public APIs provide no event that tells Sledge to issue that later statement.
Without a future Turso cross-process notification primitive, Sledge must either:

- reject independent local writers,
- accept polling explicitly for that operating mode, or
- choose a storage mode with an adapter-native remote wait.

Silently polling while presenting the mode as deterministic would be the wrong
contract.

### Remote replicated writers

Turso Sync's long-polling `pull()` is a genuine alternative adapter capability:
the remote service holds the request waiting for a new revision. It can be
treated as a storage-native change source, followed by durable-state
re-evaluation.

It is not automatically suitable for Sledge. The official Sync guide describes
explicit `push()` and `pull()` and “last push wins” conflict behavior. Sledge
would need a separate design for event identity, projection consistency,
concurrent replica writes, retry, and offline behavior before this could be a
ledger backend.

## Package and local Sledge status

- npm's current stable `@tursodatabase/database` is `0.7.1`, published
  2026-07-22. The current stable `@tursodatabase/sync` is also `0.7.1`.
- GitHub has a `v0.8.0-pre.2` CLI/repository prerelease dated 2026-07-26, but npm
  still tags `0.7.1` as both `latest` and the newest published JavaScript
  database package inspected.
- This Sledge checkout declares `@tursodatabase/database: ^0.5.1` and currently
  has `0.5.1` installed. The local checkout is on the older
  `codex/fix-shared-memory-uri` branch; the locally available `origin/main`
  still declares `^0.5.1`.
- Current Sledge worker scheduling uses a one-second `storePollMs` fallback
  because SQLite gives cross-connection visibility without notifications.
  Current event streaming uses a process-local append sequence and waiter set.
  These are two different liveness models over the same storage.

Local evidence:

- [package.json](../../package.json)
- [Turso storage adapter](../../src/ledger/turso-ledger.ts)
- [database ledger worker and event waiting](../../src/ledger/database-ledger-engine.ts)

Upstream package evidence:

- [`@tursodatabase/database` npm versions](https://www.npmjs.com/package/@tursodatabase/database?activeTab=versions)
- [`@tursodatabase/sync` npm versions](https://www.npmjs.com/package/@tursodatabase/sync?activeTab=versions)
- [Turso GitHub releases](https://github.com/tursodatabase/turso/releases)

One documentation uncertainty is worth recording: the current multi-process
guide imports `@tursodatabase/libsql`, which is not published on npm as of the
research date. The actual published `@tursodatabase/database@0.7.1` types do
include `multiprocess_wal`, so the feature is present but the guide's package
name appears stale or premature. “Query subscriptions” are likewise named as
experimental in the repository README but have no identifiable public
JavaScript surface; they may describe planned or internal DBSP work.

## Recommendation

Treat these as two independent decisions:

1. Upgrade Sledge to `@tursodatabase/database@0.7.1`, evaluate using its
   transaction-scoped API, and consider deleting the `better-sqlite3` adapter to
   get one asynchronous storage model.
2. Define Sledge as the sole live owner of a database and replace its fallback
   storage polling with runtime-owned condition notifications. Do not claim
   polling-free support for independent local writers until Turso exposes a
   suitable cross-connection/cross-process notification capability.

Turso's newer features strengthen that recommendation rather than invalidate
it: its local engine now supports multiple processes, CDC, and incremental
views, but none of those surfaces currently supplies the missing wake signal.
