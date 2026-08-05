import {
  Settlement,
  matchSettlement,
  type Settlement as TerminalSettlement,
} from "../../src/stdlib.ts";

export type RootFailure = {
  readonly stage: "root";
  readonly message: string;
};

export type DerivedFailure = {
  readonly stage: "derived";
  readonly message: string;
};

export type PipelineFailure = RootFailure | DerivedFailure;

export type PrototypeState = {
  readonly rootAttempts: number;
  readonly derivedAttempts: number;
  readonly root: TerminalSettlement<string, RootFailure> | null;
  readonly derived: TerminalSettlement<number, PipelineFailure> | null;
  readonly ordinaryProgramValue: string | null;
  readonly lastAction: string;
};

export type PrototypeAction =
  | { readonly type: "root-threw" }
  | { readonly type: "root-succeeded" }
  | { readonly type: "root-failed" }
  | { readonly type: "root-cancelled" }
  | { readonly type: "derived-threw" }
  | { readonly type: "derived-succeeded" }
  | { readonly type: "derived-failed" }
  | { readonly type: "derived-cancelled" }
  | { readonly type: "reset" };

export function initialState(): PrototypeState {
  return {
    rootAttempts: 0,
    derivedAttempts: 0,
    root: null,
    derived: null,
    ordinaryProgramValue: null,
    lastAction: "ready",
  };
}

export function transition(
  state: PrototypeState,
  action: PrototypeAction,
): PrototypeState {
  if (action.type === "reset") {
    return initialState();
  }

  if (action.type === "root-threw") {
    assertPending(state.root, "root");

    return {
      ...state,
      rootAttempts: state.rootAttempts + 1,
      lastAction: "root attempt threw; durable result remains pending",
    };
  }

  if (action.type === "root-succeeded") {
    assertPending(state.root, "root");

    return finish({
      ...state,
      rootAttempts: state.rootAttempts + 1,
      root: Settlement.succeeded("memory extracted"),
      lastAction: "root durably succeeded; derived program may now run",
    });
  }

  if (action.type === "root-failed") {
    assertPending(state.root, "root");
    const failure: RootFailure = {
      stage: "root",
      message: "input cannot be processed",
    };
    const settlement = Settlement.failed(failure);

    return finish({
      ...state,
      rootAttempts: state.rootAttempts + 1,
      root: settlement,
      derived: settlement,
      lastAction: "typed root failure propagated without running derived code",
    });
  }

  if (action.type === "root-cancelled") {
    assertPending(state.root, "root");
    const settlement = Settlement.cancelled();

    return finish({
      ...state,
      rootAttempts: state.rootAttempts + 1,
      root: settlement,
      derived: settlement,
      lastAction: "root cancellation propagated without becoming a failure",
    });
  }

  if (state.root?.outcome !== "succeeded") {
    throw new Error("derived code requires a successful root settlement");
  }

  assertPending(state.derived, "derived");

  if (action.type === "derived-threw") {
    return {
      ...state,
      derivedAttempts: state.derivedAttempts + 1,
      lastAction: "derived attempt threw; durable result remains pending",
    };
  }

  if (action.type === "derived-succeeded") {
    return finish({
      ...state,
      derivedAttempts: state.derivedAttempts + 1,
      derived: Settlement.succeeded(state.root.value.length),
      lastAction: "derived program durably succeeded",
    });
  }

  if (action.type === "derived-failed") {
    const failure: DerivedFailure = {
      stage: "derived",
      message: "compaction rejected the extracted memory",
    };

    return finish({
      ...state,
      derivedAttempts: state.derivedAttempts + 1,
      derived: Settlement.failed(failure),
      lastAction: "derived program durably failed with typed data",
    });
  }

  return finish({
    ...state,
    derivedAttempts: state.derivedAttempts + 1,
    derived: Settlement.cancelled(),
    lastAction: "derived program durably cancelled",
  });
}

function finish(state: PrototypeState): PrototypeState {
  if (state.derived === null) {
    return state;
  }

  return {
    ...state,
    ordinaryProgramValue: matchSettlement(state.derived, {
      succeeded: (value) => `value:${value}`,
      failed: (error) => `error:${error.stage}:${error.message}`,
      cancelled: () => "cancelled",
    }),
  };
}

function assertPending(
  settlement: TerminalSettlement<unknown, unknown> | null,
  name: string,
): asserts settlement is null {
  if (settlement !== null) {
    throw new Error(`${name} is already durably settled`);
  }
}
