import type { TSchema } from "typebox";
import type { StaticDecode } from "typebox/type";
import { Value } from "typebox/value";

/** Immutable artifact storage standing in for Harness-owned blob storage. */
export class PrototypeArtifactStore {
  readonly #artifacts = new Map<string, unknown>();

  put<TSchemaValue extends TSchema>(
    ref: string,
    schema: TSchemaValue,
    value: StaticDecode<TSchemaValue>,
  ): void {
    const encoded = Value.Encode(schema, value);
    const existing = this.#artifacts.get(ref);

    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(encoded)) {
        throw new Error(`artifact ${ref} is immutable`);
      }

      return;
    }

    this.#artifacts.set(ref, structuredClone(encoded));
  }

  get<TSchemaValue extends TSchema>(
    ref: string,
    schema: TSchemaValue,
  ): StaticDecode<TSchemaValue> {
    const encoded = this.#artifacts.get(ref);

    if (encoded === undefined) {
      throw new Error(`artifact ${ref} does not exist`);
    }

    return Value.Decode(schema, structuredClone(encoded));
  }
}
