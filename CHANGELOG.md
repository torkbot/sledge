# Changelog

## Unreleased

- Breaking: replace the old `defineLedgerModel` / `registerLedgerModel` /
  `bindLedgerModel` construction path with
  `defineLedgerShape(...)`, migration-derived
  `defineMaterialization(...)`, `withMaterializations(...)`, and
  `.register(...)`.
- Breaking: storage adapters now receive a registered `model` instead of a
  `boundModel`.
- Add v2 materialization APIs: `@torkbot/sledge/ledger` records typed
  table-local columns, indexes, semantic event references, second-phase
  foreign-key metadata, schema namespace/version metadata, and materialization
  migration history metadata.
- Add a typed materialization migration DSL for ordered schema-change history:
  create table, add column, create index, create unique index, add foreign key,
  and data migration operations are recorded as data instead of `from` / `to`
  callbacks.
- Preserve materialization migration version tuples in generated history types
  and add `MaterializationSchemaFor`, `MaterializationReadDatabaseFor`,
  `MaterializationWriteDatabaseFor`, `MaterializationDatabaseFor`,
  `MaterializationMigrationDatabaseFor`, and
  `MaterializationImplementationRegistrationFor` helper types so downstream
  helpers can derive database facades from the authoritative migration chain.
- Bind materialization histories to the ledger shape so migration data
  callbacks can use typed semantic `readEvent(...)`, `readEvents(...)`, and
  `scanEvents(...)` handles during backfills without seeing the internal
  `events` table.
- Run materialization history hygiene during ledger startup: track applied
  namespace versions, create fresh namespaces by replaying the ordered
  migration history, replay data migration steps, and apply supported
  incremental DDL without exposing raw SQL.
- Re-read materialization namespace versions after acquiring the migration lock
  so concurrent runtimes do not replay data migrations from stale version
  observations.
- Create indexes declared on tables introduced by incremental materialization
  migrations so upgraded namespaces match fresh namespaces.
- Preserve same-migration foreign keys on tables introduced by incremental
  materialization migrations while still rejecting SQLite foreign-key additions
  to pre-existing tables.
- Run data migration callbacks against the replayed materialization schema
  state for that migration step instead of exposing future tables/indexes from
  the final schema.
- Prune live-only signals that do not materialize durable signal work instead
  of retaining observer-only rows forever.
- Split materialization contracts from implementations. Materialization
  migrations derive the current schema and `.define(...)` attaches plain-object
  indexer/query contracts, while `.register(...)` supplies typed indexer/query
  implementations.
- Add ledger-owned event refs on event envelopes so projection access callbacks
  can write semantic event references without exposing the internal events
  table.
- Expand the typed materialization facade toward TorkBot coverage: indexers can
  read projection state, update rows, delete rows, inspect affected-row counts,
  use ordered/limited range queries, and hydrate semantic `EventRef` values
  without receiving raw SQL or the internal `events` table.
- Declare `kysely` as the internal SQL compiler substrate for the v2
  materialization facade while keeping public indexer/query callbacks on
  Sledge-owned handles.
- Route materialization facade execution through an internal statement compiler
  boundary and add a non-public Kysely-backed lowerer without changing the
  public indexer/query API.
- Use the Kysely-backed SQLite statement compiler from the SQLite storage
  adapters while keeping Kysely out of the public callback surfaces.
- Add typed integer `add(...)` write expressions so counters and retry attempts
  can be incremented without raw SQL.
- Add typed `decrementIfPositive(...)` integer write expressions for bounded
  grant/use counters without raw `CASE` SQL.
- Add typed event scan payload predicates and event-id ordering so callbacks
  can query semantic event history without reaching for `json_extract(...)`.
- Add typed `scanSignals(...)` reads for retained signal history using the same
  payload filtering facade and internal Kysely-backed compiler path.
- Add typed `eventIdBounds()` on event and signal scans for low/high watermark
  queries without raw `MIN(event_id)` / `MAX(event_id)` SQL.
- Add typed `latestEventRefsByPayload(...)` on event and signal scans for
  grouped latest-ref queries without raw JSON extraction or `GROUP BY` SQL.
- Add typed batch insert values so data migrations and indexers can write many
  projection rows in one statement without raw `INSERT ... VALUES` SQL.
- Add typed composite projection joins so multi-column relationships can be
  queried without raw `ON a = b AND c = d` SQL.
- Make that statement compiler an explicit adapter-supplied internal dependency
  for projection implementation factories and materialization table/index DDL,
  removing the register-time SQLite compiler assumption.
- Add typed `whereAny([...])` disjunction groups to projection read, update,
  and delete builders so common OR predicates do not require raw SQL.
- Add typed `innerJoin(...).selectFrom(...)` projection reads for
  association-table lookups without exposing raw SQL or storage handles.
- Add typed `leftJoin(...).selectFrom(...)` projection reads for optional
  related rows, with selected joined-table columns exposed as nullable.
- Add typed `whereNotExists(...)` projection anti-join predicates for
  unassociated-row lookups without exposing raw subqueries.
