import { type Static, type TSchema } from "typebox";

import type { EventToken } from "../ledger.ts";
import { defineModule, type LedgerModuleContribution } from "../sledge.ts";

const eventPortBrand: unique symbol = Symbol("sledge.experimental.eventPort");
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

export interface EventPort<TSchemaValue extends TSchema> {
  readonly [eventPortBrand]: TSchemaValue;
}

const sinkBrand: unique symbol = Symbol("sledge.experimental.sink");

/** A terminal graph binding that cannot be used as another event source. */
export interface Sink {
  readonly [sinkBrand]: true;
}

type Revealed<TValue> =
  TValue extends EventPort<infer TSchemaValue>
    ? EventToken<string, string, TSchemaValue, null>
    : TValue extends Readonly<Record<string, unknown>>
      ? { readonly [TKey in keyof TValue]: Revealed<TValue[TKey]> }
      : never;

type RuntimePort<TSchemaValue extends TSchema = TSchema> = {
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

export interface OperatorModuleDefinition {
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

type SchemaOfEvent<TEvent extends EventToken> =
  TEvent extends EventToken<string, string, infer TSchemaValue, TSchema | null>
    ? TSchemaValue
    : never;

/**
 * Compiles a small operator graph into one ordinary ledger module. Operator
 * objects describe reusable behavior; binding ids own durable graph nodes.
 */
export function defineOperatorModule<
  const TModuleId extends string,
  const TRevealed extends Readonly<Record<string, unknown>>,
>(
  moduleId: TModuleId,
  define: (graph: OperatorModuleDefinition) => TRevealed,
): () => LedgerModuleContribution<Revealed<TRevealed>> {
  return defineModule(moduleId, (module) => {
    const ports = new Map<string, RuntimePort>();
    const imported = new Map<EventToken, RuntimePort>();
    const bindings: RuntimeBinding[] = [];

    const createPort = <TSchemaValue extends TSchema>(
      localName: string,
      schema: TSchemaValue,
      definition: TSchema | EventToken = schema,
    ): RuntimePort<TSchemaValue> => {
      if (definition === schema && localName.startsWith(privateGraphIdPrefix)) {
        throw new Error(
          `operator graph id must not start with reserved prefix ${privateGraphIdPrefix}`,
        );
      }

      if (ports.has(localName)) {
        throw new Error(`duplicate operator graph id ${localName}`);
      }

      const port = Object.freeze({
        [eventPortBrand]: schema,
        definition,
        localName,
      });
      ports.set(localName, port);
      return port;
    };
    const event: OperatorModuleDefinition["event"] = (name, schema) =>
      createPort(name, schema);
    const importEvent: OperatorModuleDefinition["import"] = (external) => {
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
      const runtimeSource = readPort(source);

      if (ports.get(runtimeSource.localName) !== runtimeSource) {
        throw new Error("event port does not belong to this operator graph");
      }

      if (bindings.some((binding) => binding.bindingId === bindingId)) {
        throw new Error(`duplicate operator binding id ${bindingId}`);
      }

      if (bindingId.startsWith(privateGraphIdPrefix)) {
        throw new Error(
          `operator binding id must not start with reserved prefix ${privateGraphIdPrefix}`,
        );
      }

      if (!(operator instanceof MapAsync) && !(operator instanceof ForEach)) {
        throw new Error("invalid operator");
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
    const graph: OperatorModuleDefinition = Object.freeze({
      event,
      import: importEvent,
      bind: bind as OperatorModuleDefinition["bind"],
    });
    const revealed = define(graph);
    const eventDefinitions: Record<string, TSchema | EventToken> = {};

    for (const port of ports.values()) {
      eventDefinitions[port.localName] = port.definition;
    }

    const queueDefinitions = Object.fromEntries(
      bindings.map((binding) => [binding.bindingId, binding.operator.input]),
    );
    const declaration = module.declare({
      events: eventDefinitions,
      queues: queueDefinitions,
    });
    const linked = module.link(declaration, null);
    const downstreamBySource = Map.groupBy(
      bindings,
      (binding) => binding.source.localName,
    );
    const eventHandlers = Object.fromEntries(
      [...downstreamBySource].map(([sourceName, downstream]) => [
        sourceName,
        async (input: {
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
        }) => {
          await Promise.all(
            downstream.map(async (binding) => {
              await input.actions.enqueue(
                binding.bindingId,
                input.event.payload,
                {
                  workKey: `${moduleId}:${binding.bindingId}:${input.event.eventId}`,
                },
              );
            }),
          );
        },
      ]),
    );
    const queueHandlers = Object.fromEntries(
      bindings.map((binding) => [
        binding.bindingId,
        async (input: {
          readonly work: {
            readonly attempt: number;
            readonly payload: unknown;
            readonly sourceEventId: number;
          };
          readonly lease: { readonly signal: AbortSignal };
          readonly actions: {
            emit(eventName: string, payload: unknown): void;
          };
        }) => {
          const context: AsyncOperatorContext = {
            key: `${moduleId}:${binding.bindingId}:${input.work.sourceEventId}`,
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
              input.actions.emit(binding.output.localName, output);
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
        },
      ]),
    );
    type Registration = Parameters<typeof linked.register>[0];
    const registered = linked.register({
      events: eventHandlers,
      queues: queueHandlers,
      queries: {},
    } as unknown as Registration);
    const capabilities = mapRevealed(revealed, declaration.events);

    return module.expose(registered, capabilities as Revealed<TRevealed>);
  });
}

function readPort<TSchemaValue extends TSchema>(
  port: EventPort<TSchemaValue>,
): RuntimePort<TSchemaValue> {
  const candidate = port as Partial<RuntimePort>;

  if (
    typeof candidate.localName !== "string" ||
    candidate[eventPortBrand] === undefined
  ) {
    throw new Error("event port does not belong to this operator graph");
  }

  return candidate as RuntimePort<TSchemaValue>;
}

function mapRevealed(
  value: unknown,
  events: Readonly<Record<string, EventToken>>,
): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error("operator modules may only reveal event ports");
  }

  if (eventPortBrand in value) {
    return events[readPort(value as EventPort<TSchema>).localName];
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        mapRevealed(nested, events),
      ]),
    ),
  );
}

// Imported event schemas are carried by their operator input contract. This
// sentinel is never passed to the ledger declaration or used for decoding.
const operatorInputPlaceholder = {} as TSchema;
