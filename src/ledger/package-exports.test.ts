import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type PackageJson = {
  readonly exports: Readonly<Record<string, unknown>>;
};

test("package exports expose only supported public modules", async () => {
  const packageJson = decodePackageJson(
    JSON.parse(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "package.json",
        ),
        "utf8",
      ),
    ) as unknown,
  );

  assert.deepEqual(Object.keys(packageJson.exports).sort(), [
    "./better-sqlite3-ledger",
    "./ledger",
    "./runtime/contracts",
    "./runtime/node-runtime",
    "./runtime/virtual-runtime",
    "./turso-ledger",
  ]);

  for (const exportName of [
    "./database-ledger-engine",
    "./internal-storage",
    "./projection-access",
  ]) {
    assert.equal(Object.hasOwn(packageJson.exports, exportName), false);
  }
});

function decodePackageJson(value: unknown): PackageJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package.json must be an object");
  }

  const exportsValue = (value as { readonly exports?: unknown }).exports;

  if (
    typeof exportsValue !== "object" ||
    exportsValue === null ||
    Array.isArray(exportsValue)
  ) {
    throw new Error("package.json exports must be an object");
  }

  return {
    exports: exportsValue as Readonly<Record<string, unknown>>,
  };
}
