# Failure and outcome taxonomy

> Research note for the settlement-algebra prototype. This is a design input,
> not an implementation proposal.

## Recommendation

Keep `Settlement<Success, Failure>` as the small, portable algebra for a
**logical program that has durably settled**:

```ts
type Settlement<Success, Failure> =
  | { readonly outcome: "succeeded"; readonly value: Success }
  | { readonly outcome: "failed"; readonly error: Failure }
  | { readonly outcome: "cancelled" };
```

Do not add `retrying`, `timedOut`, `defected`, `retryExhausted`, `deadLettered`,
or `crashed` merely because one attempt or worker can enter those states. A
producer should cross the settlement boundary only after retry, cancellation,
and deadline policy has decided the logical program's outcome.

The algebra is not sufficient as the _only_ execution status model. Sledge
also needs an operational view that can distinguish pending work from delayed,
retrying, suspended, cancellation-requested, and abandoned/dead-lettered work.
If Sledge gains an administrative force-stop operation, that close state must
remain distinct from cooperative `cancelled`; call it `terminated` in a wider
completion/closure type rather than pretending the program returned it.

The resulting boundary is:

```text
attempt Exit / thrown value / worker loss
                  |
                  v
       retry + cancellation + deadline policy
                  |
       +----------+-----------+
       |                      |
       v                      v
portable Settlement      operational execution state
```

## What the established systems separate

