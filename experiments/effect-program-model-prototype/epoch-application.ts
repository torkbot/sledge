import { Cause, Effect, Exit, Option } from "effect";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { defineMaterialization, type QueueLedger } from "../../src/ledger.ts";
import { defineLedger, defineModule } from "../../src/sledge.ts";
import { defineResult } from "../../src/stdlib.ts";
import { defineInvocation } from "../../src/experimental/invocation.ts";
import {
  DurableActivities,
  defineActivity,
  invoke,
  type Activity,
} from "./effect-api.ts";

export const MemoryInputSchema = Type.Object({
  previousMemory: Type.Array(Type.String()),
  prefix: Type.Array(Type.String({ minLength: 1 })),
});

export const MemoryResultSchema = Type.Object({
  memory: Type.Array(Type.String({ minLength: 1 })),
  durableFacts: Type.Array(Type.String({ minLength: 1 })),
});

export const CompactionInputSchema = Type.Object({
  prefix: Type.Array(Type.String({ minLength: 1 })),
  memoryExtraction: MemoryResultSchema,
});

export const CompactionResultSchema = Type.Object({
  compactedPrefix: Type.Array(Type.String({ minLength: 1 })),
});

export const EpochInputSchema = Type.Object({
  previousMemory: Type.Array(Type.String()),
  prefix: Type.Array(Type.String({ minLength: 1 })),
});

export const EpochResultSchema = Type.Object({
  memory: Type.Array(Type.String({ minLength: 1 })),
  compactedPrefix: Type.Array(Type.String({ minLength: 1 })),
});

const FailureSchema = Type.String({ minLength: 1 });
const MemoryEnvelopeSchema = Type.Object({
  workflowRef: Type.String({ minLength: 1 }),
  value: MemoryInputSchema,
});
const CompactionEnvelopeSchema = Type.Object({
  workflowRef: Type.String({ minLength: 1 }),
  value: CompactionInputSchema,
});

export const extractMemory = defineActivity("extract-memory", {
  inputSchema: MemoryInputSchema,
  resultSchema: MemoryResultSchema,
  failureSchema: FailureSchema,
});

export const compactPrefix = defineActivity("compact-prefix", {
  inputSchema: CompactionInputSchema,
  resultSchema: CompactionResultSchema,
  failureSchema: FailureSchema,
});

export type EpochProgram = (
  input: Static<typeof EpochInputSchema>,
) => Effect.Effect<Static<typeof EpochResultSchema>, string, DurableActivities>;

export interface EpochFunctions {
  extractMemory(input: {
    readonly input: Static<typeof MemoryInputSchema>;
    readonly signal: AbortSignal;
  }): Promise<Static<typeof MemoryResultSchema>>;

  compactPrefix(input: {
    readonly input: Static<typeof CompactionInputSchema>;
    readonly signal: AbortSignal;
  }): Promise<Static<typeof CompactionResultSchema>>;
}

function createMemoryInvocation(execute: EpochFunctions["extractMemory"]) {
  return defineInvocation("prototype.effect.extract-memory", {
    inputSchema: MemoryEnvelopeSchema,
    resultSchema: MemoryResultSchema,
    failureSchema: FailureSchema,
    execute: async ({ input: envelope, signal }) => ({
      outcome: "succeeded",
      value: await execute({ input: envelope.value, signal }),
    }),
  });
}

function createCompactionInvocation(execute: EpochFunctions["compactPrefix"]) {
  return defineInvocation("prototype.effect.compact-prefix", {
    inputSchema: CompactionEnvelopeSchema,
    resultSchema: CompactionResultSchema,
    failureSchema: FailureSchema,
    execute: async ({ input: envelope, signal }) => ({
      outcome: "succeeded",
      value: await execute({ input: envelope.value, signal }),
    }),
  });
}

type MemoryCapabilities = ReturnType<
  ReturnType<typeof createMemoryInvocation>
>["capabilities"];

type CompactionCapabilities = ReturnType<
  ReturnType<typeof createCompactionInvocation>
>["capabilities"];

export function createEpochEffectApplication(input: {
  readonly functions: EpochFunctions;
  readonly program: EpochProgram;
  readonly onProgramReplay: () => void;
}) {
  const memoryDefinition = createMemoryInvocation(
    input.functions.extractMemory,
  );
  const compactionDefinition = createCompactionInvocation(
    input.functions.compactPrefix,
  );

  return defineLedger((sledge) => {
    const memory = sledge.install(memoryDefinition());
    const compaction = sledge.install(compactionDefinition());
    const workflow = sledge.install(
      defineEpochWorkflow({
        compaction,
        memory,
        onProgramReplay: input.onProgramReplay,
        program: input.program,
      })(),
    );

    return { compaction, memory, workflow };
  });
}

