// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { erpCloudflareBindings, type ErpAiSearch } from "../server/cloudflare-storage.ts";
import type {
  KnowledgeChunkDraft,
  KnowledgeDocument,
  KnowledgeIndexedChunkDraft,
} from "./types";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_INDEX_EXECUTION_CONFIG } from "./config.ts";

export class KnowledgeSearchProviderError extends Error {
  readonly code: "unavailable" | "index_failed" | "index_timeout";
  readonly retryable: boolean;

  constructor(
    code: KnowledgeSearchProviderError["code"],
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = "KnowledgeSearchProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function knowledgeSearchBinding(): Promise<ErpAiSearch> {
  const bindings = await erpCloudflareBindings();
  if (!bindings?.knowledgeSearch) {
    throw new KnowledgeSearchProviderError(
      "unavailable",
      "The Cloudflare AI Search binding is unavailable.",
    );
  }
  return bindings.knowledgeSearch;
}

export function knowledgeItemMetadata(document: KnowledgeDocument) {
  // AI Search currently permits five custom metadata fields per instance. The
  // tenant is isolated by the dedicated instance and is also rechecked in D1.
  return {
    access_scope: document.accessScope,
    category: document.category,
    product: document.product || "__none__",
    region: document.region || "__none__",
    language: document.language,
  };
}

function itemName(document: KnowledgeDocument, chunkIndex: number) {
  return `kb-${document.id}-g${document.indexGeneration}-${String(chunkIndex).padStart(5, "0")}.md`;
}

function itemBody(document: KnowledgeDocument, chunk: KnowledgeChunkDraft) {
  const headings = [document.title, ...chunk.headingPath].filter(Boolean);
  const headingText = headings.map((heading, index) => `${"#".repeat(Math.min(index + 1, 6))} ${heading}`).join("\n\n");
  return `${headingText}\n\n${chunk.text}\n`;
}

async function uploadOne(
  provider: ErpAiSearch,
  document: KnowledgeDocument,
  chunk: KnowledgeChunkDraft,
  chunkIndex: number,
): Promise<KnowledgeIndexedChunkDraft> {
  let item;
  try {
    item = await provider.items.uploadAndPoll(
      itemName(document, chunkIndex),
      itemBody(document, chunk),
      {
        metadata: knowledgeItemMetadata(document),
        pollIntervalMs: 750,
        timeoutMs: KNOWLEDGE_INDEX_EXECUTION_CONFIG.providerItemPollTimeoutMs,
      },
    );
  } catch {
    throw new KnowledgeSearchProviderError(
      "index_failed",
      "Cloudflare AI Search could not accept an index item.",
    );
  }
  if (item.status === "queued" || item.status === "running") {
    throw new KnowledgeSearchProviderError(
      "index_timeout",
      "Cloudflare AI Search did not finish indexing within the safe background window.",
    );
  }
  if (item.status !== "completed" || !item.id || !item.key) {
    throw new KnowledgeSearchProviderError(
      "index_failed",
      "Cloudflare AI Search rejected an index item.",
    );
  }
  return {
    ...chunk,
    indexItemKey: item.key,
    indexItemId: item.id,
  };
}

export async function uploadKnowledgeChunks(input: {
  provider: ErpAiSearch;
  document: KnowledgeDocument;
  chunks: KnowledgeChunkDraft[];
}) {
  const results: KnowledgeIndexedChunkDraft[] = new Array(input.chunks.length);
  let cursor = 0;
  let firstFailure: unknown;
  const workers = Array.from(
    { length: Math.min(KNOWLEDGE_INDEX_EXECUTION_CONFIG.providerUploadConcurrency, input.chunks.length) },
    async () => {
      while (cursor < input.chunks.length && firstFailure === undefined) {
        const chunkIndex = cursor;
        cursor += 1;
        try {
          results[chunkIndex] = await uploadOne(
            input.provider,
            input.document,
            input.chunks[chunkIndex],
            chunkIndex,
          );
        } catch (error) {
          firstFailure ??= error;
          throw error;
        }
      }
    },
  );
  await Promise.allSettled(workers);
  if (firstFailure !== undefined) {
    // Wait for every in-flight upload before cleanup. Promise.all() would
    // return on the first failure and a slower worker could otherwise create
    // an orphaned AI Search item after cleanup had already finished.
    await deleteKnowledgeIndexItems(
      input.provider,
      results.filter(Boolean).map((chunk) => chunk.indexItemId),
    );
    throw firstFailure;
  }
  return results;
}

export async function deleteKnowledgeIndexItems(provider: ErpAiSearch, itemIds: readonly string[]) {
  await Promise.allSettled(
    [...new Set(itemIds)].filter(Boolean).map((itemId) => provider.items.delete(itemId)),
  );
}
