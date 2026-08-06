import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import {
  serializeException,
  SerializedExceptionSchema,
  type SerializedException,
} from "../exception.ts";
import { createEventRef, type EventRef } from "./event-ref.ts";
import type {
  EventCausationWork,
  EventToken,
  ProjectionIndexerEvent,
  ProjectionReadDatabase,
} from "./ledger.ts";
import type { AnyProjectionSchema } from "./projection-access.ts";

const eventPortBrand: unique symbol = Symbol("sledge.experimental.eventPort");
const eventPortNameBrand: unique symbol = Symbol(
  "sledge.experimental.eventPortName",
);
const eventPortSettlementBrand: unique symbol = Symbol(
  "sledge.experimental.eventPortSettlement",
);
const operatorIndexerPortBrand: unique symbol = Symbol(
  "sledge.experimental.operatorIndexerPort",
);
const sinkBrand: unique symbol = Symbol("sledge.experimental.sink");
const privateGraphIdPrefix = "__sledge_";

export type AsyncOperatorContext = {
  /** Stable across retries and suitable for external idempotency. */
  readonly key: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
};

export type OperatorSettlement<TValue> =
  | { readonly outcome: "succeeded"; readonly value: TValue }
  | { readonly outcome: "failed"; readonly error: SerializedException };

export type OperatorSettlementSchema<TValueSchema extends TSchema> = ReturnType<
  typeof SettlementSchema<TValueSchema>
>;

export function SettlementSchema<TValueSchema extends TSchema>(
  value: TValueSchema,
) {
  return Type.Union([
    Type.Object({
      outcome: Type.Literal("succeeded"),
      value,
    }),
    Type.Object({
      outcome: Type.Literal("failed"),
      error: SerializedExceptionSchema,
    }),
  ]);
}

export class UncaughtOperatorError extends Error {
  constructor(operatorName: string, bindingId: string, cause: unknown) {
    super(`operator ${operatorName} failed at binding ${bindingId}`, { cause });
    this.name = "UncaughtOperatorError";
  }
}

/** An immutable, reusable asynchronous transformation. */
export class MapAsync<
  const TName extends string,
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
> {
  readonly name: TName;
  readonly input: TInputSchema;
  readonly output: TOutputSchema;
  readonly timeoutMs: number;
  readonly map: (
    input: Static<TInputSchema>,
    context: AsyncOperatorContext,
  ) => Static<TOutputSchema> | Promise<Static<TOutputSchema>>;

  constructor(
    name: TName,
    definition: {
      readonly input: TInputSchema;
      readonly output: TOutputSchema;
      readonly timeoutMs: number;
      readonly map: MapAsync<TName, TInputSchema, TOutputSchema>["map"];
    },
  ) {
    this.name = name;
    this.input = definition.input;
    this.output = definition.output;
    assertTimeoutMs(definition.timeoutMs);
    this.timeoutMs = definition.timeoutMs;
    this.map = definition.map;
    Object.freeze(this);
  }
}

/** An immutable, reusable terminal asynchronous effect. */
export class ForEach<const TName extends string, TInputSchema extends TSchema> {
  readonly name: TName;
  readonly input: TInputSchema;
  readonly run: (
    input: Static<TInputSchema>,
    context: AsyncOperatorContext,
  ) => void | Promise<void>;

  constructor(
    name: TName,
    definition: {
      readonly input: TInputSchema;
      readonly run: ForEach<TName, TInputSchema>["run"];
    },
  ) {
    this.name = name;
    this.input = definition.input;
    this.run = definition.run;
    Object.freeze(this);
  }
}

export type EventPort<
  TSchemaValue extends TSchema,
  TName extends string = string,
  TSettlementValueSchema extends TSchema | null = null,
> = TSchemaValue & {
  readonly [eventPortBrand]: TSchemaValue;
  readonly [eventPortNameBrand]: TName;
  readonly [eventPortSettlementBrand]: TSettlementValueSchema;
};

/** A terminal binding that cannot be used as another event source. */
export interface Sink {
  readonly [sinkBrand]: true;
}

