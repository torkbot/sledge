import Database from "better-sqlite3";
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import {
  createDurableObjectDriver,
  type SledgeDurableObjectStorage,
} from "./durable-object.ts";
import { defineLedger, defineModule } from "./sledge.ts";

type DurableObjectTransaction = {
  rollback(): void;
};

test("the Durable Object driver writes through the host storage SQL API", async () => {
  const database = new Database(":memory:");
  const transactions: DurableObjectTransaction[] = [];
  const sql = createSqlStorage(database);
  const storage = {
    sql,
    transaction: async <T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> => {
      const transaction = { rollback: () => undefined };
      transactions.push(transaction);
      return await closure(transaction);
    },
  } satisfies SledgeDurableObjectStorage;
  const application = defineLedger((sledge) => {
    const messages = sledge.install(
      defineModule("contract.durable-object", (module) => {
        const declaration = module.declare({
          events: { received: Type.String() },
        });
        const registered = module.link(declaration, null, {
          events: { received: () => undefined },
        });

        return module.expose(registered, { events: registered.events });
      })(),
    );

    return { messages };
  });

  const opened = await application.open(
    createDurableObjectDriver({
      databaseIdentity: "durable-object:test",
      storage,
    }),
  );

  try {
    const committed = await opened.ledger.emit(
      opened.capabilities.messages.events.received,
      "hello",
    );

    assert.equal(committed.payload, "hello");
    assert.equal(transactions.length > 0, true);
  } finally {
    await opened.close();
    database.close();
  }
});

function createSqlStorage(database: Database.Database) {
  return {
    exec<
      TRow extends Record<
        string,
        ArrayBuffer | bigint | boolean | number | string | null
      >,
    >(
      query: string,
      ...bindings: readonly (
        | ArrayBuffer
        | bigint
        | boolean
        | number
        | string
        | null
      )[]
    ) {
      const encodedBindings = bindings.map((binding) =>
        typeof binding === "boolean" ? Number(binding) : binding,
      );
      let rows: TRow[] = [];
      let rowsWritten = 0;

      try {
        const statement = database.prepare(query);

        if (statement.reader) {
          rows = statement.all(...encodedBindings) as TRow[];
        } else {
          rowsWritten = statement.run(...encodedBindings).changes;
        }
      } catch (error: unknown) {
        if (
          encodedBindings.length !== 0 ||
          !(error instanceof RangeError) ||
          !error.message.includes("more than one statement")
        ) {
          throw error;
        }

        database.exec(query);
      }

      return {
        rowsWritten,
        toArray: () => rows,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
}
