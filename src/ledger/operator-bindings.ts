import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { EventToken } from "./ledger.ts";

const eventPortBrand: unique symbol = Symbol("sledge.experimental.eventPort");
const sinkBrand: unique symbol = Symbol("sledge.experimental.sink");
const privateGraphIdPrefix = "__sledge_";

export type AsyncOperatorContext = {
  /** Stable across retries and suitable for external idempotency. */
  readonly key: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
};

/** An immutable, reusable asynchronous transformation. */
export class MapAsync<
  const TName extends string,
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
> {
  readonly name: TName;
  readonly input: TInputSchema;
  readonly output: TOutputSchema;
  readonly map: (
    input: Static<TInputSchema>,
    context: AsyncOperatorContext,
  ) => Static<TOutputSchema> | Promise<Static<TOutputSchema>>;

  constructor(
    name: TName,
    definition: {
      readonly input: TInputSchema;
      readonly output: TOutputSchema;
      readonly map: MapAsync<TName, TInputSchema, TOutputSchema>["map"];
    },
  ) {
    this.name = name;
    this.input = definition.input;
    this.output = definition.output;
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

export type EventPort<TSchemaValue extends TSchema> = TSchemaValue & {
  readonly [eventPortBrand]: TSchemaValue;
};

/** A terminal binding that cannot be used as another event source. */
export interface Sink {
  readonly [sinkBrand]: true;
}

export type RevealedModuleCapabilities<TValue> =
  TValue extends EventPort<infer TSchemaValue>
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

type RuntimePort<TSchemaValue extends TSchema = TSchema> = TSchemaValue & {
  readonly [eventPortBrand]: TSchemaValue;
  readonly definition: TSchema | EventToken;
  readonly localName: string;
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

export interface OperatorBindingDefinition {
  event<const TName extends string, const TEventSchema extends TSchema>(
    name: TName,
    schema: TEventSchema,
  ): EventPort<TEventSchema>;

  import<const TEvent extends EventToken>(
    event: TEvent,
  ): EventPort<SchemaOfEvent<TEvent>>;

  bind<
    const TBindingId extends string,
    TInputSchema extends TSchema,
    TOutputSchema extends TSchema,
  >(
    bindingId: TBindingId,
    source: EventPort<TInputSchema>,
    operator: MapAsync<string, TInputSchema, TOutputSchema>,
  ): EventPort<TOutputSchema>;

  bind<const TBindingId extends string, TInputSchema extends TSchema>(
    bindingId: TBindingId,
    source: EventPort<TInputSchema>,
    operator: ForEach<string, TInputSchema>,
  ): Sink;
}

type EventHandlerInput = {
  readonly event: {
    readonly eventId: number;
    readonly payload: unknown;
  };
  readonly actions: {
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
  const createPort = <TSchemaValue extends TSchema>(
    localName: string,
    schema: TSchemaValue,
    definition: TSchema | EventToken = schema,
  ): RuntimePort<TSchemaValue> => {
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
        definition,
        localName,
      }),
    );
    ports.set(localName, port);
    return port;
  };
  const event: OperatorBindingDefinition["event"] = (name, schema) =>
    createPort(name, schema);
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
    );
    imported.set(external, port);
    return port;
  };
  function bind<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
    bindingId: string,
    source: EventPort<TInputSchema>,
    operator:
      | MapAsync<string, TInputSchema, TOutputSchema>
      | ForEach<string, TInputSchema>,
  ): EventPort<TOutputSchema> | Sink {
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
      const output = createPort(bindingId, operator.output);
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

  return {
    definition: Object.freeze({
      event,
      import: importEvent,
      bind: bind as OperatorBindingDefinition["bind"],
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

        setOwn(queues, binding.bindingId, binding.operator.input);
      }

      return { events, queues };
    },
    augmentRegistration: <TRegistration>(registration: TRegistration) => {
      const existing = registration as RuntimeRegistration;
      const downstreamBySource = Map.groupBy(
        bindings,
        (binding) => binding.source.localName,
      );
      const events = { ...existing.events };
      const queues = { ...existing.queues };

      for (const [sourceName, downstream] of downstreamBySource) {
        const existingHandler = Object.hasOwn(events, sourceName)
          ? events[sourceName]
          : undefined;
        setOwn(events, sourceName, async (input: EventHandlerInput) => {
          await existingHandler?.(input);
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
          const context: AsyncOperatorContext = {
            key: createOperatorAttemptKey(
              moduleId,
              binding.bindingId,
              input.work.sourceEventId,
            ),
            attempt: input.work.attempt,
            signal: input.lease.signal,
          };

          try {
            if (binding.output !== null) {
              const output = await binding.operator.map(
                input.work.payload,
                context,
              );
              input.lease.signal.throwIfAborted();
              Value.Assert(binding.operator.output, output);
              input.actions.emit(
                binding.output.localName,
                Value.Decode(binding.operator.output, output),
              );
            } else {
              await binding.operator.run(input.work.payload, context);
              input.lease.signal.throwIfAborted();
            }
          } catch (cause: unknown) {
            throw new Error(
              `operator ${binding.operator.name} failed at binding ${binding.bindingId}`,
              { cause },
            );
          }
        });
      }

      return { ...existing, events, queues } as TRegistration;
    },
    reveal: (value, events, preserve) =>
      mapRevealed(value, events, preserve, ports),
  };
}

function createOperatorAttemptKey(
  moduleId: string,
  bindingId: string,
  sourceEventId: number,
): string {
  return `${moduleId}:${bindingId}:${sourceEventId}`;
}

function readPort<TSchemaValue extends TSchema>(
  port: EventPort<TSchemaValue>,
): RuntimePort<TSchemaValue> {
  const candidate = port as Partial<RuntimePort>;

  if (
    typeof candidate.localName !== "string" ||
    candidate[eventPortBrand] === undefined
  ) {
    throw new Error("event port does not belong to this ledger module");
  }

  return candidate as RuntimePort<TSchemaValue>;
}

function mapRevealed(
  value: unknown,
  events: Readonly<Record<string, EventToken>>,
  preserve: (value: object) => boolean,
  ownedPorts: ReadonlyMap<string, RuntimePort>,
): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
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

    return event;
  }

  if (preserve(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => mapRevealed(entry, events, preserve, ownedPorts)),
    );
  }

  const prototype = Object.getPrototypeOf(value) as object | null;

  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const clone = {
    ...(value as Readonly<Record<PropertyKey, unknown>>),
  };

  for (const [key, entry] of Object.entries(value)) {
    setOwn(clone, key, mapRevealed(entry, events, preserve, ownedPorts));
  }

  Object.freeze(clone);
  return clone;
}

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
