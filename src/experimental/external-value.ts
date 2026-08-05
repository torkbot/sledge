import { Type, type Static, type TSchema } from "typebox";

import { defineMaterialization } from "../ledger.ts";
import { defineModule } from "../sledge.ts";
import { defineResult } from "../stdlib.ts";

/**
 * Defines a typed result supplied later by an external actor.
 *
 * Opening establishes the request before any value may be supplied. The first
 * supplied value is copied into the one terminal event; later submissions
 * remain ordinary input facts and cannot change the result.
 */
export function defineExternalValue<
  const TModuleId extends string,
  const TValueSchema extends TSchema,
>(
  moduleId: TModuleId,
  input: {
    readonly valueSchema: TValueSchema;
  },
) {
  return defineModule(moduleId, (module) => {
    type ExternalValue = Static<TValueSchema>;
    const ValueSchema = Type.Unsafe<ExternalValue>(input.valueSchema);
    const result = defineResult(module, {
      resultSchema: ValueSchema,
      failureSchema: Type.Never(),
    });
    const OpenedSchema = Type.Object({
      ref: result.refSchema,
      prompt: Type.String({ minLength: 1 }),
    });
    const SuppliedSchema = Type.Object({
      ref: result.refSchema,
      value: ValueSchema,
    });
    const ResolvedSchema = Type.Object({
      ref: result.refSchema,
      value: ValueSchema,
    });
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        prompt: Type.String({ minLength: 1 }),
      }),
      Type.Object({
        kind: Type.Literal("resolved"),
        prompt: Type.String({ minLength: 1 }),
        value: ValueSchema,
      }),
    ]);
    const declaration = module.declare({
      events: {
        opened: OpenedSchema,
        supplied: SuppliedSchema,
        resolved: ResolvedSchema,
      },
      queues: {
        accept: SuppliedSchema,
      },
    });
    const materialization = defineMaterialization(declaration, {
      namespace: "external_value",
    })
      .version(1, "record external values", (schema) =>
        schema.createTable("requests", (table) =>
          table
            .columns({
              ref: table.text().notNull(),
              source: table.eventRef("opened").notNull(),
              resolution: table.eventRef("resolved"),
            })
            .primaryKey(["ref"]),
        ),
      )
      .define({
        indexers: {
          open: { sourceEvent: "opened", input: OpenedSchema },
          resolve: { sourceEvent: "resolved", input: ResolvedSchema },
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
    type OpenedHandler = NonNullable<EventRegistrations["opened"]>;
    type SuppliedHandler = NonNullable<EventRegistrations["supplied"]>;
    type ResolvedHandler = NonNullable<EventRegistrations["resolved"]>;
    type OpenIndexer = IndexerRegistrations["open"];
    type ResolveIndexer = IndexerRegistrations["resolve"];
    type StateQuery = QueryRegistrations["state"];
    type AcceptHandler = NonNullable<QueueRegistrations["accept"]>;
    const registered = linked.register({
      events: {
        opened: async ({ event, actions }: Parameters<OpenedHandler>[0]) => {
          await actions.index("open", event.payload);
        },
        supplied: async ({
          event,
          actions,
        }: Parameters<SuppliedHandler>[0]) => {
          await actions.enqueue("accept", event.payload, {
            partitionKey: event.payload.ref,
            workKey: `external-value:${event.eventId}`,
          });
        },
        resolved: async ({
          event,
          actions,
        }: Parameters<ResolvedHandler>[0]) => {
          await actions.index("resolve", event.payload);
        },
      },
      indexers: {
        open: async ({
          input: request,
          event,
          db,
        }: Parameters<OpenIndexer>[0]) => {
          await db
            .insertInto("requests")
            .values({
              ref: request.ref,
              source: event.ref,
              resolution: null,
            })
            .execute();
        },
        resolve: async ({
          input: resolution,
          event,
          db,
        }: Parameters<ResolveIndexer>[0]) => {
          const request = await db
            .selectFrom("requests")
            .select(["ref"])
            .where("ref", "=", resolution.ref)
            .executeTakeFirst();

          if (request === null) {
            throw new Error(
              `external value ${resolution.ref} resolved without opening`,
            );
          }

          await db
            .updateTable("requests")
            .set({ resolution: event.ref })
            .where("ref", "=", resolution.ref)
            .whereNull("resolution")
            .execute();
        },
      },
      queries: {
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const request = await db
            .selectFrom("requests")
            .select(["source", "resolution"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (request === null) {
            return null;
          }

          const opened = await db.readEvent(request.source);

          if (opened === null) {
            throw new Error(
              `external value ${params.ref} lost its opening event`,
            );
          }

          if (request.resolution === null) {
            return { kind: "pending", prompt: opened.payload.prompt };
          }

          const resolved = await db.readEvent(request.resolution);

          if (resolved === null) {
            throw new Error(
              `external value ${params.ref} lost its resolution event`,
            );
          }

          return {
            kind: "resolved",
            prompt: opened.payload.prompt,
            value: resolved.payload.value,
          };
        },
      },
      queues: {
        accept: async ({ work, actions }: Parameters<AcceptHandler>[0]) => {
          const state = await actions.query("state", {
            ref: work.payload.ref,
          });

          if (state === null) {
            throw new Error(
              `external value ${work.payload.ref} was supplied before opening`,
            );
          }

          if (state.kind === "resolved") {
            return;
          }

          actions.emit("resolved", work.payload, {
            dedupeKey: `external-value:${work.payload.ref}:resolved`,
          });
        },
      },
    } satisfies Registration);
    const resultPort = result
      .fromEvent(registered.events.resolved, (payload) => ({
        ref: payload.ref,
        outcome: "succeeded",
        value: payload.value,
      }))
      .readFrom(registered.queries.state, {
        observe: (state, ref) =>
          state?.kind === "resolved"
            ? {
                ref,
                outcome: "succeeded",
                value: state.value,
              }
            : null,
      });

    return module.expose(registered, {
      events: {
        opened: registered.events.opened,
        supplied: registered.events.supplied,
      },
      queries: { state: registered.queries.state },
      result: resultPort,
    });
  });
}

export type ExternalValueCapabilities<
  TModuleId extends string,
  TValueSchema extends TSchema,
> = ReturnType<
  ReturnType<typeof defineExternalValue<TModuleId, TValueSchema>>
>["capabilities"];
