import { isDeepStrictEqual } from "node:util";

import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  defineMaterialization,
  type EventPayload,
  type EventToken,
  type QueryParameters,
  type QueryToken,
} from "../ledger.ts";
import { defineModule, type ApplicationLedger } from "../sledge.ts";
import {
  Settlement,
  type Settlement as TerminalSettlement,
} from "../stdlib.ts";

declare const executionServiceBrand: unique symbol;
declare const executionProgramBrand: unique symbol;
declare const executionRefBrand: unique symbol;
declare const activityBrand: unique symbol;

/** A typed requirement that an activity resolves from its runtime module. */
export type ExecutionService<TId extends string, TImplementation> = {
  readonly [executionServiceBrand]: {
    readonly id: TId;
    readonly implementation: TImplementation;
  };
};

type AnyExecutionService = ExecutionService<string, unknown>;

type ServiceImplementation<TService> =
  TService extends ExecutionService<string, infer TImplementation>
    ? TImplementation
    : never;

const executionServiceIds = new WeakMap<object, string>();

export function defineExecutionService<
  const TId extends string,
  TImplementation,
>(id: TId): ExecutionService<TId, TImplementation> {
  assertIdentifier(id, "execution service id");
  const service = Object.freeze({}) as ExecutionService<TId, TImplementation>;
  executionServiceIds.set(service, id);
  return service;
}

export type ExecutionServiceBinding<TService extends AnyExecutionService> = {
  readonly service: TService;
  readonly implementation: ServiceImplementation<TService>;
};

export function bindExecutionService<
  const TService extends AnyExecutionService,
>(
  service: TService,
  implementation: ServiceImplementation<TService>,
): ExecutionServiceBinding<TService> {
  readExecutionServiceId(service);
  return Object.freeze({ service, implementation });
}

/**
 * An immutable execution graph fragment. Operators always return a new graph;
 * constructing one never starts work or mutates durable state.
 */
export interface Execution<TResult, TFailure, TServices = never> {
  map<TNext>(
    transform: (value: TResult) => TNext,
  ): Execution<TNext, TFailure, TServices>;

  flatMap<TNext, TNextFailure, TNextServices>(
    transform: (
      value: TResult,
    ) => Execution<TNext, TNextFailure, TNextServices>,
  ): Execution<TNext, TFailure | TNextFailure, TServices | TNextServices>;
}

type ExecutionNode =
  | { readonly kind: "succeed"; readonly value: unknown }
  | { readonly kind: "fail"; readonly error: unknown }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "activity";
      readonly activity: object;
      readonly input: unknown;
    }
  | {
      readonly kind: "flatMap";
      readonly source: object;
      readonly transform: (value: unknown) => object;
    };

const executionNodes = new WeakMap<object, ExecutionNode>();

function createExecution<TResult, TFailure, TServices>(
  node: ExecutionNode,
): Execution<TResult, TFailure, TServices> {
  let execution: Execution<TResult, TFailure, TServices>;

  execution = Object.freeze({
    map: <TNext>(transform: (value: TResult) => TNext) => {
      return createExecution<TNext, TFailure, TServices>({
        kind: "flatMap",
        source: execution,
        // This is the single erased-value seam inside the graph interpreter.
        // The source node produced the value under TResult before this closure
        // is invoked, so restoring that static type is safe here.
        transform: (value) => succeed(transform(value as TResult)),
      });
    },
    flatMap: <TNext, TNextFailure, TNextServices>(
      transform: (
        value: TResult,
      ) => Execution<TNext, TNextFailure, TNextServices>,
    ) => {
      return createExecution<
        TNext,
        TFailure | TNextFailure,
        TServices | TNextServices
      >({
        kind: "flatMap",
        source: execution,
        // See the map seam above. All untrusted persisted values are decoded
        // by their activity schema before evaluation reaches this closure.
        transform: (value) => transform(value as TResult),
      });
    },
  });
  executionNodes.set(execution, node);
  return execution;
}

export function succeed<TResult>(
  value: TResult,
): Execution<TResult, never, never> {
  return createExecution({ kind: "succeed", value });
}

export function fail<TFailure>(
  error: TFailure,
): Execution<never, TFailure, never> {
  return createExecution({ kind: "fail", error });
}

