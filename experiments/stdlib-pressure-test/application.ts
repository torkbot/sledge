import { defineLedger } from "@torkbot/sledge";
import { Type } from "typebox";

import { defineComposition } from "./composition.ts";
import { defineInvocation, type PrototypeLogger } from "./invocation.ts";

export const ToolCallInputSchema = Type.Object({
  toolName: Type.Literal("search_workspace"),
  query: Type.String({ minLength: 1 }),
  behavior: Type.Union([Type.Literal("succeed"), Type.Literal("fail")]),
});

export const ToolCallOutputSchema = Type.Object({
  matches: Type.Array(Type.String()),
});

export const CompactionInputSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  revisions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const CompactionOutputSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  keptRevision: Type.String({ minLength: 1 }),
  removedRevisions: Type.Integer({ minimum: 0 }),
});

export function createPressureTestApplication() {
  const log: string[] = [];
  const logger: PrototypeLogger = {
    info(message) {
      log.push(message);
    },
  };
  const defineToolCalls = defineInvocation({
    moduleId: "prototype.tool-calls",
    inputSchema: ToolCallInputSchema,
    outputSchema: ToolCallOutputSchema,
    maxAttempts: 2,
    timeoutMs: 5_000,
    logger,
    execute: async ({ input, signal }) => {
      signal.throwIfAborted();

      if (input.behavior === "fail") {
        throw new Error(`tool ${input.toolName} rejected ${input.query}`);
      }

      return {
        matches: [`src/${input.query}.ts`, `docs/${input.query}.md`],
      };
    },
  });
  const defineCompactions = defineInvocation({
    moduleId: "prototype.compactions",
    inputSchema: CompactionInputSchema,
    outputSchema: CompactionOutputSchema,
    maxAttempts: 3,
    timeoutMs: 30_000,
    logger,
    execute: async ({ input, signal }) => {
      signal.throwIfAborted();
      const keptRevision = input.revisions.at(-1);

      if (keptRevision === undefined) {
        throw new Error("decoded compaction has no revisions");
      }

      return {
        documentId: input.documentId,
        keptRevision,
        removedRevisions: input.revisions.length - 1,
      };
    },
  });
  const application = defineLedger((sledge) => {
    const toolCalls = sledge.install(defineToolCalls());
    const compactions = sledge.install(defineCompactions());
    const composition = sledge.install(
      defineComposition({
        moduleId: "prototype.composition",
        sources: {
          toolCalls: toolCalls.result,
          compactions: compactions.result,
        },
      })(),
    );

    return {
      composition,
      compactions,
      toolCalls,
    };
  });

  return {
    application,
    log,
  };
}
