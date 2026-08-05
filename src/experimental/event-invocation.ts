import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  type EmitOptions,
  type EventPayload,
  type EventToken,
  type LedgerEventCommit,
  type QueryToken,
  type QueueLedger,
} from "../ledger.ts";
import { defineModule } from "../sledge.ts";

export type EventInvocationRequest<TInput> = {
  /** Stable identity for retries and external-effect idempotency. */
  readonly key: string;
  readonly input: TInput;
};

/** Attempt-scoped ledger access explicitly imported by an event invocation. */
export interface EventInvocationLedgerPort<
  TEvents extends EventToken = never,
  TQueries extends QueryToken = never,
> {
  emit<const TEvent extends TEvents>(
    event: TEvent,
    payload: EventPayload<TEvent>,
    options?: EmitOptions,
  ): Promise<LedgerEventCommit<TEvent>>;

  query<
    const TQueryModuleId extends string,
    const TQueryName extends string,
    const TParamsSchema extends TSchema,
    const TResultSchema extends TSchema,
  >(
    query: TQueries &
      QueryToken<TQueryModuleId, TQueryName, TParamsSchema, TResultSchema>,
    params: Static<TParamsSchema>,
  ): Promise<Static<TResultSchema>>;
}

/** Storage-local query access available while filtering derived work. */
export interface EventInvocationFilterLedgerPort<
  TQueries extends QueryToken = never,
> {
  query<
    const TQueryModuleId extends string,
    const TQueryName extends string,
    const TParamsSchema extends TSchema,
    const TResultSchema extends TSchema,
  >(
    query: TQueries &
      QueryToken<TQueryModuleId, TQueryName, TParamsSchema, TResultSchema>,
    params: Static<TParamsSchema>,
  ): Promise<Static<TResultSchema>>;
}

export type EventInvocationFilter<
  TInput,
  TQueries extends Readonly<Record<string, QueryToken>> = {},
> = (input: {
  readonly input: TInput;
  readonly key: string;
  readonly signal: AbortSignal;
  readonly ledger: EventInvocationFilterLedgerPort<TQueries[keyof TQueries]>;
}) => boolean | Promise<boolean>;

export type EventInvocationExecution<
  TInput,
  TTerminalPayload,
  TEvents extends Readonly<Record<string, EventToken>> = {},
  TQueries extends Readonly<Record<string, QueryToken>> = {},
> = (input: {
  readonly input: TInput;
  readonly key: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly ledger: EventInvocationLedgerPort<
    TEvents[keyof TEvents],
    TQueries[keyof TQueries]
  >;
  readonly withTimeout: <TValue>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<TValue>,
  ) => Promise<TValue>;
}) => Promise<TTerminalPayload>;

/**
 * Derives retryable work from an existing event and commits an existing domain
 * event as its terminal fact.
 *
 * The module appends no protocol events of its own. Source handling only
 * creates private durable work, and the terminal event is emitted atomically
 * with acknowledgement of the successful attempt. Throwing retries. External
 * effects must use `key` as their idempotency key.
 */
export function defineEventInvocation<
  const TModuleId extends string,
  const TSourceModuleId extends string,
  const TSourceName extends string,
  const TSourceSchema extends TSchema,
  const TTerminalModuleId extends string,
  const TTerminalName extends string,
  const TTerminalSchema extends TSchema,
  const TInputSchema extends TSchema,
  const TEvents extends Readonly<Record<string, EventToken>> = {},
  const TQueries extends Readonly<Record<string, QueryToken>> = {},