export function cancelled(): Execution<never, never, never> {
  return createExecution({ kind: "cancelled" });
}

type ActivityAttempt<TInput, TService, TResult, TFailure> = (input: {
  readonly input: TInput;
  readonly service: ServiceImplementation<TService>;
  readonly ref: ExecutionRef<unknown, string>;
  readonly attempt: number;
  readonly signal: AbortSignal;
}) => Promise<TerminalSettlement<TResult, TFailure>>;

type RuntimeActivity = {
  readonly id: string;
  readonly service: AnyExecutionService;
  readonly inputSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly failureSchema: TSchema;
  execute(input: {
    readonly input: unknown;
    readonly service: unknown;
    readonly ref: ExecutionRef<unknown, string>;
    readonly attempt: number;
    readonly signal: AbortSignal;
  }): Promise<TerminalSettlement<unknown, unknown>>;
};

export type Activity<
  TId extends string,
  TInput,
  TResult,
  TFailure,
  TService extends AnyExecutionService,
> = ((input: TInput) => Execution<TResult, TFailure, TService>) & {
  readonly id: TId;
  readonly [activityBrand]: {
    readonly input: TInput;
    readonly result: TResult;
    readonly failure: TFailure;
    readonly service: TService;
  };
};

const runtimeActivities = new WeakMap<object, RuntimeActivity>();

export function defineActivity<
  const TId extends string,
  const TService extends AnyExecutionService,
  const TInputSchema extends TSchema,
  const TResultSchema extends TSchema,
  const TFailureSchema extends TSchema,
>(
  id: TId,
  service: TService,
  input: {
    readonly inputSchema: TInputSchema;
    readonly resultSchema: TResultSchema;
    readonly failureSchema: TFailureSchema;
    readonly execute: ActivityAttempt<
      Static<TInputSchema>,
      TService,
      Static<TResultSchema>,
      Static<TFailureSchema>
    >;
  },
): Activity<
  TId,
  Static<TInputSchema>,
  Static<TResultSchema>,
  Static<TFailureSchema>,
  TService
> {
  assertIdentifier(id, "activity id");
  readExecutionServiceId(service);
  const InputSchema = Type.Unsafe<Static<TInputSchema>>(input.inputSchema);

  let activity: Activity<
    TId,
    Static<TInputSchema>,
    Static<TResultSchema>,
    Static<TFailureSchema>,
    TService
  >;
  const invoke = (activityInput: Static<TInputSchema>) => {
    const encoded = Value.Encode(InputSchema, activityInput);
    return createExecution<
      Static<TResultSchema>,
      Static<TFailureSchema>,
      TService
    >({ kind: "activity", activity, input: encoded });
  };
  activity = Object.assign(invoke, { id }) as typeof activity;
  Object.freeze(activity);

  runtimeActivities.set(activity, {
    id,
    service,
    inputSchema: input.inputSchema,
    resultSchema: input.resultSchema,
    failureSchema: input.failureSchema,
    execute: async (attempt) => {
      const decodedInput = Value.Decode(InputSchema, attempt.input);

      // The binding and the activity carry the same authenticated service
      // token. That runtime identity check is what permits this local type
      // restoration without recursively branding user implementations.
      const implementation = attempt.service as ServiceImplementation<TService>;
      return await input.execute({
        ...attempt,
        input: decodedInput,
        service: implementation,
      });
    },
  });
  return activity;
}

export type ExecutionProgram<
  TId extends string,
  TInput,
  TResult,
  TFailure,
  TServices,
> = {
  readonly id: TId;
  readonly [executionProgramBrand]: {
    readonly input: TInput;
    readonly result: TResult;
    readonly failure: TFailure;
    readonly services: TServices;
  };
};

type AnyExecutionProgram = ExecutionProgram<
  string,
  unknown,
  unknown,
  unknown,
  unknown
>;

type RuntimeProgram = {
  readonly id: string;
  readonly inputSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly failureSchema: TSchema;
  build(input: unknown): object;
};

const runtimePrograms = new WeakMap<object, RuntimeProgram>();

export function defineExecutionProgram<
  const TId extends string,
  const TInputSchema extends TSchema,
  const TResultSchema extends TSchema,
  const TFailureSchema extends TSchema,
  TServices,
