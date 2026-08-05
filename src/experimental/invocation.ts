import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  defineMaterialization,
  type EmitOptions,
  type EventPayload,
  type EventToken,
  type LedgerEventCommit,
  type QueryParameters,
  type QueryResult,
  type QueryToken,
  type QueueLedger,
} from "../ledger.ts";
import { defineModule } from "../sledge.ts";
import { defineResult, type ResultRef } from "../stdlib.ts";

export type InvocationResolution<TResult, TFailure> =
  | { readonly outcome: "succeeded"; readonly value: TResult }
  | { readonly outcome: "failed"; readonly error: TFailure }
  | { readonly outcome: "cancelled" };

export type InvocationExecution<
  TInput,
  TResult,
  TFailure,
  TModuleId extends string,
  TEvents extends Readonly<Record<string, EventToken>> = {},
  TQueries extends Readonly<Record<string, QueryToken>> = {},
> = (input: {
  readonly input: TInput;
  readonly ref: ResultRef<TResult, TModuleId>;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly ledger: InvocationLedgerPort<
    TEvents[keyof TEvents],
    TQueries[keyof TQueries]
  >;
  readonly withTimeout: <TValue>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<TValue>,
  ) => Promise<TValue>;
}) => Promise<InvocationResolution<TResult, TFailure>>;

/** Attempt-scoped ledger access explicitly imported by an invocation. */
export interface InvocationLedgerPort<
  TEvents extends EventToken = never,
  TQueries extends QueryToken = never,
> {
  emit<const TEvent extends TEvents>(
    event: TEvent,
    payload: EventPayload<TEvent>,
    options?: EmitOptions,
  ): Promise<LedgerEventCommit<TEvent>>;

  query<const TQuery extends TQueries>(
    query: TQuery,
    params: QueryParameters<NoInfer<TQuery>>,
  ): Promise<QueryResult<TQuery>>;
}

/**
 * Defines a typed durable request/result protocol around an at-least-once
 * operation.
 *
 * Throwing asks Sledge to retry the operation. Returning a resolution records
 * one terminal fact. External effects should use `ref` as their idempotency
 * key because a worker may finish the operation and fail before settlement is
 * committed.
 */
export function defineInvocation<
  const TModuleId extends string,
  const TInputSchema extends TSchema,
  const TResultSchema extends TSchema,
  const TFailureSchema extends TSchema,
  const TEvents extends Readonly<Record<string, EventToken>> = {},
  const TQueries extends Readonly<Record<string, QueryToken>> = {},
