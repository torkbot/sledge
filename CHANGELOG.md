# Changelog

## Unreleased

- Add `querySnapshot(...requests)` to atomically return an ordered tuple of
  validated projection results and the opaque durable-event cursor through
  which they were read. Resuming from that cursor cannot omit an event
  committed concurrently with the snapshot.
- Add `readEvents({ cursor })` for one immediate, bounded read of durable events
  after a cursor. Invocation-shaped hosts can advance the same durable feed
  without keeping a request open.
- Add a Durable Object driver for host-owned SQLite and
  `runWorkersUntilQuiescent(...)` for invocation-shaped runtimes. Eligible work
  drains under ordinary queue limits, delayed work remains durable, and the
  result reports its earliest known future eligibility before workers close.
- Retain queue ownership while timed-out or explicitly cancelled operations
  unwind. Cancellation still aborts the operation signal immediately, but a
  same-partition successor cannot start merely because the cancelled JavaScript
  promise has not settled yet.
- Add experimental `CoalescingOperation` bindings for canonical keyed demand.
  Each key runs one at-least-once generation at a time, coalesces activity
  during execution into at most one successor, reads authoritative ledger
  projections through its operation context, and commits successful output to
  a required typed continuation event. Payload disagreements within one live
  coalescing stream fail instead of silently choosing first, latest, or merge
  semantics. Lease loss and cancellation retain the usual cooperative,
  at-least-once execution boundary.
- Allow `module.declare(...)` to import caller-owned query tokens. Projectionless
  modules can now query explicit installed capabilities from event, durable
  queue, and signal-queue handlers without inventing an empty materialization.
- Express ledger query parameters and results directly from their token schemas.
  Generic module factories can now call `ledger.query(...)` without private
  type adapters while concrete tokens continue to reject invalid parameters.
- Breaking: make `MapAsync` produce one durable settlement for every input.
  Returned values become successful settlements; thrown values, invalid mapped
  outputs, and required per-operator timeouts become failed settlements using
  Sledge's canonical portable exception format. Chained operators receive
  successful values directly and propagate failures without invoking later
  mappers. Add `module.indexer(port)` for automatic settlement indexing and
  `module.origin(context, ancestor)` for typed traversal to an originating
  event, removing application-owned settlement plumbing and causation queries.
- Hide the implemented ledger module carried by `LedgerModuleContribution`.
  Contributions now expose only their bounded capabilities while Sledge keeps
  installation provenance and the implemented module in a library-owned
  carrier with a private field.
- Breaking: replace default global worker concurrency with required per-queue
  `configureQueue({ moduleId, name, kind })`. Each queue receives its own
  positive `maxInFlight`; saturated queues are excluded from claim selection.
  Optional top-level `maxInFlight` remains a combined process safety ceiling.
  Workers never claim queues absent from their model, and `waitForIdle(...)`
  measures only queues known to that worker version so rolling deployments
  preserve newer durable work.
- Add `module.link(declaration, materializations, registration)` to the scoped
  module definition port. Linking installs the storage contract and its
  implementations atomically instead of returning an intermediate value whose
  only purpose is a subsequent `register(...)` call. Canonical module factories
  no longer import their linking phase from `@torkbot/sledge/ledger`, and
  linking rejects declarations not minted by that exact factory invocation
  even when the durable module id matches. Private provenance follows
  successful links into exposure, so exposure also rejects registered modules
  that bypassed the scoped phase. Remove the standalone declaration, linking,
  and registered-module construction interface from the public
  `@torkbot/sledge/ledger` export.
- Breaking: rename the driver adapter exports to
  `@torkbot/sledge/better-sqlite3` and `@torkbot/sledge/turso`. The removed
  `-ledger` suffix implied that these adapters were alternate ledger models
  rather than storage drivers passed to `application.open(...)`.