>(
  id: TId,
  input: {
    readonly inputSchema: TInputSchema;
    readonly resultSchema: TResultSchema;
    readonly failureSchema: TFailureSchema;
    readonly build: (
      input: Static<TInputSchema>,
    ) => Execution<Static<TResultSchema>, Static<TFailureSchema>, TServices>;
  },
): ExecutionProgram<
  TId,
  Static<TInputSchema>,
  Static<TResultSchema>,
  Static<TFailureSchema>,
  TServices
> {
  assertIdentifier(id, "execution program id");
  const InputSchema = Type.Unsafe<Static<TInputSchema>>(input.inputSchema);
  const program = Object.freeze({ id }) as ExecutionProgram<
    TId,
    Static<TInputSchema>,
    Static<TResultSchema>,
    Static<TFailureSchema>,
    TServices
  >;
  runtimePrograms.set(program, {
    id,
    inputSchema: input.inputSchema,
    resultSchema: input.resultSchema,
    failureSchema: input.failureSchema,
    build: (persistedInput) => {
      return input.build(Value.Decode(InputSchema, persistedInput));
    },
  });
  return program;
}

export type ExecutionRef<
  TResult,
  TProgramId extends string = string,
> = string & {
  readonly [executionRefBrand]: {
    readonly result: TResult;
    readonly programId: TProgramId;
  };
};

type ProgramInput<TProgram> =
  TProgram extends ExecutionProgram<
    string,
    infer TInput,
    unknown,
    unknown,
    unknown
  >
    ? TInput
    : never;

type ProgramResult<TProgram> =
  TProgram extends ExecutionProgram<
    string,
    unknown,
    infer TResult,
    unknown,
    unknown
  >
    ? TResult
    : never;

type ProgramFailure<TProgram> =
  TProgram extends ExecutionProgram<
    string,
    unknown,
    unknown,
    infer TFailure,
    unknown
  >
    ? TFailure
    : never;

type ProgramId<TProgram> =
  TProgram extends ExecutionProgram<
    infer TId,
    unknown,
    unknown,
    unknown,
    unknown
  >
    ? TId
    : never;

type ProgramServices<TProgram> =
  TProgram extends ExecutionProgram<
    string,
    unknown,
    unknown,
    unknown,
    infer TServices
  >
    ? TServices
    : never;

type BoundService<TBinding> =
  TBinding extends ExecutionServiceBinding<infer TService> ? TService : never;

type MissingServices<
  TPrograms extends readonly AnyExecutionProgram[],
  TBindings extends readonly ExecutionServiceBinding<AnyExecutionService>[],
> = Exclude<
  ProgramServices<TPrograms[number]>,
  BoundService<TBindings[number]>
>;

type CompleteServiceBindings<
  TPrograms extends readonly AnyExecutionProgram[],
  TBindings extends readonly ExecutionServiceBinding<AnyExecutionService>[],
> = [MissingServices<TPrograms, TBindings>] extends [never] ? TBindings : never;

export interface ExecutionRuntime<
  TPrograms extends readonly AnyExecutionProgram[],
> {
  start<const TProgram extends TPrograms[number]>(
    ledger: ApplicationLedger,
    program: TProgram,
    input: ProgramInput<TProgram>,
    options: { readonly key: string },
  ): Promise<ExecutionRef<ProgramResult<TProgram>, ProgramId<TProgram>>>;

  read<const TProgram extends TPrograms[number]>(
    ledger: ApplicationLedger,
    program: TProgram,
    ref: ExecutionRef<ProgramResult<TProgram>, ProgramId<TProgram>>,
  ): Promise<TerminalSettlement<
    ProgramResult<TProgram>,
    ProgramFailure<TProgram>
  > | null>;
}

type JournalActivity = {
  readonly path: string;
  readonly activityId: string;
  readonly input: unknown;
  readonly settlement: TerminalSettlement<unknown, unknown> | null;
};

type JournalState = {
  readonly ref: ExecutionRef<unknown, string>;
  readonly programId: string;
  readonly input: unknown;
  readonly settlement: TerminalSettlement<unknown, unknown> | null;
  readonly activities: readonly JournalActivity[];
};

