import { defineModule } from "@torkbot/sledge";
import { defineMaterialization } from "@torkbot/sledge/ledger";
import { defineResult, type ResultRef } from "@torkbot/sledge/stdlib";
import { Type, type Static, type TSchema } from "typebox";

export interface PrototypeLogger {
  info(message: string): void;
}

export type InvocationExecution<
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
  TModuleId extends string,
> = (input: {
  readonly input: Static<TInputSchema>;
  readonly ref: ResultRef<Static<TOutputSchema>, TModuleId>;
  readonly signal: AbortSignal;
}) => Promise<Static<TOutputSchema>>;

/**
 * Pressure-test protocol for a typed, finite durable effect.
 *
 * Engine work identity, attempts, timeout, leases, and the private queue remain
 * inside the module. Callers retain only semantic request, state, and result
 * capabilities.
 */
export function defineInvocation<
  const TModuleId extends string,
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
>(input: {
  readonly moduleId: TModuleId;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly execute: InvocationExecution<TInputSchema, TOutputSchema, TModuleId>;
  readonly logger: PrototypeLogger;
}) {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("invocation maxAttempts must be a positive integer");
  }

  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("invocation timeoutMs must be a positive integer");
  }

  return defineModule(input.moduleId, (module) => {
    type InvocationInput = Static<TInputSchema>;
    type InvocationOutput = Static<TOutputSchema>;
    const InvocationInputSchema = Type.Unsafe<InvocationInput>(
      input.inputSchema,
    );
    const InvocationOutputSchema = Type.Unsafe<InvocationOutput>(
      input.outputSchema,
    );
    const result = defineResult(module, {
      resultSchema: input.outputSchema,
    });
    const RequestedSchema = Type.Object({
      ref: result.refSchema,
      input: InvocationInputSchema,
    });
    const FailureSchema = Type.Object({
      message: Type.String({ minLength: 1 }),
    });
    const SettledSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("succeeded"),
        output: InvocationOutputSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("failed"),
        error: FailureSchema,
      }),
    ]);
    const StateParamsSchema = Type.Object({
      ref: result.refSchema,
    });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        input: InvocationInputSchema,
      }),
      Type.Object({
        kind: Type.Literal("succeeded"),
        input: InvocationInputSchema,
        output: InvocationOutputSchema,
      }),
      Type.Object({
        kind: Type.Literal("failed"),
        input: InvocationInputSchema,
        error: FailureSchema,
      }),
    ]);
    const MetricsResultSchema = Type.Object({
      requests: Type.Integer({ minimum: 0 }),
      settlements: Type.Integer({ minimum: 0 }),
    });
    const declaration = module.declare({
      events: {
        requested: RequestedSchema,
        settled: SettledSchema,
      },
      queues: {
        execute: RequestedSchema,
      },
    });
    const materializations = defineMaterialization(declaration, {
      namespace: "invocation",
    })
      .version(1, "record invocation requests and settlements", (schema) =>
        schema
          .createTable("requests", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                source: table.eventRef("requested").notNull(),
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
          recordRequest: {
            sourceEvent: "requested",
            input: RequestedSchema,
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
    const registered = module.link(declaration, materializations).register({
      events: {
        requested: async ({ event, actions }) => {
          await actions.index("recordRequest", event.payload);
          await actions.enqueue("execute", event.payload, {
            coalescingKey: event.payload.ref,
            partitionKey: event.payload.ref,
          });
        },
        settled: async ({ event, actions }) => {
          await actions.index("recordSettlement", event.payload);
        },
      },
      indexers: {
        recordRequest: async ({ input: request, event, db }) => {
          await db
            .insertInto("requests")
            .values({
              ref: request.ref,
              source: event.ref,
            })
            .execute();
        },
        recordSettlement: async ({ input: settlement, event, db }) => {
          const request = await db
            .selectFrom("requests")
            .select(["ref"])
            .where("ref", "=", settlement.ref)
            .executeTakeFirst();

          if (request === null) {
            throw new Error(
              `invocation ${settlement.ref} settled without a request`,
            );
          }

          await db
            .insertInto("settlements")
            .values({
              ref: settlement.ref,
              source: event.ref,
            })
            .execute();
        },
      },
      queries: {
        metrics: async ({ db }) => {
          const [requests, settlements] = await Promise.all([
            db.selectFrom("requests").aggregate().count("count").execute(),
            db.selectFrom("settlements").aggregate().count("count").execute(),
          ]);

          return {
            requests: requests.count,
            settlements: settlements.count,
          };
        },
        state: async ({ params, db }) => {
          const request = await db
            .selectFrom("requests")
            .selectEvent("source")
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (request === null) {
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
              input: request.payload.input,
            };
          }

          if (settlement.payload.outcome === "succeeded") {
            return {
              kind: "succeeded",
              input: request.payload.input,
              output: settlement.payload.output,
            };
          }

          return {
            kind: "failed",
            input: request.payload.input,
            error: settlement.payload.error,
          };
        },
      },
      queues: {
        execute: async ({ work, lease, actions, control }) => {
          input.logger.info(
            `attempt ${work.attempt}/${input.maxAttempts} for ${work.payload.ref}`,
          );

          try {
            const output = await control.withTimeout(
              input.timeoutMs,
              async (signal) =>
                await input.execute({
                  input: work.payload.input,
                  ref: work.payload.ref,
                  signal,
                }),
            );

            lease.signal.throwIfAborted();
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                outcome: "succeeded",
                output,
              },
              {
                dedupeKey: `invocation:${work.payload.ref}:settled`,
              },
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
                outcome: "failed",
                error: {
                  message: errorMessage(error),
                },
              },
              {
                dedupeKey: `invocation:${work.payload.ref}:settled`,
              },
            );
          }
        },
      },
    });
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
      events: {
        requested: registered.events.requested,
      },
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

  return "invocation failed with a non-Error value";
}