- Breaking: add `defineModule(moduleId, callback)` as the canonical module
  construction boundary. Each factory invocation receives a fresh scoped
  `LedgerModuleDefinition`; `module.declare(...)` injects the stable identity,
  and its single `module.expose(...)` call returns the only contribution shape
  accepted by `sledge.install(...)`. Owners and contributions carry private
  runtime provenance as well as opaque TypeScript brands, so retained owners,
  forged or mismatched registered modules, repeated reveals, async factories,
  and hand-assembled contributions fail at their boundary.
- Freeze registered module carriers once their contracts, implementations, and
  private composition provenance are complete, preventing untyped callers from
  rewriting durable module identity after registration.
- Breaking: rename `defineSledge(...)` to `defineLedger(...)`. Sledge remains
  the conventional name of the scoped assembly port passed to the definition;
  ledger concepts no longer carry the package name in their function names.
- Breaking: invert storage construction around
  `application.open(driver, timing?)`. `createBetterSqliteDriver(...)` and
  `createTursoDriver(...)` now return inert driver values instead of accepting
  an application. Node.js clock and scheduler implementations are used by
  default; deterministic tests may pass one coherent `LedgerTiming` override.
- Breaking: remove the result-port standard library and the experimental
  `all`, `race`, and `then` modules. Their protocol-oriented composition model
  is replaced by one operator graph interface rather than carried forward
  alongside a competing design.
- Add `@torkbot/sledge/experimental/operators` with immutable `MapAsync` and
  `ForEach` operators. The canonical `defineModule(...)` port exposes
  `event(...)`, `import(...)`, and `bind(...)`, so reusable behavior, ordinary
  handlers, and materializations compile as one ledger module rather than a
  parallel operator-module abstraction. Durable binding ids compile fan-out
  and chaining into ordinary ledger events and private queues with stable
  idempotency keys and no interpreter or generic protocol events. `MapAsync`
  emits one typed event on success; terminal `ForEach` acknowledges without
  manufacturing an event.
- Breaking: make durable event `actions.enqueue(...)` asynchronous. Addressed
  work resolves to its persisted `WorkRef`, including an existing identity
  preserved by coalescing; anonymous work resolves to `null`. Export
  `WorkRefSchema` so the opaque identity can cross validated event outcome,
  payload, and projection boundaries.
- Breaking: add `defineLedger(...)` as the single application composition
  boundary. Its scoped `install(...)` method consumes module contributions and
  immediately reveals their bounded capabilities, so applications no longer
  retain registered module handles or perform a final composition step. The
  callback returns the public capability tree directly, and `install(...)`
  preserves each module's exact capability type instead of recursively branding
  arbitrary objects. Remove `sledge.expose(...)`,
  `InstalledLedgerModuleCapabilities`, and `LedgerApplicationModules`.
  Composition validates imported contracts against the exact owning modules;
  assembly queries and opened-ledger operations reject unknown or cross-open
  token identities at runtime while preserving token-specific payload and
  result types. Reused contributions deliberately reuse token identities.
  Graph-wide application event streams are broadly typed because they have no
  token argument from which to infer an installed event union.
- Add storage-backed application discovery through scoped `query(...)` phase
  boundaries. Queries observe the installed module prefix, later installs form
  another prefix, and returning from the definition revokes assembly before
  the adapter opens the exact final graph. Existing roots require ordered
  prefixes; fresh databases must install their complete bootstrap graph without
  querying.
- Breaking: replace public model composition and model-resolution APIs with the
  root `LedgerApplication` API. Applications open with a storage driver and
  return per-open capabilities plus the owning ledger runtime; adapter-owned
  composition and storage linking remain internal.
- Migration: the application API preserves the existing durable storage layout.
  Databases created by 0.24 remain valid when the application installs the same
  module ids in the same order. Changing that durable graph still requires an
  intentional migration or reset.
- Add `expireHistory({ through: cursor })` as a durable, monotonic event-stream
  boundary. Tailing omits expired history, resuming an older cursor raises
  `LedgerHistoryExpiredError`, and no event rows are physically deleted.
  Event streams discover expiration performed by peer runtimes, including
  while a previously read batch is being consumed.