type Evaluation =
  | {
      readonly kind: "settled";
      readonly settlement: TerminalSettlement<unknown, unknown>;
    }
  | {
      readonly kind: "schedule";
      readonly path: string;
      readonly activity: RuntimeActivity;
      readonly input: unknown;
    }
  | { readonly kind: "waiting" };

const GenericSettlementSchema = Type.Union([
  Type.Object({
    outcome: Type.Literal("succeeded"),
    value: Type.Unknown(),
  }),
  Type.Object({
    outcome: Type.Literal("failed"),
    error: Type.Unknown(),
  }),
  Type.Object({ outcome: Type.Literal("cancelled") }),
]);
const ExecutionRefSchema = Type.Unsafe<ExecutionRef<unknown, string>>(
  Type.String({ minLength: 1 }),
);
const StartedSchema = Type.Object({
  ref: ExecutionRefSchema,
  programId: Type.String({ minLength: 1 }),
  input: Type.Unknown(),
});
const ScheduledSchema = Type.Object({
  kind: Type.Literal("activity_scheduled"),
  ref: ExecutionRefSchema,
  path: Type.String({ minLength: 1 }),
  activityId: Type.String({ minLength: 1 }),
  input: Type.Unknown(),
});
const ExecutionSettledSchema = Type.Object({
  kind: Type.Literal("execution_settled"),
  ref: ExecutionRefSchema,
  settlement: GenericSettlementSchema,
});
const AdvancedSchema = Type.Union([ScheduledSchema, ExecutionSettledSchema]);
const ActivitySettledSchema = Type.Object({
  ref: ExecutionRefSchema,
  path: Type.String({ minLength: 1 }),
  activityId: Type.String({ minLength: 1 }),
  settlement: GenericSettlementSchema,
});
const StateParamsSchema = Type.Object({ ref: ExecutionRefSchema });
const StateResultSchema = Type.Union([
  Type.Null(),
  Type.Object({
    ref: ExecutionRefSchema,
    programId: Type.String({ minLength: 1 }),
    input: Type.Unknown(),
    settlement: Type.Union([Type.Null(), GenericSettlementSchema]),
    activities: Type.Array(
      Type.Object({
        path: Type.String({ minLength: 1 }),
        activityId: Type.String({ minLength: 1 }),
        input: Type.Unknown(),
        settlement: Type.Union([Type.Null(), GenericSettlementSchema]),
      }),
    ),
  }),
]);

export function defineExecutionModule<
  const TModuleId extends string,
  const TPrograms extends readonly [
    AnyExecutionProgram,
    ...AnyExecutionProgram[],
  ],
  const TBindings extends
    readonly ExecutionServiceBinding<AnyExecutionService>[],
