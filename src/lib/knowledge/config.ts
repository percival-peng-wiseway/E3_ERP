import type { KnowledgeAccessScope } from "./types";

export const KNOWLEDGE_CHUNK_CONFIG = Object.freeze({
  targetTokens: 600,
  minimumTokens: 400,
  maximumTokens: 800,
  overlapRatio: 0.12,
  maximumSourceBytes: 20 * 1024 * 1024,
  maximumDocumentCharacters: 4_000_000,
  maximumPdfPages: 250,
  maximumDocxEntries: 2_048,
  maximumDocxEntryBytes: 32 * 1024 * 1024,
  maximumDocxExpandedBytes: 64 * 1024 * 1024,
});

export const KNOWLEDGE_RETRIEVAL_CONFIG = Object.freeze({
  minimumConfidence: 0.48,
  maximumChunks: 8,
  maximumChunksPerDocument: 3,
});

export const KNOWLEDGE_VECTOR_CONFIG = Object.freeze({
  provider: "Cloudflare Vectorize",
  embeddingModel: "@cf/qwen/qwen3-embedding-0.6b" as const,
  dimensions: 1_024,
  metric: "cosine" as const,
  namespace: "e3",
  embeddingBatchSize: 8,
});

/**
 * Local development can still use Next `after()` while production runs the
 * durable Workflow. Vectorize mutations normally settle within seconds, but
 * the Workflow retains a wider window for large embedding batches.
 */
export const KNOWLEDGE_INDEX_EXECUTION_CONFIG = Object.freeze({
  backgroundBudgetMs: 30_000,
  backgroundCompletionReserveMs: 3_000,
  workflowProviderTimeoutMs: 2 * 60_000,
  workflowLeaseSeconds: 15 * 60,
  maximumChunksPerDocument: 256,
  vectorMutationPollIntervalMs: 500,
  vectorMutationTimeoutMs: 20_000,
  jobLeaseSeconds: 45,
});

const ACCESS_SCOPE_SET = new Set<string>(["company", "sales", "pm", "finance", "admin"]);

export function isKnowledgeAccessScope(value: unknown): value is KnowledgeAccessScope {
  return typeof value === "string" && ACCESS_SCOPE_SET.has(value);
}

/** Administrator sees every scope; other authenticated roles see company plus their own scope. */
export function canAccessKnowledgeScope(role: string, scope: KnowledgeAccessScope): boolean {
  const rawRole = role.trim().toLowerCase();
  const normalizedRole = rawRole === "specialist" ? "sales" : rawRole;
  if (normalizedRole === "admin") return true;
  if (scope === "company") return Boolean(normalizedRole);
  return normalizedRole === scope;
}
