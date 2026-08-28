import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { createKnowledgeDocument, enqueueKnowledgeIndexJob, getKnowledgeDocument, KnowledgeRepositoryError } from "@/lib/knowledge/repository";
import { KNOWLEDGE_TENANT_ID } from "@/lib/knowledge/types";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import {
  declaredWorkspaceFilesBodyTooLarge,
  readWorkspaceFilesJson,
  workspaceFileId,
  workspaceFilesRequestIsJson,
  WorkspaceFilesRequestBodyTooLarge,
} from "@/lib/workspace-files/request";
import {
  knowledgeError,
  knowledgeJson,
  isSupportedKnowledgeFile,
  KNOWLEDGE_ROUTE_BODY_BYTES,
  parseKnowledgeReindex,
} from "../../../request";
import { knowledgeDocumentView } from "../../../view";
import { continueKnowledgeIndex } from "../../../background";
import { getWorkspaceFileIndexSource, WorkspaceFilesRepositoryError } from "@/lib/workspace-files/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return knowledgeError(401, "authentication_required", "Sign in to manage knowledge documents.");
  if (session.user.role !== "admin") return knowledgeError(403, "admin_required", "Only Administrators can manage the knowledge base.");
  if (!isAuthorizedMutationRequest(request)) return knowledgeError(403, "forbidden", "This knowledge request is not allowed.");
  if ([...request.nextUrl.searchParams.keys()].length) return knowledgeError(400, "invalid_query", "Reindexing does not accept query parameters.");
  const id = workspaceFileId((await context.params).id);
  if (!id) return knowledgeError(400, "invalid_id", "The knowledge document ID is invalid.");
  if (!workspaceFilesRequestIsJson(request)) return knowledgeError(415, "unsupported_media_type", "Send the current document version as JSON.");
  if (declaredWorkspaceFilesBodyTooLarge(request, KNOWLEDGE_ROUTE_BODY_BYTES)) return knowledgeError(413, "request_too_large", "The reindex request is too large.");

  try {
    const body = await readWorkspaceFilesJson(request, KNOWLEDGE_ROUTE_BODY_BYTES);
    const input = parseKnowledgeReindex(body);
    if (!input) return knowledgeError(400, "invalid_reindex", "Provide the current knowledge document version.");
    let document = await getKnowledgeDocument(id, KNOWLEDGE_TENANT_ID);
    if (!document) return knowledgeError(404, "not_found", "The knowledge document was not found.");
    if (input.expectedUpdatedAt !== document.updatedAt) return knowledgeError(409, "version_conflict", "This document changed. Refresh and try again.");
    if (document.status === "disabled") return knowledgeError(409, "document_disabled", "Enable this document before reindexing it.");
    const source = await getWorkspaceFileIndexSource(document.fileId);
    if (!source) return knowledgeError(404, "file_not_found", "The active source file was not found.");
    if (!isSupportedKnowledgeFile(source.name, source.contentType)) {
      return knowledgeError(415, "unsupported_file", "Knowledge documents must be PDF, DOCX, TXT or Markdown files.");
    }
    if (source.version !== document.fileVersion || source.checksum !== document.sourceChecksum
      || source.name !== document.fileName || source.sourcePath !== document.sourcePath
      || source.contentType !== document.contentType) {
      document = (await createKnowledgeDocument({
        tenantId: KNOWLEDGE_TENANT_ID,
        fileId: source.fileId,
        fileVersion: source.version,
        fileName: source.name,
        sourcePath: source.sourcePath,
        contentType: source.contentType,
        checksum: source.checksum,
        createdBy: session.user.username,
        title: document.title,
        documentType: document.documentType,
        category: document.category,
        language: document.language,
        version: document.version,
        accessScope: document.accessScope,
        product: document.product,
        region: document.region,
        effectiveFrom: document.effectiveFrom,
        effectiveTo: document.effectiveTo,
        tags: document.tags,
      })).document;
    }
    const job = await enqueueKnowledgeIndexJob({ documentId: document.id, tenantId: KNOWLEDGE_TENANT_ID, requestedBy: session.user.username, reason: "manual_reindex" });
    continueKnowledgeIndex(job.id);
    return knowledgeJson({ data: { document: knowledgeDocumentView(document) } }, { status: 202 });
  } catch (error) {
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) return knowledgeError(413, "request_too_large", "The reindex request is too large.");
    if (error instanceof SyntaxError) return knowledgeError(400, "invalid_json", "The reindex request is invalid.");
    if (error instanceof KnowledgeRepositoryError) return knowledgeError(error.status, error.code, error.message);
    if (error instanceof WorkspaceFilesRepositoryError) return knowledgeError(error.status, error.code, error.message);
    return knowledgeError(500, "knowledge_unavailable", "The document could not be queued for reindexing.");
  }
}
