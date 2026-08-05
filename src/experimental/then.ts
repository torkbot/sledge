import { IsNever, Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  defineMaterialization,
  type EmitOptions,
  type EventPayload,
  type EventToken,
  type LedgerEventCommit,
  type QueryToken,
  type QueueLedger,
} from "../ledger.ts";
import { defineModule } from "../sledge.ts";
import {
  defineResult,
  type ResultObservation,
  type ResultRef,
} from "../stdlib.ts";

type ResultPortShape = {
  readonly moduleId: string;
  readonly resultSchema: TSchema;
  readonly failureSchema: TSchema;
  readonly refSchema: TSchema;
  ref(key: string): string;
  readonly source: {
    readonly event: EventToken<string, string, TSchema, null>;
    observe(payload: unknown): ResultObservation;
  };
  readonly reader: {
    readonly query: QueryToken<string, string, TSchema, TSchema>;
    params(ref: string): unknown;
    observe(result: unknown, ref: string): ResultObservation | null;
  };
};

type RuntimeResultPort = ResultPortShape;

const composedFailureMembers = new WeakMap<object, readonly TSchema[]>();

type SourceValue<TSource extends ResultPortShape> = Static<
  TSource["resultSchema"]
>;

type SourceFailure<TSource extends ResultPortShape> = Static<
  TSource["failureSchema"]
>;

type SourceRef<TSource extends ResultPortShape> = ReturnType<TSource["ref"]>;

type ResultObservationForPort<TPort extends ResultPortShape> =
  ResultObservation<
    Static<TPort["resultSchema"]>,
    TPort["moduleId"],
    Static<TPort["failureSchema"]>
  >;

export interface ThenLedgerPort<
  TReads extends readonly ResultPortShape[] = readonly [],
  TEvents extends EventToken = never,
  TQueries extends QueryToken = never,
> {
  read<const TPort extends TReads[number]>(
    result: TPort,
    ref: ReturnType<TPort["ref"]>,
  ): Promise<ResultObservationForPort<TPort> | null>;

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

export type ThenResolution<TResult, TFailure> =
  | { readonly outcome: "succeeded"; readonly value: TResult }
  | { readonly outcome: "failed"; readonly error: TFailure }
  | { readonly outcome: "cancelled" };

export type ThenExecution<
  TSource extends ResultPortShape,
  TOutputModuleId extends string,
  TOutputSchema extends TSchema,
  TFailureSchema extends TSchema,
  TReads extends readonly ResultPortShape[] = readonly [],
  TEvents extends Readonly<Record<string, EventToken>> = {},
  TQueries extends Readonly<Record<string, QueryToken>> = {},
> = (input: {
  readonly sourceRef: SourceRef<TSource>;
  readonly ref: ResultRef<Static<TOutputSchema>, TOutputModuleId>;
  readonly value: SourceValue<TSource>;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly ledger: ThenLedgerPort<
    TReads,
    TEvents[keyof TEvents],
    TQueries[keyof TQueries]
  >;
  readonly withTimeout: <TResult>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<TResult>,
  ) => Promise<TResult>;
}) => Promise<ThenResolution<Static<TOutputSchema>, Static<TFailureSchema>>>;

/**
 * Defines one durable result derived causally from another typed result.
 *
 * A successful source invokes execute. Returning a resolution settles the
 * derived result; throwing requests the queue's normal durable retry. Source
 * failure and cancellation propagate without invoking application code.
 */
export function defineThen<
  const TModuleId extends string,
  const TSource extends ResultPortShape,
  const TOutputSchema extends TSchema,
  const TFailureSchema extends TSchema,
  const TReads extends readonly ResultPortShape[] = readonly [],
  const TEvents extends Readonly<Record<string, EventToken>> = {},
  const TQueries extends Readonly<Record<string, QueryToken>> = {},
