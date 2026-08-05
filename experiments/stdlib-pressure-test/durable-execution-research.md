# Durable-execution primitives for a Sledge standard library

> Research note for the throwaway standard-library pressure test. This is not an
> API proposal.

## The decisive distinction

Durable-execution systems persist two different kinds of truth:

1. **Execution-journal state** says which attempt ran, which nondeterministic
   step result may be replayed, which concurrent operation completed first, and
   where recovery should resume.
2. **Domain facts** say that an application operation was requested, an artifact
   was published, a compaction settled, or a new epoch became authoritative.

Temporal, Restate, DBOS, and Durable Task deliberately make the first category
part of their runtime. Temporal records activity inputs and results in workflow
history so workflows can replay, and warns that every activity call increases
the history that must be stored and replayed
([activity execution](https://docs.temporal.io/develop/typescript/activities/execution)).
Restate quorum-commits each `ctx.run` result before acknowledging the handler,
then supplies the journal to a later attempt
([architecture](https://docs.restate.dev/references/architecture)). DBOS
transactions atomically commit application database changes and a DBOS
checkpoint
([transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)).
Durable Task re-executes an orchestrator from the start and substitutes results
from its stored history at each `await`/`yield`
([orchestrations](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations)).

Sledge should not copy those private journals into its public event vocabulary.
The current [`ResultPort`](../../src/stdlib.ts) points at a producer's original
typed terminal event. That event is portable domain truth. A retry checkpoint,
lease heartbeat, or replay-order record is not.

This suggests one rule for a standard library:

> Promote protocols that let independently defined ledger modules compose
> domain facts. Keep machinery that only helps one execution attempt recover in
> the engine or in a private module materialization.

## Pressure-test matrix

| Desired capability                    | What durable-execution systems provide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Smallest Sledge-shaped primitive                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed durable result                  | Temporal and DBOS expose reconstructable handles whose `result()`/`getResult()` can join an active or completed execution ([Temporal client](https://docs.temporal.io/develop/typescript/client/temporal-client), [DBOS handles](https://docs.dbos.dev/typescript/reference/methods)).                                                                                                                                                                                                                                                                            | `ResultPort<TResult, TOwner>`: typed durable identity plus a decoder for one producer-owned terminal fact. Do not mirror settlement onto a generic bus.                                                                                                                                                                                                                                           |
| Causal dependent work                 | Workflow runtimes journal an awaited call and replay its result. Restate also journals inter-service promises and messages before applying them ([architecture](https://docs.restate.dev/references/architecture)).                                                                                                                                                                                                                                                                                                                                               | `then(source, operation)` as an installed protocol module: the source terminal fact atomically records the observation and enqueues successor work. A deterministic child ref makes redelivery converge. The child emits only its own terminal fact.                                                                                                                                              |
| Expensive intermediate checkpoint     | Temporal activity heartbeat details let a retried activity resume progress ([activity timeouts](https://docs.temporal.io/develop/typescript/activities/timeouts)); DBOS commits a transaction's user changes and checkpoint together.                                                                                                                                                                                                                                                                                                                             | No public result primitive by default. Store attempt-local progress behind the queue handler and fence it by work attempt/epoch. Promote it to a `ResultPort` only when another module must independently address or compose it.                                                                                                                                                                  |
| Finite `all` / `race`                 | Restate promise combinators record completion order for deterministic replay ([concurrent tasks](https://docs.restate.dev/develop/ts/concurrent-tasks)); Durable Task supplies restart-safe fan-out/fan-in ([fan-out/fan-in](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-fan-in-fan-out)).                                                                                                                                                                                                                                           | One finite group declaration containing member refs, a projection of observed terminal facts, and one group terminal fact. `race` chooses immutable ledger order, not worker callback order. A group result is itself a `ResultPort`, so nesting needs no special case.                                                                                                                           |
| Join already-running work             | Temporal can reconstruct a workflow handle from its workflow ID and await the result; DBOS can retrieve a handle by workflow ID, including after completion.                                                                                                                                                                                                                                                                                                                                                                                                      | Index source settlements independently of group existence. Opening a group atomically records its topology and enqueues reconciliation, so already-settled members and future members use the same path. Never replay or duplicate the source fact.                                                                                                                                               |
| Wait for completion                   | Temporal handles await a server-side result. DBOS retrieved handles may poll the database. These are observation APIs, not extra workflow facts.                                                                                                                                                                                                                                                                                                                                                                                                                  | A separately installed observer capability over a storage-local result lookup plus a resumable event cursor, bounded by `AbortSignal`. It must close the snapshot/subscribe race. It must not append a `wait-started` fact, mutate `ResultPort`, or depend on a process-local notification. The current pressure test proves durable module-to-module waiting, but not this client-facing helper. |
| Publish a multi-step epoch atomically | Restate defines a step as happened only after its journal record is quorum-committed, and only then acknowledges the handler. DBOS can atomically checkpoint with changes in the same application database. Durable Task's default Azure Storage provider explicitly cannot transact its history and queues together, so it uses eventual-consistency recovery patterns.                                                                                                                                                                                          | Stage expensive artifacts under immutable/content-addressed refs. Append one producer-owned `epoch-published` fact containing the complete manifest and expected parent epoch. In that append transaction, validate the parent, update the publication projection, and wake dependents. External blob writes remain idempotent staging; the terminal ledger fact is the commit point.             |
| Restart and replay                    | Temporal and Durable Task replay deterministic orchestration code. Restate replays a journal and resumes at the first incomplete step. DBOS recovers workflows from completed steps.                                                                                                                                                                                                                                                                                                                                                                              | Prefer event-driven recovery already native to Sledge: projections preserve observations; durable queue work preserves pending execution; event handlers atomically connect terminal facts to new work. No serialized call stack or source-code replay is required.                                                                                                                               |
| Reject stale parents / attempts       | Restate assigns monotonically increasing attempt epochs and rejects events from superseded epochs, preventing late attempts from publishing ([architecture](https://docs.restate.dev/references/architecture)).                                                                                                                                                                                                                                                                                                                                                   | Keep Sledge's lease fencing for queue-attempt emissions, but treat publication freshness as a domain invariant: terminal publication carries the expected parent epoch/ref, and its event handler atomically rejects a stale parent. Deterministic refs deduplicate identity; they do not by themselves express supersession.                                                                     |
| Bound event/history amplification     | Temporal keeps a complete execution history, warns after 10,240 events, and terminates a run above 51,200; Continue-As-New starts a fresh history under the same workflow ID ([history limits](https://docs.temporal.io/workflow-execution/event), [Continue-As-New](https://docs.temporal.io/develop/typescript/workflows/continue-as-new)). Durable Task likewise resets eternal orchestration history to prevent unbounded growth ([eternal orchestrations](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-eternal-orchestrations)). | Keep retries, heartbeats, checkpoints, and reconcile passes out of domain events. One producer terminal fact and one composition terminal fact are enough. Materialization size may grow with declared topology and results; it should not grow with polling, retries, or replay.                                                                                                                 |

## A small algebra, not a workflow language

The promising reusable surface is smaller than a durable-execution SDK:

```text
Result<T>                 one typed, producer-owned terminal fact
then(Result<A>, A -> B)   one causally triggered durable operation yielding Result<B>
all({ ...Result<T> })     one finite, nestable aggregate Result
race({ ...Result<T> })    one finite, first-settled Result in durable event order
wait(Result<T>)           runtime observation; no new domain fact
```

This is intentionally not a general workflow DSL. Temporal and Durable Task
make `then`, `all`, and `race` replayed language control flow. Restate records
the completion order of promise combinators for the same reason. Restate also
shows that useful durable operations need not require its `Workflow` service
type: Basic Services and Virtual Objects receive durable steps, calls, timers,
and external-event primitives
([services](https://docs.restate.dev/develop/ts/services)). Sledge can go
further and implement each operator as a small event/projection/work protocol.
The ledger model describes facts and their causal edges; it does not serialize
a closure, instruction pointer, or arbitrary program counter.

The algebra also needs a sharp boundary around failure. A `Result` can normalize
terminal outcome to `succeeded | failed | cancelled`, while the producer keeps
its own typed error facts and retry policy. A generic `then` should not invent
cross-domain retry classification, compensation, or loser cancellation. Those
are operation or application policies until repeated concrete integrations
prove a smaller shared contract.

## Applying it to an expensive compaction epoch

Consider `dream -> compact -> publish`:

1. `dream` yields a typed manifest of immutable artifact refs.
2. `compact` is causally derived with `then` and yields another typed manifest.
3. `publish` is not merely another generic continuation. It is a domain module
   that compares `parentEpoch` with the current authoritative epoch and appends
   the single `epoch-published` fact.

If `dream` can cheaply resume inside one durable work item, its progress belongs
to private checkpoint state. If another module must consume a partial dream,
that partial output has become domain-addressable and deserves its own result
and terminal fact. This criterion avoids a vague generic "checkpoint" that is
simultaneously too public for retries and too weak for domain publication.

The publication event can atomically update Sledge projections and enqueue
dependents because those operations share the append transaction. It cannot
atomically create remote blobs. The safe split is immutable/idempotent artifact
staging first, then one compare-and-publish ledger transaction containing every
ref needed to read the epoch. A late attempt may leave unreachable staged
artifacts, but it cannot make a stale epoch authoritative.

## What the current prototype establishes

The [`stdlib pressure test`](./README.md) already supplies useful evidence:

- Direct source observation avoids a second generic settlement fact.
- A source event can trigger `then` work without a separate child-request fact.
- Finite `all` and first-settled `race` survive restart and nest through their
  own result port.
- Recording source settlements before group creation is sufficient to join
  work that has already completed.
- Choosing the lowest terminal event ID makes `race` independent of worker and
  callback timing; late losers cannot revise the result.
- Retries and duplicate submissions need not amplify the domain event stream.

The evidence is strongest for `ResultPort` and finite composition. `then` still
bundles retry count, timeout, terminal error shape, and side-effect idempotency;
those choices are not yet a universal operation contract. Client-facing
`wait`, private checkpoint storage, and stale-parent publication each need a
focused pressure test before they justify library API.

## Recommended next pressure tests

1. **Wait without missed completion:** establish the exact query/cursor
   handshake, then prove completion before, during, and after attachment across
   two processes.
2. **Checkpoint without domain amplification:** crash an expensive operation at
   several progress points, prove bounded recomputation, and verify that only
   its authoritative terminal fact reaches the domain stream.
3. **Competing epoch publication:** let two children share one parent; prove one
   publication wins atomically, the stale child cannot publish after losing its
   lease, and restart does not change the winner.
4. **History accounting:** report domain events, projection rows, private
   checkpoint rows, and staged garbage separately. A low event count is not
   enough if another unbounded journal has merely moved out of sight.

The likely standard-library center is therefore **typed durable results plus
small finite protocols over those results**. The durable execution journal is
valuable inspiration for engine internals, but importing it wholesale would
trade Sledge's small declarative ledger modules for a second orchestration
model.