export type RevealedModuleCapabilities<TValue> =
  TValue extends EventPort<infer TSchemaValue, string, TSchema | null>
    ? EventToken<string, string, TSchemaValue, null>
    : TValue extends readonly unknown[]
      ? {
          readonly [TKey in keyof TValue]: RevealedModuleCapabilities<
            TValue[TKey]
          >;
        }
      : TValue extends (...args: never[]) => unknown
        ? TValue
        : TValue extends object
          ? {
              readonly [TKey in keyof TValue]: TKey extends string | number
                ? RevealedModuleCapabilities<TValue[TKey]>
                : TValue[TKey];
            }
          : TValue;

export type SchemaOfEvent<TEvent extends EventToken> =
  TEvent extends EventToken<string, string, infer TSchemaValue, TSchema | null>
    ? TSchemaValue
    : never;

type RuntimePort<
  TSchemaValue extends TSchema = TSchema,
  TName extends string = string,
  TSettlementValueSchema extends TSchema | null = TSchema | null,
> = TSchemaValue & {
  readonly [eventPortBrand]: TSchemaValue;
  readonly [eventPortNameBrand]: TName;
  readonly [eventPortSettlementBrand]: TSettlementValueSchema;
  readonly definition: TSchema | EventToken;
  readonly localName: TName;
  readonly settlementValueSchema: TSchema | null;
  readonly source: RuntimePort | null;
};

export type OperatorOriginEvent<TSchemaValue extends TSchema> = {
  readonly eventId: number;
  readonly ref: EventRef<string>;
  readonly tsMs: number;
  readonly eventName: string;
  readonly payload: Static<TSchemaValue>;
  readonly causationEventId: number | null;
  readonly causationWork: EventCausationWork | null;
  readonly dedupeKey: string | null;
};

type RuntimeBinding =
  | {
      readonly bindingId: string;
      readonly source: RuntimePort;
      readonly output: RuntimePort;
      readonly operator: MapAsync<string, TSchema, TSchema>;
    }
  | {
      readonly bindingId: string;
      readonly source: RuntimePort;
      readonly output: null;
      readonly operator: ForEach<string, TSchema>;
    };

type RuntimeOperatorIndexerDefinition = {
  readonly [operatorIndexerPortBrand]: RuntimePort;
};

export interface OperatorBindingDefinition {
  event<const TName extends string, const TEventSchema extends TSchema>(
    name: TName,
    schema: TEventSchema,
  ): EventPort<TEventSchema, TName>;

  import<const TEvent extends EventToken>(
    event: TEvent,
  ): EventPort<SchemaOfEvent<TEvent>>;

  indexer<TSchemaValue extends TSchema, TName extends string>(
    source: EventPort<TSchemaValue, TName, TSchema | null>,
  ): { readonly sourceEvent: TName; readonly input: TSchemaValue };

  bind<
    const TBindingId extends string,
    TInputSchema extends TSchema,
    TOutputSchema extends TSchema,
  >(
    bindingId: TBindingId,
    source: EventPort<TInputSchema, string, null>,
    operator: MapAsync<string, TInputSchema, TOutputSchema>,
  ): EventPort<
    OperatorSettlementSchema<TOutputSchema>,
    TBindingId,
    TOutputSchema
  >;

  bind<
    const TBindingId extends string,
    TInputSchema extends TSchema,
    TOutputSchema extends TSchema,
  >(
    bindingId: TBindingId,
    source: EventPort<
      OperatorSettlementSchema<TInputSchema>,
      string,
      TInputSchema
    >,
    operator: MapAsync<string, TInputSchema, TOutputSchema>,
  ): EventPort<
    OperatorSettlementSchema<TOutputSchema>,
    TBindingId,
    TOutputSchema
  >;

  bind<const TBindingId extends string, TInputSchema extends TSchema>(
    bindingId: TBindingId,
    source: EventPort<TInputSchema, string, null>,
    operator: ForEach<string, TInputSchema>,
  ): Sink;

  bind<const TBindingId extends string, TInputSchema extends TSchema>(
    bindingId: TBindingId,
    source: EventPort<
      OperatorSettlementSchema<TInputSchema>,
      string,
      TInputSchema
    >,
    operator: ForEach<string, TInputSchema>,
  ): Sink;

  origin<
    TProjectionSchema extends AnyProjectionSchema,
    TEvents extends Record<string, TSchema>,
    TSignals extends Record<string, TSchema>,
    TAncestorSchema extends TSchema,
    TAncestorSettlementSchema extends TSchema | null,
  >(
    input: {
      readonly event: ProjectionIndexerEvent<string>;
      readonly db: ProjectionReadDatabase<TProjectionSchema, TEvents, TSignals>;
    },
    ancestor: EventPort<TAncestorSchema, string, TAncestorSettlementSchema>,
  ): Promise<OperatorOriginEvent<TAncestorSchema>>;
}

