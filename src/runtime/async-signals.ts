/**
 * Process-local change notification with a generation snapshot.
 *
 * Capturing the generation before reading authoritative state, then waiting
 * for a later generation, closes the race between the state read and waiter
 * registration. Notifications carry no state; callers always re-read their
 * authority after waking.
 */
export class ChangeSignal {
  readonly #waiters = new Set<() => void>();
  #generation = 0;

  snapshot(): number {
    return this.#generation;
  }

  notify(): void {
    this.#generation += 1;

    const waiters = [...this.#waiters];
    this.#waiters.clear();

    for (const waiter of waiters) {
      waiter();
    }
  }

  async waitForChange(
    observedGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || this.#generation !== observedGeneration) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        this.#waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };

      signal.addEventListener("abort", finish, {
        once: true,
      });
      this.#waiters.add(finish);

      if (signal.aborted || this.#generation !== observedGeneration) {
        finish();
      }
    });
  }
}

export type SignalRaceResult<T> =
  | {
      readonly status: "completed";
      readonly value: T;
    }
  | {
      readonly status: "aborted";
    };

/**
 * Stops awaiting an operation when a signal aborts without abandoning the
 * operation's eventual rejection. The underlying operation remains owned by
 * its originating runtime and may continue until that runtime can cancel or
 * close it.
 */
export async function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<SignalRaceResult<T>> {
  const aborted = Promise.withResolvers<SignalRaceResult<T>>();
  const onAbort = () => {
    aborted.resolve({
      status: "aborted",
    });
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
  }

  try {
    return await Promise.race([
      aborted.promise,
      operation.then(
        (value): SignalRaceResult<T> => ({
          status: "completed",
          value,
        }),
      ),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Suppress any rejection from operation that arrives after the signal
    // already won the race. Without this, a post-abort rejection on
    // operation.then(...) has no active handler and triggers
    // UnhandledPromiseRejection in Node.js 15+.
    void operation.catch(() => undefined);
  }
}
