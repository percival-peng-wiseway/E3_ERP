import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpVector } from "../server/cloudflare-storage";
// @ts-expect-error -- Node ESM tests require the explicit extension.
import { KnowledgeVectorProviderError, upsertKnowledgeChunks, type KnowledgeVectorProvider } from "./vectorize.ts";
import type { KnowledgeChunkDraft, KnowledgeDocument } from "./types";

const timestamp = "2026-08-31T00:00:00.000Z";

function document(): KnowledgeDocument {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "e3",
    fileId: "00000000-0000-4000-8000-000000000002",
    fileVersion: 1,
    title: "Multilingual commissioning manual",
    fileName: "manual.md",
    sourcePath: "Files / manual.md",
    contentType: "text/markdown",
    documentType: "manual",
    category: "commissioning",
    language: "multilingual",
    sourceChecksum: "a".repeat(64),
    version: "1.0",
    indexGeneration: 2,
    status: "indexing",
    accessScope: "pm",
    product: "H3",
    region: "AU",
    effectiveFrom: null,
    effectiveTo: null,
    tags: [],
    lastIndexedAt: null,
    errorCode: null,
    errorMessage: null,
    disabledAt: null,
    disabledReason: null,
    createdAt: timestamp,
    createdBy: "admin",
    updatedAt: timestamp,
    updatedBy: "admin",
  };
}

function chunks(count: number): KnowledgeChunkDraft[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `Procedure ${index + 1} 检查`,
    tokenCount: 4,
    headingPath: ["Commissioning"],
    pageFrom: index + 1,
    pageTo: index + 1,
    contentChecksum: String(index + 1).padStart(64, "0"),
    indexItemKey: `knowledge/${document().id}/g2/${String(index).padStart(5, "0")}`,
  }));
}

function provider(options: { visibleAfter?: number } = {}) {
  const stored = new Map<string, ErpVector>();
  const deleted: string[] = [];
  let reads = 0;
  const value = [1, ...Array.from({ length: 1_023 }, () => 0)];
  const instance: KnowledgeVectorProvider = {
    async embedDocuments(texts) { return texts.map(() => value); },
    async embedQuery() { return value; },
    async upsert(vectors) { vectors.forEach((vector) => stored.set(vector.id, vector)); return { mutationId: "mutation-1" }; },
    async deleteByIds(ids) { ids.forEach((id) => { deleted.push(id); stored.delete(id); }); return { mutationId: "mutation-delete" }; },
    async getByIds(ids) {
      reads += 1;
      if (reads < (options.visibleAfter || 1)) return [];
      return ids.flatMap((id) => stored.get(id) || []);
    },
    async query() { return []; },
    async describe() { return { vectorCount: stored.size, dimensions: 1_024, processedUpToDatetime: "", processedUpToMutation: "" }; },
  };
  return { instance, stored, deleted, get reads() { return reads; } };
}

test("ERP chunks are embedded once and become stable Vectorize IDs", async () => {
  const vectors = provider({ visibleAfter: 3 });
  let now = 0;
  const indexed = await upsertKnowledgeChunks({
    provider: vectors.instance,
    document: document(),
    chunks: chunks(3),
    providerTimeoutMs: 2_000,
    timing: { now: () => now, wait: async (milliseconds) => { now += milliseconds; } },
  });
  assert.equal(vectors.reads, 3);
  assert.equal(indexed.length, 3);
  assert.equal(indexed[0].indexItemId, indexed[0].indexItemKey);
  assert.equal(vectors.stored.get(indexed[0].indexItemId)?.namespace, "e3");
  assert.deepEqual(vectors.stored.get(indexed[0].indexItemId)?.metadata, {
    tenant_id: "e3",
    document_id: document().id,
    generation: 2,
    chunk_index: 0,
    access_scope: "pm",
    language: "multilingual",
    category: "commissioning",
    product: "H3",
    region: "AU",
  });
});

test("a Vectorize visibility timeout cleans the incomplete generation", async () => {
  const vectors = provider({ visibleAfter: Number.POSITIVE_INFINITY });
  let now = 0;
  await assert.rejects(
    upsertKnowledgeChunks({
      provider: vectors.instance,
      document: document(),
      chunks: chunks(2),
      providerTimeoutMs: 1_000,
      timing: { now: () => now, wait: async (milliseconds) => { now += milliseconds; } },
    }),
    (error: unknown) => error instanceof KnowledgeVectorProviderError && error.code === "index_timeout",
  );
  assert.equal(now, 1_000);
  assert.equal(vectors.stored.size, 0);
  assert.equal(vectors.deleted.length, 2);
});

test("embedding failures fail closed before D1 activation", async () => {
  const vectors = provider();
  vectors.instance.embedDocuments = async () => { throw new Error("offline"); };
  await assert.rejects(
    upsertKnowledgeChunks({ provider: vectors.instance, document: document(), chunks: chunks(1) }),
    (error: unknown) => error instanceof KnowledgeVectorProviderError && error.code === "index_failed",
  );
  assert.equal(vectors.stored.size, 0);
});