type EventHandlerInput = {
  readonly event: {
    readonly eventId: number;
    readonly payload: unknown;
  };
  readonly actions: {
    index(indexName: string, input: unknown): Promise<void>;
    enqueue(
      queueName: string,
      payload: unknown,
      options: { readonly workKey: string },
    ): Promise<unknown>;
  };
};

type QueueHandlerInput = {
  readonly work: {
    readonly attempt: number;
    readonly payload: unknown;
    readonly sourceEventId: number;
  };
  readonly lease: { readonly signal: AbortSignal };
  readonly control: {
    withTimeout<TResult>(
      timeoutMs: number,
      operation: (signal: AbortSignal) => Promise<TResult>,
    ): Promise<TResult>;
    deadLetter(error: unknown): never;
  };
  readonly actions: {
    emit(eventName: string, payload: unknown): void;
  };
};

type RuntimeRegistration = {
  readonly events?: Readonly<
    Record<string, (input: EventHandlerInput) => unknown>
  >;
  readonly queues?: Readonly<
    Record<string, (input: QueueHandlerInput) => unknown>
  >;
  readonly [key: string]: unknown;
};

/** Private compiler state owned by one `defineModule` invocation. */
export function createOperatorBindingCompiler(moduleId: string): {
  readonly definition: OperatorBindingDefinition;
  augmentContract(input: {
    readonly events: Readonly<Record<string, TSchema | EventToken>>;
    readonly queues?: Readonly<Record<string, TSchema>>;
  }): {
    readonly events: Record<string, TSchema | EventToken>;
    readonly queues: Record<string, TSchema>;
  };
  augmentRegistration<TRegistration>(
    registration: TRegistration,
    indexers?: Readonly<Record<string, unknown>>,
  ): TRegistration;
  reveal(
    value: unknown,
    events: Readonly<Record<string, EventToken>>,
    preserve: (value: object) => boolean,
  ): unknown;
} {
  const ports = new Map<string, RuntimePort>();
  const imported = new Map<EventToken, RuntimePort>();
  const bindings: RuntimeBinding[] = [];
  let declared = false;

  const assertAuthoring = (): void => {
    if (declared) {
      throw new Error(
        "operator bindings must be defined before module.declare(...)",
      );
    }
  };
  const createPort = <
    TSchemaValue extends TSchema,
    TName extends string,
    TSettlementValueSchema extends TSchema | null,
  >(
    localName: TName,
    schema: TSchemaValue,
    definition: TSchema | EventToken,
    settlementValueSchema: TSettlementValueSchema,
    source: RuntimePort | null,
  ): RuntimePort<TSchemaValue, TName, TSettlementValueSchema> => {
    assertAuthoring();

    if (definition === schema && localName.startsWith(privateGraphIdPrefix)) {
      throw new Error(
        `operator graph id must not start with reserved prefix ${privateGraphIdPrefix}`,
      );
    }

    if (ports.has(localName)) {
      throw new Error(`duplicate operator graph id ${localName}`);
    }

    const port = Object.freeze(
      Object.assign({}, schema, {
        [eventPortBrand]: schema,
        [eventPortNameBrand]: localName,
        [eventPortSettlementBrand]: settlementValueSchema,
        definition,
        localName,
        settlementValueSchema,
        source,
      }),
    );
    ports.set(localName, port);
    return port;
  };
  const event: OperatorBindingDefinition["event"] = (name, schema) =>
    createPort(name, schema, schema, null, null);
  const indexer: OperatorBindingDefinition["indexer"] = (source) => {
    const port = readPort(source);

    if (ports.get(port.localName) !== port) {
      throw new Error("event port does not belong to this ledger module");
    }

    const definition = Object.freeze({
      [operatorIndexerPortBrand]: port,
      sourceEvent: port.localName,
      input: source,
    });
    return definition;
  };
  const importEvent: OperatorBindingDefinition["import"] = (external) => {
    assertAuthoring();
    const existing = imported.get(external);

    if (existing !== undefined) {
      return existing as unknown as EventPort<SchemaOfEvent<typeof external>>;
    }

    const schema = operatorInputPlaceholder as SchemaOfEvent<typeof external>;
    const port = createPort(
      `${privateGraphIdPrefix}import_${imported.size}`,
      schema,
      external,
      null,
      null,
    );
    imported.set(external, port);
    return port;
  };
  function bind<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
    bindingId: string,
    source: EventPort<TInputSchema, string, TSchema | null>,
    operator:
      | MapAsync<string, TInputSchema, TOutputSchema>
      | ForEach<string, TInputSchema>,
  ):
    | EventPort<OperatorSettlementSchema<TOutputSchema>, string, TOutputSchema>
    | Sink {
    assertAuthoring();
    const runtimeSource = readPort(source);

    if (ports.get(runtimeSource.localName) !== runtimeSource) {
      throw new Error("event port does not belong to this ledger module");
    }

    if (bindings.some((binding) => binding.bindingId === bindingId)) {
      throw new Error(`duplicate operator binding id ${bindingId}`);
    }

    if (bindingId.startsWith(privateGraphIdPrefix)) {
      throw new Error(
        `operator binding id must not start with reserved prefix ${privateGraphIdPrefix}`,
      );
    }

    if (operator instanceof MapAsync) {
      const outputSchema = SettlementSchema(operator.output);
      const output = createPort(
        bindingId,
        outputSchema,
        outputSchema,
        operator.output,
        runtimeSource,
      );
      bindings.push({
        bindingId,
        source: runtimeSource,
        output,
        operator: operator as MapAsync<string, TSchema, TSchema>,
      });
      return output;
    }

    if (!(operator instanceof ForEach)) {
      throw new Error("invalid operator");
    }

    if (ports.has(bindingId)) {
      throw new Error(`duplicate operator graph id ${bindingId}`);
    }

    bindings.push({
      bindingId,
      source: runtimeSource,
      output: null,
      operator: operator as ForEach<string, TSchema>,
    });
    return Object.freeze({ [sinkBrand]: true as const });
  }
  const origin: OperatorBindingDefinition["origin"] = async (
    input,
    ancestor,
  ) => {
    const current = ports.get(input.event.eventName);
    const target = readPort(ancestor);

    if (current === undefined || ports.get(target.localName) !== target) {
      throw new Error("operator origin is outside this ledger module");
    }

    let source = current.source;
    let causationEventId = input.event.causationEventId;
    // The compiler has already proved every path member belongs to the
    // declaration. ProjectionReadDatabase cannot express that runtime-derived
    // event-name union, so this internal reader restores the proven shape.
    const readEvent = input.db.readEvent as unknown as (
      ref: EventRef<string>,
    ) => Promise<OperatorOriginEvent<TSchema> | null>;

    while (source !== null && causationEventId !== null) {
      const event = await readEvent(
        createEventRef(source.localName, causationEventId),
      );

      if (event === null) {
        throw new Error(
          `operator event ${current.localName} lost ancestor ${source.localName}`,
        );
      }

      if (source === target) {
        return event as OperatorOriginEvent<typeof ancestor>;
      }

      source = source.source;
      causationEventId = event.causationEventId;
    }

    throw new Error(
      `operator event ${current.localName} does not descend from ${target.localName}`,
    );
  };

  return {
    definition: Object.freeze({
      event,
      import: importEvent,
      bind: bind as OperatorBindingDefinition["bind"],
      indexer,
      origin,
    }),
    augmentContract: (input) => {
      assertAuthoring();
      declared = true;
      const events: Record<string, TSchema | EventToken> = {};
      const queues = { ...input.queues };

      for (const [localName, definition] of Object.entries(input.events)) {
        const ownedPort = ports.get(localName);

        if (ownedPort !== undefined && definition !== ownedPort) {
          throw new Error(
            `ledger event ${localName} conflicts with an operator port`,
          );
        }

        if (typeof definition === "object" && eventPortBrand in definition) {
          const port = readPort(definition as EventPort<TSchema>);

          if (
            ports.get(port.localName) !== port ||
            port.localName !== localName
          ) {
            throw new Error(
              `event port ${localName} does not belong to this ledger module declaration`,
            );
          }

          setOwn(events, localName, port.definition);
        } else {
          setOwn(events, localName, definition);
        }
      }

      for (const port of ports.values()) {
        if (!Object.hasOwn(events, port.localName)) {
          setOwn(events, port.localName, port.definition);
        }
      }

      for (const binding of bindings) {
        if (Object.hasOwn(queues, binding.bindingId)) {
          throw new Error(`duplicate ledger queue ${binding.bindingId}`);
        }

        setOwn(
          queues,
          binding.bindingId,
          binding.source.settlementValueSchema === null
            ? binding.operator.input
            : binding.source,
        );
      }

      return { events, queues };
    },
    augmentRegistration: <TRegistration>(
      registration: TRegistration,
      indexerDefinitions = {},
    ) => {
      const existing = registration as RuntimeRegistration;
      const downstreamBySource = Map.groupBy(
        bindings,
        (binding) => binding.source.localName,
      );
      const events = { ...existing.events };
      const queues = { ...existing.queues };
      const operatorIndexersBySource = new Map<string, string[]>();

      for (const [indexerName, definition] of Object.entries(
        indexerDefinitions,
      )) {
        if (typeof definition !== "object" || definition === null) {
          continue;
        }

        const port = (definition as Partial<RuntimeOperatorIndexerDefinition>)[
          operatorIndexerPortBrand
        ];

        if (port === undefined || ports.get(port.localName) !== port) {
          continue;
        }

        const names = operatorIndexersBySource.get(port.localName) ?? [];
        names.push(indexerName);
        operatorIndexersBySource.set(port.localName, names);
      }

      for (const sourceName of new Set([
        ...downstreamBySource.keys(),
        ...operatorIndexersBySource.keys(),
      ])) {
        const downstream = downstreamBySource.get(sourceName) ?? [];
        const indexerNames = operatorIndexersBySource.get(sourceName) ?? [];
        const existingHandler = Object.hasOwn(events, sourceName)
          ? events[sourceName]
          : undefined;
        setOwn(events, sourceName, async (input: EventHandlerInput) => {
          await Promise.all(
            indexerNames.map(async (indexerName) => {
              await input.actions.index(indexerName, input.event.payload);
            }),
          );
          await existingHandler?.({
            ...input,
            actions: {
              ...input.actions,
              index: async (indexerName, indexInput) => {
                if (indexerNames.includes(indexerName)) {
                  throw new Error(
                    `operator indexer ${indexerName} is dispatched automatically`,
                  );
                }

                await input.actions.index(indexerName, indexInput);
              },
            },
          });
          await Promise.all(
            downstream.map(async (binding) => {
              await input.actions.enqueue(
                binding.bindingId,
                input.event.payload,
                {
                  workKey: createOperatorAttemptKey(
                    moduleId,
                    binding.bindingId,
                    input.event.eventId,
                  ),
                },
              );
            }),
          );
        });
      }

      for (const binding of bindings) {
        setOwn(queues, binding.bindingId, async (input: QueueHandlerInput) => {
          const key = createOperatorAttemptKey(
            moduleId,
            binding.bindingId,
            input.work.sourceEventId,
          );

          if (binding.output !== null) {
            let settlement: OperatorSettlement<unknown>;
            const sourceSettlement = decodeSourceSettlement(
              binding.source,
              input.work.payload,
            );

            if (sourceSettlement?.outcome === "failed") {
              input.actions.emit(binding.output.localName, sourceSettlement);
              return;
            }

            const rawOperatorInput =
              sourceSettlement?.outcome === "succeeded"
                ? sourceSettlement.value
                : input.work.payload;

            try {
              const operatorInput = Value.Decode(
                binding.operator.input,
                rawOperatorInput,
              );
              const output = await input.control.withTimeout(
                binding.operator.timeoutMs,
                async (signal) =>
                  await binding.operator.map(operatorInput, {
                    key,
                    attempt: input.work.attempt,
                    signal,
                  }),
              );
              input.lease.signal.throwIfAborted();
              Value.Assert(binding.operator.output, output);
              settlement = {
                outcome: "succeeded",
                value: Value.Decode(binding.operator.output, output),
              };
            } catch (cause: unknown) {
              input.lease.signal.throwIfAborted();
              settlement = {
                outcome: "failed",
                error: serializeException(
                  new UncaughtOperatorError(
                    binding.operator.name,
                    binding.bindingId,
                    cause,
                  ),
                ),
              };
            }

            input.actions.emit(binding.output.localName, settlement);
            return;
          }

          const context: AsyncOperatorContext = {
            key,
            attempt: input.work.attempt,
            signal: input.lease.signal,
          };

          const sourceSettlement = decodeSourceSettlement(
            binding.source,
            input.work.payload,
          );

          if (sourceSettlement?.outcome === "failed") {
            return;
          }

          const rawOperatorInput =
            sourceSettlement?.outcome === "succeeded"
              ? sourceSettlement.value
              : input.work.payload;

          let operatorInput: Static<TSchema>;

          try {
            operatorInput = Value.Decode(
              binding.operator.input,
              rawOperatorInput,
            );
          } catch (cause: unknown) {
            input.control.deadLetter(
              new UncaughtOperatorError(
                binding.operator.name,
                binding.bindingId,
                cause,
              ),
            );
          }

          try {
            await binding.operator.run(operatorInput, context);
            input.lease.signal.throwIfAborted();
          } catch (cause: unknown) {
            throw new UncaughtOperatorError(
              binding.operator.name,
              binding.bindingId,
              cause,
            );
          }
        });
      }

      return { ...existing, events, queues } as TRegistration;
    },
    reveal: (value, events, preserve) =>
      mapRevealed(value, events, preserve, ports).value,
  };
}