>(
  moduleId: TModuleId,
  source: TSource,
  input: {
    readonly resultSchema: TOutputSchema;
    readonly failureSchema: TFailureSchema;
    readonly reads?: TReads;
    readonly access?: {
      readonly events: TEvents;
      readonly queries: TQueries;
    };
    readonly execute: ThenExecution<
      TSource,
      TModuleId,
      TOutputSchema,
      TFailureSchema,
      TReads,
      TEvents,
      TQueries
    >;
  },
) {
  return defineModule(moduleId, (module) => {
    type SourceResult = SourceValue<TSource>;
    type SourceError = SourceFailure<TSource>;
    type OutputValue = Static<TOutputSchema>;
    type LocalFailure = Static<TFailureSchema>;
    type OutputFailure = SourceError | LocalFailure;
    const SourceValueSchema = Type.Unsafe<SourceResult>(source.resultSchema);
    const SourceFailureSchema = Type.Unsafe<SourceError>(source.failureSchema);
    const SourceRefSchema = Type.Unsafe<SourceRef<TSource>>(source.refSchema);
    const OutputValueSchema = Type.Unsafe<OutputValue>(input.resultSchema);
    const LocalFailureSchema = Type.Unsafe<LocalFailure>(input.failureSchema);
    const ComposedFailureSchema = composeFailureSchema(
      source.failureSchema,
      input.failureSchema,
    );
    const OutputFailureSchema = Type.Unsafe<OutputFailure>(
      ComposedFailureSchema,
    );

    composedFailureMembers.set(
      OutputFailureSchema,
      failureMembers(ComposedFailureSchema),
    );
    const result = defineResult(module, {
      resultSchema: input.resultSchema,
      failureSchema: OutputFailureSchema,
    });
    const SourceObservationSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("succeeded"),
        value: SourceValueSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("failed"),
        error: SourceFailureSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]);
    const SettledSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("succeeded"),
        output: OutputValueSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("failed"),
        error: OutputFailureSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]);
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        sourceRef: SourceRefSchema,
      }),
      Type.Object({
        kind: Type.Literal("succeeded"),
        sourceRef: SourceRefSchema,
        output: OutputValueSchema,
      }),
      Type.Object({
        kind: Type.Literal("failed"),
        sourceRef: SourceRefSchema,
        error: OutputFailureSchema,
      }),
      Type.Object({
        kind: Type.Literal("cancelled"),
        sourceRef: SourceRefSchema,
      }),
    ]);
    const readableResults = input.reads ?? [];
    const readableResultSet = new Set<RuntimeResultPort>(readableResults);
    const importedEvents = importThenEvents(input.access?.events ?? {});
    const importedQueries = importThenQueries(input.access?.queries ?? {});
    const allowedEvents = new Set<EventToken>(
      Object.values(input.access?.events ?? {}),
    );
    const allowedQueries = new Set<QueryToken>(
      Object.values(input.access?.queries ?? {}),
    );
    const readableResultQueries: Record<
      string,
      QueryToken<string, string, TSchema, TSchema>
    > = {};

    for (const [index, readable] of readableResults.entries()) {
      readableResultQueries[`read_${index}`] = readable.reader.query;
    }

    const declaration = module.declare({
      events: {
        source: source.source.event,
        settled: SettledSchema,
        ...importedEvents,
      },
      queries: { ...readableResultQueries, ...importedQueries },
      queues: { execute: SourceObservationSchema },
    });
    const materializations = defineMaterialization(declaration, {
      namespace: "then",
    })
      .version(1, "record derived results", (schema) =>
        schema.createTable("derivations", (table) =>
          table
            .columns({
              ref: table.text().notNull(),
              source: table.eventRef("source").notNull(),
              sourceRef: table.text().notNull(),
              settlement: table.eventRef("settled"),
            })
            .primaryKey(["ref"]),
        ),
      )
      .define({
        indexers: {
          recordSource: {
            sourceEvent: "source",
            input: SourceObservationSchema,
          },
          recordSettlement: {
            sourceEvent: "settled",
            input: SettledSchema,
          },
        },
        queries: {
          state: { params: StateParamsSchema, result: StateResultSchema },
        },
      });
    const linked = module.link(declaration, materializations);
    type Registration = Parameters<typeof linked.register>[0];
    type EventRegistrations = NonNullable<Registration["events"]>;
    type IndexerRegistrations = NonNullable<Registration["indexers"]>;
    type QueryRegistrations = Registration["queries"];
    type QueueRegistrations = NonNullable<Registration["queues"]>;
    type SourceHandler = NonNullable<EventRegistrations["source"]>;
    type SettledHandler = NonNullable<EventRegistrations["settled"]>;
    type SourceIndexer = IndexerRegistrations["recordSource"];
    type SettlementIndexer = IndexerRegistrations["recordSettlement"];
    type StateQuery = QueryRegistrations["state"];
    type ExecuteHandler = NonNullable<QueueRegistrations["execute"]>;
    const registration = {
      events: {
        source: async ({ event, actions }: Parameters<SourceHandler>[0]) => {
          const observation = source.source.observe(event.payload);
          const ref = result.ref(observation.ref);
          const sourceRef = Value.Decode(SourceRefSchema, observation.ref);
          let record: Static<typeof SourceObservationSchema>;

          if (observation.outcome === "succeeded") {
            record = {
              ref,
              sourceRef,
              outcome: observation.outcome,
              value: Value.Decode(SourceValueSchema, observation.value),
            };
          } else if (observation.outcome === "failed") {
            record = {
              ref,
              sourceRef,
              outcome: observation.outcome,
              error: Value.Decode(SourceFailureSchema, observation.error),
            };
          } else {
            record = { ref, sourceRef, outcome: observation.outcome };
          }

          await actions.index("recordSource", record);
          await actions.enqueue("execute", record, {
            coalescingKey: ref,
            partitionKey: ref,
          });
        },
        settled: async ({ event, actions }: Parameters<SettledHandler>[0]) => {
          await actions.index("recordSettlement", event.payload);
        },
      },
      indexers: {
        recordSource: async ({
          input: sourceObservation,
          event,
          db,
        }: Parameters<SourceIndexer>[0]) => {
          await db
            .insertInto("derivations")
            .values({
              ref: sourceObservation.ref,
              source: event.ref,
              sourceRef: sourceObservation.sourceRef,
              settlement: null,
            })
            .execute();
        },
        recordSettlement: async ({
          input: settlement,
          event,
          db,
        }: Parameters<SettlementIndexer>[0]) => {
          const derivation = await db
            .selectFrom("derivations")
            .select(["ref"])
            .where("ref", "=", settlement.ref)
            .executeTakeFirst();

          if (derivation === null) {
            throw new Error(
              `derived result ${settlement.ref} settled without a source`,
            );
          }

          await db
            .updateTable("derivations")
            .set({ settlement: event.ref })
            .where("ref", "=", settlement.ref)
            .whereNull("settlement")
            .execute();
        },
      },
      queries: {
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const derivation = await db
            .selectFrom("derivations")
            .select(["sourceRef", "settlement"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (derivation === null) {
            return null;
          }

          if (derivation.settlement === null) {
            return {
              kind: "pending",
              sourceRef: Value.Decode(SourceRefSchema, derivation.sourceRef),
            };
          }

          const settlement = await db.readEvent(derivation.settlement);

          if (settlement === null) {
            throw new Error(
              `derived result ${params.ref} lost its settlement event`,
            );
          }

          if (settlement.payload.outcome === "succeeded") {
            return {
              kind: "succeeded",
              sourceRef: settlement.payload.sourceRef,
              output: settlement.payload.output,
            };
          }

          if (settlement.payload.outcome === "failed") {
            return {
              kind: settlement.payload.outcome,
              sourceRef: settlement.payload.sourceRef,
              error: settlement.payload.error,
            };
          }

          return {
            kind: settlement.payload.outcome,
            sourceRef: settlement.payload.sourceRef,
          };
        },
      },
      queues: {
        execute: async ({
          work,
          lease,
          actions,
          ledger,
          control,
        }: Parameters<ExecuteHandler>[0]) => {
          if (work.payload.outcome !== "succeeded") {
            const settlement =
              work.payload.outcome === "failed"
                ? {
                    ref: work.payload.ref,
                    sourceRef: work.payload.sourceRef,
                    outcome: work.payload.outcome,
                    error: work.payload.error,
                  }
                : {
                    ref: work.payload.ref,
                    sourceRef: work.payload.sourceRef,
                    outcome: work.payload.outcome,
                  };

            actions.emit("settled", settlement, {
              dedupeKey: `then:${work.payload.ref}:settled`,
            });
            return;
          }

          const executionLedger = new ActiveThenLedgerPort<
            TReads,
            TEvents[keyof TEvents],
            TQueries[keyof TQueries]
          >(
            ledger as QueueLedger<EventToken, QueryToken>,
            readableResultSet,
            allowedEvents,
            allowedQueries,
          );
          let resolution: ThenResolution<OutputValue, LocalFailure>;

          try {
            resolution = await input.execute({
              sourceRef: work.payload.sourceRef,
              ref: work.payload.ref,
              value: work.payload.value,
              attempt: work.attempt,
              signal: lease.signal,
              ledger: executionLedger,
              withTimeout: async (timeoutMs, operation) =>
                await control.withTimeout(timeoutMs, operation),
            });
          } finally {
            executionLedger.close();
          }

          lease.signal.throwIfAborted();

          if (resolution.outcome === "succeeded") {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: work.payload.sourceRef,
                outcome: resolution.outcome,
                output: Value.Decode(OutputValueSchema, resolution.value),
              },
              { dedupeKey: `then:${work.payload.ref}:settled` },
            );
            return;
          }

          actions.emit(
            "settled",
            resolution.outcome === "failed"
              ? {
                  ref: work.payload.ref,
                  sourceRef: work.payload.sourceRef,
                  outcome: resolution.outcome,
                  error: Value.Decode(
                    OutputFailureSchema,
                    Value.Decode(LocalFailureSchema, resolution.error),
                  ),
                }
              : {
                  ref: work.payload.ref,
                  sourceRef: work.payload.sourceRef,
                  outcome: resolution.outcome,
                },
            { dedupeKey: `then:${work.payload.ref}:settled` },
          );
        },
      },
    } satisfies Registration;
    const registered = linked.register(registration);
    const resultPort = result
      .fromEvent(registered.events.settled, (payload) => {
        if (payload.outcome === "succeeded") {
          return {
            ref: payload.ref,
            outcome: payload.outcome,
            value: payload.output,
          };
        }

        if (payload.outcome === "failed") {
          return {
            ref: payload.ref,
            outcome: payload.outcome,
            error: payload.error,
          };
        }

        return { ref: payload.ref, outcome: payload.outcome };
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
              value: state.output,
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
      refFor: (sourceRef: SourceRef<TSource>) => result.ref(sourceRef),
      queries: { state: registered.queries.state },
      result: resultPort,
    });
  });
}

