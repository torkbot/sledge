import type {
  RuntimeClock,
  RuntimeScheduledTask,
  RuntimeScheduler,
} from "./contracts.ts";

const maximumNodeTimerDelayMs = 2_147_483_647;

/**
 * Production runtime clock implementation based on system wall time.
 */
export class SystemRuntimeClock implements RuntimeClock {
  nowMs(): number {
    return Date.now();
  }
}

class NodeScheduledTask implements RuntimeScheduledTask {
  readonly #cancel: () => void;

  constructor(cancel: () => void) {
    this.#cancel = cancel;
  }

  cancel(): void {
    this.#cancel();
  }
}

/**
 * Production runtime scheduler backed by Node.js timers.
 */
export class NodeRuntimeScheduler implements RuntimeScheduler {
  scheduleOnce(delayMs: number, task: () => void): RuntimeScheduledTask {
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const dueAtMs = performance.now() + delayMs;

    const scheduleNext = (): void => {
      const remainingDelayMs = Math.max(0, dueAtMs - performance.now());
      const scheduledDelayMs = Math.min(
        remainingDelayMs,
        maximumNodeTimerDelayMs,
      );
      handle = setTimeout(() => {
        handle = null;

        if (cancelled) {
          return;
        }

        if (performance.now() < dueAtMs) {
          scheduleNext();
          return;
        }

        task();
      }, scheduledDelayMs);
    };

    scheduleNext();

    return new NodeScheduledTask(() => {
      cancelled = true;

      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    });
  }

  scheduleRepeating(everyMs: number, task: () => void): RuntimeScheduledTask {
    const handle = setInterval(task, everyMs);

    return new NodeScheduledTask(() => {
      clearInterval(handle);
    });
  }
}
