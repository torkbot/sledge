import { Type } from "typebox";

import { defineMaterialization } from "../ledger.ts";
import { defineModule } from "../sledge.ts";
import { defineResult } from "../stdlib.ts";

export type DeadlineResult = {
  readonly firedAtMs: number;
};

const DeadlineResultSchema = Type.Object({
  firedAtMs: Type.Number(),
});

/**
 * Defines one-shot absolute deadlines as composable durable results.
 *
 * A schedule creates delayed queue work. The firing event records the actual
 * lease-acquisition time, so restart and scheduler delay remain observable.
 * Cancellation is deliberately not part of this protocol: a race choosing a
 * different result does not imply that abandoning the deadline is harmless.
 */
export function defineDeadline<const TModuleId extends string>(
  moduleId: TModuleId,
) {
  return defineModule(moduleId, (module) => {
    const result = defineResult(module, {
      resultSchema: DeadlineResultSchema,
      failureSchema: Type.Never(),
    });
    const ScheduledSchema = Type.Object({
      ref: result.refSchema,
      atMs: Type.Number(),
    });
    const FiredSchema = Type.Object({
      ref: result.refSchema,
      firedAtMs: Type.Number(),
    });
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("scheduled"),
        atMs: Type.Number(),
      }),
      Type.Object({
        kind: Type.Literal("fired"),
        atMs: Type.Number(),
        firedAtMs: Type.Number(),
      }),
    ]);
    const declaration = module.declare({
      events: {
        scheduled: ScheduledSchema,
        fired: FiredSchema,
      },
      queues: {
        fire: ScheduledSchema,
      },
    });
    const materialization = defineMaterialization(declaration, {
      namespace: "deadline",
    })
      .version(1, "record durable deadlines", (schema) =>
        schema.createTable("deadlines", (table) =>
          table
            .columns({
              ref: table.text().notNull(),
              schedule: table.eventRef("scheduled").notNull(),
              firing: table.eventRef("fired"),
            })
            .primaryKey(["ref"]),
        ),
      )
      .define({
        indexers: {
          schedule: { sourceEvent: "scheduled", input: ScheduledSchema },
          fire: { sourceEvent: "fired", input: FiredSchema },
        },
        queries: {
          state: { params: StateParamsSchema, result: StateResultSchema },
        },
      });
    const linked = module.link(declaration, materialization);
    type Registration = Parameters<typeof linked.register>[0];
    type EventRegistrations = NonNullable<Registration["events"]>;
    type IndexerRegistrations = NonNullable<Registration["indexers"]>;
    type QueryRegistrations = Registration["queries"];
    type QueueRegistrations = NonNullable<Registration["queues"]>;
    type ScheduledHandler = NonNullable<EventRegistrations["scheduled"]>;
    type FiredHandler = NonNullable<EventRegistrations["fired"]>;
    type ScheduleIndexer = IndexerRegistrations["schedule"];
    type FireIndexer = IndexerRegistrations["fire"];
    type StateQuery = QueryRegistrations["state"];
    type FireHandler = NonNullable<QueueRegistrations["fire"]>;
    const registered = linked.register({
      events: {
        scheduled: async ({
          event,
          actions,
        }: Parameters<ScheduledHandler>[0]) => {
          await actions.index("schedule", event.payload);
          await actions.enqueue("fire", event.payload, {
            availableAtMs: event.payload.atMs,
            coalescingKey: event.payload.ref,
            partitionKey: event.payload.ref,
          });
        },
        fired: async ({ event, actions }: Parameters<FiredHandler>[0]) => {
          await actions.index("fire", event.payload);
        },
      },
      indexers: {
        schedule: async ({
          input: deadline,
          event,
          db,
        }: Parameters<ScheduleIndexer>[0]) => {
          await db
            .insertInto("deadlines")
            .values({
              ref: deadline.ref,
              schedule: event.ref,
              firing: null,
            })
            .execute();
        },
        fire: async ({
          input: firing,
          event,
          db,
        }: Parameters<FireIndexer>[0]) => {
          const deadline = await db
            .selectFrom("deadlines")
            .select(["ref"])
            .where("ref", "=", firing.ref)
            .executeTakeFirst();

          if (deadline === null) {
            throw new Error(`deadline ${firing.ref} fired without a schedule`);
          }

          await db
            .updateTable("deadlines")
            .set({ firing: event.ref })
            .where("ref", "=", firing.ref)
            .whereNull("firing")
            .execute();
        },
      },
      queries: {
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const deadline = await db
            .selectFrom("deadlines")
            .select(["schedule", "firing"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (deadline === null) {
            return null;
          }

          const schedule = await db.readEvent(deadline.schedule);

          if (schedule === null) {
            throw new Error(`deadline ${params.ref} lost its schedule event`);
          }

          if (deadline.firing === null) {
            return { kind: "scheduled", atMs: schedule.payload.atMs };
          }

          const firing = await db.readEvent(deadline.firing);

          if (firing === null) {
            throw new Error(`deadline ${params.ref} lost its firing event`);
          }

          return {
            kind: "fired",
            atMs: schedule.payload.atMs,
            firedAtMs: firing.payload.firedAtMs,
          };
        },
      },
      queues: {
        fire: ({ work, lease, actions }: Parameters<FireHandler>[0]) => {
          actions.emit(
            "fired",
            {
              ref: work.payload.ref,
              firedAtMs: lease.leaseAcquiredAtMs,
            },
            {
              dedupeKey: `deadline:${work.payload.ref}:fired`,
            },
          );
        },
      },
    } satisfies Registration);
    const resultPort = result
      .fromEvent(registered.events.fired, (payload) => ({
        ref: payload.ref,
        outcome: "succeeded",
        value: { firedAtMs: payload.firedAtMs },
      }))
      .readFrom(registered.queries.state, {
        observe: (state, ref) =>
          state?.kind === "fired"
            ? {
                ref,
                outcome: "succeeded",
                value: { firedAtMs: state.firedAtMs },
              }
            : null,
      });

    return module.expose(registered, {
      events: { scheduled: registered.events.scheduled },
      queries: { state: registered.queries.state },
      result: resultPort,
    });
  });
}

export type DeadlineCapabilities<TModuleId extends string> = ReturnType<
  ReturnType<typeof defineDeadline<TModuleId>>
>["capabilities"];
