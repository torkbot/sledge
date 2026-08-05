# Sledge stdlib pressure test

> **THROWAWAY PROTOTYPE — not a Sledge, Harness, or TorkBot API proposal.**

This prototype asks whether the Sledge 0.27 module model can support a small
algebra of typed durable results, causal `then`, finite `all`, and first-settled
`race` without a workflow interpreter, a generic settlement bus, or model
handles leaking into application assembly.

The representative producers deliberately have different jobs:

- a typed agent tool invocation;
- asynchronous background document compaction.
- a memory-first compaction epoch that stages immutable artifacts and publishes
  memory plus transient conversation context atomically.

The pressure test is falsified if any of the following requires public engine
identity, producer-specific coordinator code, duplicate terminal facts,
process-local correctness callbacks, or caller-managed module handles:

1. Both producers use one invocation factory with finite attempts, an operation
   timeout, typed success, and durable terminal failure.
2. One coordinator consumes an arbitrary finite record of heterogeneous result
   ports and supports its own results as nested members.
3. `all` waits for every member and derives one deterministic aggregate outcome.
4. `race` chooses the lowest terminal event id, remains stable after late
   losers, and carries the winner's outcome.
5. A group opened before restart settles after its remaining member completes
   on a later ledger runtime.
6. A successful invocation uses exactly two durable facts (`requested` and
   `settled`), and a completed composition uses exactly two (`opened` and
   `settled`).
7. A successful derived operation treats its source result as the durable
   request and contributes only its own terminal fact.
8. Memory extraction can checkpoint before compaction, survive restart, and
   remain invisible until one expected-parent epoch publication makes both
   memory and compacted context authoritative.

Run the deterministic pressure test:

```sh
node --run prototype:stdlib -- --demo
```

Add `--trace` to include every durable event in the report.

Run the memory-first compaction epoch:

```sh
node --run prototype:stdlib:epoch
```

Run the interactive state explorer:

```sh
node --run prototype:stdlib
```

The scratch SQLite database is created under the operating-system temporary
directory and disposed when the process exits.

The [durable-execution research](./durable-execution-research.md) compares the
prototype with the journaling and recovery boundaries in Temporal, Restate,
DBOS, and Durable Task using first-party sources.

## Baseline from the earlier Harness experiment

The first Harness prototype compared a generic settlement bus with direct event
contributions. Direct contributions reduced its complete scenario from 36 to
26 durable event rows and removed half of all terminal facts. This pressure
test keeps that constraint: producers expose their original terminal event
through `ResultPort`; composition observes it directly and never mirrors it
onto another event.

## Verdict

The composition protocol survived the pressure test:

- Four invocation lifecycles and four composition lifecycles used exactly 16
  durable event rows: two facts per lifecycle.
- One `all` group crossed a complete ledger close and reopen before settling.
- A late failed loser did not change an already-settled `race`.
- A historical `race` chose the member with the earlier durable terminal event,
  independent of member declaration order.
- Composition results nested directly into another `all` group.
- Duplicate invocation submission and invocation retries added no domain event
  rows, and the final ledger had no remaining work.

The four composition groups used 25 projection rows: four groups, nine members,
four member completions, and eight result observations. Together with eight
invocation projection rows, the scenario used 33 projection rows. This is
bounded by declared topology and terminal results rather than polling history.

The developer-facing composition surface stayed small: provide a finite record
of result ports, emit one `opened` event containing typed result refs, and
observe the composition's own result port. The source-event aliases and the one
type-erasure boundary needed to iterate heterogeneous sources remain private to
the module factory.

The experiment exposed one foundational Sledge typing defect: `ResultPort`
widened its terminal event token, so installing a module that revealed a result
port lost the event's module ownership. Preserving the concrete event token in
`ResultPort` fixes that without changing the runtime API.

It exposed a second missing capability: a successful `ResultObservation` must
carry its typed value. Identity and outcome are enough for `all` and `race`, but
a causal successor cannot remain producer-independent without the successful
value. Failed and cancelled observations remain valueless.

## Memory-first compaction epoch

The advanced epoch scenario composes three independently defined modules:

1. A root invocation extracts durable memory from a raw prefix and stages an
   immutable memory artifact.
2. `then` derives compaction from that successful result. The compactor reads
   the staged memory, removes memory-backed facts from the prefix, and stages a
   transient-only prefix artifact.
3. A domain-owned publisher compares the candidate's parent with the current
   epoch and appends one terminal fact containing both artifact refs.

Four candidates used exactly 16 domain event rows and 25 projection rows. Each
candidate used one dreaming request, one dreaming terminal fact, one derived
compaction terminal fact, and one epoch terminal fact. A compaction retry,
complete ledger close and reopen, and duplicate request added no domain facts.

The scenario established all of the following:

- Dreaming completed and its immutable memory artifact remained durable while
  compaction was pending and no epoch was visible.
- Restart resumed the pending compaction without repeating dreaming.
- Re-emitting the same request joined its original durable identity.
- Memory and compacted context became visible only through one published epoch.
- Two candidates shared the same parent; the delayed candidate was rejected as
  stale after the other published, even though it covered a later cutoff.
- A candidate rebased onto the winning epoch subsequently published the later
  cutoff.
- Retries, duplicate submission, and reconciliation did not amplify the domain
  event stream.

The userspace wiring stayed small:

```ts
const dreaming = sledge.install(defineDreaming());

const compactions = sledge.install(
  defineThen({
    moduleId: "app.memory-aware-compactions",
    source: dreaming.result,
    outputSchema: CompactionOutputSchema,
    execute: compactWithoutMemoryFacts,
    maxAttempts: 3,
    timeoutMs: 30_000,
    logger,
  })(),
);

const epochs = sledge.install(
  defineEpochPublisher({
    moduleId: "app.epochs",
    source: compactions.result,
  })(),
);
```

`defineEpochPublisher` is deliberately application code. Epoch numbering,
expected-parent validation, and the manifest it publishes are domain semantics,
not standard-library concepts.

The blocking path is not yet solved cleanly. The scenario waits by repeatedly
querying the latest epoch. A production `wait` must atomically pair a
storage-local result lookup with a resumable event cursor so completion cannot
land between the query and subscription. Sledge does not currently expose that
snapshot/cursor seam. Process-local signals and unbounded polling are not
correct substitutes.

The invocation factory is less settled. Its two-fact lifecycle and shared use by
tool calls and compaction are sound, but retry classification, terminal error
data, and side-effect idempotency belong to the operation contract. It should
remain experimental until a concrete Harness tool-execution integration forces
those decisions.

The evidence supports promoting the exact `ResultPort` typing and successful
value fixes first, then finite `all`/`race`. It supports further development of
causal `then`, but not the current policy-bearing factory: retry count, timeout,
terminal errors, and side-effect idempotency are still bundled together. It
does not support promoting a general invocation primitive yet.

## Questions intentionally left open

- Whether retries need error classification rather than a required finite
  attempt count.
- Whether composition should expose failure payloads in addition to normalized
  outcomes and typed producer refs.
- Whether `any`, quorum, loser cancellation, or retention deserve shared
  protocols after `all` and `race` are understood.
- Whether a polished stdlib should generate source-event aliases internally or
  Sledge should expose a deeper contribution primitive for this pattern.
- The exact query-snapshot/cursor contract needed for race-free client waiting.
- Whether `then` should describe only the causal edge while the derived module
  owns execution policy, or whether a smaller shared operation contract emerges
  from Harness integration.
