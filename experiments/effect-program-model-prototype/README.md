# Effect program model prototype

This is a throwaway, runnable experiment for one architectural question:

> Can an ordinary `Effect<A, E, R>` be the program representation while
> Sledge supplies durable execution semantics underneath it?

The scenario is deliberately demanding. An epoch program extracts durable
memory, passes that exact output into compaction, and publishes both as one
workflow result. Compaction fails once, the process restarts, and the program
resumes from the durable activity journal.

```ts
export const epochProgram: EpochProgram = (input) =>
  Effect.gen(function* () {
    const memoryExtraction = yield* invoke(extractMemory, {
      previousMemory: input.previousMemory,
      prefix: input.prefix,
    });
    const compaction = yield* invoke(compactPrefix, {
      prefix: input.prefix,
      memoryExtraction,
    });

    return {
      memory: memoryExtraction.memory,
      compactedPrefix: compaction.compactedPrefix,
    };
  });
```

Run it from the repository root:

```sh
node --run prototype:effect-program
```

The program runs three times: once until memory extraction is scheduled, once
until compaction is scheduled, and once to completion. Completed activities
are replayed from ledger state and are not executed again. A child settlement
enqueues the next workflow tick, so a suspended workflow consumes no worker and
does not poll.

The expected journal is six domain events:

1. workflow requested
2. memory extraction requested
3. memory extraction settled
4. compaction requested
5. compaction settled
6. workflow settled

The activity retry and the three pure program replays add no domain events.
The work queue still records retry mechanics in its own durable state.

The executable scenario currently verifies:

- three deterministic program replays;
- one process/database restart between activity attempts;
- one memory extraction call despite replay;
- two compaction calls because the first attempt fails; and
- six domain events with no work left behind.

## What this intentionally does not decide

The interpreter is epoch-specific. It proves replay, suspension, activity
identity, event-driven wake-up, restart recovery, and event cost before a
generic public API is designed. The next experiment should determine how
activity implementations and their schemas become `Layer` contributions
without exposing result ports, event aliases, or workflow plumbing to users.

The prototype contains one confined type assertion where an open generic
`DurableActivities.run` method meets an erased runtime activity registry. That
is design evidence, not an API to preserve: a production design should either
make the registry itself existentially typed inside Sledge or have a bound
activity reveal its already-typed Effect constructor.

This prototype also exposes the central constraint: arbitrary Effects are not
automatically durable. Replay is safe only when external I/O crosses a
journaled Sledge capability such as `invoke(...)`. An all-in design therefore
needs a runtime environment that makes unjournaled production I/O unavailable
by construction, plus explicit code-version semantics for replaying old
programs.
