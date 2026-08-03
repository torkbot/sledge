import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { defineMaterialization, type EventToken } from "../ledger.ts";
import { defineModule } from "../sledge.ts";
import {
  defineResult,
  type ResultObservation,
  type ResultRef,
} from "../stdlib.ts";

type ResultPortShape = {
  readonly moduleId: string;
  readonly resultSchema: TSchema;
  readonly refSchema: TSchema;
  ref(key: string): string;
  readonly source: {
    readonly event: EventToken<string, string, TSchema, null>;
    observe(payload: unknown): ResultObservation;
  };
};

type SourceValue<TSource extends ResultPortShape> = Static<
  TSource["resultSchema"]
>;

type SourceRef<TSource extends ResultPortShape> = ReturnType<TSource["ref"]>;

export type ThenResolution<TResult> =
  | { readonly outcome: "succeeded"; readonly value: TResult }
  | { readonly outcome: "failed" | "cancelled" };

export type ThenExecution<
  TSource extends ResultPortShape,
  TOutputModuleId extends string,
  TOutputSchema extends TSchema,
> = (input: {
  readonly sourceRef: SourceRef<TSource>;
  readonly ref: ResultRef<Static<TOutputSchema>, TOutputModuleId>;
  readonly value: SourceValue<TSource>;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly withTimeout: <TResult>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<TResult>,
  ) => Promise<TResult>;
}) => Promise<ThenResolution<Static<TOutputSchema>>>;

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
>(
  moduleId: TModuleId,
  source: TSource,
  input: {
    readonly resultSchema: TOutputSchema;
    readonly execute: ThenExecution<TSource, TModuleId, TOutputSchema>;
  },
) {
  return defineModule(moduleId, (module) => {
    type SourceResult = SourceValue<TSource>;
    type OutputValue = Static<TOutputSchema>;
    const SourceValueSchema = Type.Unsafe<SourceResult>(source.resultSchema);
    const SourceRefSchema = Type.Unsafe<SourceRef<TSource>>(source.refSchema);
    const OutputValueSchema = Type.Unsafe<OutputValue>(input.resultSchema);
    const result = defineResult(module, { resultSchema: input.resultSchema });
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
      }),
      Type.Object({
        kind: Type.Literal("cancelled"),
        sourceRef: SourceRefSchema,
      }),
    ]);
    const declaration = module.declare({
      events: {
        source: source.source.event,
        settled: SettledSchema,
      },
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
          const record =
            observation.outcome === "succeeded"
              ? {
                  ref,
                  sourceRef,
                  outcome: observation.outcome,
                  value: Value.Decode(SourceValueSchema, observation.value),
                }
              : { ref, sourceRef, outcome: observation.outcome };

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
          control,
        }: Parameters<ExecuteHandler>[0]) => {
          if (work.payload.outcome !== "succeeded") {
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

          const resolution = await input.execute({
            sourceRef: work.payload.sourceRef,
            ref: work.payload.ref,
            value: work.payload.value,
            attempt: work.attempt,
            signal: lease.signal,
            withTimeout: async (timeoutMs, operation) =>
              await control.withTimeout(timeoutMs, operation),
          });

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
            {
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
    const resultPort = result.fromEvent(registered.events.settled, (payload) =>
      payload.outcome === "succeeded"
        ? {
            ref: payload.ref,
            outcome: payload.outcome,
            value: payload.output,
          }
        : { ref: payload.ref, outcome: payload.outcome },
    );

    return module.expose(registered, {
      refFor: (sourceRef: SourceRef<TSource>) => result.ref(sourceRef),
      queries: { state: registered.queries.state },
      result: resultPort,
    });
  });
}