>(
  moduleId: TModuleId,
  input: {
    readonly programs: TPrograms;
    readonly services: CompleteServiceBindings<TPrograms, TBindings>;
  },
) {
  return defineModule(moduleId, (module) => {
    const programs = new Map<string, RuntimeProgram>();
    const programTokens = new Set<object>();

    for (const token of input.programs) {
      const program = readRuntimeProgram(token);

      if (programs.has(program.id)) {
        throw new Error(`duplicate execution program id ${program.id}`);
      }

      programs.set(program.id, program);
      programTokens.add(token);
    }

    const services = new Map<object, unknown>();
    const serviceIds = new Set<string>();

    for (const binding of input.services) {
      const serviceId = readExecutionServiceId(binding.service);

      if (serviceIds.has(serviceId)) {
        throw new Error(`duplicate execution service binding ${serviceId}`);
      }

      serviceIds.add(serviceId);
      services.set(binding.service, binding.implementation);
    }

    const declaration = module.declare({
      events: {
        started: StartedSchema,
        advanced: AdvancedSchema,
        activitySettled: ActivitySettledSchema,
      },
      queues: {
        control: Type.Object({ ref: ExecutionRefSchema }),
        activity: ScheduledSchema,
      },
    });
    const materialization = defineMaterialization(declaration, {
      namespace: "execution",
    })
      .version(1, "record execution journals", (schema) =>
        schema
          .createTable("executions", (table) =>
            table
              .columns({
                ref: table.text().notNull(),
                programId: table.text().notNull(),
                input: table.json<unknown>().notNull(),
                settlement: table.json<TerminalSettlement<unknown, unknown>>(),
              })
              .primaryKey(["ref"]),
          )
          .createTable("activities", (table) =>
            table
              .columns({
                executionRef: table.text().notNull(),
                path: table.text().notNull(),
                activityId: table.text().notNull(),
                input: table.json<unknown>().notNull(),
                settlement: table.json<TerminalSettlement<unknown, unknown>>(),
              })
              .primaryKey(["executionRef", "path"]),
          ),
      )
      .define({
        indexers: {
          start: { sourceEvent: "started", input: StartedSchema },
          advance: { sourceEvent: "advanced", input: AdvancedSchema },
          settleActivity: {
            sourceEvent: "activitySettled",
            input: ActivitySettledSchema,
          },
        },
        queries: {
          state: { params: StateParamsSchema, result: StateResultSchema },
        },
      });
    const linked = module.link(declaration, materialization);
    type Registration = Parameters<typeof linked.register>[0];
    type Events = NonNullable<Registration["events"]>;
    type Indexers = NonNullable<Registration["indexers"]>;
    type Queries = Registration["queries"];
    type Queues = NonNullable<Registration["queues"]>;
    type StartEvent = NonNullable<Events["started"]>;
    type AdvanceEvent = NonNullable<Events["advanced"]>;
    type ActivitySettledEvent = NonNullable<Events["activitySettled"]>;
    type StartIndexer = Indexers["start"];
    type AdvanceIndexer = Indexers["advance"];
    type SettleActivityIndexer = Indexers["settleActivity"];
    type StateQuery = Queries["state"];
    type ControlQueue = NonNullable<Queues["control"]>;
    type ActivityQueue = NonNullable<Queues["activity"]>;

    const registered = linked.register({
      events: {
        started: async (context: Parameters<StartEvent>[0]) => {
          const { event, actions } = context;
          const program = readProgramById(programs, event.payload.programId);
          Value.Decode(program.inputSchema, event.payload.input);
          await actions.index("start", event.payload);
          await actions.enqueue(
            "control",
            { ref: event.payload.ref },
            {
              coalescingKey: event.payload.ref,
              partitionKey: event.payload.ref,
            },
          );
        },
        advanced: async (context: Parameters<AdvanceEvent>[0]) => {
          const { event, actions } = context;
          await actions.index("advance", event.payload);

          if (event.payload.kind === "activity_scheduled") {
            await actions.enqueue("activity", event.payload, {
              workKey: `${event.payload.ref}:${event.payload.path}`,
            });
          }
        },
        activitySettled: async (
          context: Parameters<ActivitySettledEvent>[0],
        ) => {
          const { event, actions } = context;
          await actions.index("settleActivity", event.payload);
          await actions.enqueue(
            "control",
            { ref: event.payload.ref },
            {
              coalescingKey: event.payload.ref,
              partitionKey: event.payload.ref,
            },
          );
        },
      },
      queues: {
        control: async (context: Parameters<ControlQueue>[0]) => {
          const { actions, work } = context;
          const state = await actions.query("state", { ref: work.payload.ref });

          if (state === null) {
            throw new Error(`execution ${work.payload.ref} has no journal`);
          }

          if (state.settlement !== null) {
            return;
          }

          const program = readProgramById(programs, state.programId);
          const graph = program.build(state.input);
          const evaluation = evaluateExecution(
            graph,
            "root",
            indexActivities(state.activities),
          );

          if (evaluation.kind === "waiting") {
            return;
          }

          if (evaluation.kind === "schedule") {
            actions.emit("advanced", {
              kind: "activity_scheduled",
              ref: state.ref,
              path: evaluation.path,
              activityId: evaluation.activity.id,
              input: Value.Encode(
                evaluation.activity.inputSchema,
                evaluation.input,
              ),
            });
            return;
          }

          actions.emit("advanced", {
            kind: "execution_settled",
            ref: state.ref,
            settlement: encodeSettlement(program, evaluation.settlement),
          });
        },
        activity: async (context: Parameters<ActivityQueue>[0]) => {
          const { actions, lease, work } = context;
          const state = await actions.query("state", { ref: work.payload.ref });

          if (state === null) {
            throw new Error(`execution ${work.payload.ref} has no journal`);
          }

          if (state.settlement !== null) {
            return;
          }

          const program = readProgramById(programs, state.programId);
          const graph = program.build(state.input);
          const activity = findActivity(
            graph,
            "root",
            work.payload.path,
            indexActivities(state.activities),
          );

          if (
            activity === null ||
            activity.activity.id !== work.payload.activityId
          ) {
            throw new Error(
              `execution ${state.ref} no longer resolves activity ${work.payload.activityId} at ${work.payload.path}`,
            );
          }

          assertSameOpaqueValue(
            activity.input,
            work.payload.input,
            "activity input",
          );
          const service = services.get(activity.activity.service);

          if (!services.has(activity.activity.service)) {
            throw new Error(
              `missing execution service ${readExecutionServiceId(activity.activity.service)}`,
            );
          }

          const settlement = await activity.activity.execute({
            input: work.payload.input,
            service,
            ref: state.ref,
            attempt: lease.attempt,
            signal: lease.signal,
          });
          lease.signal.throwIfAborted();

          actions.emit("activitySettled", {
            ref: state.ref,
            path: work.payload.path,
            activityId: work.payload.activityId,
            settlement: encodeActivitySettlement(activity.activity, settlement),
          });
        },
      },
      indexers: {
        start: async (context: Parameters<StartIndexer>[0]) => {
          const { db, input: start } = context;
          await db
            .insertInto("executions")
            .values({
              ref: start.ref,
              programId: start.programId,
              input: start.input,
              settlement: null,
            })
            .execute();
        },
        advance: async (context: Parameters<AdvanceIndexer>[0]) => {
          const { db, input: advance } = context;

          if (advance.kind === "activity_scheduled") {
            await db
              .insertInto("activities")
              .values({
                executionRef: advance.ref,
                path: advance.path,
                activityId: advance.activityId,
                input: advance.input,
                settlement: null,
              })
              .execute();
            return;
          }

          const update = await db
            .updateTable("executions")
            .set({ settlement: advance.settlement })
            .where("ref", "=", advance.ref)
            .whereNull("settlement")
            .execute();

          if (update.changes !== 1) {
            throw new Error(
              `execution ${advance.ref} settled without one pending journal`,
            );
          }
        },
        settleActivity: async (
          context: Parameters<SettleActivityIndexer>[0],
        ) => {
          const { db, input: settlement } = context;
          const update = await db
            .updateTable("activities")
            .set({ settlement: settlement.settlement })
            .where("executionRef", "=", settlement.ref)
            .where("path", "=", settlement.path)
            .where("activityId", "=", settlement.activityId)
            .whereNull("settlement")
            .execute();

          if (update.changes !== 1) {
            throw new Error(
              `activity ${settlement.activityId} at ${settlement.path} did not have one pending journal entry`,
            );
          }
        },
      },
      queries: {
        state: async (context: Parameters<StateQuery>[0]) => {
          const { db, params } = context;
          const execution = await db
            .selectFrom("executions")
            .select(["programId", "input", "settlement"])
            .where("ref", "=", params.ref)
            .executeTakeFirst();

          if (execution === null) {
            return null;
          }

          const activityRows = await db
            .selectFrom("activities")
            .select(["path", "activityId", "input", "settlement"])
            .where("executionRef", "=", params.ref)
            .orderBy("path", "asc")
            .execute();
          const activities: JournalActivity[] = [];

          for (const row of activityRows) {
            activities.push({
              path: row.path,
              activityId: row.activityId,
              input: row.input,
              settlement: row.settlement,
            });
          }

          return {
            ref: params.ref,
            programId: execution.programId,
            input: execution.input,
            settlement: execution.settlement,
            activities,
          };
        },
      },
    });

    const runtime: ExecutionRuntime<TPrograms> = Object.freeze({
      start: async <const TProgram extends TPrograms[number]>(
        ledger: ApplicationLedger,
        programToken: TProgram,
        programInput: ProgramInput<TProgram>,
        options: { readonly key: string },
      ) => {
        assertIdentifier(options.key, "execution key");

        if (!programTokens.has(programToken)) {
          throw new Error("execution program is not installed in this runtime");
        }

        const program = readRuntimeProgram(programToken);
        const ref = createExecutionRef<TProgram>(
          moduleId,
          program.id,
          options.key,
        );
        const payload = Value.Encode(StartedSchema, {
          ref,
          programId: program.id,
          input: Value.Encode(program.inputSchema, programInput),
        });
        // TypeBox's generic Static type does not reduce through a token whose
        // module id is still generic. The concrete schema encoded this value
        // immediately above; this assertion only bridges that library limit.
        await ledger.emit(
          linked.events.started,
          payload as EventPayload<typeof linked.events.started>,
          { dedupeKey: ref },
        );
        return ref;
      },
      read: async <const TProgram extends TPrograms[number]>(
        ledger: ApplicationLedger,
        programToken: TProgram,
        ref: ExecutionRef<ProgramResult<TProgram>, ProgramId<TProgram>>,
      ) => {
        if (!programTokens.has(programToken)) {
          throw new Error("execution program is not installed in this runtime");
        }

        const program = readRuntimeProgram(programToken);
        const params = Value.Encode(StateParamsSchema, { ref });
        const state = await ledger.query(
          linked.queries.state,
          // This is the query-side form of the encoded token bridge above.
          params as QueryParameters<typeof linked.queries.state>,
        );

        if (state === null || state.settlement === null) {
          return null;
        }

        if (state.programId !== program.id) {
          throw new Error(
            `execution ${ref} belongs to ${state.programId}, not ${program.id}`,
          );
        }

        return decodeSettlement(
          program,
          state.settlement,
        ) as TerminalSettlement<
          ProgramResult<TProgram>,
          ProgramFailure<TProgram>
        >;
      },
    });

    return module.expose(registered, { execution: runtime });
  });
}

