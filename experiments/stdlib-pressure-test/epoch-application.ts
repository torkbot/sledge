import { defineLedger } from "@torkbot/sledge";

import { PrototypeArtifactStore } from "./artifact-store.ts";
import {
  DreamInputSchema,
  DreamOutputSchema,
  MemoryArtifactSchema,
  PrefixArtifactSchema,
  CompactionOutputSchema,
  type MemoryArtifact,
} from "./epoch-model.ts";
import { defineEpochPublisher } from "./epoch-publisher.ts";
import { defineInvocation, type PrototypeLogger } from "./invocation.ts";
import { defineThen } from "./then.ts";

export function createEpochPressureTestApplication(input: {
  readonly artifacts: PrototypeArtifactStore;
  readonly failCompactionOnceFor: ReadonlySet<string>;
}) {
  const log: string[] = [];
  const failuresRemaining = new Set(input.failCompactionOnceFor);
  const logger: PrototypeLogger = {
    info(message) {
      log.push(message);
    },
  };
  const defineDreaming = defineInvocation({
    moduleId: "prototype.dreaming",
    inputSchema: DreamInputSchema,
    outputSchema: DreamOutputSchema,
    maxAttempts: 2,
    timeoutMs: 30_000,
    logger,
    execute: async ({ input: request, signal }) => {
      signal.throwIfAborted();
      const previousMemory = input.artifacts.get(
        request.previousMemoryRef,
        MemoryArtifactSchema,
      );
      const rawPrefix = input.artifacts.get(
        request.rawPrefixRef,
        PrefixArtifactSchema,
      );
      const entries = new Map(
        previousMemory.entries.map((entry) => [entry.key, entry.value]),
      );

      for (const message of rawPrefix.messages) {
        if (message.cursor > request.cutoff) {
          throw new Error(
            `dreaming prefix crossed cutoff ${request.cutoff} at ${message.cursor}`,
          );
        }

        if (message.kind === "durable") {
          entries.set(message.memory.key, message.memory.value);
        }
      }

      const memoryRef = `artifact:memory:${request.attemptId}`;
      const memory: MemoryArtifact = {
        entries: [...entries.entries()]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, value })),
      };

      input.artifacts.put(memoryRef, MemoryArtifactSchema, memory);

      return {
        attemptId: request.attemptId,
        conversationId: request.conversationId,
        parentEpoch: request.parentEpoch,
        cutoff: request.cutoff,
        memoryRef,
        rawPrefixRef: request.rawPrefixRef,
      };
    },
  });
  const application = defineLedger((sledge) => {
    const dreaming = sledge.install(defineDreaming());
    const compactions = sledge.install(
      defineThen({
        moduleId: "prototype.memory-aware-compactions",
        source: dreaming.result,
        outputSchema: CompactionOutputSchema,
        maxAttempts: 3,
        timeoutMs: 30_000,
        logger,
        execute: async ({ value: dream, signal }) => {
          signal.throwIfAborted();

          if (failuresRemaining.delete(dream.attemptId)) {
            throw new Error(
              `simulated compaction interruption for ${dream.attemptId}`,
            );
          }

          const memory = input.artifacts.get(
            dream.memoryRef,
            MemoryArtifactSchema,
          );
          const rawPrefix = input.artifacts.get(
            dream.rawPrefixRef,
            PrefixArtifactSchema,
          );
          const durableKeys = new Set(memory.entries.map((entry) => entry.key));

          for (const message of rawPrefix.messages) {
            if (
              message.kind === "durable" &&
              !durableKeys.has(message.memory.key)
            ) {
              throw new Error(
                `compaction cannot drop uncommitted memory ${message.memory.key}`,
              );
            }
          }

          const compactedPrefixRef = `artifact:prefix:${dream.attemptId}`;

          input.artifacts.put(compactedPrefixRef, PrefixArtifactSchema, {
            messages: rawPrefix.messages.filter(
              (message) => message.kind === "transient",
            ),
          });

          return {
            attemptId: dream.attemptId,
            conversationId: dream.conversationId,
            parentEpoch: dream.parentEpoch,
            cutoff: dream.cutoff,
            memoryRef: dream.memoryRef,
            compactedPrefixRef,
          };
        },
      })(),
    );
    const epochs = sledge.install(
      defineEpochPublisher({
        moduleId: "prototype.epochs",
        source: compactions.result,
      })(),
    );

    return { compactions, dreaming, epochs };
  });

  return { application, log };
}
