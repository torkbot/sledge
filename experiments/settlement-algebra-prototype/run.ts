import { createInterface } from "node:readline/promises";

import {
  initialState,
  transition,
  type PrototypeAction,
  type PrototypeState,
} from "./model.ts";
import { runDurableDemo } from "./durable-demo.ts";
import { runFailureAudit } from "./failure-audit.ts";

const actions = new Map<string, PrototypeAction>([
  ["t", { type: "root-threw" }],
  ["s", { type: "root-succeeded" }],
  ["f", { type: "root-failed" }],
  ["c", { type: "root-cancelled" }],
  ["d", { type: "derived-threw" }],
  ["v", { type: "derived-succeeded" }],
  ["e", { type: "derived-failed" }],
  ["x", { type: "derived-cancelled" }],
  ["r", { type: "reset" }],
]);

async function main(): Promise<void> {
  if (process.argv.includes("--failure-audit")) {
    console.log(JSON.stringify(await runFailureAudit(), null, 2));
    return;
  }

  if (process.argv.includes("--durable")) {
    console.log(JSON.stringify(await runDurableDemo(), null, 2));
    return;
  }

  if (process.argv.includes("--demo")) {
    console.log(JSON.stringify(runDemo(), null, 2));
    return;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let state = initialState();

  try {
    for (;;) {
      render(state);
      const command = (await readline.question("> ")).trim().toLowerCase();

      if (command === "q") {
        return;
      }

      const action = actions.get(command);

      if (action === undefined) {
        state = { ...state, lastAction: `unknown command ${command}` };
        continue;
      }

      try {
        state = transition(state, action);
      } catch (error: unknown) {
        state = {
          ...state,
          lastAction:
            error instanceof Error ? error.message : "unknown transition error",
        };
      }
    }
  } finally {
    readline.close();
  }
}

function runDemo(): readonly PrototypeState[] {
  const traces: PrototypeState[] = [];

  traces.push(
    runScenario([
      { type: "root-threw" },
      { type: "root-succeeded" },
      { type: "derived-threw" },
      { type: "derived-succeeded" },
    ]),
  );
  traces.push(runScenario([{ type: "root-failed" }]));
  traces.push(runScenario([{ type: "root-cancelled" }]));
  traces.push(
    runScenario([{ type: "root-succeeded" }, { type: "derived-failed" }]),
  );

  return traces;
}

function runScenario(actions: readonly PrototypeAction[]): PrototypeState {
  return actions.reduce(transition, initialState());
}

function render(state: PrototypeState): void {
  console.clear();
  console.log("\x1b[1mSettlement algebra prototype\x1b[0m");
  console.log(
    "\x1b[2mThrowing retries an attempt; settlements terminate durable programs.\x1b[0m\n",
  );
  console.log("\x1b[1mState\x1b[0m");
  console.log(JSON.stringify(state, null, 2));
  console.log("\n\x1b[1mRoot\x1b[0m");
  console.log(
    "\x1b[1m[t]\x1b[0m throw  \x1b[1m[s]\x1b[0m succeed  \x1b[1m[f]\x1b[0m fail  \x1b[1m[c]\x1b[0m cancel",
  );
  console.log("\x1b[1mDerived\x1b[0m");
  console.log(
    "\x1b[1m[d]\x1b[0m throw  \x1b[1m[v]\x1b[0m succeed  \x1b[1m[e]\x1b[0m fail  \x1b[1m[x]\x1b[0m cancel",
  );
  console.log("\x1b[1m[r]\x1b[0m reset  \x1b[1m[q]\x1b[0m quit");
}

main().catch((error: unknown) => {
  console.error("Settlement algebra prototype failed", error);
  process.exitCode = 1;
});