function evaluateExecution(
  execution: object,
  path: string,
  activities: ReadonlyMap<string, JournalActivity>,
): Evaluation {
  const node = readExecutionNode(execution);

  if (node.kind === "succeed") {
    return { kind: "settled", settlement: Settlement.succeeded(node.value) };
  }

  if (node.kind === "fail") {
    return { kind: "settled", settlement: Settlement.failed(node.error) };
  }

  if (node.kind === "cancelled") {
    return { kind: "settled", settlement: Settlement.cancelled() };
  }

  if (node.kind === "activity") {
    const activity = readRuntimeActivity(node.activity);
    const recorded = activities.get(path);

    if (recorded === undefined) {
      return { kind: "schedule", path, activity, input: node.input };
    }

    assertActivityMatches(recorded, activity, node.input);

    if (recorded.settlement === null) {
      return { kind: "waiting" };
    }

    return {
      kind: "settled",
      settlement: decodeActivitySettlement(activity, recorded.settlement),
    };
  }

  const sourcePath = `${path}/source`;
  const source = evaluateExecution(node.source, sourcePath, activities);

  if (source.kind !== "settled") {
    return source;
  }

  if (source.settlement.outcome !== "succeeded") {
    return source;
  }

  return evaluateExecution(
    node.transform(source.settlement.value),
    `${path}/then`,
    activities,
  );
}

