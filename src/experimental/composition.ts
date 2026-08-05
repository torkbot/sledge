import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  defineMaterialization,
  type EventToken,
  type QueryToken,
} from "../ledger.ts";
import { defineModule } from "../sledge.ts";
import {
  AnyResultRefSchema,
  defineResult,
  ResultOutcomeSchema,
  Settlement,
  type ResultObservation,
  type ResultOutcome,
  type ResultPortShape,
  type ResultRef,
  type ResultSource,
} from "../stdlib.ts";

type CompositionMode = "all" | "race";

type RuntimeResultPort = {
  readonly moduleId: string;
  readonly failureSchema: TSchema;
  readonly refSchema: TSchema;
  readonly source: ResultSource;
};

type ResultRefForPort<TPort> = TPort extends {
  readonly moduleId: infer TModuleId extends string;
  readonly resultSchema: infer TResultSchema extends TSchema;
}
  ? ResultRef<Static<TResultSchema>, TModuleId>
  : never;

type CompositionMemberRef<TSources extends readonly ResultPortShape[]> =
  ResultRefForPort<TSources[number]>;

export type SettledMember<
  TRef extends ResultRef<unknown> = ResultRef<unknown>,
> = {
  readonly ref: TRef;
  readonly outcome: ResultOutcome;
};

export type AllResult<TRef extends ResultRef<unknown> = ResultRef<unknown>> = {
  readonly members: Readonly<Record<string, SettledMember<TRef>>>;
};

export type RaceResult<TRef extends ResultRef<unknown> = ResultRef<unknown>> = {
  readonly winner: string;
  readonly ref: TRef;
};

type SourceBinding = {
  readonly eventName: string;
  readonly indexerName: string;
  readonly source: ResultSource;
};

type SettledObservation = {
  readonly member: {
    readonly key: string;
    readonly ref: ResultRef<unknown>;
  };
  readonly status: {
    readonly eventId: number;
    readonly outcome: ResultOutcome;
  };
};

/**
 * Defines a durable finite join over independently owned result protocols.
 *
 * Callers name each joined ref when opening a group. The generated module owns
 * source aliases, settlement indexes, reconciliation work, restart recovery,
 * and the aggregate terminal event.
 */
export function defineAll<
  const TModuleId extends string,
  const TSources extends readonly [ResultPortShape, ...ResultPortShape[]],
>(moduleId: TModuleId, sources: TSources) {
  return defineComposition("all", moduleId, sources);
}

/**
 * Defines a durable first-settled race over independently owned results.
 *
 * The winner is the member with the lowest terminal event id, so replay and a
 * delayed reconciliation worker make the same choice.
 */
export function defineRace<
  const TModuleId extends string,
  const TSources extends readonly [ResultPortShape, ...ResultPortShape[]],
>(moduleId: TModuleId, sources: TSources) {
  return defineComposition("race", moduleId, sources);
}

function defineComposition<
  const TMode extends CompositionMode,
  const TModuleId extends string,
  const TSources extends readonly [ResultPortShape, ...ResultPortShape[]],
