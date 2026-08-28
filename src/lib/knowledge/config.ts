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
 * budget in this deployment. Eight items are uploaded in one parallel wave and
 * each poll is capped at 18 seconds, reserving about 12 seconds for parsing,
 * D1 activation and cleanup. Larger documents require a Queue/Workflow path.
 */
export const KNOWLEDGE_INDEX_EXECUTION_CONFIG = Object.freeze({
  backgroundBudgetMs: 30_000,
  maximumChunksPerDocument: 8,
  providerUploadConcurrency: 8,
  providerItemPollTimeoutMs: 18_000,
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
