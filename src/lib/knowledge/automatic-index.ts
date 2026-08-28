import type { WorkspaceFileIndexSource } from "../workspace-files/types.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { getWorkspaceFileIndexSource } from "../workspace-files/repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { automaticKnowledgeMetadata, isSupportedKnowledgeFile } from "./file-metadata.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { createKnowledgeDocument, enqueueKnowledgeIndexJob, getActiveKnowledgeDocumentByChecksum, KnowledgeRepositoryError, listActiveKnowledgeChunksForDocument } from "./repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_TENANT_ID, type KnowledgeChunk, type KnowledgeDocument, type KnowledgeDocumentCreateResult, type KnowledgeIndexJob } from "./types.ts";

export type AutomaticKnowledgeIndexResult = {
  eligible: boolean;
  status: "queued" | "ready" | "duplicate" | "not_supported" | "failed";
  documentId: string | null;
  jobId: string | null;
  errorCode: string | null;
};

type AutomaticKnowledgeIndexDependencies = {
  createDocument: (input: Parameters<typeof createKnowledgeDocument>[0]) => Promise<KnowledgeDocumentCreateResult>;
  enqueueJob: (input: Parameters<typeof enqueueKnowledgeIndexJob>[0]) => Promise<KnowledgeIndexJob>;
  findActiveDocumentByChecksum: (checksum: string, tenantId: typeof KNOWLEDGE_TENANT_ID) => Promise<KnowledgeDocument | null>;
  getFileSource: (fileId: string) => Promise<WorkspaceFileIndexSource | null>;
  listActiveChunks: (documentId: string, tenantId: typeof KNOWLEDGE_TENANT_ID) => Promise<KnowledgeChunk[]>;
};

const defaultDependencies: AutomaticKnowledgeIndexDependencies = {
  createDocument: createKnowledgeDocument,
  enqueueJob: enqueueKnowledgeIndexJob,
  findActiveDocumentByChecksum: getActiveKnowledgeDocumentByChecksum,
  getFileSource: getWorkspaceFileIndexSource,
  listActiveChunks: listActiveKnowledgeChunksForDocument,
};

function safeErrorCode(error: unknown) {
  return error instanceof KnowledgeRepositoryError
    ? error.code
    : "knowledge_registration_failed";
}

function failedDuplicate(documentId: string | null, errorCode: string): AutomaticKnowledgeIndexResult {
  return {
    eligible: true,
    status: "failed",
    documentId,
    jobId: null,
    errorCode,
  };
}

async function resolveDuplicate(
  input: { file: WorkspaceFileIndexSource; requestedBy: string },
  dependencies: AutomaticKnowledgeIndexDependencies,
): Promise<AutomaticKnowledgeIndexResult> {
  let canonicalId: string | null = null;
  try {
    const canonical = await dependencies.findActiveDocumentByChecksum(input.file.checksum, KNOWLEDGE_TENANT_ID);
    if (!canonical) return failedDuplicate(null, "duplicate_unresolved");
    canonicalId = canonical.id;
    if (canonical.accessScope !== "company") {
      // Never widen an existing document's ACL as a side effect of uploading a
      // second copy. An Administrator can resolve the metadata conflict.
      return failedDuplicate(canonicalId, "scope_conflict");
    }

    const source = await dependencies.getFileSource(canonical.fileId);
    if (!source || source.checksum !== canonical.sourceChecksum || source.version !== canonical.fileVersion) {
      return failedDuplicate(canonicalId, "canonical_source_unavailable");
    }

    if (canonical.status === "ready") {
      const chunks = await dependencies.listActiveChunks(canonical.id, KNOWLEDGE_TENANT_ID);
      const activeGenerationReady = chunks.length > 0 && chunks.every((chunk) => (
        chunk.active
        && chunk.documentId === canonical.id
        && chunk.indexGeneration === canonical.indexGeneration
        && chunk.indexedVersion === canonical.version
      ));
      if (activeGenerationReady) {
        return {
          eligible: true,
          status: "duplicate",
          documentId: canonicalId,
          jobId: null,
          errorCode: null,
        };
      }
    }

    // enqueueKnowledgeIndexJob returns an existing pending/running job when one
    // exists and creates a retry for failed or incomplete canonical documents.
    const job = await dependencies.enqueueJob({
      documentId: canonical.id,
      tenantId: KNOWLEDGE_TENANT_ID,
      requestedBy: input.requestedBy,
      reason: "automatic_duplicate_recovery",
    });
    return {
      eligible: true,
      status: "queued",
      documentId: canonicalId,
      jobId: job.id,
      errorCode: null,
    };
  } catch (error) {
    return failedDuplicate(canonicalId, safeErrorCode(error));
  }
}

/**
 * Persist the ERP-owned document and index job before the upload response is sent.
 * The caller starts the returned job with Next `after()`; provider data is never
 * allowed to bypass the D1 document, ACL and citation mappings.
 */
export async function registerAutomaticKnowledgeIndex(
  input: { file: WorkspaceFileIndexSource; requestedBy: string },
  dependencyOverrides: Partial<AutomaticKnowledgeIndexDependencies> = {},
): Promise<AutomaticKnowledgeIndexResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  if (!isSupportedKnowledgeFile(input.file.name, input.file.contentType)) {
    return {
      eligible: false,
      status: "not_supported",
      documentId: null,
      jobId: null,
      errorCode: null,
    };
  }

  let documentId: string | null = null;
  try {
    const metadata = automaticKnowledgeMetadata(input.file);
    const result = await dependencies.createDocument({
      tenantId: KNOWLEDGE_TENANT_ID,
      fileId: input.file.fileId,
      fileVersion: input.file.version,
      fileName: input.file.name,
      sourcePath: input.file.sourcePath,
      contentType: input.file.contentType,
      checksum: input.file.checksum,
      createdBy: input.requestedBy,
      title: metadata.title,
      documentType: metadata.documentType,
      category: metadata.category,
      language: metadata.language,
      version: metadata.version,
      accessScope: "company",
      product: null,
      region: null,
      effectiveFrom: null,
      effectiveTo: null,
      tags: ["auto-indexed"],
    });
    documentId = result.document.id;
    if (result.action === "unchanged" && result.document.status === "ready") {
      return {
        eligible: true,
        status: "ready",
        documentId,
        jobId: null,
        errorCode: null,
      };
    }
    const job = await dependencies.enqueueJob({
      documentId,
      tenantId: KNOWLEDGE_TENANT_ID,
      requestedBy: input.requestedBy,
      reason: result.action === "reindex_required" ? "file_updated" : "automatic_file_upload",
    });
    return {
      eligible: true,
      status: "queued",
      documentId,
      jobId: job.id,
      errorCode: null,
    };
  } catch (error) {
    if (error instanceof KnowledgeRepositoryError && error.code === "duplicate_checksum") {
      return resolveDuplicate(input, dependencies);
    }
    return {
      eligible: true,
      status: "failed",
      documentId,
      jobId: null,
      errorCode: safeErrorCode(error),
    };
  }
}
