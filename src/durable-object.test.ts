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
  const application = createDurableObjectApplication();

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

test("the Durable Object driver closes after accepted writes settle", async () => {
  const database = new Database(":memory:");
  const transactionEntered = Promise.withResolvers<void>();
  const releaseTransaction = Promise.withResolvers<void>();
  let pauseTransactions = false;
  const storage = {
    sql: createSqlStorage(database),
    transaction: async <T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> => {
      if (pauseTransactions) {
        transactionEntered.resolve();
        await releaseTransaction.promise;
      }

      return await closure({ rollback: () => undefined });
    },
  } satisfies SledgeDurableObjectStorage;
  const application = createDurableObjectApplication();
  const opened = await application.open(
    createDurableObjectDriver({
      databaseIdentity: "durable-object:close",
      storage,
    }),
  );
  let emit: Promise<unknown> | null = null;
  let close: Promise<void> | null = null;

  try {
    pauseTransactions = true;
    emit = opened.ledger.emit(
      opened.capabilities.messages.events.received,
      "in flight",
    );
    await transactionEntered.promise;

    let closeDidSettle = false;
    close = opened.close().then(() => {
      closeDidSettle = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      assert.equal(closeDidSettle, false);
    } finally {
      releaseTransaction.resolve();
    }

    await emit;
    await close;
  } finally {
    releaseTransaction.resolve();
    await Promise.allSettled([
      ...(emit === null ? [] : [emit]),
      ...(close === null ? [] : [close]),
    ]);
    await opened.close();
    database.close();
  }
});

test("the Durable Object driver serializes reads behind active host transactions", async () => {
  const database = new Database(":memory:");
  const transactionEntered = Promise.withResolvers<void>();
  const releaseTransaction = Promise.withResolvers<void>();
  let pauseTransactions = false;
  const storage = {
    sql: createSqlStorage(database),
    transaction: async <T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> => {
      if (pauseTransactions) {
        transactionEntered.resolve();
        await releaseTransaction.promise;
      }

      return await closure({ rollback: () => undefined });
    },
  } satisfies SledgeDurableObjectStorage;
  const application = createDurableObjectApplication();
  const opened = await application.open(
    createDurableObjectDriver({
      databaseIdentity: "durable-object:isolation",
      storage,
    }),
  );
  let emit: Promise<unknown> | null = null;
  let read: Promise<unknown> | null = null;

  try {
    pauseTransactions = true;
    emit = opened.ledger.emit(
      opened.capabilities.messages.events.received,
      "in flight",
    );
    await transactionEntered.promise;

    let readDidSettle = false;
    read = opened.ledger.listWork().then((work) => {
      readDidSettle = true;
      return work;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      assert.equal(readDidSettle, false);
    } finally {
      releaseTransaction.resolve();
    }

    await emit;
    await read;
  } finally {
    releaseTransaction.resolve();
    await Promise.allSettled([
      ...(emit === null ? [] : [emit]),
      ...(read === null ? [] : [read]),
    ]);
    await opened.close();
    database.close();
  }
});

function createDurableObjectApplication() {
  return defineLedger((sledge) => {
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
}

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
