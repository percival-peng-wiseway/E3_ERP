import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpAiSearch, ErpAiSearchItem, ErpAiSearchItemStatus } from "../server/cloudflare-storage";
// @ts-expect-error -- Node ESM tests require the explicit extension.
import { KnowledgeSearchProviderError, uploadKnowledgeChunks } from "./ai-search.ts";
// @ts-expect-error -- Node ESM tests require the explicit extension.
import { KNOWLEDGE_INDEX_EXECUTION_CONFIG } from "./config.ts";
import type { KnowledgeChunkDraft, KnowledgeDocument } from "./types";

const timestamp = "2026-08-28T00:00:00.000Z";

function fixtureDocument(): KnowledgeDocument {
  return {
    id: "doc-batch",
    tenantId: "e3",
    fileId: "file-batch",
    fileVersion: 1,
    title: "Batch manual",
    fileName: "batch.md",
    sourcePath: "Files / Manuals / batch.md",
    contentType: "text/markdown",
    documentType: "manual",
    category: "installation",
    language: "en-AU",
    sourceChecksum: "a".repeat(64),
    version: "1.0",
    indexGeneration: 2,
    status: "indexing",
    accessScope: "pm",
    product: null,
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

function fixtureChunks(count: number): KnowledgeChunkDraft[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `Procedure ${index + 1}`,
    tokenCount: 2,
    headingPath: ["Procedure", String(index + 1)],
    pageFrom: index + 1,
    pageTo: index + 1,
    contentChecksum: String(index + 1).padStart(64, "0"),
  }));
}

function statusProvider(status: ErpAiSearchItemStatus) {
  const items = new Map<string, ErpAiSearchItem>();
  const deleted: string[] = [];
  let listCalls = 0;
  const provider = {
    items: {
      async upload(name: string, _content: string, options?: { metadata?: Record<string, unknown> }) {
        const item: ErpAiSearchItem = {
          id: `item-${items.size + 1}`,
          key: name,
          status: "queued",
          metadata: options?.metadata,
        };
        items.set(item.id, item);
        return item;
      },
      async list(options?: { search?: string }) {
        listCalls += 1;
        const result = [...items.values()]
          .filter((item) => !options?.search || item.key.includes(options.search))
          .map((item) => ({ ...item, status }));
        return { result };
      },
      async delete(itemId: string) {
        deleted.push(itemId);
        items.delete(itemId);
      },
      get(itemId: string) { return { info: async () => items.get(itemId)! }; },
      async uploadAndPoll() { throw new Error("uploadAndPoll must not be called"); },
    },
    async search() { return { chunks: [] }; },
  } as unknown as ErpAiSearch;
  return {
    provider,
    items,
    deleted,
    get listCalls() { return listCalls; },
  };
}

test("provider item errors remove every uploaded item before failing", async () => {
  const cloud = statusProvider("error");
  await assert.rejects(
    uploadKnowledgeChunks({
      provider: cloud.provider,
      document: fixtureDocument(),
      chunks: fixtureChunks(3),
    }),
    (error: unknown) => error instanceof KnowledgeSearchProviderError && error.code === "index_failed",
  );
  assert.equal(cloud.items.size, 0);
  assert.deepEqual(cloud.deleted.sort(), ["item-1", "item-2", "item-3"]);
});

test("one global timeout removes all items still being indexed", async () => {
  const cloud = statusProvider("running");
  let currentTime = 0;
  await assert.rejects(
    uploadKnowledgeChunks({
      provider: cloud.provider,
      document: fixtureDocument(),
      chunks: fixtureChunks(17),
      timing: {
        now: () => currentTime,
        wait: async (milliseconds) => { currentTime += milliseconds; },
      },
    }),
    (error: unknown) => error instanceof KnowledgeSearchProviderError && error.code === "index_timeout",
  );
  assert.equal(currentTime, KNOWLEDGE_INDEX_EXECUTION_CONFIG.providerBatchTimeoutMs);
  assert.ok(cloud.listCalls > 1);
  assert.equal(cloud.items.size, 0);
  assert.equal(cloud.deleted.length, 17);
});
