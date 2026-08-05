import { defineModule } from "@torkbot/sledge";
import { defineMaterialization, type EventToken } from "@torkbot/sledge/ledger";
import {
  AnyResultRefSchema,
  defineResult,
  ResultOutcomeSchema,
  type ResultObservation,
  type ResultOutcome,
  type ResultRef,
  type ResultSource,
} from "@torkbot/sledge/stdlib";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const CompositionModeSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("race"),
]);

const SettledMemberSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  ref: AnyResultRefSchema,
  outcome: ResultOutcomeSchema,
});

export const CompositionResultSchema = Type.Object({
  mode: CompositionModeSchema,
  outcome: ResultOutcomeSchema,
  winner: Type.Union([Type.Null(), Type.String({ minLength: 1 })]),
  members: Type.Array(SettledMemberSchema, { minItems: 1 }),
});

export type CompositionResult = Static<typeof CompositionResultSchema>;

type RefForResultPort<TPort> = TPort extends {
  readonly moduleId: infer TModuleId extends string;
  readonly resultSchema: infer TResultSchema extends TSchema;
}
  ? ResultRef<Static<TResultSchema>, TModuleId>
  : never;

type CompositionMemberRef<
  TSources extends Record<string, unknown>,
  TModuleId extends string,
> =
  | RefForResultPort<TSources[keyof TSources]>
  | ResultRef<CompositionResult, TModuleId>;

type SourceBinding = {
  readonly eventName: string;
  readonly indexerName: string;
  readonly source: ResultSource;
};

type ResultPortShape = {
  readonly moduleId: string;
  readonly resultSchema: TSchema;
  readonly refSchema: TSchema;
  readonly source: {
    readonly event: EventToken<string, string, TSchema, null>;
    readonly observe: (payload: unknown) => unknown;
  };
};

type ResultPortRecord<TSources extends Record<string, unknown>> = {
  readonly [TKey in keyof TSources]: TSources[TKey] extends ResultPortShape
    ? TSources[TKey]
    : never;
};

type RuntimeResultPort = {
  readonly refSchema: TSchema;
  readonly source: ResultSource;
};

/**
 * Pressure-test implementation of heterogeneous, nestable result composition.
 *
 * Source-specific event aliases and indexers are generated inside this deep
 * module. The public capability contains only one typed group ref, one opening
 * event, one state query, and the resulting ResultPort.
 */
export function defineComposition<
  const TModuleId extends string,
  const TSources extends Record<string, unknown>,
