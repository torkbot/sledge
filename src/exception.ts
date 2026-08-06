import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const maximumCauseDepth = 32;

export const SerializedExceptionFrameSchema = Type.Object({
  name: Type.String(),
  message: Type.String(),
  stack: Type.Union([Type.String(), Type.Null()]),
});

/**
 * A portable exception representation ordered from the thrown value through
 * its cause chain. A flat chain avoids recursive wire schemas and makes cyclic
 * or excessively deep JavaScript causes finite by construction.
 */
export const SerializedExceptionSchema = Type.Object({
  chain: Type.Array(SerializedExceptionFrameSchema, {
    minItems: 1,
    maxItems: maximumCauseDepth,
  }),
});

export type SerializedExceptionFrame = Static<
  typeof SerializedExceptionFrameSchema
>;
export type SerializedException = Static<typeof SerializedExceptionSchema>;

/** Converts any thrown JavaScript value into Sledge's canonical wire shape. */
export function serializeException(thrown: unknown): SerializedException {
  const chain: SerializedExceptionFrame[] = [];
  const seen = new Set<object>();
  let current: unknown = thrown;

  while (chain.length < maximumCauseDepth) {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        chain.push({
          name: "CircularExceptionCause",
          message: "exception cause chain contains a cycle",
          stack: null,
        });
        break;
      }

      seen.add(current);
    }

    chain.push(exceptionFrame(current));

    if (!(current instanceof Error) || current.cause === undefined) {
      break;
    }

    current = current.cause;
  }

  const serialized = { chain };
  Value.Assert(SerializedExceptionSchema, serialized);
  return Value.Decode(SerializedExceptionSchema, serialized);
}

/** Rehydrates a wire exception as ordinary Error instances with causes. */
export function rehydrateException(serialized: SerializedException): Error {
  const decoded = Value.Decode(SerializedExceptionSchema, serialized);
  let cause: Error | undefined;

  for (const frame of decoded.chain.toReversed()) {
    const error = new Error(frame.message, { cause });
    error.name = frame.name;

    if (frame.stack !== null) {
      error.stack = frame.stack;
    }

    cause = error;
  }

  if (cause === undefined) {
    throw new Error("serialized exception must contain at least one frame");
  }

  return cause;
}

function exceptionFrame(thrown: unknown): SerializedExceptionFrame {
  if (thrown instanceof Error) {
    return {
      name: thrown.name,
      message: thrown.message,
      stack: thrown.stack ?? null,
    };
  }

  return {
    name: "NonErrorThrown",
    message: safeString(thrown),
    stack: null,
  };
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unprintable thrown value>";
  }
}