>(mode: TMode, moduleId: TModuleId, sources: TSources) {
  const runtimeSources = sources as readonly RuntimeResultPort[];

  if (runtimeSources.length === 0) {
    throw new Error(`${mode} requires at least one result source`);
  }

  const uniqueSourceModules = new Set(
    runtimeSources.map((port) => port.moduleId),
  );

  if (uniqueSourceModules.size !== runtimeSources.length) {
    throw new Error(`${mode} result sources must come from distinct modules`);
  }

  const uniqueTerminalEvents = new Set(
    runtimeSources.map((port) => port.source.event),
  );

  if (uniqueTerminalEvents.size !== runtimeSources.length) {
    throw new Error(`${mode} result sources must have unique terminal events`);
  }

  return defineModule(moduleId, (module) => {
    const MemberKeySchema = Type.String({ pattern: "^.+$" });
    type MemberRef = CompositionMemberRef<TSources>;
    const memberRefSchemas = runtimeSources.map((port) => port.refSchema);
    const MemberRefSchema = Type.Unsafe<MemberRef>(
      memberRefSchemas.length === 1
        ? memberRefSchemas[0]!
        : Type.Union(
            memberRefSchemas as unknown as [TSchema, TSchema, ...TSchema[]],
          ),
    );
    const SettledMemberSchema = Type.Object({
      ref: MemberRefSchema,
      outcome: ResultOutcomeSchema,
    });
    const AllResultSchema = Type.Unsafe<AllResult<MemberRef>>(
      Type.Object({
        members: Type.Record(MemberKeySchema, SettledMemberSchema, {
          additionalProperties: false,
          minProperties: 1,
        }),
      }),
    );
    const RaceResultSchema = Type.Unsafe<RaceResult<MemberRef>>(
      Type.Object({
        winner: Type.String({ minLength: 1 }),
        ref: MemberRefSchema,
      }),
    );
    type ResultValue = TMode extends "all"
      ? AllResult<MemberRef>
      : RaceResult<MemberRef>;
    const ResultSchema = Type.Unsafe<ResultValue>(
      mode === "all" ? AllResultSchema : RaceResultSchema,
    );
    const result = defineResult(module, {
      resultSchema: ResultSchema,
      failureSchema: ResultSchema,
    });
    const MembersSchema = Type.Record(MemberKeySchema, MemberRefSchema, {
      additionalProperties: false,
      minProperties: 1,
    });
    const OpenedSchema = Type.Object({
      ref: result.refSchema,
      members: MembersSchema,
    });
    const SettledSchema = result.observationSchema;
    const SettlementRecordSchema = Type.Object({
      ref: AnyResultRefSchema,
      outcome: ResultOutcomeSchema,
      eventId: Type.Integer({ minimum: 1 }),
    });
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        members: MembersSchema,
      }),
      Type.Object({
        kind: Type.Literal("settled"),
        settlement: SettledSchema,
      }),
    ]);
    const GroupsForMemberParamsSchema = Type.Object({
      memberRef: AnyResultRefSchema,
    });
    const GroupsForMemberResultSchema = Type.Array(result.refSchema);
    const SettlementStatusParamsSchema = Type.Object({
      ref: AnyResultRefSchema,
    });
    const SettlementStatusResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        eventId: Type.Integer({ minimum: 1 }),
        outcome: ResultOutcomeSchema,
      }),
    ]);
    const sourceBindings: SourceBinding[] = runtimeSources.map(
      (port, index) => ({
        eventName: `source_${index}`,
        indexerName: `recordSource_${index}`,
        source: port.source,
      }),
    );
    const sourceEventDefinitions: Record<string, ResultSource["event"]> = {};
    const sourceIndexerDefinitions: Record<
      string,
      {
        readonly sourceEvent: string;
        readonly input: typeof SettlementRecordSchema;
      }
    > = {};

    for (const binding of sourceBindings) {
      sourceEventDefinitions[binding.eventName] = binding.source.event;
      sourceIndexerDefinitions[binding.indexerName] = {
        sourceEvent: binding.eventName,
        input: SettlementRecordSchema,
      };
    }

    const declaration = module.declare({
      events: {
        opened: OpenedSchema,
        settled: SettledSchema,
        ...sourceEventDefinitions,
      },
      queues: {
        reconcile: Type.Object({ ref: result.refSchema }),
      },
    });
    const materializations = defineMaterialization(declaration, {
      namespace: mode,
    })
      .version(1, "record groups and terminal observations", (schema) =>
        schema
          .createTable("groups", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                source: table.eventRef("opened").notNull(),
                settlement: table.eventRef("settled"),
              })
              .primaryKey(["ref"]),
          )
          .createTable("members", (table) =>
            table
              .columns({
                groupRef: table.text().notNull(),
                key: table.text().notNull(),
                memberRef: table.text().notNull(),
                position: table.integer().notNull(),
              })
              .primaryKey(["groupRef", "key"]),
          )
          .createIndex("groups-by-member", "members", ["memberRef"])
          .createTable("settlements", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                eventId: table.integer().notNull(),
                outcome: table.json<ResultOutcome>().notNull(),
              })
              .primaryKey(["ref"]),
          ),
      )
      .define({
        indexers: {
          open: { sourceEvent: "opened", input: OpenedSchema },
          complete: { sourceEvent: "settled", input: SettledSchema },
          ...sourceIndexerDefinitions,
        },
        queries: {
          state: { params: StateParamsSchema, result: StateResultSchema },
          groupsForMember: {
            params: GroupsForMemberParamsSchema,
            result: GroupsForMemberResultSchema,
          },
          settlementStatus: {
            params: SettlementStatusParamsSchema,
            result: SettlementStatusResultSchema,
          },
        },
      });
    const linked = module.link(declaration, materializations);
    type Registration = Parameters<typeof linked.register>[0];
    type EventRegistrations = NonNullable<Registration["events"]>;
    type IndexerRegistrations = NonNullable<Registration["indexers"]>;
    type QueryRegistrations = Registration["queries"];
    type QueueRegistrations = NonNullable<Registration["queues"]>;
    type OpenedHandler = NonNullable<EventRegistrations["opened"]>;
    type SettledHandler = NonNullable<EventRegistrations["settled"]>;
    type OpenIndexer = IndexerRegistrations["open"];
    type CompleteIndexer = IndexerRegistrations["complete"];
    type StateQuery = QueryRegistrations["state"];
    type GroupsForMemberQuery = QueryRegistrations["groupsForMember"];
    type SettlementStatusQuery = QueryRegistrations["settlementStatus"];
    type ReconcileHandler = NonNullable<QueueRegistrations["reconcile"]>;
    type OwnSettlementContext = Parameters<
      NonNullable<EventRegistrations["settled"]>
    >[0];
    type SettlementIndexerContext = {
      readonly input: Static<typeof SettlementRecordSchema>;
      readonly db: Parameters<OpenIndexer>[0]["db"];
    };

    const recordAndWake = async (input: {
      readonly observation: ResultObservation;
      readonly eventId: number;
      readonly indexerName: string;
      readonly actions: OwnSettlementContext["actions"];
    }): Promise<void> => {
      const index = input.actions.index as unknown as (
        name: string,
        record: Static<typeof SettlementRecordSchema>,
      ) => Promise<void>;

      await index(input.indexerName, {
        ref: input.observation.ref,
        outcome: input.observation.outcome,
        eventId: input.eventId,
      });
      const groups = await input.actions.query("groupsForMember", {
        memberRef: input.observation.ref,
      });

      for (const ref of groups) {
        await input.actions.enqueue(
          "reconcile",
          { ref },
          { coalescingKey: ref, partitionKey: ref },
        );
      }
    };
    const sourceEventHandlers: Record<string, unknown> = {};

    for (const binding of sourceBindings) {
      sourceEventHandlers[binding.eventName] = async (context: unknown) => {
        // The generated alias and observation adapter originate from the same
        // source binding. Object iteration erases that correlation, so the
        // runtime callback shape is restored only inside this implementation.
        const sourceContext = context as {
          readonly event: {
            readonly payload: unknown;
            readonly eventId: number;
          };
          readonly actions: OwnSettlementContext["actions"];
        };
        const observation = binding.source.observe(sourceContext.event.payload);

        await recordAndWake({
          observation,
          eventId: sourceContext.event.eventId,
          indexerName: binding.indexerName,
          actions: sourceContext.actions,
        });
      };
    }

    const recordSettlement = async ({
      input: settlement,
      db,
    }: SettlementIndexerContext): Promise<void> => {
      await db.insertInto("settlements").values(settlement).execute();
    };
    const sourceIndexerHandlers: Record<string, unknown> = {};

    for (const binding of sourceBindings) {
      sourceIndexerHandlers[binding.indexerName] = recordSettlement;
    }

    // All computed registration keys are generated from sourceBindings above.
    // The type erasure needed for heterogeneous aliases stays behind the
    // operator boundary rather than leaking into application wiring.
    const registration = {
      events: {
        opened: async ({ event, actions }: Parameters<OpenedHandler>[0]) => {
          assertUniqueMemberRefs(event.payload.members);
          await actions.index("open", event.payload);
          await actions.enqueue(
            "reconcile",
            { ref: event.payload.ref },
            {
              coalescingKey: event.payload.ref,
              partitionKey: event.payload.ref,
            },
          );
        },
        settled: async ({ event, actions }: Parameters<SettledHandler>[0]) => {
          await actions.index("complete", event.payload);
        },
        ...sourceEventHandlers,
      },
      indexers: {
        open: async ({
          input: group,
          event,
          db,
        }: Parameters<OpenIndexer>[0]) => {
          await db
            .insertInto("groups")
            .values({ ref: group.ref, source: event.ref, settlement: null })
            .execute();

          for (const [position, [key, memberRef]] of Object.entries(
            group.members,
          ).entries()) {
            await db
              .insertInto("members")
              .values({
                groupRef: group.ref,
                key,
                memberRef,
                position,
              })
              .execute();
          }
        },
        complete: async ({
          input: completion,
          event,
          db,
        }: Parameters<CompleteIndexer>[0]) => {
          const group = await db
            .selectFrom("groups")
            .select(["ref"])
            .where("ref", "=", completion.ref)
            .executeTakeFirst();

          if (group === null) {
            throw new Error(
              `${mode} ${completion.ref} settled without opening`,
            );
          }

          await db
            .updateTable("groups")
            .set({ settlement: event.ref })
            .where("ref", "=", completion.ref)
            .whereNull("settlement")
            .execute();
        },
        ...sourceIndexerHandlers,
      },
      queries: {
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const group = await db
            .selectFrom("groups")
            .select(["settlement"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (group === null) {
            return null;
          }

          if (group.settlement !== null) {
            const settlement = await db.readEvent(group.settlement);

            if (settlement === null) {
              throw new Error(
                `${mode} ${params.ref} lost its settlement event`,
              );
            }

            return { kind: "settled", settlement: settlement.payload };
          }

          const members = await db
            .selectFrom("members")
            .select(["key", "memberRef", "position"])
            .where("groupRef", "=", params.ref)
            .orderBy("position", "asc")
            .execute();

          return {
            kind: "pending",
            members: Object.fromEntries(
              members.map((member) => [
                member.key,
                Value.Decode(MemberRefSchema, member.memberRef),
              ]),
            ),
          };
        },
        groupsForMember: async ({
          params,
          db,
        }: Parameters<GroupsForMemberQuery>[0]) => {
          const rows = await db
            .selectFrom("members")
            .select(["groupRef"])
            .where("memberRef", "=", params.memberRef)
            .execute();

          return rows.map((row) =>
            Value.Decode(result.refSchema, row.groupRef),
          );
        },
        settlementStatus: async ({
          params,
          db,
        }: Parameters<SettlementStatusQuery>[0]) => {
          return await db
            .selectFrom("settlements")
            .select(["eventId", "outcome"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();
        },
      },
      queues: {
        reconcile: async ({
          work,
          actions,
        }: Parameters<ReconcileHandler>[0]) => {
          const state = await actions.query("state", { ref: work.payload.ref });

          if (state === null) {
            throw new Error(
              `${mode} ${work.payload.ref} reconciled before opening`,
            );
          }

          if (state.kind === "settled") {
            return;
          }

          const observations = await Promise.all(
            Object.entries(state.members).map(async ([key, ref]) => ({
              member: { key, ref },
              status: await actions.query("settlementStatus", { ref }),
            })),
          );
          const settled = observations.filter(
            (
              observation,
            ): observation is typeof observation & {
              readonly status: NonNullable<typeof observation.status>;
            } => observation.status !== null,
          );

          if (mode === "all" && settled.length !== observations.length) {
            return;
          }

          if (mode === "race" && settled.length === 0) {
            return;
          }

          const candidate =
            mode === "all" ? settleAll(settled) : settleRace(settled);
          const settlement: Settlement<ResultValue, ResultValue> =
            candidate.outcome === "succeeded"
              ? Settlement.succeeded(
                  Value.Decode(ResultSchema, candidate.value),
                )
              : candidate.outcome === "failed"
                ? Settlement.failed(Value.Decode(ResultSchema, candidate.error))
                : Settlement.cancelled();

          actions.emit(
            "settled",
            observeSettlement(work.payload.ref, settlement),
            { dedupeKey: `composition:${work.payload.ref}:settled` },
          );
        },
      },
    } satisfies Registration;
    const registered = linked.register(registration);
    const resultPort = result
      .fromEvent(registered.events.settled, (payload) => payload)
      .readFrom(registered.queries.state, {
        observe: (state, ref) => {
          if (state === null || state.kind === "pending") {
            return null;
          }

          return state.settlement;
        },
      });

    return module.expose(registered, {
      events: { opened: registered.events.opened },
      queries: { state: registered.queries.state },
      result: resultPort,
    });
  });
}

