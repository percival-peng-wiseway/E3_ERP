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

/**
 * Next `after()`/Workers `waitUntil()` has a roughly 30 second post-response
 * budget in this deployment. Up to 24 items are uploaded immediately, four at
 * a time, then the whole generation is checked with one list call per poll in
 * one 18-second provider window. This leaves time for parsing, D1 activation,
 * and cleanup. Documents above 24 chunks still require a Queue/Workflow path.
 */
export const KNOWLEDGE_INDEX_EXECUTION_CONFIG = Object.freeze({
  backgroundBudgetMs: 30_000,
  backgroundCompletionReserveMs: 3_000,
  maximumChunksPerDocument: 24,
  providerUploadConcurrency: 4,
  providerBatchPollIntervalMs: 750,
  providerBatchTimeoutMs: 18_000,
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