function createOperatorAttemptKey(
  moduleId: string,
  bindingId: string,
  sourceEventId: number,
): string {
  return `${moduleId}:${bindingId}:${sourceEventId}`;
}

function readPort<
  TSchemaValue extends TSchema,
  TName extends string,
  TSettlementValueSchema extends TSchema | null,
>(
  port: EventPort<TSchemaValue, TName, TSettlementValueSchema>,
): RuntimePort<TSchemaValue, TName, TSettlementValueSchema> {
  const candidate = port as Partial<
    RuntimePort<TSchemaValue, TName, TSettlementValueSchema>
  >;

  if (
    typeof candidate.localName !== "string" ||
    candidate[eventPortBrand] === undefined
  ) {
    throw new Error("event port does not belong to this ledger module");
  }

  return candidate as RuntimePort<TSchemaValue, TName, TSettlementValueSchema>;
}

function decodeSourceSettlement(
  source: RuntimePort,
  payload: unknown,
): OperatorSettlement<unknown> | null {
  if (source.settlementValueSchema === null) {
    return null;
  }

  return Value.Decode(source, payload) as OperatorSettlement<unknown>;
}

function mapRevealed(
  value: unknown,
  events: Readonly<Record<string, EventToken>>,
  preserve: (value: object) => boolean,
  ownedPorts: ReadonlyMap<string, RuntimePort>,
): RevealResult {
  if (typeof value !== "object" || value === null) {
    return { value, changed: false };
  }

  if (eventPortBrand in value) {
    const port = readPort(value as EventPort<TSchema>);
    const localName = port.localName;

    if (ownedPorts.get(localName) !== port) {
      throw new Error("event port does not belong to this ledger module");
    }

    const event = events[localName];

    if (event === undefined) {
      throw new Error(`ledger module lost operator event ${localName}`);
    }

    return { value: event, changed: true };
  }

  if (preserve(value)) {
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    const entries = value.map((entry) =>
      mapRevealed(entry, events, preserve, ownedPorts),
    );

    if (!entries.some((entry) => entry.changed)) {
      return { value, changed: false };
    }

    return {
      value: Object.freeze(entries.map((entry) => entry.value)),
      changed: true,
    };
  }

  const prototype = Object.getPrototypeOf(value) as object | null;

  if (prototype !== Object.prototype && prototype !== null) {
    return { value, changed: false };
  }

  const entries = Object.entries(value).map(([key, entry]) => ({
    key,
    mapped: mapRevealed(entry, events, preserve, ownedPorts),
  }));

  if (!entries.some((entry) => entry.mapped.changed)) {
    return { value, changed: false };
  }

  const clone = {
    ...(value as Readonly<Record<PropertyKey, unknown>>),
  };

  for (const entry of entries) {
    setOwn(clone, entry.key, entry.mapped.value);
  }

  Object.freeze(clone);
  return { value: clone, changed: true };
}

type RevealResult = {
  readonly value: unknown;
  readonly changed: boolean;
};

function setOwn<TValue>(
  target: Record<string, TValue>,
  key: string,
  value: TValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

// Imported event schemas are carried by their operator input contract. This
// sentinel is never passed to the ledger declaration or used for decoding.
const operatorInputPlaceholder = {} as TSchema;

function assertTimeoutMs(timeoutMs: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "operator timeoutMs must be a positive integer no greater than 2,147,483,647",
    );
  }
}
