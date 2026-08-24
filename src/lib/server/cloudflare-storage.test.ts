import assert from "node:assert/strict";
import { test } from "node:test";

const storageModule = "./cloudflare-storage.ts";
const {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  readVersionedDocument,
  writeVersionedDocument,
} = await import(storageModule) as typeof import("./cloudflare-storage");
import type { ErpD1Database } from "./cloudflare-storage";

type StoredRow = {
  value: string;
  version: number;
};

class FakeStatement {
  private values: unknown[] = [];
  private readonly database: FakeDatabase;
  private readonly query: string;

  constructor(database: FakeDatabase, query: string) {
    this.database = database;
    this.query = query;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    const row = this.database.rows.get(String(this.values[0]));
    return (row ? { ...row } : null) as T | null;
  }

  async run() {
    if (this.query.includes("INSERT OR IGNORE")) {
      const [key, value] = this.values.map(String);
      if (this.database.rows.has(key)) return { success: true, meta: { changes: 0 } };
      this.database.rows.set(key, { value, version: 1 });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("UPDATE erp_documents")) {
      const [value, , key, expectedVersion] = this.values;
      const row = this.database.rows.get(String(key));
      if (!row || row.version !== Number(expectedVersion)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.database.rows.set(String(key), { value: String(value), version: row.version + 1 });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: false, error: "Unexpected statement", meta: { changes: 0 } };
  }
}

class FakeDatabase {
  readonly rows = new Map<string, StoredRow>();

  prepare(query: string) {
    return new FakeStatement(this, query);
  }
}

test("versioned D1 documents insert, update and round-trip JSON", async () => {
  const database = new FakeDatabase() as unknown as ErpD1Database;
  assert.deepEqual(await readVersionedDocument(database, "schedule"), { value: null, version: 0 });

  await writeVersionedDocument(database, "schedule", [{ id: "one" }], 0);
  assert.deepEqual(await readVersionedDocument(database, "schedule"), {
    value: [{ id: "one" }],
    version: 1,
  });

  await writeVersionedDocument(database, "schedule", [{ id: "one" }, { id: "two" }], 1);
  assert.deepEqual(await readVersionedDocument(database, "schedule"), {
    value: [{ id: "one" }, { id: "two" }],
    version: 2,
  });
});

test("stale versions fail instead of overwriting a concurrent D1 update", async () => {
  const database = new FakeDatabase() as unknown as ErpD1Database;
  await writeVersionedDocument(database, "payments", [{ id: "original" }], 0);
  await writeVersionedDocument(database, "payments", [{ id: "winner" }], 1);

  await assert.rejects(
    writeVersionedDocument(database, "payments", [{ id: "stale" }], 1),
    CloudflareDocumentConflictError,
  );
  assert.deepEqual(await readVersionedDocument(database, "payments"), {
    value: [{ id: "winner" }],
    version: 2,
  });
});

test("invalid D1 document metadata is rejected", async () => {
  const fake = new FakeDatabase();
  fake.rows.set("broken", { value: "[]", version: 0 });
  await assert.rejects(
    readVersionedDocument(fake as unknown as ErpD1Database, "broken"),
    CloudflareStorageConfigurationError,
  );
});

test("oversized documents fail before D1 reaches its row limit", async () => {
  const database = new FakeDatabase() as unknown as ErpD1Database;
  await assert.rejects(
    writeVersionedDocument(database, "too-large", { value: "x".repeat(1_900_000) }, 0),
    CloudflareStorageConfigurationError,
  );
  assert.equal((database as unknown as FakeDatabase).rows.size, 0);
});
