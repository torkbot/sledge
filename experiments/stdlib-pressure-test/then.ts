import { defineModule } from "@torkbot/sledge";
import { defineMaterialization, type EventToken } from "@torkbot/sledge/ledger";
import {
  defineResult,
  ResultOutcomeSchema,
  type ResultRef,
} from "@torkbot/sledge/stdlib";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { PrototypeLogger } from "./invocation.ts";

type RuntimeResultObservation =
  | {
      readonly ref: string;
      readonly outcome: "succeeded";
      readonly value: unknown;
    }
  | { readonly ref: string; readonly outcome: "failed" | "cancelled" };

type ResultPortShape = {
  readonly moduleId: string;
  readonly resultSchema: TSchema;
  readonly refSchema: TSchema;
  ref(key: string): string;
  readonly source: {
    readonly event: EventToken<string, string, TSchema, null>;
    observe(payload: unknown): RuntimeResultObservation;
  };
};

type SourceValue<TSource extends ResultPortShape> = Static<
  TSource["resultSchema"]
>;

type SourceRef<TSource extends ResultPortShape> = ReturnType<TSource["ref"]>;

export type ThenExecution<
  TSource extends ResultPortShape,
  TOutputModuleId extends string,
  TOutputSchema extends TSchema,
> = (input: {
  readonly sourceRef: SourceRef<TSource>;
  readonly ref: ResultRef<Static<TOutputSchema>, TOutputModuleId>;
  readonly value: SourceValue<TSource>;
  readonly signal: AbortSignal;
}) => Promise<Static<TOutputSchema>>;

/**
 * Pressure-test implementation of one durable operation causally derived from
 * a typed result. The source terminal fact is the request, so a successful
 * derived operation contributes only its own terminal fact.
 */
export function defineThen<
  const TModuleId extends string,
  const TSource extends ResultPortShape,
  TOutputSchema extends TSchema,