function composeFailureSchema(source: TSchema, local: TSchema): TSchema {
  const members = [...failureMembers(source), ...failureMembers(local)].filter(
    (member, index, all) => all.indexOf(member) === index,
  );
  const schema =
    members.length === 0
      ? Type.Never()
      : members.length === 1
        ? members[0]!
        : Type.Union(members);

  // Only unions created by this operator are flattened later. Caller-owned
  // unions stay intact so their options, references, and codec boundaries are
  // not rewritten. The weak metadata follows runtime schema identity without
  // becoming part of the public result contract.
  composedFailureMembers.set(schema, members);
  return schema;
}

function failureMembers(schema: TSchema): readonly TSchema[] {
  if (IsNever(schema)) {
    return [];
  }

  return composedFailureMembers.get(schema) ?? [schema];
}

class ActiveThenLedgerPort<
  TReads extends readonly ResultPortShape[],
  TEvents extends EventToken,
  TQueries extends QueryToken,
> implements ThenLedgerPort<TReads, TEvents, TQueries> {
  readonly #ledger: QueueLedger<EventToken, QueryToken>;
  readonly #readableResults: ReadonlySet<RuntimeResultPort>;
  readonly #events: ReadonlySet<EventToken>;
  readonly #queries: ReadonlySet<QueryToken>;
  #open = true;

  constructor(
    ledger: QueueLedger<EventToken, QueryToken>,
    readableResults: ReadonlySet<RuntimeResultPort>,
    events: ReadonlySet<EventToken>,
    queries: ReadonlySet<QueryToken>,
  ) {
    this.#ledger = ledger;
    this.#readableResults = readableResults;
    this.#events = events;
    this.#queries = queries;
  }

  async read<const TPort extends TReads[number]>(
    result: TPort,
    ref: ReturnType<TPort["ref"]>,
  ): Promise<ResultObservationForPort<TPort> | null> {
    this.#assertOpen();

    if (!this.#readableResults.has(result)) {
      throw new Error("then attempted to read an unadmitted result");
    }

    // Heterogeneous result/query correlations are checked when each exact
    // reader is imported. The broad runtime view stays inside this operator.
    const readable = result as RuntimeResultPort;
    const state = await this.#ledger.query(
      readable.reader.query,
      readable.reader.params(ref),
    );
    this.#assertOpen();

    return readable.reader.observe(
      state,
      ref,
    ) as ResultObservationForPort<TPort> | null;
  }

  async emit<const TEvent extends TEvents>(
    event: TEvent,
    payload: EventPayload<TEvent>,
    options?: EmitOptions,
  ): Promise<LedgerEventCommit<TEvent>> {
    this.#assertOpen();

    if (!this.#events.has(event)) {
      throw new Error(
        "then attempted to emit an event capability that it did not import",
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
        "then attempted to use a query capability that it did not import",
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
      throw new Error("then ledger port is no longer active");
    }
  }
}

function importThenEvents(
  events: Readonly<Record<string, EventToken>>,
): Readonly<Record<`then:event:${string}`, EventToken>> {
  return Object.fromEntries(
    Object.entries(events).map(([name, event]) => [
      `then:event:${name}`,
      event,
    ]),
  ) as Readonly<Record<`then:event:${string}`, EventToken>>;
}

function importThenQueries(
  queries: Readonly<Record<string, QueryToken>>,
): Readonly<Record<`then:query:${string}`, QueryToken>> {
  return Object.fromEntries(
    Object.entries(queries).map(([name, query]) => [
      `then:query:${name}`,
      query,
    ]),
  ) as Readonly<Record<`then:query:${string}`, QueryToken>>;
}