function assertUniqueMemberRefs(
  members: Readonly<Record<string, ResultRef<unknown>>>,
): void {
  const refs = new Set<string>();

  for (const ref of Object.values(members)) {
    if (refs.has(ref)) {
      throw new Error(`composition member ref ${ref} is duplicated`);
    }

    refs.add(ref);
  }
}

function settleAll(
  settled: readonly SettledObservation[],
): Settlement<AllResult, AllResult> {
  const outcomes = settled.map(({ status }) => status.outcome);
  const result = {
    members: Object.fromEntries(
      settled.map(({ member, status }) => [
        member.key,
        { ref: member.ref, outcome: status.outcome },
      ]),
    ),
  };

  if (outcomes.includes("failed")) {
    return Settlement.failed(result);
  }

  if (outcomes.includes("cancelled")) {
    return Settlement.cancelled();
  }

  return Settlement.succeeded(result);
}

function settleRace(
  settled: readonly SettledObservation[],
): Settlement<RaceResult, RaceResult> {
  const winner = settled.toSorted(
    (left, right) => left.status.eventId - right.status.eventId,
  )[0];

  if (winner === undefined) {
    throw new Error("race result requires one terminal observation");
  }

  const result = {
    winner: winner.member.key,
    ref: winner.member.ref,
  };

  if (winner.status.outcome === "succeeded") {
    return Settlement.succeeded(result);
  }

  if (winner.status.outcome === "failed") {
    return Settlement.failed(result);
  }

  return Settlement.cancelled();
}

function observeSettlement<TResult, TFailure, TModuleId extends string>(
  ref: ResultRef<TResult, TModuleId>,
  settlement: Settlement<TResult, TFailure>,
): ResultObservation<TResult, TModuleId, TFailure> {
  if (settlement.outcome === "succeeded") {
    return { ref, outcome: settlement.outcome, value: settlement.value };
  }

  if (settlement.outcome === "failed") {
    return { ref, outcome: settlement.outcome, error: settlement.error };
  }

  return { ref, outcome: settlement.outcome };
}
