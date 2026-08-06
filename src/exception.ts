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

    const cause = exceptionCause(current);

    if (cause === noExceptionCause) {
      break;
    }

    current = cause;
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
  if (isError(thrown)) {
    return {
      name: readErrorString(thrown, "name", "Error"),
      message: readErrorString(thrown, "message", "<unreadable error message>"),
      stack: readErrorStack(thrown),
    };
  }

  return {
    name: "NonErrorThrown",
    message: safeString(thrown),
    stack: null,
  };
}

const noExceptionCause = Symbol("no exception cause");

function exceptionCause(error: unknown): unknown | typeof noExceptionCause {
  if (!isError(error)) {
    return noExceptionCause;
  }

  try {
    const cause = error.cause;
    return cause === undefined ? noExceptionCause : cause;
  } catch {
    return noExceptionCause;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readErrorString(
  error: Error,
  property: "name" | "message",
  fallback: string,
): string {
  try {
    const value = error[property];
    return typeof value === "string" ? value : safeString(value);
  } catch {
    return fallback;
  }
}

function readErrorStack(error: Error): string | null {
  try {
    return typeof error.stack === "string" ? error.stack : null;
  } catch {
    return null;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unprintable thrown value>";
  }
}
