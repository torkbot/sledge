/**
 * Time source used by runtime implementations.
 *
 * Implementations should depend on this abstraction rather than `Date.now()`
 * directly so tests can run with deterministic virtual time.
 */
export interface RuntimeClock {
  nowMs(): number;
}

/**
 * Handle returned by runtime scheduling primitives.
 */
export interface RuntimeScheduledTask {
  cancel(): void;
}

/**
 * Scheduling abstraction used by runtime polling and heartbeat loops.
 *
 * Implementations can back this with real timers in production and virtual
 * schedulers in tests.
 */
export interface RuntimeScheduler {
  scheduleOnce(delayMs: number, task: () => void): RuntimeScheduledTask;
  scheduleRepeating(everyMs: number, task: () => void): RuntimeScheduledTask;
}