function findActivity(
  execution: object,
  path: string,
  targetPath: string,
  activities: ReadonlyMap<string, JournalActivity>,
): { readonly activity: RuntimeActivity; readonly input: unknown } | null {
  const node = readExecutionNode(execution);

  if (node.kind === "activity") {
    if (path !== targetPath) {
      return null;
    }

    return { activity: readRuntimeActivity(node.activity), input: node.input };
  }

  if (node.kind !== "flatMap") {
    return null;
  }

  const sourcePath = `${path}/source`;

  if (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`)) {
    return findActivity(node.source, sourcePath, targetPath, activities);
  }

  const source = evaluateExecution(node.source, sourcePath, activities);

  if (source.kind !== "settled" || source.settlement.outcome !== "succeeded") {
    return null;
  }

  return findActivity(
    node.transform(source.settlement.value),
    `${path}/then`,
    targetPath,
    activities,
  );
}

function encodeActivitySettlement(
  activity: RuntimeActivity,
  settlement: TerminalSettlement<unknown, unknown>,
): TerminalSettlement<unknown, unknown> {
  const decoded = Value.Decode(GenericSettlementSchema, settlement);

  if (decoded.outcome === "succeeded") {
    return Settlement.succeeded(
      Value.Encode(activity.resultSchema, decoded.value),
    );
  }

  if (decoded.outcome === "failed") {
    return Settlement.failed(
      Value.Encode(activity.failureSchema, decoded.error),
    );
  }

  return Settlement.cancelled();
}

function decodeActivitySettlement(
  activity: RuntimeActivity,
  settlement: TerminalSettlement<unknown, unknown>,
): TerminalSettlement<unknown, unknown> {
  const decoded = Value.Decode(GenericSettlementSchema, settlement);

  if (decoded.outcome === "succeeded") {
    return Settlement.succeeded(
      Value.Decode(activity.resultSchema, decoded.value),
    );
  }

  if (decoded.outcome === "failed") {
    return Settlement.failed(
      Value.Decode(activity.failureSchema, decoded.error),
    );
  }

  return Settlement.cancelled();
}

function encodeSettlement(
  program: RuntimeProgram,
  settlement: TerminalSettlement<unknown, unknown>,
): TerminalSettlement<unknown, unknown> {
  const decoded = Value.Decode(GenericSettlementSchema, settlement);

  if (decoded.outcome === "succeeded") {
    return Settlement.succeeded(
      Value.Encode(program.resultSchema, decoded.value),
    );
  }

  if (decoded.outcome === "failed") {
    return Settlement.failed(
      Value.Encode(program.failureSchema, decoded.error),
    );
  }

  return Settlement.cancelled();
}

function decodeSettlement(
  program: RuntimeProgram,
  settlement: TerminalSettlement<unknown, unknown>,
): TerminalSettlement<unknown, unknown> {
  const decoded = Value.Decode(GenericSettlementSchema, settlement);

  if (decoded.outcome === "succeeded") {
    return Settlement.succeeded(
      Value.Decode(program.resultSchema, decoded.value),
    );
  }

  if (decoded.outcome === "failed") {
    return Settlement.failed(
      Value.Decode(program.failureSchema, decoded.error),
    );
  }

  return Settlement.cancelled();
}

function indexActivities(
  activities: readonly JournalActivity[],
): ReadonlyMap<string, JournalActivity> {
  return new Map(activities.map((activity) => [activity.path, activity]));
}

function assertActivityMatches(
  recorded: JournalActivity,
  activity: RuntimeActivity,
  input: unknown,
): void {
  if (recorded.activityId !== activity.id) {
    throw new Error(
      `execution graph changed at ${recorded.path}: expected ${recorded.activityId}, resolved ${activity.id}`,
    );
  }

  assertSameOpaqueValue(recorded.input, input, `activity ${activity.id} input`);
}

function assertSameOpaqueValue(
  left: unknown,
  right: unknown,
  description: string,
): void {
  if (!isDeepStrictEqual(left, right)) {
    throw new Error(`${description} changed after it was journaled`);
  }
}

function createExecutionRef<TProgram extends AnyExecutionProgram>(
  moduleId: string,
  programId: string,
  key: string,
): ExecutionRef<ProgramResult<TProgram>, ProgramId<TProgram>> {
  return `execution:v1:${JSON.stringify([moduleId, programId, key])}` as ExecutionRef<
    ProgramResult<TProgram>,
    ProgramId<TProgram>
  >;
}

function readExecutionNode(execution: object): ExecutionNode {
  const node = executionNodes.get(execution);

  if (node === undefined) {
    throw new Error("invalid execution graph node");
  }

  return node;
}

function readRuntimeActivity(activity: object): RuntimeActivity {
  const runtime = runtimeActivities.get(activity);

  if (runtime === undefined) {
    throw new Error("invalid activity");
  }

  return runtime;
}

function readRuntimeProgram(program: object): RuntimeProgram {
  const runtime = runtimePrograms.get(program);

  if (runtime === undefined) {
    throw new Error("invalid execution program");
  }

  return runtime;
}

function readProgramById(
  programs: ReadonlyMap<string, RuntimeProgram>,
  programId: string,
): RuntimeProgram {
  const program = programs.get(programId);

  if (program === undefined) {
    throw new Error(`unknown execution program ${programId}`);
  }

  return program;
}

function readExecutionServiceId(service: object): string {
  const id = executionServiceIds.get(service);

  if (id === undefined) {
    throw new Error("invalid execution service");
  }

  return id;
}

function assertIdentifier(value: string, description: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${description} must not be empty`);
  }
}
