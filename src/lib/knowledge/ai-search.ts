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

function itemPrefix(document: KnowledgeDocument) {
  return `kb-${document.id}-g${document.indexGeneration}-`;
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
): Promise<{ chunk: KnowledgeChunkDraft; id: string; key: string }> {
  let item;
  try {
    item = await provider.items.upload(
      itemName(document, chunkIndex),
      itemBody(document, chunk),
      {
        metadata: knowledgeItemMetadata(document),
      },
    );
  } catch {
    throw new KnowledgeSearchProviderError(
      "index_failed",
      "Cloudflare AI Search could not accept an index item.",
    );
  }
  return { chunk, id: item.id, key: item.key };
}

type KnowledgeUploadTiming = {
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
};

const DEFAULT_UPLOAD_TIMING: KnowledgeUploadTiming = {
  now: Date.now,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const FAILED_ITEM_STATUSES = new Set(["error", "skipped", "outdated"]);

async function listBatchItems(provider: ErpAiSearch, document: KnowledgeDocument) {
  const response = await provider.items.list({
    page: 1,
    per_page: KNOWLEDGE_INDEX_EXECUTION_CONFIG.maximumChunksPerDocument,
    search: itemPrefix(document),
    sort_by: "status",
  });
  if (!response || !Array.isArray(response.result)) {
    throw new KnowledgeSearchProviderError(
      "index_failed",
      "Cloudflare AI Search returned an invalid item status response.",
    );
  }
  return response.result;
}

async function cleanupBatchItems(
  provider: ErpAiSearch,
  document: KnowledgeDocument,
  expectedKeys: ReadonlySet<string>,
  knownIds: ReadonlySet<string>,
) {
  const ids = new Set(knownIds);
  try {
    const listed = await listBatchItems(provider, document);
    for (const item of listed) {
      if (item.id && expectedKeys.has(item.key)) ids.add(item.id);
    }
  } catch {
    // Known upload ids can still be removed when status discovery is unavailable.
  }
  await deleteKnowledgeIndexItems(provider, [...ids]);
}

export async function uploadKnowledgeChunks(input: {
  provider: ErpAiSearch;
  document: KnowledgeDocument;
  chunks: KnowledgeChunkDraft[];
  /** Deterministic clock used only by focused timeout tests. */
  timing?: KnowledgeUploadTiming;
}) {
  const timing = input.timing || DEFAULT_UPLOAD_TIMING;
  const deadline = timing.now() + KNOWLEDGE_INDEX_EXECUTION_CONFIG.providerBatchTimeoutMs;
  const uploads: Array<{ chunk: KnowledgeChunkDraft; id: string; key: string }> = new Array(input.chunks.length);
  const expectedKeys = new Set(input.chunks.map((_, index) => itemName(input.document, index)));
  const knownIds = new Set<string>();
  let cursor = 0;
  let firstFailure: unknown;
  const workers = Array.from(
    { length: Math.min(KNOWLEDGE_INDEX_EXECUTION_CONFIG.providerUploadConcurrency, input.chunks.length) },
    async () => {
      while (cursor < input.chunks.length && firstFailure === undefined) {
        const chunkIndex = cursor;
        cursor += 1;
        try {
          const uploaded = await uploadOne(
            input.provider,
            input.document,
            input.chunks[chunkIndex],
            chunkIndex,
          );
          uploads[chunkIndex] = uploaded;
          if (uploaded.id) knownIds.add(uploaded.id);
          if (!uploaded.id || !uploaded.key || uploaded.key !== itemName(input.document, chunkIndex)) {
            throw new KnowledgeSearchProviderError(
              "index_failed",
              "Cloudflare AI Search rejected an index item.",
            );
          }
        } catch (error) {
          firstFailure ??= error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstFailure !== undefined) {
    // Every in-flight upload has settled, so cleanup cannot race a late item.
    await cleanupBatchItems(input.provider, input.document, expectedKeys, knownIds);
    throw firstFailure;
  }

  try {
    while (true) {
      // One provider call observes the whole generation; the timeout is global,
      // rather than being restarted independently for every chunk.
      const listed = await listBatchItems(input.provider, input.document);
      const byKey = new Map(listed
        .filter((item) => item.id && expectedKeys.has(item.key))
        .map((item) => [item.key, item]));
      for (const item of byKey.values()) {
        if (item.id) knownIds.add(item.id);
        if (FAILED_ITEM_STATUSES.has(item.status)) {
          throw new KnowledgeSearchProviderError(
            "index_failed",
            "Cloudflare AI Search rejected an index item.",
          );
        }
      }
      if (expectedKeys.size === byKey.size
        && [...expectedKeys].every((key) => byKey.get(key)?.status === "completed")) {
        return uploads.map(({ chunk, key }, index) => ({
          ...chunk,
          indexItemKey: key,
          indexItemId: byKey.get(itemName(input.document, index))!.id,
        }));
      }

      const remaining = deadline - timing.now();
      if (remaining <= 0) {
        throw new KnowledgeSearchProviderError(
          "index_timeout",
          "Cloudflare AI Search did not finish indexing within the safe background window.",
        );
      }
      await timing.wait(Math.min(KNOWLEDGE_INDEX_EXECUTION_CONFIG.providerBatchPollIntervalMs, remaining));
    }
  } catch (error) {
    await cleanupBatchItems(input.provider, input.document, expectedKeys, knownIds);
    if (error instanceof KnowledgeSearchProviderError) throw error;
    throw new KnowledgeSearchProviderError(
      "index_failed",
      "Cloudflare AI Search could not report index item status.",
    );
  }
}

export async function deleteKnowledgeIndexItems(provider: ErpAiSearch, itemIds: readonly string[]) {
  await Promise.allSettled(
    [...new Set(itemIds)].filter(Boolean).map((itemId) => provider.items.delete(itemId)),
  );
}