| Phenomenon                                       | Portable program settlement?                                                            | Evidence and interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful return                                | Yes: `succeeded(value)`                                                                 | Temporal, Restate, and Azure all expose completed execution separately from live operational states. Temporal calls `Completed` a closed status, while Azure distinguishes `Completed` from `Pending`, `Running`, and `Suspended` ([Temporal Workflow status](https://docs.temporal.io/workflow-execution#status), [Azure instance status](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-instance-management#query-instances)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Declared application failure                     | Yes: `failed(error)` after policy declines further retries                              | Temporal distinguishes application failures from transparent platform failures; an unhandled Temporal failure closes the Workflow, while an ordinary Workflow-code defect fails and retries only the Workflow Task. Restate similarly distinguishes terminal application errors from retryable transient errors. Azure marshals an activity or sub-orchestration exception back to the orchestrator, where ordinary program error handling may catch it; only an unhandled orchestrator exception closes the orchestration as failed ([Temporal application failures](https://docs.temporal.io/encyclopedia/application-failures), [Restate error handling](https://docs.restate.dev/guides/error-handling), [Azure error handling](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-error-handling), [Azure orchestration error handling](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations#error-handling)). |
| Retry / backoff                                  | No                                                                                      | Temporal Activity attempts retry while the logical Activity remains pending; retry details are deliberately suppressed from Workflow history until completion or final failure. Restate exposes `backing-off` as an active invocation state. Retry count, delay, and last error therefore belong to durable work/runtime inspection, not `Settlement` ([Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies), [Restate introspection](https://docs.restate.dev/services/introspection)).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Retry exhaustion                                 | Not by itself                                                                           | Temporal returns an error when maximum attempts are exceeded, so surrounding Workflow code can still catch it. A Restate invocation normally pauses when attempts are exhausted and can later resume, although policy may instead kill it. Azure retry exhaustion surfaces the task failure back to the orchestrator, where it remains catchable. The policy's _next action_ decides whether the program remains suspended, handles a typed failure, or is forcibly terminated; `retryExhausted` is not a universal settlement ([Temporal maximum attempts](https://docs.temporal.io/encyclopedia/retry-policies#maximum-attempts), [Restate retry configuration](https://docs.restate.dev/services/configuration#retries), [Azure retries](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-error-handling)).                                                                                                                                       |
| Attempt timeout / heartbeat timeout              | No                                                                                      | Temporal's Start-to-Close and heartbeat failures can lead to another Activity attempt, while Schedule-to-Close bounds the entire Activity execution. Restate's inactivity timeout asks an attempt to suspend while preserving progress, and its abort timeout protects that suspension process. These are attempt-supervision facts ([Temporal Activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures), [Restate service timeouts](https://docs.restate.dev/guides/error-handling#timeouts-between-restate-and-the-service)).                                                                                                                                                                                                                                                                                                                                                                                                         |
| Program deadline                                 | Usually `failed(E)` when declared by the program; otherwise an operational forced close | Restate context-action timeouts are catchable and otherwise cause retry. Azure models orchestration timeouts with durable timers and ordinary control flow. Temporal also exposes `Timed Out` as a distinct server-enforced closed Workflow status. Sledge should therefore let a semantic deadline be a typed `Failure`, while a future engine-enforced execution deadline belongs beside force termination, not beside attempt timeout ([Restate context-action timeouts](https://docs.restate.dev/guides/error-handling#timeouts-for-context-actions), [Azure durable timers](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations#durable-timers), [Temporal closed statuses](https://docs.temporal.io/workflow-execution#closed)).                                                                                                                                                                                                   |
| Cancellation request                             | No                                                                                      | Temporal distinguishes requesting cancellation from the closed `Cancelled` status; `Cancelled` means the Workflow successfully handled the request. Restate cancellation is non-blocking and surfaces cooperatively at the next durable await point. A request, an attempt's `AbortSignal`, and acknowledged cancellation are three different facts ([Temporal Workflow status](https://docs.temporal.io/workflow-execution#closed), [Restate cancellation](https://docs.restate.dev/services/invocation/managing-invocations#cancel)).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Acknowledged cooperative cancellation            | Yes: `cancelled`                                                                        | Once cancellation has propagated through the program's cleanup/compensation boundary and is durably committed, downstream programs need a terminal result distinct from failure. Restate explicitly contrasts cancellation, which permits compensation, with kill, which does not ([Restate cancellation and kill](https://docs.restate.dev/services/invocation/managing-invocations#cancel)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Administrative termination / kill                | No program settlement; yes, distinct durable closure if Sledge supports it              | Temporal has separate `Cancelled` and forceful `Terminated` closed statuses. Restate kill immediately stops the invocation tree without compensation and warns that state may be inconsistent. Azure calls `Terminated` abrupt and notes that termination does not currently propagate to activities or sub-orchestrations. Collapsing this into `cancelled` would make cleanup and causal claims false ([Temporal statuses](https://docs.temporal.io/workflow-execution#closed), [Restate kill](https://docs.restate.dev/services/invocation/managing-invocations#kill), [Azure termination](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-instance-management#terminate-orchestration-instances)).                                                                                                                                                                                                                                              |
| Defect, panic, or unexpected exception           | No, by default                                                                          | Effect represents an unexpected defect as `Cause.Die`, separately from typed `Cause.Fail<E>` and interruption. Temporal retries ordinary Workflow-code defects as Workflow Task failures and transparently recovers worker crashes; ordinary Activity errors are retryable Application Failures by default. A defect should therefore remain attempt/runtime diagnostic state until explicit policy converts it to a typed failure, suspension, or force termination ([Effect `Cause`](https://github.com/Effect-TS/effect/blob/effect%403.22.1/packages/effect/src/Cause.ts), [Temporal failure classification](https://docs.temporal.io/encyclopedia/application-failures#workflow-task-failures-vs-workflow-execution-failures)).                                                                                                                                                                                                                                         |
| Dead-letter                                      | No                                                                                      | Restate describes a DLQ as application code that catches a terminal failure and forwards it elsewhere; its retry policy separately pauses or kills an invocation. Sledge's queue dead-letter is likewise a terminal _work disposition_, not evidence that the logical producer emitted a failure. It needs operational inspection and an explicit resume/terminate/reclassify decision ([Restate DLQ](https://docs.restate.dev/guides/error-handling#dead-letter-queue), [Restate retry configuration](https://docs.restate.dev/services/configuration#retries)).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Worker/process crash, lease loss, shutdown abort | Never                                                                                   | Temporal explicitly handles Worker crashes, network interruptions, and infrastructure outages transparently by recovering on another Worker. No program outcome was produced. Sledge should release/recover the lease and retry without emitting a settlement ([Temporal platform failures](https://docs.temporal.io/encyclopedia/application-failures#platform-failures)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## How Effect's `Exit` should cross the boundary

Effect's `Exit<A, E>` is `Success<A> | Failure<Cause<E>>`. Its `Cause<E>` is
intentionally lossless: it can contain typed `Fail<E>`, unexpected `Die`, fiber
`Interrupt`, and sequential or parallel combinations. That is an excellent
**attempt interpreter** model, but a poor portable ledger payload: defects are
`unknown`, interruption carries a process-local `FiberId`, and cause trees
contain execution topology and traces ([Effect `Exit`](https://github.com/Effect-TS/effect/blob/effect%403.22.1/packages/effect/src/Exit.ts),
[Effect `Cause`](https://github.com/Effect-TS/effect/blob/effect%403.22.1/packages/effect/src/Cause.ts)).

The durable interpreter should normalize an `Exit` with provenance and policy:

```text
Success<A>                         -> Settlement.succeeded(A)
Fail<E> after retry policy         -> Settlement.failed(E)
Interrupt from durable cancel      -> Settlement.cancelled(), after acknowledgement
Interrupt from lease loss/shutdown -> retry; remain unsettled
Die / unexpected defect            -> retry, then suspend or explicitly terminate
```

Effect's `Cause` is still valuable for attempt diagnostics, including parallel
and finalizer failures. Sledge should not persist it as the public result
algebra. If an application needs multiple durable failures, that is part of its
declared `Failure` schema and aggregation policy.

## Concrete gaps in the current prototype

The three variants themselves are a good program-settlement taxonomy. The gaps
are around ownership and observation:

1. **`cancelled()` is producer-callable without a cancellation request.** The
   prototype cannot tell an acknowledged external cancellation from application
   code choosing the branch. If cancellation is control-plane semantics, the
   durable interpreter should own its production or require evidence of the
   corresponding durable request.
2. **`null` observation collapses materially different live states.** A result
   can be absent, pending, delayed, retrying, blocked behind a partition,
   cancellation-requested, or permanently dead-lettered. None should become a
   settlement, but operators and users need a separate operational status API
   to tell whether progress is expected.
3. **There is no force-termination closure.** This is acceptable while Sledge
   exposes no such capability. If one is introduced, it must not reuse
   `cancelled`; Restate, Temporal, and Azure all preserve the semantic
   difference between cooperative cleanup and abrupt termination.
4. **Thrown defects retry with no algebraic escalation boundary.** Infinite
   retry may be the intended default, but a bounded policy must say `pause`,
   `terminate`, or translate a known condition into the producer's typed
   `Failure`. It must not silently manufacture an untyped `failed` settlement.
5. **Attempt interruption has ambiguous provenance.** The same `AbortSignal`
   shape can mean user cancellation, lease fencing, timeout, or worker
   shutdown. Only the first may become `cancelled`; the others must remain
   operational unless a higher-level policy closes the program.

The smallest sound next design is therefore not another settlement variant. It
is a strict interpreter boundary plus a separately queryable execution status.
Add a distinct termination closure only alongside a real force-stop use case.
