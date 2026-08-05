# Settlement algebra prototype

This throwaway prototype answers one question:

> Does one `Settlement<A, E>` value make Sledge producers, causal operators,
> and ordinary program code share the same terminal-state model without
> conflating retry, typed failure, and cancellation?

Run the interactive state machine:

```sh
node --run prototype:settlement
```

Run the deterministic scenarios:

```sh
node --run prototype:settlement -- --demo
```

Run the real durable composition bridge:

```sh
node --run prototype:settlement -- --durable
```

Audit attempt failures, retry exhaustion, lease interruption, and raw queue
cancellation:

```sh
node --run prototype:settlement -- --failure-audit
```

The prototype treats thrown attempts as retryable and non-terminal. Only these
values settle a program:

```ts
Settlement.succeeded(value);
Settlement.failed(error);
Settlement.cancelled();
```

This is deliberately not the whole execution-state model. Attempt timeouts,
lease loss, worker shutdown, retry backoff, retry exhaustion, pause, and raw
queue dead-letter/cancellation are operational facts. They require a separate
status/control plane; manufacturing a settlement from them would make a worker
failure indistinguishable from a program decision. See
[`failure-outcome-taxonomy.md`](./failure-outcome-taxonomy.md) for the
cross-platform comparison.

It feeds the exact same terminal shape through `invocation -> then`, joins the
results with `all` and `race`, then feeds `all` into another `then`. Finally,
`matchSettlement(...)` translates observations into ordinary synchronous code.
The durable run uses a scratch SQLite database and restarts before retrying, so
the experiment exercises real ledger composition rather than merely a
standalone discriminated union.

## Validation criteria

- Invocation and causal derivation return the same terminal type.
- `all` and `race` produce that same type without nesting another outcome.
- An aggregate result can feed another causal operator without an adapter.
- A `ResultObservation` is structurally a settlement plus its durable ref.
- Typed failure and cancellation propagate without executing downstream code.
- Throwing leaves the durable result pending and retries after restart.
- Lease interruption retries and does not manufacture program cancellation.
- Retry exhaustion becomes a typed failure only through explicit policy.
- Operationally terminal work cannot be mistaken for a program settlement.
- The terminal event schema comes from `defineResult(...)`, rather than being
  rebuilt by every producer.
- Ordinary code handles every terminal state through one exhaustive function.
- Aggregate success metadata is the success value; aggregate failure metadata
  is the typed error; cancellation remains payload-free.
- The existing all/race event counts do not change.

The last operational criterion currently fails: cancelling the private work
behind an invocation makes that queue item terminal while its result remains
pending. The failure audit keeps this counterexample executable so the next
design cannot accidentally hide it.
