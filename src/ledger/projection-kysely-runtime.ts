import { createRequire } from "node:module";

import {
  createKyselySqliteProjectionStatementCompiler,
  type KyselyProjectionQueryCompilerConstructor,
} from "./projection-kysely-compiler.ts";
import type { ProjectionStatementCompiler } from "./projection-sql-compiler.ts";

const requireFromModule = createRequire(import.meta.url);

export function createRuntimeKyselySqliteProjectionStatementCompiler(): ProjectionStatementCompiler {
  const moduleUnknown: unknown = requireFromModule("kysely");

  return createKyselySqliteProjectionStatementCompiler({
    SqliteQueryCompiler: readKyselyQueryCompilerConstructor(
      moduleUnknown,
      "SqliteQueryCompiler",
    ),
  });
}

function readKyselyQueryCompilerConstructor(
  moduleUnknown: unknown,
  name: string,
): KyselyProjectionQueryCompilerConstructor {
  if (!isRecord(moduleUnknown)) {
    throw new Error("expected kysely module to be an object");
  }

  const constructorUnknown = moduleUnknown[name];

  if (typeof constructorUnknown !== "function") {
    throw new Error(`expected kysely module to export ${name}`);
  }

  return constructorUnknown as KyselyProjectionQueryCompilerConstructor;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
