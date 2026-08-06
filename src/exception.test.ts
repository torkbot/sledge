import assert from "node:assert/strict";
import test from "node:test";

import { rehydrateException, serializeException } from "./exception.ts";

test("exceptions have one canonical portable cause-chain representation", () => {
  const cause = new TypeError("invalid response");
  const thrown = new Error("provider failed", { cause });
  const serialized = serializeException(thrown);

  assert.deepEqual(
    serialized.chain.map(({ name, message }) => ({ name, message })),
    [
      { name: "Error", message: "provider failed" },
      { name: "TypeError", message: "invalid response" },
    ],
  );

  const rehydrated = rehydrateException(serialized);
  assert.equal(rehydrated.name, "Error");
  assert.equal(rehydrated.message, "provider failed");
  assert(rehydrated.cause instanceof Error);
  assert.equal(rehydrated.cause.name, "TypeError");
  assert.equal(rehydrated.cause.message, "invalid response");
});

test("non-error thrown values and cyclic causes remain finite", () => {
  const cyclic = new Error("cycle");
  Object.defineProperty(cyclic, "cause", { value: cyclic });

  assert.deepEqual(
    serializeException("plain failure").chain.map(({ name, message }) => ({
      name,
      message,
    })),
    [{ name: "NonErrorThrown", message: "plain failure" }],
  );
  assert.deepEqual(
    serializeException(cyclic).chain.map(({ name }) => name),
    ["Error", "CircularExceptionCause"],
  );
});

test("exception serialization survives throwing Error property getters", () => {
  const hostile = new Error("hidden");
  Object.defineProperties(hostile, {
    name: { get: () => assert.fail("name getter must not escape") },
    message: { get: () => assert.fail("message getter must not escape") },
    stack: { get: () => assert.fail("stack getter must not escape") },
    cause: { get: () => assert.fail("cause getter must not escape") },
  });

  assert.deepEqual(serializeException(hostile), {
    chain: [
      {
        name: "Error",
        message: "<unreadable error message>",
        stack: null,
      },
    ],
  });
});