- Add typed projection aggregate reads with `count(...)`, `countNotNull(...)`,
  `min(...)`, and `max(...)` aliases for summary queries without exposing raw
  SQL.
- Add batched semantic event-ref hydration with `readEvents(...)` so queries
  can avoid event-table N+1 reads without receiving the internal events table.
- Add semantic `scanEvents(eventName)` reads so backfills and queries can stream
  typed event history without receiving the internal events table.
- Add typed `orderByList(...)` projection reads for application-defined
  priority ordering without exposing raw `CASE` SQL.
- Add typed `orderByNulls(...)` projection reads for explicit nullable-column
  ordering without exposing raw `CASE` SQL.
- Add typed `unionFrom(...)` / `unionValue(...)` / `unionAll(...)`
  projection reads for prioritized candidate streams without exposing raw
  `UNION` SQL.
- Serialize boolean `unionValue(...)` literals for SQLite and decode nullable
  union aliases using merged nullability across all arms.
- Track `executeExpectingOne()` affected-row assertions as pending projection
  writes so unawaited assertion failures still fail the indexer/data scope.
- Reject non-serializable JSON projection values at the facade boundary before
  storage adapters receive bind parameters.
- Preserve materialization definition types through ledger construction and
  adapter inputs so event handlers can only call indexers for their source
  event.
- Reject out-of-order materialization histories and histories whose replayed
  table shape does not match the current materialization schema.
- Reject materialization histories whose replayed indexes, unique keys, or
  foreign keys do not match the current materialization schema, including
  operations ordered before their referenced tables or columns exist.
- Reject non-positive event reference IDs when projection access serializes or
  decodes event-ref columns.
- Ensure declared materialization tables and indexes during ledger startup from
  the typed materialization migration history instead of requiring callers to
  run raw SQL setup.
- Remove the low-level `@torkbot/sledge/database-ledger-engine` package export
  and hide generated raw-scope implementations behind an internal attachment
  that is not part of the public registered-model type.
- Export `createEventRef(...)` from `@torkbot/sledge/ledger` and reject invalid
  event-ref IDs at construction time.
- Harden materialization/projection validation for migration-order data steps,
  data steps before declared keys/relations, foreign-key target keys, duplicate
  index names, ledger-reserved object names, SQLite-internal object names,
  case-only duplicate tables/columns, unsafe integer union literals, null
  predicate values, unsupported same-table joins, and late projection writes
  after indexer completion.
- Reject projection table/index names that would collide under SQLite's
  identifier rules or share SQLite's table/index namespace, enable SQLite
  foreign-key enforcement on adapter connections, and preserve JSON `null`
  values in JSON projection columns.
- Preserve JSON objects that look like projection-expression metadata during
  update/upsert serialization, and chunk batched semantic event reads below
  SQLite bind-variable limits.
- Preserve JSON `null` values in JSON equality/`whereIn` predicates and reject
  non-null `addColumn` migration steps until the migration DSL supports
  defaults or two-phase constraints.
- Compile write `max(...)` expressions null-safely so nullable operands do not
  overwrite an existing non-null value with SQL `NULL`.
- Reject SQLite URI `databaseUrl` values before opening adapter connections.
  This prevents shared-memory URI strings such as
  `file:sledge?mode=memory&cache=shared` from being treated as literal
  filesystem paths by the underlying drivers.

## 0.9.0 - 2026-05-20

- Breaking: SQLite/Turso adapters now take a `databaseUrl` instead of a
  caller-owned database handle. Sledge owns the connections it opens and closes
  them with the ledger.
- Breaking: query and indexer implementations now receive the Sledge-provided
  storage scope as their first argument. Ambient `ledger.query(...)` receives an
  ambient read scope; event projection `actions.query(...)` and
  `actions.index(...)` receive the event transaction scope.
- Remove ledger-level busy retry configuration. Conventional SQLite adapters
  keep a single writer gate internally; busy lock conflicts from other
  connections fail fast.
- Reject plain `:memory:` database URLs because they cannot support the
  multi-connection storage model.
- Require the `better-sqlite3` adapter to open databases in WAL journal mode so
  owned reader connections do not block writer commits.

## 0.8.0

- Breaking: `ledger.cancelWork(...)` now targets a durable `WorkRef` instead of
  the storage-local `workId`.
- Add `workKey` to `actions.enqueue(...)` and `actions.enqueueSignal(...)`
  options. Keyed work is exposed with a durable `ref` in work snapshots so
  consumers can inspect and cancel logical work items without relying on
  storage row ids.

## 0.7.0

- Breaking: `ledger.emit(...)` now returns the durable event envelope for the
  winning event instead of `void`. When `dedupeKey` matches an existing event,
  Sledge returns that existing event envelope without replaying materialization.
- Add durable work inspection and cancellation APIs: `ledger.cancelWork(...)`,
  `ledger.queryWork(...)`, and `ledger.listWork(...)`. Cancellation is terminal:
  cancelled work will not dispatch or retry after restart. If the cancelled work
  is leased by the active worker handle, Sledge also aborts the lease signal.
