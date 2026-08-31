import type { KnowledgeDocument } from "@/lib/knowledge/types";
import { KNOWLEDGE_VECTOR_CONFIG } from "@/lib/knowledge/config";
import type { WorkspaceKnowledgeSummary } from "@/lib/workspace-files/types";

/** Keep database/index implementation fields out of browser responses. */
export function knowledgeDocumentView(document: KnowledgeDocument, activeChunks = 0): WorkspaceKnowledgeSummary {
  return {
    id: document.id,
    fileId: document.fileId,
    title: document.title,
    documentType: document.documentType,
    category: document.category || null,
    product: document.product,
    region: document.region,
    language: document.language,
    accessScope: document.accessScope,
    documentVersion: document.version,
    effectiveFrom: document.effectiveFrom,
    effectiveTo: document.effectiveTo,
    status: document.status,
    vectorProvider: KNOWLEDGE_VECTOR_CONFIG.provider,
    embeddingModel: KNOWLEDGE_VECTOR_CONFIG.embeddingModel,
    vectorDimensions: KNOWLEDGE_VECTOR_CONFIG.dimensions,
    vectorMetric: KNOWLEDGE_VECTOR_CONFIG.metric,
    activeChunks,
    indexGeneration: document.indexGeneration,
    lastIndexedAt: document.lastIndexedAt,
    updatedAt: document.updatedAt,
    errorMessage: document.errorMessage,
  };
}
