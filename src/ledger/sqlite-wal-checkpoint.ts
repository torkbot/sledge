import { Type } from "typebox";
import { Value } from "typebox/value";

const WalCheckpointResultSchema = Type.Tuple([
  Type.Object({
    busy: Type.Union([Type.Literal(0), Type.Literal(1)]),
    log: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    checkpointed: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
]);

export function assertWalCheckpointTruncated(result: unknown): void {
  const [checkpoint] = Value.Decode(WalCheckpointResultSchema, result);

  if (checkpoint.busy === 0) {
    return;
  }

  throw new Error(
    "SQLite WAL checkpoint could not truncate because another connection is busy " +
      `(busy: ${checkpoint.busy}, log: ${formatFrameCount(checkpoint.log)}, ` +
      `checkpointed: ${formatFrameCount(checkpoint.checkpointed)})`,
  );
}

function formatFrameCount(value: number | null): string {
  return value === null ? "unknown" : String(value);
}
