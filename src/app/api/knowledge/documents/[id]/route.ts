import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  createKnowledgeDocument,
  disableKnowledgeForFile,
  enqueueKnowledgeIndexJob,
  getKnowledgeDocument,
  KnowledgeRepositoryError,
  reactivateKnowledgeForFile,
  updateKnowledgeDocumentMetadata,
} from "@/lib/knowledge/repository";
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
  parseKnowledgeStateChange,
  parseKnowledgeUpdate,
} from "../../request";
import { knowledgeDocumentView } from "../../view";
import { continueKnowledgeIndex } from "../../background";
import { getWorkspaceFileIndexSource, WorkspaceFilesRepositoryError } from "@/lib/workspace-files/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function documentId(context: { params: Promise<{ id: string }> }) {
  return workspaceFileId((await context.params).id);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return knowledgeError(401, "authentication_required", "Sign in to manage knowledge documents.");
  if (session.user.role !== "admin") return knowledgeError(403, "admin_required", "Only Administrators can manage the knowledge base.");
  if (!isAuthorizedMutationRequest(request)) return knowledgeError(403, "forbidden", "This knowledge request is not allowed.");
  if ([...request.nextUrl.searchParams.keys()].length) return knowledgeError(400, "invalid_query", "Knowledge changes do not accept query parameters.");
  const id = await documentId(context);
  if (!id) return knowledgeError(400, "invalid_id", "The knowledge document ID is invalid.");
  if (!workspaceFilesRequestIsJson(request)) return knowledgeError(415, "unsupported_media_type", "Send knowledge settings as JSON.");
  if (declaredWorkspaceFilesBodyTooLarge(request, KNOWLEDGE_ROUTE_BODY_BYTES)) return knowledgeError(413, "request_too_large", "The knowledge settings are too large.");

  try {
    const body = await readWorkspaceFilesJson(request, KNOWLEDGE_ROUTE_BODY_BYTES);
    const current = await getKnowledgeDocument(id, KNOWLEDGE_TENANT_ID);
    if (!current) return knowledgeError(404, "not_found", "The knowledge document was not found.");
    const stateChange = parseKnowledgeStateChange(body);
    if (stateChange) {
      if (stateChange.expectedUpdatedAt !== current.updatedAt) return knowledgeError(409, "version_conflict", "This document changed. Refresh and try again.");
      const document = stateChange.action === "disable"
        ? await disableKnowledgeForFile(current.fileId, "disabled_by_admin", KNOWLEDGE_TENANT_ID, session.user.username)
        : await (async () => {
          const source = await getWorkspaceFileIndexSource(current.fileId);
          if (!source) throw new KnowledgeRepositoryError("The active source file was not found.", 404, "file_not_found");
          if (!isSupportedKnowledgeFile(source.name, source.contentType)) {
            throw new KnowledgeRepositoryError("Knowledge documents must be PDF, DOCX, TXT or Markdown files.", 415, "unsupported_file");
          }
          const refreshed = await createKnowledgeDocument({
            tenantId: KNOWLEDGE_TENANT_ID,
            fileId: current.fileId,
            fileVersion: source.version,
            fileName: source.name,
            sourcePath: source.sourcePath,
            contentType: source.contentType,
            checksum: source.checksum,
            createdBy: session.user.username,
            title: current.title,
            documentType: current.documentType,
            category: current.category,
            language: current.language,
            version: current.version,
            accessScope: current.accessScope,
            product: current.product,
            region: current.region,
            effectiveFrom: current.effectiveFrom,
            effectiveTo: current.effectiveTo,
            tags: current.tags,
          });
          return refreshed.document.status === "disabled"
            ? reactivateKnowledgeForFile(current.fileId, KNOWLEDGE_TENANT_ID, session.user.username)
            : refreshed.document;
        })();
      if (!document) return knowledgeError(404, "not_found", "The knowledge document was not found.");
      if (stateChange.action === "enable") {
        const job = await enqueueKnowledgeIndexJob({ documentId: document.id, tenantId: KNOWLEDGE_TENANT_ID, requestedBy: session.user.username, reason: "document_reenabled" });
        continueKnowledgeIndex(job.id);
      }
      return knowledgeJson({ data: { document: knowledgeDocumentView(document) } }, { status: stateChange.action === "enable" ? 202 : 200 });
    }

    const update = parseKnowledgeUpdate(body);
    if (!update) return knowledgeError(400, "invalid_document", "Choose valid knowledge document settings.");
    const source = await getWorkspaceFileIndexSource(current.fileId);
    if (!source) return knowledgeError(404, "file_not_found", "The active source file was not found.");
    let document = await updateKnowledgeDocumentMetadata(
      id,
      {
        title: update.title,
        documentType: update.documentType,
        category: update.category || "general",
        language: update.language,
        version: update.version,
        accessScope: update.accessScope,
        product: update.product,
        region: update.region,
        effectiveFrom: update.effectiveFrom,
        effectiveTo: update.effectiveTo,
        updatedBy: session.user.username,
      },
      update.expectedUpdatedAt,
    );
    if (current.status === "disabled") {
      document = await disableKnowledgeForFile(
        document.fileId,
        current.disabledReason || "disabled_by_admin",
        KNOWLEDGE_TENANT_ID,
        session.user.username,
      ) || document;
      return knowledgeJson({ data: { document: knowledgeDocumentView(document) } });
    }
    const job = await enqueueKnowledgeIndexJob({ documentId: document.id, tenantId: KNOWLEDGE_TENANT_ID, requestedBy: session.user.username, reason: "metadata_updated" });
    continueKnowledgeIndex(job.id);
    return knowledgeJson({ data: { document: knowledgeDocumentView(document) } }, { status: 202 });
  } catch (error) {
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) return knowledgeError(413, "request_too_large", "The knowledge settings are too large.");
    if (error instanceof SyntaxError) return knowledgeError(400, "invalid_json", "The knowledge settings are invalid.");
    if (error instanceof KnowledgeRepositoryError) return knowledgeError(error.status, error.code, error.message);
    if (error instanceof WorkspaceFilesRepositoryError) return knowledgeError(error.status, error.code, error.message);
    return knowledgeError(500, "knowledge_unavailable", "The knowledge document could not be updated.");
  }
}