function defineEpochWorkflow(input: {
  readonly memory: MemoryCapabilities;
  readonly compaction: CompactionCapabilities;
  readonly program: EpochProgram;
  readonly onProgramReplay: () => void;
}) {
  return defineModule("prototype.effect.epoch-workflow", (module) => {
    const result = defineResult(module, {
      resultSchema: EpochResultSchema,
      failureSchema: FailureSchema,
    });
    const RequestedSchema = Type.Object({
      ref: result.refSchema,
      input: EpochInputSchema,
    });
    const SettledSchema = Type.Union([
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("succeeded"),
        value: EpochResultSchema,
      }),
      Type.Object({
        ref: result.refSchema,
        outcome: Type.Literal("failed"),
        error: FailureSchema,
      }),
    ]);
    const StateParamsSchema = Type.Object({ ref: result.refSchema });
    const StateResultSchema = Type.Union([
      Type.Null(),
      Type.Object({
        kind: Type.Literal("pending"),
        input: EpochInputSchema,
      }),
      Type.Object({
        kind: Type.Literal("succeeded"),
        input: EpochInputSchema,
        value: EpochResultSchema,
      }),
      Type.Object({
        kind: Type.Literal("failed"),
        input: EpochInputSchema,
        error: FailureSchema,
      }),
    ]);
    const TickSchema = Type.Object({ ref: result.refSchema });
    const declaration = module.declare({
      events: {
        requested: RequestedSchema,
        settled: SettledSchema,
        memoryRequested: input.memory.events.requested,
        memorySettled: input.memory.result.source.event,
        compactionRequested: input.compaction.events.requested,
        compactionSettled: input.compaction.result.source.event,
      },
      queries: {
        memoryState: input.memory.queries.state,
        compactionState: input.compaction.queries.state,
      },
      queues: { tick: TickSchema },
    });
    const materialization = defineMaterialization(declaration, {
      namespace: "effect_workflow",
    })
      .version(1, "record effect workflow requests and settlements", (schema) =>
        schema.createTable("workflows", (table) =>
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
          request: { sourceEvent: "requested", input: RequestedSchema },
          settle: { sourceEvent: "settled", input: SettledSchema },
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
    type RequestedHandler = NonNullable<EventRegistrations["requested"]>;
    type SettledHandler = NonNullable<EventRegistrations["settled"]>;
    type MemorySettledHandler = NonNullable<
      EventRegistrations["memorySettled"]
    >;
    type CompactionSettledHandler = NonNullable<
      EventRegistrations["compactionSettled"]
    >;
    type RequestIndexer = IndexerRegistrations["request"];
    type SettleIndexer = IndexerRegistrations["settle"];
    type StateQuery = QueryRegistrations["state"];
    type TickHandler = NonNullable<QueueRegistrations["tick"]>;
    const registration = linked.register({
      events: {
        requested: async (context: Parameters<RequestedHandler>[0]) => {
          const { event, actions } = context;

          await actions.index("request", event.payload);
          await actions.enqueue(
            "tick",
            { ref: event.payload.ref },
            {
              coalescingKey: event.payload.ref,
              partitionKey: event.payload.ref,
            },
          );
        },
        settled: async ({ event, actions }: Parameters<SettledHandler>[0]) => {
          await actions.index("settle", event.payload);
        },
        memorySettled: async ({
          event,
          actions,
        }: Parameters<MemorySettledHandler>[0]) => {
          const observation = input.memory.result.source.observe(event.payload);
          const state = await actions.query(
            "memoryState",
            input.memory.result.reader.params(observation.ref),
          );

          if (state === null) {
            throw new Error(`memory activity ${observation.ref} has no state`);
          }

          const workflowRef = Value.Decode(
            result.refSchema,
            state.input.workflowRef,
          );

          await actions.enqueue(
            "tick",
            { ref: workflowRef },
            {
              coalescingKey: workflowRef,
              partitionKey: workflowRef,
            },
          );
        },
        compactionSettled: async ({
          event,
          actions,
        }: Parameters<CompactionSettledHandler>[0]) => {
          const observation = input.compaction.result.source.observe(
            event.payload,
          );
          const state = await actions.query(
            "compactionState",
            input.compaction.result.reader.params(observation.ref),
          );

          if (state === null) {
            throw new Error(
              `compaction activity ${observation.ref} has no state`,
            );
          }

          const workflowRef = Value.Decode(
            result.refSchema,
            state.input.workflowRef,
          );

          await actions.enqueue(
            "tick",
            { ref: workflowRef },
            {
              coalescingKey: workflowRef,
              partitionKey: workflowRef,
            },
          );
        },
      },
      indexers: {
        request: async ({
          input: request,
          event,
          db,
        }: Parameters<RequestIndexer>[0]) => {
          await db
            .insertInto("workflows")
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
          const workflow = await db
            .selectFrom("workflows")
            .select(["ref"])
            .where("ref", "=", settlement.ref)
            .executeTakeFirst();

          if (workflow === null) {
            throw new Error(
              `effect workflow ${settlement.ref} settled without a request`,
            );
          }

          await db
            .updateTable("workflows")
            .set({ settlement: event.ref })
            .where("ref", "=", settlement.ref)
            .whereNull("settlement")
            .execute();
        },
      },
      queries: {
        state: async ({ params, db }: Parameters<StateQuery>[0]) => {
          const workflow = await db
            .selectFrom("workflows")
            .select(["request", "settlement"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (workflow === null) {
            return null;
          }

          const request = await db.readEvent(workflow.request);

          if (request === null) {
            throw new Error(`effect workflow ${params.ref} lost its request`);
          }

          if (workflow.settlement === null) {
            return { kind: "pending", input: request.payload.input };
          }

          const settlement = await db.readEvent(workflow.settlement);

          if (settlement === null) {
            throw new Error(
              `effect workflow ${params.ref} lost its settlement`,
            );
          }

          if (settlement.payload.outcome === "succeeded") {
            return {
              kind: "succeeded",
              input: request.payload.input,
              value: settlement.payload.value,
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
        tick: async ({
          work,
          lease,
          actions,
          ledger,
        }: Parameters<TickHandler>[0]) => {
          const state = await actions.query("state", {
            ref: work.payload.ref,
          });

          if (state === null) {
            throw new Error(
              `effect workflow ${work.payload.ref} ran without a request`,
            );
          }

          if (state.kind !== "pending") {
            return;
          }

          input.onProgramReplay();
          let step = 0;
          const runActivity = (<
            TInputSchema extends TSchema,
            TResultSchema extends TSchema,
            TFailureSchema extends TSchema,
          >(
            activity: Activity<TInputSchema, TResultSchema, TFailureSchema>,
            activityInput: Static<TInputSchema>,
          ) => {
            const currentStep = step;
            step += 1;

            if (activity.id === extractMemory.id) {
              return runMemoryActivity({
                activityInput: Value.Decode(MemoryInputSchema, activityInput),
                ledger,
                step: currentStep,
                workflowRef: work.payload.ref,
                capabilities: input.memory,
              });
            }

            if (activity.id === compactPrefix.id) {
              return runCompactionActivity({
                activityInput: Value.Decode(
                  CompactionInputSchema,
                  activityInput,
                ),
                ledger,
                step: currentStep,
                workflowRef: work.payload.ref,
                capabilities: input.compaction,
              });
            }

            return Effect.die(
              new Error(`unknown durable activity ${activity.id}`),
            );
          }) as DurableActivities["run"];
          const program = input
            .program(state.input)
            .pipe(
              Effect.provideService(DurableActivities, { run: runActivity }),
            );
          const exit = await Effect.runPromiseExit(program, {
            signal: lease.signal,
          });

          lease.signal.throwIfAborted();

          if (Exit.isSuccess(exit)) {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                outcome: "succeeded",
                value: Value.Decode(EpochResultSchema, exit.value),
              },
              { dedupeKey: `effect:${work.payload.ref}:settled` },
            );
            return;
          }

          const defect = Cause.dieOption(exit.cause);

          if (
            Option.isSome(defect) &&
            defect.value instanceof WorkflowSuspended
          ) {
            return;
          }

          const failure = Cause.failureOption(exit.cause);

          if (Option.isSome(failure)) {
            actions.emit(
              "settled",
              {
                ref: work.payload.ref,
                outcome: "failed",
                error: Value.Decode(FailureSchema, failure.value),
              },
              { dedupeKey: `effect:${work.payload.ref}:settled` },
            );
            return;
          }

          throw Cause.squash(exit.cause);
        },
      },
    } satisfies Registration);
    const resultPort = result
      .fromEvent(registration.events.settled, (payload) =>
        payload.outcome === "succeeded"
          ? {
              ref: payload.ref,
              outcome: payload.outcome,
              value: payload.value,
            }
          : {
              ref: payload.ref,
              outcome: payload.outcome,
              error: payload.error,
            },
      )
      .readFrom(registration.queries.state, {
        observe: (state, ref) => {
          if (state === null || state.kind === "pending") {
            return null;
          }

          return state.kind === "succeeded"
            ? { ref, outcome: state.kind, value: state.value }
            : { ref, outcome: state.kind, error: state.error };
        },
      });

    return module.expose(registration, {
      events: { requested: registration.events.requested },
      queries: { state: registration.queries.state },
      result: resultPort,
    });
  });
}

class WorkflowSuspended extends Error {
  readonly activityRef: string;

  constructor(activityRef: string) {
    super(`effect workflow suspended on ${activityRef}`);
    this.name = "WorkflowSuspended";
    this.activityRef = activityRef;
  }
}

function runMemoryActivity(input: {
  readonly activityInput: Static<typeof MemoryInputSchema>;
  readonly workflowRef: string;
  readonly step: number;
  readonly capabilities: MemoryCapabilities;
  readonly ledger: QueueLedger<
    | MemoryCapabilities["events"]["requested"]
    | CompactionCapabilities["events"]["requested"],
    | MemoryCapabilities["queries"]["state"]
    | CompactionCapabilities["queries"]["state"]
  >;
}): Effect.Effect<Static<typeof MemoryResultSchema>, string> {
  const ref = input.capabilities.result.ref(
    `${input.workflowRef}:step:${input.step}`,
  );

  return Effect.flatMap(
    Effect.promise(() =>
      input.ledger.query(input.capabilities.queries.state, { ref }),
    ),
    (state) => {
      if (state === null) {
        return Effect.flatMap(
          Effect.promise(() =>
            input.ledger.emit(
              input.capabilities.events.requested,
              {
                ref,
                input: {
                  workflowRef: input.workflowRef,
                  value: input.activityInput,
                },
              },
              { dedupeKey: `effect:${ref}:requested` },
            ),
          ),
          () => Effect.die(new WorkflowSuspended(ref)),
        );
      }

      if (state.kind === "pending") {
        return Effect.die(new WorkflowSuspended(ref));
      }

      if (state.kind === "succeeded") {
        return Effect.succeed(Value.Decode(MemoryResultSchema, state.value));
      }

      if (state.kind === "failed") {
        return Effect.fail(state.error);
      }

      return Effect.fail(`memory activity ${ref} was cancelled`);
    },
  );
}

function runCompactionActivity(input: {
  readonly activityInput: Static<typeof CompactionInputSchema>;
  readonly workflowRef: string;
  readonly step: number;
  readonly capabilities: CompactionCapabilities;
  readonly ledger: QueueLedger<
    | MemoryCapabilities["events"]["requested"]
    | CompactionCapabilities["events"]["requested"],
    | MemoryCapabilities["queries"]["state"]
    | CompactionCapabilities["queries"]["state"]
  >;
}): Effect.Effect<Static<typeof CompactionResultSchema>, string> {
  const ref = input.capabilities.result.ref(
    `${input.workflowRef}:step:${input.step}`,
  );

  return Effect.flatMap(
    Effect.promise(() =>
      input.ledger.query(input.capabilities.queries.state, { ref }),
    ),
    (state) => {
      if (state === null) {
        return Effect.flatMap(
          Effect.promise(() =>
            input.ledger.emit(
              input.capabilities.events.requested,
              {
                ref,
                input: {
                  workflowRef: input.workflowRef,
                  value: input.activityInput,
                },
              },
              { dedupeKey: `effect:${ref}:requested` },
            ),
          ),
          () => Effect.die(new WorkflowSuspended(ref)),
        );
      }

      if (state.kind === "pending") {
        return Effect.die(new WorkflowSuspended(ref));
      }

      if (state.kind === "succeeded") {
        return Effect.succeed(
          Value.Decode(CompactionResultSchema, state.value),
        );
      }

      if (state.kind === "failed") {
        return Effect.fail(state.error);
      }

      return Effect.fail(`compaction activity ${ref} was cancelled`);
    },
  );
}

export const epochProgram: EpochProgram = (input) =>
  Effect.gen(function* () {
    const memoryExtraction = yield* invoke(extractMemory, {
      previousMemory: input.previousMemory,
      prefix: input.prefix,
    });
    const compaction = yield* invoke(compactPrefix, {
      prefix: input.prefix,
      memoryExtraction,
    });

    return {
      memory: memoryExtraction.memory,
      compactedPrefix: compaction.compactedPrefix,
    };
  });