>(
  moduleId: TModuleId,
  input: {
    readonly inputSchema: TInputSchema;
    readonly resultSchema: TResultSchema;
    readonly failureSchema: TFailureSchema;
    readonly access?: {
      readonly events: TEvents;
      readonly queries: TQueries;
    };
    readonly execute: InvocationExecution<
      Static<TInputSchema>,
      Static<TResultSchema>,
      Static<TFailureSchema>,
      TModuleId,
      TEvents,
      TQueries
    >;
  },
) {
  return defineModule(moduleId, (module) => {
    type InvocationInput = Static<TInputSchema>;
    type InvocationResult = Static<TResultSchema>;
    type InvocationFailure = Static<TFailureSchema>;
    const InputSchema = Type.Unsafe<InvocationInput>(input.inputSchema);
    const ResultSchema = Type.Unsafe<InvocationResult>(input.resultSchema);
    const FailureSchema = Type.Unsafe<InvocationFailure>(input.failureSchema);
    const result = defineResult(module, {
      resultSchema: ResultSchema,
      failureSchema: FailureSchema,
    });
    const RequestedSchema = Type.Object({
      ref: result.refSchema,
      input: InputSchema,
    });
    const SettledSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("succeeded"),
        value: ResultSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("failed"),
        error: FailureSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]);
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        input: InputSchema,
      }),
      Type.Object({
        kind: Type.Literal("succeeded"),
        input: InputSchema,
        value: ResultSchema,
      }),
      Type.Object({
        kind: Type.Literal("failed"),
        input: InputSchema,
        error: FailureSchema,
      }),
      Type.Object({
        kind: Type.Literal("cancelled"),
        input: InputSchema,
      }),
    ]);
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
        requested: RequestedSchema,
        settled: SettledSchema,
        ...importedEvents,
      },
      queries: importedQueries,
      queues: {
        execute: RequestedSchema,
      },
    });
    const materialization = defineMaterialization(declaration, {
      namespace: "invocation",
    })
      .version(1, "record durable invocations", (schema) =>
        schema.createTable("invocations", (table) =>
          table
            .columns({
              ref: table.text().notNull(),
              request: table.eventRef("requested").notNull(),
              settlement: table.eventRef("settled"),
            })
            .primaryKey(["ref"]),
        ),
      )
      .define({
        indexers: {
          request: {
            sourceEvent: "requested",
            input: RequestedSchema,
          },
          settle: {
            sourceEvent: "settled",
            input: SettledSchema,
          },
        },
        queries: {
          state: {
            params: StateParamsSchema,
            result: StateResultSchema,
          },
        },
      });
    const linked = module.link(declaration, materialization);
    type Registration = Parameters<typeof linked.register>[0];
    type EventRegistrations = NonNullable<Registration["events"]>;
    type IndexerRegistrations = NonNullable<Registration["indexers"]>;
    type QueryRegistrations = Registration["queries"];
    type RequestedHandler = NonNullable<EventRegistrations["requested"]>;
    type SettledHandler = NonNullable<EventRegistrations["settled"]>;
    type RequestIndexer = IndexerRegistrations["request"];
    type SettleIndexer = IndexerRegistrations["settle"];
    type StateQuery = QueryRegistrations["state"];
    const dispatchRequested = linked.eventToWork(
      "requested",
      "execute",
      ({ event }) => ({
        payload: event.payload,
        options: {
          coalescingKey: event.payload.ref,
          partitionKey: event.payload.ref,
        },
      }),
    );
    const execute = linked.workToEvent("execute", "settled", {
      filter: async ({ input: work, query }) => {
        const state = await query("state", { ref: work.ref });

        if (state === null) {
          throw new Error(`invocation ${work.ref} executed without a request`);
        }

        return state.kind === "pending";
      },
      map: async ({ input: work, attempt, signal, ledger, query, control }) => {
        const state = await query("state", { ref: work.ref });

        if (state?.kind !== "pending") {
          throw new Error(
            `admitted invocation ${work.ref} is no longer pending`,
          );
        }

        const executionLedger = new ActiveInvocationLedgerPort<
          TEvents[keyof TEvents],
          TQueries[keyof TQueries]
        >(
          ledger as QueueLedger<EventToken, QueryToken>,
          allowedEvents,
          allowedQueries,
        );
        let resolution: InvocationResolution<
          InvocationResult,
          InvocationFailure
        >;

        try {
          resolution = await input.execute({
            input: state.input,
            ref: work.ref,
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

        if (resolution.outcome === "succeeded") {
          return {
            ref: work.ref,
            outcome: resolution.outcome,
            value: Value.Decode(ResultSchema, resolution.value),
          };
        }

        if (resolution.outcome === "failed") {
          return {
            ref: work.ref,
            outcome: resolution.outcome,
            error: Value.Decode(FailureSchema, resolution.error),
          };
        }

        return {
          ref: work.ref,
          outcome: resolution.outcome,
        };
      },
    });
    const registered = linked.register({
      events: {
        requested: async (context: Parameters<RequestedHandler>[0]) => {
          const { event, actions } = context;

          await actions.index("request", event.payload);
          await dispatchRequested(context);
        },
        settled: async ({ event, actions }: Parameters<SettledHandler>[0]) => {
          await actions.index("settle", event.payload);
        },
      },
      indexers: {
        request: async ({
          input: request,
          event,
          db,
        }: Parameters<RequestIndexer>[0]) => {
          await db
            .insertInto("invocations")
            .values({
              ref: request.ref,
              request: event.ref,
              settlement: null,
            })
            .execute();
        },
        settle: async ({
          input: settlement,
          event,
          db,
        }: Parameters<SettleIndexer>[0]) => {
          const invocation = await db
            .selectFrom("invocations")
            .select(["ref"])
            .where("ref", "=", settlement.ref)
            .executeTakeFirst();

          if (invocation === null) {
            throw new Error(
              `invocation ${settlement.ref} settled without a request`,
            );
          }

          await db
            .updateTable("invocations")
            .set({ settlement: event.ref })
            .where("ref", "=", settlement.ref)
            .whereNull("settlement")
            .execute();
        },
      },
      queries: {
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const invocation = await db
            .selectFrom("invocations")
            .select(["request", "settlement"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (invocation === null) {
            return null;
          }

          const request = await db.readEvent(invocation.request);

          if (request === null) {
            throw new Error(`invocation ${params.ref} lost its request event`);
          }

          if (invocation.settlement === null) {
            return {
              kind: "pending",
              input: request.payload.input,
            };
          }

          const settlementEvent = await db.readEvent(invocation.settlement);

          if (settlementEvent === null) {
            throw new Error(
              `invocation ${params.ref} lost its settlement event`,
            );
          }

          const settlement = settlementEvent.payload;

          if (settlement.outcome === "succeeded") {
            return {
              kind: settlement.outcome,
              input: request.payload.input,
              value: settlement.value,
            };
          }

          if (settlement.outcome === "failed") {
            return {
              kind: settlement.outcome,
              input: request.payload.input,
              error: settlement.error,
            };
          }

          return {
            kind: settlement.outcome,
            input: request.payload.input,
          };
        },
      },
      queues: { execute },
    } satisfies Registration);
    const resultPort = result
      .fromEvent(registered.events.settled, (payload) => {
        if (payload.outcome === "succeeded") {
          return {
            ref: payload.ref,
            outcome: payload.outcome,
            value: payload.value,
          };
        }

        if (payload.outcome === "failed") {
          return {
            ref: payload.ref,
            outcome: payload.outcome,
            error: payload.error,
          };
        }

        return {
          ref: payload.ref,
          outcome: payload.outcome,
        };
      })
      .readFrom(registered.queries.state, {
        observe: (state, ref) => {
          if (state === null || state.kind === "pending") {
            return null;
          }

          if (state.kind === "succeeded") {
            return {
              ref,
              outcome: state.kind,
              value: state.value,
            };
          }

          if (state.kind === "failed") {
            return {
              ref,
              outcome: state.kind,
              error: state.error,
            };
          }

          return {
            ref,
            outcome: state.kind,
          };
        },
      });

    return module.expose(registered, {
      events: { requested: registered.events.requested },
      queries: { state: registered.queries.state },
      result: resultPort,
    });
  });
}

export type InvocationCapabilities<
  TModuleId extends string,
  TInputSchema extends TSchema,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
  TEvents extends Readonly<Record<string, EventToken>> = {},
  TQueries extends Readonly<Record<string, QueryToken>> = {},
> = ReturnType<
  ReturnType<
    typeof defineInvocation<
      TModuleId,
      TInputSchema,
      TResultSchema,
      TFailureSchema,
      TEvents,
      TQueries
    >
  >
>["capabilities"];

class ActiveInvocationLedgerPort<
  TEvents extends EventToken,
  TQueries extends QueryToken,
> implements InvocationLedgerPort<TEvents, TQueries> {
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
        "invocation attempted to emit an event capability that it did not import",
      );
    }

    const committed = await this.#ledger.emit(event, payload, options);
    this.#assertOpen();
    return committed;
  }

  async query<const TQuery extends TQueries>(
    query: TQuery,
    params: QueryParameters<NoInfer<TQuery>>,
  ): Promise<QueryResult<TQuery>> {
    this.#assertOpen();

    if (!this.#queries.has(query)) {
      throw new Error(
        "invocation attempted to use a query capability that it did not import",
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
      throw new Error("invocation ledger port is no longer active");
    }
  }
}

function importInvocationEvents(
  events: Readonly<Record<string, EventToken>>,
): Readonly<Record<`invocation:event:${string}`, EventToken>> {
  // The assertion is confined to generated aliases; opaque event tokens keep
  // their original owner and payload contracts.
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
  // Query aliases only make exact imported tokens available to queue work.
  return Object.fromEntries(
    Object.entries(queries).map(([name, query]) => [
      `invocation:query:${name}`,
      query,
    ]),
  ) as Readonly<Record<`invocation:query:${string}`, QueryToken>>;
}
