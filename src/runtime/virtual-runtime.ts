import type {
  RuntimeClock,
  RuntimeScheduledTask,
  RuntimeScheduler,
} from "./contracts.ts";

class VirtualRuntimeClock implements RuntimeClock {
  #nowMs: number;

  constructor(nowMs: number) {
    this.#nowMs = nowMs;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advanceByMs(ms: number): void {
    this.#nowMs += ms;
  }
}

type ScheduledEntry = {
  id: number;
  dueAtMs: number;
  everyMs: number | null;
  task: () => void;
  cancelled: boolean;
};

class VirtualRuntimeScheduler implements RuntimeScheduler {
  readonly #clock: VirtualRuntimeClock;
  readonly #entries = new Map<number, ScheduledEntry>();

  #nextId = 1;

  constructor(clock: VirtualRuntimeClock) {
    this.#clock = clock;
  }

  scheduleOnce(delayMs: number, task: () => void): RuntimeScheduledTask {
    return this.#schedule(delayMs, null, task);
  }

  scheduleRepeating(everyMs: number, task: () => void): RuntimeScheduledTask {
    return this.#schedule(everyMs, everyMs, task);
  }

  runDue(): void {
    while (true) {
      const dueEntry = this.#nextDueEntry();

      if (dueEntry === null) {
        return;
      }

      dueEntry.task();

      if (dueEntry.cancelled) {
        this.#entries.delete(dueEntry.id);
        continue;
      }

      if (dueEntry.everyMs === null) {
        this.#entries.delete(dueEntry.id);
        continue;
      }

      dueEntry.dueAtMs += dueEntry.everyMs;
    }
  }

  #schedule(
    delayMs: number,
    everyMs: number | null,
    task: () => void,
  ): RuntimeScheduledTask {
    const id = this.#nextId;
    this.#nextId += 1;

    const entry: ScheduledEntry = {
      id,
      dueAtMs: this.#clock.nowMs() + delayMs,
      everyMs,
      task,
      cancelled: false,
    };

    this.#entries.set(id, entry);

    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  #nextDueEntry(): ScheduledEntry | null {
    let selected: ScheduledEntry | null = null;

    for (const entry of this.#entries.values()) {
      if (entry.cancelled) {
        continue;
      }

      if (entry.dueAtMs > this.#clock.nowMs()) {
        continue;
      }

      if (selected === null) {
        selected = entry;
        continue;
      }

      if (entry.dueAtMs < selected.dueAtMs) {
        selected = entry;
        continue;
      }

      if (entry.dueAtMs === selected.dueAtMs && entry.id < selected.id) {
        selected = entry;
      }
    }

    return selected;
  }
}

/**
 * Deterministic runtime harness for contract and integration tests.
 */
export class VirtualRuntimeHarness {
  readonly #clock: VirtualRuntimeClock;
  readonly #scheduler: VirtualRuntimeScheduler;

  constructor(nowMs: number) {
    this.#clock = new VirtualRuntimeClock(nowMs);
    this.#scheduler = new VirtualRuntimeScheduler(this.#clock);
  }

  get clock(): VirtualRuntimeClock {
    return this.#clock;
  }

  get scheduler(): VirtualRuntimeScheduler {
    return this.#scheduler;
  }

  nowMs(): number {
    return this.#clock.nowMs();
  }

  async advanceByMs(ms: number): Promise<void> {
    this.#clock.advanceByMs(ms);
    this.#scheduler.runDue();
    await this.flush();
  }

  async flush(): Promise<void> {
    this.#scheduler.runDue();

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }
}
