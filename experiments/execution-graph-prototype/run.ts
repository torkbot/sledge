import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type, type Static } from "typebox";

import { createBetterSqliteDriver } from "../../src/better-sqlite3.ts";
import {
  bindExecutionService,
  defineActivity,
  defineExecutionModule,
  defineExecutionProgram,
  defineExecutionService,
  type ExecutionRef,
} from "../../src/experimental/execution.ts";
import { VirtualRuntimeHarness } from "../../src/runtime/virtual-runtime.ts";
import { defineLedger } from "../../src/sledge.ts";
import {
  Settlement,
  type Settlement as TerminalSettlement,
} from "../../src/stdlib.ts";

const EpochInputSchema = Type.Object({
  epoch: Type.Integer({ minimum: 1 }),
  previousMemory: Type.String(),
  prefix: Type.Array(Type.String()),
});
const ExtractedMemorySchema = Type.Object({
  durableMemory: Type.String(),
  durableDelta: Type.Array(Type.String()),
});
const CompactionInputSchema = Type.Object({
  epoch: Type.Integer({ minimum: 1 }),
  previousMemory: Type.String(),
  prefix: Type.Array(Type.String()),
  memory: ExtractedMemorySchema,
});
const CompactedPrefixSchema = Type.Object({
  summary: Type.String(),
  omittedDurableDetails: Type.Array(Type.String()),
});
const EpochResultSchema = Type.Object({
  epoch: Type.Integer({ minimum: 1 }),
  memory: ExtractedMemorySchema,
  compactedPrefix: CompactedPrefixSchema,
});
const EpochFailureSchema = Type.Union([
  Type.Object({
    stage: Type.Literal("memory"),
    message: Type.String(),
  }),
  Type.Object({
    stage: Type.Literal("compaction"),
    message: Type.String(),
  }),
]);

type AttemptContext = {
  readonly attempt: number;
  readonly signal: AbortSignal;
};

type MemoryExtractor = (
  input: Static<typeof EpochInputSchema>,
  context: AttemptContext,
) => Promise<
  TerminalSettlement<
    Static<typeof ExtractedMemorySchema>,
    { readonly stage: "memory"; readonly message: string }
  >
>;

type PrefixCompactor = (
  input: Static<typeof CompactionInputSchema>,
  context: AttemptContext,
) => Promise<
  TerminalSettlement<
    Static<typeof CompactedPrefixSchema>,
    { readonly stage: "compaction"; readonly message: string }
  >
>;

const MemoryExtractor = defineExecutionService<
  "prototype.memory-extractor",
  MemoryExtractor
>("prototype.memory-extractor");
const PrefixCompactor = defineExecutionService<
  "prototype.prefix-compactor",
  PrefixCompactor
>("prototype.prefix-compactor");

const extractMemory = defineActivity(
  "prototype.extract-memory",
  MemoryExtractor,
  {
    inputSchema: EpochInputSchema,
    resultSchema: ExtractedMemorySchema,
    failureSchema: Type.Object({
      stage: Type.Literal("memory"),
      message: Type.String(),
    }),
    execute: async ({ input, service, attempt, signal }) => {
      return await service(input, { attempt, signal });
    },
  },
);

const compactPrefix = defineActivity(
  "prototype.compact-prefix",
  PrefixCompactor,
  {
    inputSchema: CompactionInputSchema,
    resultSchema: CompactedPrefixSchema,
    failureSchema: Type.Object({
      stage: Type.Literal("compaction"),
      message: Type.String(),
    }),
    execute: async ({ input, service, attempt, signal }) => {
      return await service(input, { attempt, signal });
    },
  },
);

const compactEpoch = defineExecutionProgram("prototype.compact-epoch", {
  inputSchema: EpochInputSchema,
  resultSchema: EpochResultSchema,
  failureSchema: EpochFailureSchema,
  build: (input) => {
    return extractMemory(input).flatMap((memory) => {
      return compactPrefix({
        epoch: input.epoch,
        previousMemory: input.previousMemory,
        prefix: input.prefix,
        memory,
      }).map((compactedPrefix) => ({
        epoch: input.epoch,
        memory,
        compactedPrefix,
      }));
    });
  },
});