>(input: {
  readonly moduleId: TModuleId;
  readonly source: TSource;
  readonly outputSchema: TOutputSchema;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly execute: ThenExecution<TSource, TModuleId, TOutputSchema>;
  readonly logger: PrototypeLogger;
}) {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("then maxAttempts must be a positive integer");
  }

  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("then timeoutMs must be a positive integer");
  }

  return defineModule(input.moduleId, (module) => {
    type SourceResult = SourceValue<TSource>;
    type OutputValue = Static<TOutputSchema>;
    const SourceValueSchema = Type.Unsafe<SourceResult>(
      input.source.resultSchema,
    );
    const SourceRefSchema = Type.Unsafe<SourceRef<TSource>>(
      input.source.refSchema,
    );
    const OutputValueSchema = Type.Unsafe<OutputValue>(input.outputSchema);
    const result = defineResult(module, {
      resultSchema: input.outputSchema,
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
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]);
    const FailureSchema = Type.Object({
      message: Type.String({ minLength: 1 }),
    });
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
        error: FailureSchema,
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
        sourceOutcome: ResultOutcomeSchema,
      }),
      Type.Object({
        kind: Type.Literal("succeeded"),
        sourceRef: SourceRefSchema,
        output: OutputValueSchema,
      }),
      Type.Object({
        kind: Type.Literal("failed"),
        sourceRef: SourceRefSchema,
        error: FailureSchema,
      }),
      Type.Object({
        kind: Type.Literal("cancelled"),
        sourceRef: SourceRefSchema,
      }),
    ]);
    const MetricsResultSchema = Type.Object({
      sources: Type.Integer({ minimum: 0 }),
      settlements: Type.Integer({ minimum: 0 }),
    });
    const declaration = module.declare({
      events: {
        source: input.source.source.event,
        settled: SettledSchema,
      },
      queues: {
        execute: SourceObservationSchema,
      },
    });
    const materializations = defineMaterialization(declaration, {
      namespace: "then",
    })
      .version(
        1,
        "record source observations and derived settlements",
        (schema) =>
          schema
            .createTable("sources", (table) =>
              table
                .columns({
                  ref: table.text().notNull(),
                  sourceRef: table.text().notNull(),
                  outcome: table
                    .json<"succeeded" | "failed" | "cancelled">()
                    .notNull(),
                })
                .primaryKey(["ref"]),
            )
            .createTable("settlements", (table) =>
              table
                .columns({
                  ref: table.text().notNull(),
                  source: table.eventRef("settled").notNull(),
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
          metrics: {
            params: Type.Object({}),
            result: MetricsResultSchema,
          },
          state: {
            params: StateParamsSchema,
            result: StateResultSchema,
          },
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
    type MetricsQuery = QueryRegistrations["metrics"];
    type StateQuery = QueryRegistrations["state"];
    type ExecuteHandler = NonNullable<QueueRegistrations["execute"]>;
    const registration = {
      events: {
        source: async ({ event, actions }: Parameters<SourceHandler>[0]) => {
          const observation = input.source.source.observe(event.payload);
          const ref = result.ref(observation.ref);
          const sourceRef = Value.Decode(SourceRefSchema, observation.ref);
          const record =
            observation.outcome === "succeeded"
              ? {
                  ref,
                  sourceRef,
                  outcome: observation.outcome,
                  value: Value.Decode(SourceValueSchema, observation.value),
                }
              : {
                  ref,
                  sourceRef,
                  outcome: observation.outcome,
                };

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
          input: source,
          db,
        }: Parameters<SourceIndexer>[0]) => {
          await db
            .insertInto("sources")
            .values({
              ref: source.ref,
              sourceRef: source.sourceRef,
              outcome: source.outcome,
            })
            .execute();
        },
        recordSettlement: async ({
          input: settlement,
          event,
          db,
        }: Parameters<SettlementIndexer>[0]) => {
          const source = await db
            .selectFrom("sources")
            .select(["ref"])
            .where("ref", "=", settlement.ref)
            .executeTakeFirst();

          if (source === null) {
            throw new Error(
              `derived result ${settlement.ref} settled without a source`,
            );
          }

          await db
            .insertInto("settlements")
            .values({ ref: settlement.ref, source: event.ref })
            .execute();
        },
      },
      queries: {
        metrics: async ({ db }: Parameters<MetricsQuery>[0]) => {
          const [sources, settlements] = await Promise.all([
            db.selectFrom("sources").aggregate().count("count").execute(),
            db.selectFrom("settlements").aggregate().count("count").execute(),
          ]);

          return {
            sources: sources.count,
            settlements: settlements.count,
          };
        },
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const source = await db
            .selectFrom("sources")
            .select(["sourceRef", "outcome"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (source === null) {
            return null;
          }

          const settlement = await db
            .selectFrom("settlements")
            .selectEvent("source")
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (settlement === null) {
            return {
              kind: "pending",
              sourceRef: source.sourceRef,
              sourceOutcome: source.outcome,
            };
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
              kind: "failed",
              sourceRef: settlement.payload.sourceRef,
              error: settlement.payload.error,
            };
          }

          return {
            kind: "cancelled",
            sourceRef: settlement.payload.sourceRef,
          };
        },
      },
      queues: {
        execute: async ({
          work,
          lease,
          actions,
          control,
        }: Parameters<ExecuteHandler>[0]) => {
          if (work.payload.outcome === "cancelled") {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: work.payload.sourceRef,
                outcome: work.payload.outcome,
              },
              { dedupeKey: `then:${work.payload.ref}:settled` },
            );
            return;
          }

          if (work.payload.outcome === "failed") {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: work.payload.sourceRef,
                outcome: work.payload.outcome,
                error: { message: "source result failed" },
              },
              { dedupeKey: `then:${work.payload.ref}:settled` },
            );
            return;
          }

          const source = work.payload;

          if (source.outcome !== "succeeded") {
            throw new Error("derived operation received an invalid outcome");
          }

          input.logger.info(
            `attempt ${work.attempt}/${input.maxAttempts} for ${source.ref}`,
          );

          try {
            const output = await control.withTimeout(
              input.timeoutMs,
              async (signal) =>
                await input.execute({
                  sourceRef: source.sourceRef,
                  ref: source.ref,
                  value: source.value,
                  signal,
                }),
            );

            lease.signal.throwIfAborted();
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: source.sourceRef,
                outcome: "succeeded",
                output,
              },
              { dedupeKey: `then:${source.ref}:settled` },
            );
          } catch (error: unknown) {
            lease.signal.throwIfAborted();

            if (work.attempt < input.maxAttempts) {
              control.retry(error);
            }

            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: source.sourceRef,
                outcome: "failed",
                error: { message: errorMessage(error) },
              },
              { dedupeKey: `then:${source.ref}:settled` },
            );
          }
        },
      },
    } as unknown as Registration;

    // The source event token and its observation adapter remain correlated by
    // the ResultPort. TypeScript loses that conditional alias relationship at
    // the generic registration boundary, so the erasure stays private here.
    const registered = linked.register(registration);
    const resultPort = result.fromEvent(registered.events.settled, (payload) =>
      payload.outcome === "succeeded"
        ? {
            ref: payload.ref,
            outcome: payload.outcome,
            value: payload.output,
          }
        : {
            ref: payload.ref,
            outcome: payload.outcome,
          },
    );

    return module.expose(registered, {
      refFor: (sourceRef: SourceRef<TSource>) => result.ref(sourceRef),
      queries: {
        metrics: registered.queries.metrics,
        state: registered.queries.state,
      },
      result: resultPort,
    });
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "derived operation failed with a non-Error value";
}