>(input: {
  readonly moduleId: TModuleId;
  readonly sources: TSources & ResultPortRecord<TSources>;
}) {
  // Object.entries erases the per-key ResultPort generics. Validation remains
  // on the public mapped type above; the runtime algorithm needs only these two
  // structural fields.
  const sourceEntries = Object.entries(
    input.sources,
  ) as unknown as readonly (readonly [string, RuntimeResultPort])[];

  if (sourceEntries.length === 0) {
    throw new Error("composition requires at least one result source");
  }

  const uniqueTerminalEvents = new Set(
    sourceEntries.map(([, port]) => port.source.event),
  );

  if (uniqueTerminalEvents.size !== sourceEntries.length) {
    throw new Error(
      "composition result sources must have unique terminal events",
    );
  }

  return defineModule(input.moduleId, (module) => {
    const result = defineResult(module, {
      resultSchema: CompositionResultSchema,
    });
    const memberRefSchemas = [
      result.refSchema,
      ...sourceEntries.map(([, port]) => port.refSchema),
    ];

    // TypeBox requires a tuple to preserve a union's static members. The
    // non-empty source check above proves this runtime-generated collection has
    // at least the two schemas represented by this tuple type.
    const MemberRefSchema = Type.Unsafe<
      CompositionMemberRef<TSources, TModuleId>
    >(
      Type.Union(
        memberRefSchemas as unknown as [TSchema, TSchema, ...TSchema[]],
      ),
    );
    const MemberSchema = Type.Object({
      key: Type.String({ minLength: 1 }),
      ref: MemberRefSchema,
    });
    const OpenedSchema = Type.Object({
      ref: result.refSchema,
      mode: CompositionModeSchema,
      members: Type.Array(MemberSchema, { minItems: 1 }),
    });
    const SettledSchema = Type.Object({
      ref: result.refSchema,
      result: CompositionResultSchema,
    });
    const SettlementRecordSchema = Type.Object({
      ref: AnyResultRefSchema,
      outcome: ResultOutcomeSchema,
      eventId: Type.Integer({ minimum: 1 }),
      settledAtMs: Type.Number(),
    });
    const StateParamsSchema = Type.Object({
      ref: result.refSchema,
    });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        mode: CompositionModeSchema,
        members: Type.Array(MemberSchema, { minItems: 1 }),
      }),
      Type.Object({
        kind: Type.Literal("settled"),
        result: CompositionResultSchema,
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
    const MetricsResultSchema = Type.Object({
      completions: Type.Integer({ minimum: 0 }),
      groups: Type.Integer({ minimum: 0 }),
      members: Type.Integer({ minimum: 0 }),
      settlements: Type.Integer({ minimum: 0 }),
    });
    const sourceBindings: SourceBinding[] = sourceEntries.map(
      ([, port], index) => ({
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
        reconcile: Type.Object({
          ref: result.refSchema,
        }),
      },
    });
    const materializations = defineMaterialization(declaration, {
      namespace: "composition",
    })
      .version(1, "record groups and terminal observations", (schema) =>
        schema
          .createTable("groups", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                source: table.eventRef("opened").notNull(),
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
          .createTable("completions", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                source: table.eventRef("settled").notNull(),
              })
              .primaryKey(["ref"]),
          )
          .createTable("settlements", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                eventId: table.integer().notNull(),
                outcome: table.json<ResultOutcome>().notNull(),
                settledAtMs: table.integer().notNull(),
              })
              .primaryKey(["ref"]),
          ),
      )
      .define({
        indexers: {
          open: {
            sourceEvent: "opened",
            input: OpenedSchema,
          },
          complete: {
            sourceEvent: "settled",
            input: SettledSchema,
          },
          recordOwnSettlement: {
            sourceEvent: "settled",
            input: SettlementRecordSchema,
          },
          ...sourceIndexerDefinitions,
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
    type MetricsQuery = QueryRegistrations["metrics"];
    type StateQuery = QueryRegistrations["state"];
    type GroupsForMemberQuery = QueryRegistrations["groupsForMember"];
    type SettlementStatusQuery = QueryRegistrations["settlementStatus"];
    type ReconcileHandler = NonNullable<QueueRegistrations["reconcile"]>;
    type OwnSettlementContext = Parameters<
      NonNullable<EventRegistrations["settled"]>
    >[0];
    type OwnSettlementIndexerContext = Parameters<
      IndexerRegistrations["recordOwnSettlement"]
    >[0];

    const recordAndWake = async (input: {
      readonly observation: ResultObservation;
      readonly eventId: number;
      readonly settledAtMs: number;
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
        settledAtMs: input.settledAtMs,
      });
      const groups = await input.actions.query("groupsForMember", {
        memberRef: input.observation.ref,
      });

      for (const ref of groups) {
        await input.actions.enqueue(
          "reconcile",
          { ref },
          {
            coalescingKey: ref,
            partitionKey: ref,
          },
        );
      }
    };
    const sourceEventHandlers: Record<string, unknown> = {};

    for (const binding of sourceBindings) {
      sourceEventHandlers[binding.eventName] = async (context: unknown) => {
        // Object iteration erases the correlation between each generated event
        // alias and its source token. Both came from the same binding above;
        // this cast stays inside the implementation and restores only the
        // runtime callback shape needed to call the paired source adapter.
        const sourceContext = context as {
          readonly event: {
            readonly payload: unknown;
            readonly eventId: number;
            readonly tsMs: number;
          };
          readonly actions: OwnSettlementContext["actions"];
        };
        const observation = binding.source.observe(sourceContext.event.payload);

        await recordAndWake({
          observation,
          eventId: sourceContext.event.eventId,
          settledAtMs: sourceContext.event.tsMs,
          indexerName: binding.indexerName,
          actions: sourceContext.actions,
        });
      };
    }

    const recordSettlement = async ({
      input: settlement,
      db,
    }: OwnSettlementIndexerContext): Promise<void> => {
      await db.insertInto("settlements").values(settlement).execute();
    };
    const sourceIndexerHandlers: Record<string, unknown> = {};

    for (const binding of sourceBindings) {
      sourceIndexerHandlers[binding.indexerName] = recordSettlement;
    }

    // The generated declarations, event handlers, and indexers are all derived
    // from sourceBindings. TypeScript cannot retain those computed key
    // correlations through Object.entries, so the one erased registration seam
    // is contained here rather than exported to primitive users.
    const registration = {
      events: {
        opened: async ({ event, actions }: Parameters<OpenedHandler>[0]) => {
          assertUniqueMembers(event.payload.members);
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
          await recordAndWake({
            observation:
              event.payload.result.outcome === "succeeded"
                ? {
                    ref: event.payload.ref,
                    outcome: event.payload.result.outcome,
                    value: event.payload.result,
                  }
                : {
                    ref: event.payload.ref,
                    outcome: event.payload.result.outcome,
                  },
            eventId: event.eventId,
            settledAtMs: event.tsMs,
            indexerName: "recordOwnSettlement",
            actions,
          });
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
            .values({
              ref: group.ref,
              source: event.ref,
            })
            .execute();

          for (const [position, member] of group.members.entries()) {
            await db
              .insertInto("members")
              .values({
                groupRef: group.ref,
                key: member.key,
                memberRef: member.ref,
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
              `composition ${completion.ref} settled without opening`,
            );
          }

          await db
            .insertInto("completions")
            .values({
              ref: completion.ref,
              source: event.ref,
            })
            .execute();
        },
        recordOwnSettlement: recordSettlement,
        ...sourceIndexerHandlers,
      },
      queries: {
        metrics: async ({ db }: Parameters<MetricsQuery>[0]) => {
          const [completions, groups, members, settlements] = await Promise.all(
            [
              db.selectFrom("completions").aggregate().count("count").execute(),
              db.selectFrom("groups").aggregate().count("count").execute(),
              db.selectFrom("members").aggregate().count("count").execute(),
              db.selectFrom("settlements").aggregate().count("count").execute(),
            ],
          );

          return {
            completions: completions.count,
            groups: groups.count,
            members: members.count,
            settlements: settlements.count,
          };
        },
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const group = await db
            .selectFrom("groups")
            .selectEvent("source")
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (group === null) {
            return null;
          }

          const completion = await db
            .selectFrom("completions")
            .selectEvent("source")
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (completion !== null) {
            return {
              kind: "settled",
              result: completion.payload.result,
            };
          }

          const members = await db
            .selectFrom("members")
            .select(["key", "memberRef", "position"])
            .where("groupRef", "=", params.ref)
            .orderBy("position", "asc")
            .execute();

          return {
            kind: "pending",
            mode: group.payload.mode,
            members: members.map((member) => ({
              key: member.key,
              ref: Value.Decode(MemberRefSchema, member.memberRef),
            })),
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
          const state = await actions.query("state", {
            ref: work.payload.ref,
          });

          if (state === null) {
            throw new Error(
              `composition ${work.payload.ref} reconciled before opening`,
            );
          }

          if (state.kind === "settled") {
            return;
          }

          const observations = await Promise.all(
            state.members.map(async (member) => ({
              member,
              status: await actions.query("settlementStatus", {
                ref: member.ref,
              }),
            })),
          );
          const settled = observations.filter(
            (
              observation,
            ): observation is typeof observation & {
              readonly status: NonNullable<typeof observation.status>;
            } => observation.status !== null,
          );

          if (state.mode === "all" && settled.length !== observations.length) {
            return;
          }

          if (state.mode === "race" && settled.length === 0) {
            return;
          }

          const resultValue =
            state.mode === "all" ? allResult(settled) : raceResult(settled);

          actions.emit(
            "settled",
            {
              ref: work.payload.ref,
              result: resultValue,
            },
            {
              dedupeKey: `composition:${work.payload.ref}:settled`,
            },
          );
        },
      },
    } as unknown as Registration;
    const registered = linked.register(registration);
    const resultPort = result.fromEvent(registered.events.settled, (payload) =>
      payload.result.outcome === "succeeded"
        ? {
            ref: payload.ref,
            outcome: payload.result.outcome,
            value: payload.result,
          }
        : {
            ref: payload.ref,
            outcome: payload.result.outcome,
          },
    );

    return module.expose(registered, {
      events: {
        opened: registered.events.opened,
      },
      queries: {
        metrics: registered.queries.metrics,
        state: registered.queries.state,
      },
      result: resultPort,
    });
  });
}