>(
  moduleId: TModuleId,
  input: {
    readonly source: EventToken<
      TSourceModuleId,
      TSourceName,
      TSourceSchema,
      null
    >;
    readonly terminal: EventToken<
      TTerminalModuleId,
      TTerminalName,
      TTerminalSchema,
      null
    >;
    readonly inputSchema: TInputSchema;
    readonly derive: (source: {
      readonly eventId: number;
      readonly tsMs: number;
      readonly payload: Static<TSourceSchema>;
    }) => readonly EventInvocationRequest<Static<TInputSchema>>[];
    readonly access?: {
      readonly events: TEvents;
      readonly queries: TQueries;
    };
    readonly filter?: EventInvocationFilter<Static<TInputSchema>, TQueries>;
    readonly execute: EventInvocationExecution<
      Static<TInputSchema>,
      Static<TTerminalSchema>,
      TEvents,
      TQueries
    >;
  },
) {
  return defineModule(moduleId, (module) => {
    type InvocationInput = Static<TInputSchema>;
    const InputSchema = Type.Unsafe<InvocationInput>(input.inputSchema);
    const WorkSchema = Type.Object({
      key: Type.String({ minLength: 1 }),
      input: InputSchema,
    });
    const importedEvents = importInvocationEvents(input.access?.events ?? {});
    const importedQueries = importInvocationQueries(
      input.access?.queries ?? {},
    );
    const allowedEvents = new Set<EventToken>(
      Object.values(input.access?.events ?? {}),
    );
    const allowedQueries = new Set<QueryToken>(
      Object.values(input.access?.queries ?? {}),
    );
    const declaration = module.declare({
      events: {
        source: input.source,
        terminal: input.terminal,
        ...importedEvents,
      },
      queries: importedQueries,
      queues: {
        execute: WorkSchema,
      },
    });
    const linked = module.link(declaration, null);
    type Registration = Parameters<typeof linked.register>[0];
    const filter = input.filter;
    const sourceHandler = linked.eventToWork("source", "execute", ({ event }) =>
      input
        .derive({
          eventId: event.eventId,
          tsMs: event.tsMs,
          payload: event.payload,
        })
        .map((request) => {
          const decoded = Value.Decode(WorkSchema, request);

          return {
            payload: decoded,
            options: { workKey: decoded.key },
          };
        }),
    );
    const executeHandler = linked.workToEvent("execute", "terminal", {
      filter:
        filter === undefined
          ? undefined
          : async ({ input: work, signal, ledger }) =>
              await filter({
                input: work.input,
                key: work.key,
                signal,
                ledger,
              }),
      map: async ({ input: work, attempt, signal, ledger, control }) => {
        const executionLedger = new ActiveEventInvocationLedgerPort<
          TEvents[keyof TEvents],
          TQueries[keyof TQueries]
        >(
          ledger as QueueLedger<EventToken, QueryToken>,
          allowedEvents,
          allowedQueries,
        );
        let terminal: Static<TTerminalSchema>;

        try {
          terminal = await input.execute({
            input: work.input,
            key: work.key,
            attempt,
            signal,
            ledger: executionLedger,
            withTimeout: async (timeoutMs, operation) =>
              await control.withTimeout(timeoutMs, operation),
          });
        } finally {
          executionLedger.close();
        }

        signal.throwIfAborted();

        return terminal;
      },
    });
    // Generic imported event owners cannot be proven distinct from TModuleId
    // inside EventRegistrationProperty's conditional required-handler type.
    // The handlers themselves remain context-checked above; construction scope
    // and composed-token validation enforce the ownership distinction at runtime.
    const registration = {
      events: { source: sourceHandler },
      queues: { execute: executeHandler },
      queries: {},
    } as unknown as Registration;
    const registered = linked.register(registration);

    return module.expose(registered, {});
  });
}

class ActiveEventInvocationLedgerPort<
  TEvents extends EventToken,
  TQueries extends QueryToken,
> implements EventInvocationLedgerPort<TEvents, TQueries> {
  readonly #ledger: QueueLedger<EventToken, QueryToken>;
  readonly #events: ReadonlySet<EventToken>;
  readonly #queries: ReadonlySet<QueryToken>;
  #open = true;

  constructor(
    ledger: QueueLedger<EventToken, QueryToken>,
    events: ReadonlySet<EventToken>,
    queries: ReadonlySet<QueryToken>,
  ) {
    this.#ledger = ledger;
    this.#events = events;
    this.#queries = queries;
  }

  async emit<const TEvent extends TEvents>(
    event: TEvent,
    payload: EventPayload<TEvent>,
    options?: EmitOptions,
  ): Promise<LedgerEventCommit<TEvent>> {
    this.#assertOpen();

    if (!this.#events.has(event)) {
      throw new Error(
        "event invocation attempted to emit a capability that it did not import",
      );
    }

    const committed = await this.#ledger.emit(event, payload, options);
    this.#assertOpen();
    return committed;
  }

  async query<
    const TQueryModuleId extends string,
    const TQueryName extends string,
    const TParamsSchema extends TSchema,
    const TResultSchema extends TSchema,
  >(
    query: TQueries &
      QueryToken<TQueryModuleId, TQueryName, TParamsSchema, TResultSchema>,
    params: Static<TParamsSchema>,
  ): Promise<Static<TResultSchema>> {
    this.#assertOpen();

    if (!this.#queries.has(query)) {
      throw new Error(
        "event invocation attempted to use a query capability that it did not import",
      );
    }

    const result = await this.#ledger.query(query, params);
    this.#assertOpen();
    return result;
  }

  close(): void {
    this.#open = false;
  }

  #assertOpen(): void {
    if (!this.#open) {
      throw new Error("event invocation ledger port is no longer active");
    }
  }
}

function importInvocationEvents(
  events: Readonly<Record<string, EventToken>>,
): Readonly<Record<`invocation:event:${string}`, EventToken>> {
  // Generated aliases preserve each opaque token's original owner and payload.
  return Object.fromEntries(
    Object.entries(events).map(([name, event]) => [
      `invocation:event:${name}`,
      event,
    ]),
  ) as Readonly<Record<`invocation:event:${string}`, EventToken>>;
}

function importInvocationQueries(
  queries: Readonly<Record<string, QueryToken>>,
): Readonly<Record<`invocation:query:${string}`, QueryToken>> {
  // Generated aliases make only exact imported queries available to work.
  return Object.fromEntries(
    Object.entries(queries).map(([name, query]) => [
      `invocation:query:${name}`,
      query,
    ]),
  ) as Readonly<Record<`invocation:query:${string}`, QueryToken>>;
}
