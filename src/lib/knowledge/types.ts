export const KNOWLEDGE_TENANT_ID = "e3" as const;
export type KnowledgeTenantId = typeof KNOWLEDGE_TENANT_ID;

export const KNOWLEDGE_ACCESS_SCOPES = ["company", "sales", "pm", "finance", "admin"] as const;
export type KnowledgeAccessScope = (typeof KNOWLEDGE_ACCESS_SCOPES)[number];

export const KNOWLEDGE_DOCUMENT_STATUSES = [
  "pending", "indexing", "ready", "failed", "disabled",
] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

export const KNOWLEDGE_INDEX_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type KnowledgeIndexJobStatus = (typeof KNOWLEDGE_INDEX_JOB_STATUSES)[number];

export type KnowledgeDocument = {
  id: string;
  tenantId: KnowledgeTenantId;
  fileId: string;
  fileVersion: number;
  title: string;
  fileName: string;
  sourcePath: string;
  contentType: string;
  documentType: string;
  category: string;
  language: string;
  sourceChecksum: string;
  version: string;
  indexGeneration: number;
  status: KnowledgeDocumentStatus;
  accessScope: KnowledgeAccessScope;
  product: string | null;
  region: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  tags: string[];
  lastIndexedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type KnowledgeDocumentCreateInput = {
  fileId: string;
  tenantId: KnowledgeTenantId;
  fileVersion: number;
  title: string;
  fileName: string;
  sourcePath: string;
  contentType: string;
  documentType: string;
  category: string;
  language: string;
  version: string;
  checksum: string;
  createdBy: string;
  accessScope?: KnowledgeAccessScope;
  product?: string | null;
  region?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  tags?: string[];
};

export type KnowledgeDocumentCreateResult = {
  document: KnowledgeDocument;
  action: "created" | "unchanged" | "reindex_required";
};

export type KnowledgeDocumentMetadataPatch = Partial<Pick<KnowledgeDocument,
  "title" | "documentType" | "category" | "language" | "version" | "accessScope"
  | "product" | "region" | "effectiveFrom" | "effectiveTo" | "tags"
>> & { updatedBy: string };

export type KnowledgeChunkDraft = {
  text: string;
  tokenCount: number;
  headingPath: string[];
  pageFrom: number | null;
  pageTo: number | null;
  contentChecksum: string;
  indexItemKey?: string;
};

export type KnowledgeIndexedChunkDraft = KnowledgeChunkDraft & {
  /** Provider item id returned by AI Search Items upload; required before atomic activation. */
  indexItemId: string;
};

export type KnowledgeChunk = KnowledgeChunkDraft & {
  id: string;
  tenantId: KnowledgeTenantId;
  documentId: string;
  indexedVersion: string;
  indexGeneration: number;
  chunkIndex: number;
  indexItemKey: string;
  indexItemId: string;
  active: boolean;
  createdAt: string;
  invalidatedAt: string | null;
};

export type KnowledgeIndexJob = {
  id: string;
  tenantId: KnowledgeTenantId;
  documentId: string;
  indexGeneration: number;
  status: KnowledgeIndexJobStatus;
  reason: string;
  attempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  requestedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type ParsedKnowledgeSection = {
  text: string;
  headingPath: string[];
  pageNumber: number | null;
  order: number;
};

export type ParsedKnowledgeDocument = {
  title: string;
  contentType: string;
  sections: ParsedKnowledgeSection[];
  characterCount: number;
};

export type KnowledgeCitation = {
  documentId: string;
  chunkKey: string;
  title: string;
  fileId: string;
  fileName: string;
  version: string;
  updatedAt: string;
  headingPath: string[];
  pageFrom: number | null;
  pageTo: number | null;
  sourceUrl: string;
};

export type KnowledgeSearchCandidate = {
  document: KnowledgeDocument;
  chunk: KnowledgeChunk;
  score: number;
};

export type KnowledgeChunkReplacement = {
  activeChunks: KnowledgeChunk[];
  retiredChunks: KnowledgeChunk[];
};