async function main(): Promise<void> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "sledge-execution-graph-prototype-"),
  );
  const databaseUrl = join(directory.path, "PROTOTYPE-WIPE-ME.sqlite");
  const runtime = new VirtualRuntimeHarness(1_000_000);
  const trace: string[] = [];
  let memoryAttempts = 0;
  let compactionAttempts = 0;

  const memoryExtractor: MemoryExtractor = async (input, context) => {
    memoryAttempts += 1;
    trace.push(`memory attempt ${context.attempt}`);

    return Settlement.succeeded({
      durableMemory: `${input.previousMemory}\nUser prefers concise durable systems.`,
      durableDelta: ["User prefers concise durable systems."],
    });
  };
  const prefixCompactor: PrefixCompactor = async (input, context) => {
    compactionAttempts += 1;
    trace.push(
      `compaction attempt ${context.attempt} received ${input.memory.durableDelta.length} durable delta`,
    );

    if (context.attempt === 1) {
      throw new Error("prototype restart after compactor interruption");
    }

    return Settlement.succeeded({
      summary: "The user and assistant designed a durable execution graph.",
      omittedDurableDetails: [...input.memory.durableDelta],
    });
  };
  const application = defineLedger((sledge) => {
    const { execution } = sledge.install(
      defineExecutionModule("prototype.execution", {
        programs: [compactEpoch],
        services: [
          bindExecutionService(MemoryExtractor, memoryExtractor),
          bindExecutionService(PrefixCompactor, prefixCompactor),
        ],
      })(),
    );

    return { execution };
  });
  const input = {
    epoch: 7,
    previousMemory: "The user values ledger efficiency.",
    prefix: [
      "user: durable memory should move into the system prompt",
      "assistant: compaction can then omit the durable detail",
    ],
  };
  let ref: ExecutionRef<
    Static<typeof EpochResultSchema>,
    "prototype.compact-epoch"
  >;

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: (queue) => {
        assert.equal(queue.moduleId, "prototype.execution");
        return { maxInFlight: queue.name === "control" ? 2 : 1 };
      },
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 3,
    });

    ref = await opened.capabilities.execution.start(
      opened.ledger,
      compactEpoch,
      input,
      { key: `epoch:${input.epoch}` },
    );
    await waitFor(runtime, () => compactionAttempts === 1);
    trace.push("ledger closed with compaction pending retry");
  }

  await runtime.advanceByMs(10);

  {
    await using opened = await application.open(
      createBetterSqliteDriver({ databaseUrl }),
      runtime,
    );
    await using workers = await opened.ledger.startWorkers({
      configureQueue: (queue) => {
        assert.equal(queue.moduleId, "prototype.execution");
        return { maxInFlight: queue.name === "control" ? 2 : 1 };
      },
      scheduler: runtime.scheduler,
      defaultRetryDelayMs: 10,
      maxInFlight: 3,
    });

    let settlement: Awaited<
      ReturnType<typeof opened.capabilities.execution.read>
    > = null;
    await waitFor(runtime, async () => {
      settlement = await opened.capabilities.execution.read(
        opened.ledger,
        compactEpoch,
        ref,
      );
      return settlement !== null;
    });

    assert.equal(memoryAttempts, 1);
    assert.equal(compactionAttempts, 2);
    assert.deepEqual(settlement, {
      outcome: "succeeded",
      value: {
        epoch: 7,
        memory: {
          durableMemory:
            "The user values ledger efficiency.\nUser prefers concise durable systems.",
          durableDelta: ["User prefers concise durable systems."],
        },
        compactedPrefix: {
          summary: "The user and assistant designed a durable execution graph.",
          omittedDurableDetails: ["User prefers concise durable systems."],
        },
      },
    });
    assert.equal((await opened.ledger.listWork()).length, 0);

    console.log(
      JSON.stringify(
        {
          question:
            "Can one small graph preserve flatMap, restart, queue isolation, and service injection?",
          trace,
          serviceCalls: { memoryAttempts, compactionAttempts },
          settlement,
          remainingWork: [],
          verdict:
            "The memory result was journaled once, survived restart, and became the typed compaction input.",
        },
        null,
        2,
      ),
    );
  }
}

async function waitFor(
  runtime: VirtualRuntimeHarness,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await runtime.flush();

    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error("execution graph prototype timed out");
}

main().catch((error: unknown) => {
  console.error("execution graph prototype failed", error);
  process.exitCode = 1;
});
