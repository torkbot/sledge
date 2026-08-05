import { Context, Effect } from "effect";
import type { Static, TSchema } from "typebox";

const activityTypeId: unique symbol = Symbol(
  "sledge.effectProgramPrototype.activity",
);

/**
 * A durable operation available to an Effect program.
 *
 * The descriptor is inert. Its schemas describe the journal boundary while
 * the active Sledge interpreter decides whether to execute or replay it.
 */
export interface Activity<
  TInputSchema extends TSchema,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
> {
  readonly [activityTypeId]: true;
  readonly id: string;
  readonly inputSchema: TInputSchema;
  readonly resultSchema: TResultSchema;
  readonly failureSchema: TFailureSchema;
}

/** Effect environment capability supplied only by the durable interpreter. */
export interface DurableActivities {
  run<
    TInputSchema extends TSchema,
    TResultSchema extends TSchema,
    TFailureSchema extends TSchema,
  >(
    activity: Activity<TInputSchema, TResultSchema, TFailureSchema>,
    input: Static<TInputSchema>,
  ): Effect.Effect<Static<TResultSchema>, Static<TFailureSchema>>;
}

export const DurableActivities = Context.GenericTag<DurableActivities>(
  "@torkbot/sledge/prototype/DurableActivities",
);

export function defineActivity<
  const TInputSchema extends TSchema,
  const TResultSchema extends TSchema,
  const TFailureSchema extends TSchema,
>(
  id: string,
  input: {
    readonly inputSchema: TInputSchema;
    readonly resultSchema: TResultSchema;
    readonly failureSchema: TFailureSchema;
  },
): Activity<TInputSchema, TResultSchema, TFailureSchema> {
  if (id.length === 0) {
    throw new Error("activity id must not be empty");
  }

  const activity: Activity<TInputSchema, TResultSchema, TFailureSchema> = {
    [activityTypeId]: true,
    id,
    inputSchema: input.inputSchema,
    resultSchema: input.resultSchema,
    failureSchema: input.failureSchema,
  };

  return Object.freeze(activity);
}

/** Lift one durable activity call into an ordinary Effect program. */
export function invoke<
  TInputSchema extends TSchema,
  TResultSchema extends TSchema,
  TFailureSchema extends TSchema,
>(
  activity: Activity<TInputSchema, TResultSchema, TFailureSchema>,
  input: Static<TInputSchema>,
): Effect.Effect<
  Static<TResultSchema>,
  Static<TFailureSchema>,
  DurableActivities
> {
  return Effect.flatMap(DurableActivities, (activities) =>
    activities.run(activity, input),
  );
}