function assertUniqueMembers(
  members: readonly {
    readonly key: string;
    readonly ref: ResultRef<unknown>;
  }[],
): void {
  const keys = new Set<string>();
  const refs = new Set<string>();

  for (const member of members) {
    if (keys.has(member.key)) {
      throw new Error(`composition member key ${member.key} is duplicated`);
    }

    if (refs.has(member.ref)) {
      throw new Error(`composition member ref ${member.ref} is duplicated`);
    }

    keys.add(member.key);
    refs.add(member.ref);
  }
}

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

function allResult(settled: readonly SettledObservation[]): CompositionResult {
  const outcomes = settled.map(({ status }) => status.outcome);
  const outcome = outcomes.includes("failed")
    ? "failed"
    : outcomes.includes("cancelled")
      ? "cancelled"
      : "succeeded";

  return {
    mode: "all",
    outcome,
    winner: null,
    members: settled.map(({ member, status }) => ({
      key: member.key,
      ref: member.ref,
      outcome: status.outcome,
    })),
  };
}

function raceResult(settled: readonly SettledObservation[]): CompositionResult {
  const winner = settled.toSorted(
    (left, right) => left.status.eventId - right.status.eventId,
  )[0];

  if (winner === undefined) {
    throw new Error("race result requires one terminal observation");
  }

  return {
    mode: "race",
    outcome: winner.status.outcome,
    winner: winner.member.key,
    members: [
      {
        key: winner.member.key,
        ref: winner.member.ref,
        outcome: winner.status.outcome,
      },
    ],
  };
}
