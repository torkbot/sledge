/** Internal enqueue policy reserved for compiled operator bindings. */
export const requireMatchingOperatorCoalescingPayload: unique symbol = Symbol(
  "sledge.operator.requireMatchingCoalescingPayload",
);

export type OperatorCoalescingEnqueueOptions = {
  readonly availableAtMs?: never;
  readonly coalescingKey: string;
  readonly partitionKey: string;
  readonly [requireMatchingOperatorCoalescingPayload]: true;
  readonly workKey?: never;
};
