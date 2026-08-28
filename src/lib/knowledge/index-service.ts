import { randomUUID } from "node:crypto";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { getWorkspaceFileIndexSource } from "../workspace-files/repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { deleteKnowledgeIndexItems, knowledgeSearchBinding, KnowledgeSearchProviderError, uploadKnowledgeChunks } from "./ai-search.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { chunkParsedKnowledgeDocument } from "./chunker.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KnowledgeParseError, parseKnowledgeDocument } from "./parser.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { claimKnowledgeIndexJob, enqueueKnowledgeIndexJob, failKnowledgeIndexJob, getKnowledgeDocument, getKnowledgeIndexJob, replaceKnowledgeChunksAtomically, setKnowledgeDocumentStatus } from "./repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_TENANT_ID, type KnowledgeIndexedChunkDraft } from "./types.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_INDEX_EXECUTION_CONFIG } from "./config.ts";

type IndexServiceDependencies = {
  getSource?: typeof getWorkspaceFileIndexSource;
  getProvider?: typeof knowledgeSearchBinding;
};

function safeFailure(error: unknown) {
  if (error instanceof KnowledgeParseError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof KnowledgeSearchProviderError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message === "source_changed") {
    return { code: "source_changed", message: "The source file changed while it was being indexed." };
  }
  if (error instanceof Error && error.message === "stale_generation") {
    return { code: "stale_generation", message: "A newer knowledge document version replaced this index job." };
  }
  return { code: "index_failed", message: "The knowledge document could not be indexed." };
}

async function markCurrentGenerationFailed(documentId: string, generation: number, code: string, message: string) {
  const current = await getKnowledgeDocument(documentId, KNOWLEDGE_TENANT_ID);
  if (!current || current.status === "disabled" || current.indexGeneration !== generation) return;
  await setKnowledgeDocumentStatus(documentId, "failed", {
    tenantId: KNOWLEDGE_TENANT_ID,
    updatedBy: "indexer",
    errorCode: code,
    errorMessage: message,
    expectedUpdatedAt: current.updatedAt,
  }).catch(() => undefined);
}

/**
 * Process one persisted job. Routes call this from Next `after()`, so parsing
 * and provider polling never hold the browser request open. The D1 lease makes
 * repeated route invocations and retries idempotent.
 */
export async function processKnowledgeIndexJob(
  jobId: string,
  dependencies: IndexServiceDependencies = {},
): Promise<void> {
  const backgroundDeadlineAt = Date.now()
    + KNOWLEDGE_INDEX_EXECUTION_CONFIG.backgroundBudgetMs
    - KNOWLEDGE_INDEX_EXECUTION_CONFIG.backgroundCompletionReserveMs;
  const workerId = `knowledge-indexer:${randomUUID()}`;
  const job = await claimKnowledgeIndexJob({
    jobId,
    tenantId: KNOWLEDGE_TENANT_ID,
    workerId,
    leaseSeconds: KNOWLEDGE_INDEX_EXECUTION_CONFIG.jobLeaseSeconds,
  });
  if (!job) return;

  let uploaded: KnowledgeIndexedChunkDraft[] = [];
  let provider: Awaited<ReturnType<typeof knowledgeSearchBinding>> | null = null;
  try {
    const document = await getKnowledgeDocument(job.documentId, KNOWLEDGE_TENANT_ID);
    if (!document || document.status === "disabled") throw new Error("stale_generation");
    if (document.indexGeneration !== job.indexGeneration) throw new Error("stale_generation");

    const source = await (dependencies.getSource || getWorkspaceFileIndexSource)(document.fileId);
    if (!source || source.checksum !== document.sourceChecksum || source.version !== document.fileVersion) {
      throw new Error("source_changed");
    }
    const bytes = await source.read();
    const parsed = await parseKnowledgeDocument({
      bytes,
      contentType: source.contentType,
      fileName: source.name,
      title: document.title,
    });
    const chunks = chunkParsedKnowledgeDocument({
      documentId: document.id,
      indexGeneration: document.indexGeneration,
      parsed,
    });
    if (!chunks.length) throw new KnowledgeParseError("invalid_document", "The document contains no indexable text.");
    if (chunks.length > KNOWLEDGE_INDEX_EXECUTION_CONFIG.maximumChunksPerDocument) {
      throw new KnowledgeParseError(
        "document_too_large",
        `The document produces more than ${KNOWLEDGE_INDEX_EXECUTION_CONFIG.maximumChunksPerDocument} chunks and requires the Queue/Workflow indexer.`,
      );
    }

    provider = await (dependencies.getProvider || knowledgeSearchBinding)();
    uploaded = await uploadKnowledgeChunks({
      provider,
      document,
      chunks,
      deadlineAt: backgroundDeadlineAt,
    });

    const latest = await getKnowledgeDocument(document.id, KNOWLEDGE_TENANT_ID);
    if (!latest || latest.status === "disabled" || latest.indexGeneration !== job.indexGeneration) {
      throw new Error("stale_generation");
    }
    const replacement = await replaceKnowledgeChunksAtomically(document.id, job.indexGeneration, uploaded, {
      jobId: job.id,
      workerId,
    });
    await deleteKnowledgeIndexItems(provider, replacement.retiredChunks.map((chunk) => chunk.indexItemId));
  } catch (error) {
    if (provider && uploaded.length) {
      await deleteKnowledgeIndexItems(provider, uploaded.map((chunk) => chunk.indexItemId));
    }
    const failure = safeFailure(error);
    await markCurrentGenerationFailed(job.documentId, job.indexGeneration, failure.code, failure.message);
    await failKnowledgeIndexJob(job.id, workerId, failure).catch(() => undefined);

    // If metadata/file state advanced while this job was running, immediately
    // create and process the replacement generation instead of leaving it
    // dependent on another browser request.
    if (failure.code === "stale_generation" || failure.code === "source_changed") {
      const latest = await getKnowledgeDocument(job.documentId, KNOWLEDGE_TENANT_ID);
      if (latest && latest.status !== "disabled" && latest.indexGeneration !== job.indexGeneration) {
        const replacement = await enqueueKnowledgeIndexJob({
          documentId: latest.id,
          tenantId: KNOWLEDGE_TENANT_ID,
          requestedBy: "indexer",
          reason: "superseded_index_job",
        });
        if (replacement.id !== job.id) {
          await processKnowledgeIndexJob(replacement.id, dependencies);
        }
      }
    }
  }
}

/** Explicit retry entry point for tests/operations that have only a job id. */
export async function knowledgeIndexJobStatus(jobId: string) {
  return getKnowledgeIndexJob(jobId, KNOWLEDGE_TENANT_ID);
}
