import { defineModule } from "@torkbot/sledge";
import { defineMaterialization, type EventToken } from "@torkbot/sledge/ledger";
import { defineResult } from "@torkbot/sledge/stdlib";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { CompactionOutputSchema, PublishedEpochSchema } from "./epoch-model.ts";

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

type CompactionValue = Static<typeof CompactionOutputSchema>;

type CompactionPort<TSource extends ResultPortShape> =
  Static<TSource["resultSchema"]> extends CompactionValue ? TSource : never;

/**
 * Domain-owned publication boundary for one memory/compaction epoch.
 *
 * The stdlib candidates provide the typed source and causal work. This module
 * owns the application invariant that an epoch advances one parent at a time
 * and reveals memory plus compacted context as one fact.
 */
export function defineEpochPublisher<
  const TModuleId extends string,
  const TSource extends ResultPortShape,
>(input: {
  readonly moduleId: TModuleId;
  readonly source: TSource & CompactionPort<TSource>;
}) {
  return defineModule(input.moduleId, (module) => {
    const result = defineResult(module, { resultSchema: PublishedEpochSchema });
    const SourceRefSchema = Type.Unsafe<ReturnType<TSource["ref"]>>(
      input.source.refSchema,
    );
    const CandidateSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("succeeded"),
        value: CompactionOutputSchema,
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
        output: PublishedEpochSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("failed"),
        reason: Type.Union([
          Type.Literal("source_failed"),
          Type.Literal("stale_parent"),
        ]),
      }),
      Type.Object({
        ref: result.refSchema,
        sourceRef: SourceRefSchema,
        outcome: Type.Literal("cancelled"),
      }),
    ]);
    const LatestParamsSchema = Type.Object({
      conversationId: Type.String({ minLength: 1 }),
    });
    const LatestResultSchema = Type.Union([Type.Null(), PublishedEpochSchema]);
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        sourceRef: SourceRefSchema,
      }),
      Type.Object({
        kind: Type.Literal("published"),
        epoch: PublishedEpochSchema,
      }),
      Type.Object({
        kind: Type.Literal("failed"),
        reason: Type.Union([
          Type.Literal("source_failed"),
          Type.Literal("stale_parent"),
        ]),
      }),
      Type.Object({ kind: Type.Literal("cancelled") }),
    ]);
    const MetricsResultSchema = Type.Object({
      candidates: Type.Integer({ minimum: 0 }),
      terminals: Type.Integer({ minimum: 0 }),
      publishedConversations: Type.Integer({ minimum: 0 }),
    });
    const declaration = module.declare({
      events: {
        source: input.source.source.event,
        settled: SettledSchema,
      },
      queues: {
        publish: CandidateSchema,
      },
    });
    const materializations = defineMaterialization(declaration, {
      namespace: "epochs",
    })
      .version(
        1,
        "record candidates and atomically published epochs",
        (schema) =>
          schema
            .createTable("candidates", (table) =>
              table
                .columns({
                  ref: table.text().notNull(),
                  sourceRef: table.text().notNull(),
                })
                .primaryKey(["ref"]),
            )
            .createTable("terminals", (table) =>
              table
                .columns({
                  ref: table.text().notNull(),
                  source: table.eventRef("settled").notNull(),
                })
                .primaryKey(["ref"]),
            )
            .createTable("latest", (table) =>
              table
                .columns({
                  conversationId: table.text().notNull(),
                  epoch: table.integer().notNull(),
                  source: table.eventRef("settled").notNull(),
                })
                .primaryKey(["conversationId"]),
            ),
      )
      .define({
        indexers: {
          recordCandidate: {
            sourceEvent: "source",
            input: CandidateSchema,
          },
          recordTerminal: {
            sourceEvent: "settled",
            input: SettledSchema,
          },
        },
        queries: {
          latest: {
            params: LatestParamsSchema,
            result: LatestResultSchema,
          },
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
    type CandidateIndexer = IndexerRegistrations["recordCandidate"];
    type TerminalIndexer = IndexerRegistrations["recordTerminal"];
    type LatestQuery = QueryRegistrations["latest"];
    type MetricsQuery = QueryRegistrations["metrics"];
    type StateQuery = QueryRegistrations["state"];
    type PublishHandler = NonNullable<QueueRegistrations["publish"]>;
    const registration = {
      events: {
        source: async ({ event, actions }: Parameters<SourceHandler>[0]) => {
          const observation = input.source.source.observe(event.payload);
          const ref = result.ref(observation.ref);
          const sourceRef = Value.Decode(SourceRefSchema, observation.ref);
          const value =
            observation.outcome === "succeeded"
              ? Value.Decode(CompactionOutputSchema, observation.value)
              : null;
          const candidate =
            observation.outcome === "succeeded"
              ? {
                  ref,
                  sourceRef,
                  outcome: observation.outcome,
                  value: Value.Decode(
                    CompactionOutputSchema,
                    observation.value,
                  ),
                }
              : {
                  ref,
                  sourceRef,
                  outcome: observation.outcome,
                };

          await actions.index("recordCandidate", candidate);
          await actions.enqueue("publish", candidate, {
            coalescingKey: ref,
            partitionKey: value === null ? ref : value.conversationId,
          });
        },
        settled: async ({ event, actions }: Parameters<SettledHandler>[0]) => {
          await actions.index("recordTerminal", event.payload);
        },
      },
      indexers: {
        recordCandidate: async ({
          input: candidate,
          db,
        }: Parameters<CandidateIndexer>[0]) => {
          await db
            .insertInto("candidates")
            .values({ ref: candidate.ref, sourceRef: candidate.sourceRef })
            .execute();
        },
        recordTerminal: async ({
          input: terminal,
          event,
          db,
        }: Parameters<TerminalIndexer>[0]) => {
          const candidate = await db
            .selectFrom("candidates")
            .select(["ref"])
            .where("ref", "=", terminal.ref)
            .executeTakeFirst();

          if (candidate === null) {
            throw new Error(
              `epoch ${terminal.ref} settled without a candidate`,
            );
          }

          await db
            .insertInto("terminals")
            .values({ ref: terminal.ref, source: event.ref })
            .execute();

          if (terminal.outcome !== "succeeded") {
            return;
          }

          const latest = await db
            .selectFrom("latest")
            .select(["epoch"])
            .where("conversationId", "=", terminal.output.conversationId)
            .executeTakeFirst();
          const expectedParent = latest?.epoch ?? 0;

          if (terminal.output.parentEpoch !== expectedParent) {
            throw new Error(
              `epoch publication expected parent ${expectedParent}, received ${terminal.output.parentEpoch}`,
            );
          }

          await db
            .insertInto("latest")
            .values({
              conversationId: terminal.output.conversationId,
              epoch: terminal.output.epoch,
              source: event.ref,
            })
            .onConflict(["conversationId"])
            .doUpdateSet({
              epoch: terminal.output.epoch,
              source: event.ref,
            })
            .execute();
        },
      },
      queries: {
        latest: async ({ params, db }: Parameters<LatestQuery>[0]) => {
          const latest = await db
            .selectFrom("latest")
            .selectEvent("source")
            .where("conversationId", "=", params.conversationId)
            .executeTakeFirst();

          return latest?.payload.outcome === "succeeded"
            ? latest.payload.output
            : null;
        },
        metrics: async ({ db }: Parameters<MetricsQuery>[0]) => {
          const [candidates, terminals, publishedConversations] =
            await Promise.all([
              db.selectFrom("candidates").aggregate().count("count").execute(),
              db.selectFrom("terminals").aggregate().count("count").execute(),
              db.selectFrom("latest").aggregate().count("count").execute(),
            ]);

          return {
            candidates: candidates.count,
            terminals: terminals.count,
            publishedConversations: publishedConversations.count,
          };
        },
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const candidate = await db
            .selectFrom("candidates")
            .select(["sourceRef"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (candidate === null) {
            return null;
          }

          const terminal = await db
            .selectFrom("terminals")
            .selectEvent("source")
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (terminal === null) {
            return { kind: "pending", sourceRef: candidate.sourceRef };
          }

          if (terminal.payload.outcome === "succeeded") {
            return { kind: "published", epoch: terminal.payload.output };
          }

          if (terminal.payload.outcome === "failed") {
            return { kind: "failed", reason: terminal.payload.reason };
          }

          return { kind: "cancelled" };
        },
      },
      queues: {
        publish: async ({ work, actions }: Parameters<PublishHandler>[0]) => {
          if (work.payload.outcome === "cancelled") {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: work.payload.sourceRef,
                outcome: "cancelled",
              },
              { dedupeKey: `epoch:${work.payload.ref}:settled` },
            );
            return;
          }

          if (work.payload.outcome === "failed") {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: work.payload.sourceRef,
                outcome: "failed",
                reason: "source_failed",
              },
              { dedupeKey: `epoch:${work.payload.ref}:settled` },
            );
            return;
          }

          const latest = await actions.query("latest", {
            conversationId: work.payload.value.conversationId,
          });
          const currentEpoch = latest?.epoch ?? 0;

          if (work.payload.value.parentEpoch !== currentEpoch) {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                sourceRef: work.payload.sourceRef,
                outcome: "failed",
                reason: "stale_parent",
              },
              { dedupeKey: `epoch:${work.payload.ref}:settled` },
            );
            return;
          }

          actions.emit(
            "settled",
            {
              ref: work.payload.ref,
              sourceRef: work.payload.sourceRef,
              outcome: "succeeded",
              output: {
                conversationId: work.payload.value.conversationId,
                epoch: currentEpoch + 1,
                parentEpoch: work.payload.value.parentEpoch,
                cutoff: work.payload.value.cutoff,
                memoryRef: work.payload.value.memoryRef,
                compactedPrefixRef: work.payload.value.compactedPrefixRef,
              },
            },
            { dedupeKey: `epoch:${work.payload.ref}:settled` },
          );
        },
      },
    } as unknown as Registration;
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
      refFor: (sourceRef: ReturnType<TSource["ref"]>) => result.ref(sourceRef),
      queries: {
        latest: registered.queries.latest,
        metrics: registered.queries.metrics,
        state: registered.queries.state,
      },
      result: resultPort,
    });
  });
}