- Add `terminalWorkRetentionMs` to `ledger.startWorkers(...)` options. Retained
  terminal work (`dead` and `cancelled`) is pruned according to this shared
  retention window.
- Ensure work inspection APIs read committed work state only and do not expose
  rows staged by in-flight event materialization that may roll back.

## 0.6.3

- Stop serializing external `ledger.query(...)` and queue-handler
  `actions.query(...)` calls behind the storage mutation gate. Durable writes
  remain serialized; event streams use the committed event high-water mark to
  avoid exposing uncommitted events and refresh that mark from storage so
  same-process ledger handles stay consistent.

## 0.6.2

- Serialize the worker dispatch scheduling read with writes so idle-work
  polling cannot overlap `BEGIN` / `COMMIT` on single-connection async SQLite
  adapters.

## 0.6.1

- Serialize external `ledger.query(...)` and queue-handler `actions.query(...)`
  calls with ledger writes so single-connection async SQLite adapters do not
  interleave reads with `BEGIN` / `COMMIT` transaction boundaries.
- Keep event-handler `actions.query(...)` and `actions.index(...)`
  transaction-local through an explicit internal transaction scope, preserving
  read-your-writes behavior while rejecting action calls that escape the event
  handler lifetime.

## 0.6.0

- Breaking: ledgers and storage adapters no longer own the underlying database
  handle lifecycle. Callers that open a database must close it after closing any
  workers and the ledger.
- Separate passive ledger construction from queue execution. Ledgers now start
  queue dispatch only through `ledger.startWorkers(...)`, which returns a
  disposable worker handle. `ledger.close()` no longer closes the underlying
  database handle, so applications must close their DB connections
  separately.
- Reject concurrent worker handles for the same ledger instance so queue
  execution has one explicit lifecycle owner at a time.

## 0.5.0

- Replace `@sinclair/typebox` with `typebox` for JSON-compatible schema construction and runtime validation.

## 0.4.0

- Simplify model registration to a single typed object keyed by event/signal/queue names

  `register` now accepts an object with optional `events`, `signals`, `queues`, and `signalQueues` maps. Event registration handlers now own both projection (`actions.index(...)`) and durable work materialization (`actions.enqueue(...)`) for each event. This removes the previous builder-style API (`project`, `materialize`, `materializeSignal`, `handle`, `handleSignal`) and enforces one handler per key.

- Simplify queue handler completion semantics and remove explicit lease-hold API

  Queue and signal queue handlers now implicitly ack on normal return. Throwing retries with default timing. Explicit non-default outcomes now use control methods (`control.retry(...)`, `control.deadLetter(...)`) instead of returning a discriminated outcome union. Lease renewal is now automatic for the full handler duration and `lease.hold()` has been removed.

- Add query access to event registration handlers

  Event handlers can now call `actions.query(...)` in addition to `actions.index(...)` and `actions.enqueue(...)`, enabling event-time branching based on read-side state.

- Publish queue-emitted signals immediately while preserving lease ownership

  `QueueActions.emitSignal(...)` now appends and notifies observers immediately in its own transaction instead of staging signal publication until the durable queue handler completes. Immediate publication is guarded by the active `(work_id, lease_id)` so stale or lost-lease handlers cannot publish signals.

- Use TypeScript native preview for package typecheck and build

  The package scripts now run `tsgo` from `@typescript/native-preview` for `typecheck` and `build`.

## 0.3.0

- Add signals for transient handler-local orchestration

  Models can now define `signals` and `signalQueues`. Durable handlers can emit signals with `actions.emitSignal(...)`; signals can materialize signal work with `builder.materializeSignal(...)`; and signal work is handled with `builder.handleSignal(...)`. Signals can be observed live with `ledger.onSignal(...)`, which returns a disposable subscription handle. Durable event consumers remain durable-only.

## 0.2.0

- Add event tailing and resume APIs for external consumers

  You can now consume ledger events as a stream using `tailEvents({ last, signal })` and continue later with `resumeEvents({ cursor, signal })`. This makes it practical to build and maintain read models in separate processes (including browser and worker clients) without replaying from the beginning each time.

- Make event stream cursors opaque and portable

  Stream items now include a cursor token intended for persistence and later resume. The cursor format is intentionally opaque, so applications should store and pass it back as-is.

- Prevent tail/resume consumers from seeing uncommitted events

  Event stream reads are now coordinated with in-flight mutations so consumers don't observe rows that are later rolled back. In practice, this makes client-side materialization safer under failures and concurrent writes.

- Improve stream shutdown behavior

  Closing a stream iterator (including via `return()`) now shuts down cleanly without requiring external abort plumbing.

## 0.1.0

- Initial public release of `@torkbot/sledge`

  This release introduces a SQLite-backed event and work engine with typed events and queues, projector/materializer registration, deterministic retries, dead-letter outcomes, and lease-based work handling.

- Add better-sqlite3 and Turso adapters

  You can run the same ledger model against local SQLite (`better-sqlite3`) or Turso using the provided adapters.

- Add runtime scheduling primitives for production and tests

  Includes Node runtime helpers for real execution and a virtual runtime harness for deterministic tests.