- Add durable queue `control.deferUntil(availableAtMs)` for successful,
  non-retry deferral to an absolute runtime-clock deadline, including clean
  attempt/WorkRef semantics, restart-safe non-idle scheduling, prompt peer
  rescheduling, and transaction-order-independent composition with coalesced
  and partitioned successors.
- Make clean ledger shutdown drain adapter-owned operations, checkpoint committed
  WAL frames into the main SQLite file, truncate the WAL, and release the writer.
  A busy external connection now produces a truthful close error without leaking
  the Sledge-owned writer.
- Add typed `selectEvent(...)` projection reads that dereference non-null event
  refs in one storage statement while preserving projection order and duplicate
  refs, with missing or mismatched events reported as storage corruption.
- Add engine-authored `causationWork` metadata to durable event envelopes so
  projections and replay consumers can authenticate the exact module, queue,
  work item, and attempt that emitted a fact. Existing and public emissions
  carry `null`.
- Add result-bearing events whose owning handler returns a validated durable
  outcome from `ledger.emit(...)`, including stable outcomes for deduplicated
  emissions.
- Give durable queue handlers a capability-scoped `ledger` port for immediately
  emitting declared events and querying their current projections before the
  work attempt continues.
- Add durable `coalescingKey` enqueue semantics so repeated requests for one
  queue identity converge on one unattempted work item and can only move its
  availability earlier. Attempted work and retry backoff remain immutable;
  later requests create one coalesced successor.
- Add deterministic `control.withTimeout(...)` operation deadlines to durable
  and signal queue handlers, composing timeout and active-lease cancellation
  through one handler-facing `AbortSignal`.
- Store `null` written to nullable JSON projection columns as SQL `NULL`, so
  `whereNull(...)`, `whereNotNull(...)`, and nullable reads agree while
  non-null JSON columns can still store the JSON literal `null`.
- Reject ambiguous `null` predicates for nullable JSON columns and `null`
  entries in nullable-column `orderByList(...)` values; use `whereNull(...)`
  and `orderByNulls(...)` for SQL null semantics.
- Breaking: require every ledger module to declare a stable `moduleId`, install
  registered module contributions through `defineLedger(...)`, and use opaque
  event, query, and signal tokens at runtime.
- Allow unused `queues`, `signals`, and `signalQueues` shape categories to be
  omitted; omitted categories are exact empty definitions.
- Breaking: remove the uncomposed `createLedger(...)` and
  `LedgerEngineFactory` public seam. Storage-specific exports now create opaque
  drivers accepted only by `LedgerApplication.open(...)`.
- Breaking: make `WorkRef` an opaque Sledge-generated string instead of a
  caller-constructible queue tuple. Keyed work persists its own stable identity,
  so cancellation never depends on public queue or module names.
- Allow modules to alias another composed module's exact event and query
  contracts without duplicating persisted events or query implementations.
- Expose each registered module's event, query, and signal tokens so module
  factories can return bounded capabilities with their installable module.
- Preserve aliased event payload and query parameter/result types when one
  generic module factory consumes another generic module.
- Execute event contributions deterministically in application installation order
  inside one atomic append transaction.
- Persist the application's ordered module ids and reject runtimes whose
  module set or contribution order does not match the database owner.
- Namespace projection tables and indexes, durable queues, and materialization
  histories by module identity so independently defined modules can safely
  reuse local names.

## 0.13.0 - 2026-07-27

- Add `partitionKey` enqueue semantics for strict per-queue FIFO execution
  across retries, lease recovery, restarts, and competing worker runtimes while
  preserving concurrency across partitions.

## 0.12.0 - 2026-07-27

- Include `causationEventId` in projection indexer event context so indexers can
  enforce causal ownership without re-reading the source event.

## 0.11.0 - 2026-07-27

- Add `LedgerWorkers.waitForIdle({ signal })` for deterministic,
  cancellation-aware waiting until no nonterminal or executing work remains.
- Make event-stream and worker-idle waits stop promptly when their signal
  aborts, even while an underlying storage read continues settling safely.

## 0.10.0 - 2026-07-27

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
