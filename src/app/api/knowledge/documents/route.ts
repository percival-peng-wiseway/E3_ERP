import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  createKnowledgeDocument,
  disableKnowledgeForFile,
  enqueueKnowledgeIndexJob,
  KnowledgeRepositoryError,
} from "@/lib/knowledge/repository";
import { KNOWLEDGE_TENANT_ID } from "@/lib/knowledge/types";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import {
  declaredWorkspaceFilesBodyTooLarge,
  readWorkspaceFilesJson,
  workspaceFilesRequestIsJson,
  WorkspaceFilesRequestBodyTooLarge,
} from "@/lib/workspace-files/request";
import {
  getWorkspaceFileIndexSource,
  WorkspaceFilesRepositoryError,
} from "@/lib/workspace-files/repository";
import {
  knowledgeError,
  knowledgeJson,
  isSupportedKnowledgeFile,
  KNOWLEDGE_ROUTE_BODY_BYTES,
  parseKnowledgeCreate,
} from "../request";
import { knowledgeDocumentView } from "../view";
import { continueKnowledgeIndex } from "../background";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const session = getErpSession(request);
  if (!session) return knowledgeError(401, "authentication_required", "Sign in to manage knowledge documents.");
  if (session.user.role !== "admin") return knowledgeError(403, "admin_required", "Only Administrators can manage the knowledge base.");
  if (!isAuthorizedMutationRequest(request)) return knowledgeError(403, "forbidden", "This knowledge request is not allowed.");
  if ([...request.nextUrl.searchParams.keys()].length) return knowledgeError(400, "invalid_query", "Knowledge changes do not accept query parameters.");
  if (!workspaceFilesRequestIsJson(request)) return knowledgeError(415, "unsupported_media_type", "Send knowledge settings as JSON.");
  if (declaredWorkspaceFilesBodyTooLarge(request, KNOWLEDGE_ROUTE_BODY_BYTES)) return knowledgeError(413, "request_too_large", "The knowledge settings are too large.");

  try {
    const body = await readWorkspaceFilesJson(request, KNOWLEDGE_ROUTE_BODY_BYTES);
    const input = parseKnowledgeCreate(body);
    if (!input) return knowledgeError(400, "invalid_document", "Choose valid knowledge document settings.");
    const file = await getWorkspaceFileIndexSource(input.fileId);
    if (!file) return knowledgeError(404, "file_not_found", "The active file was not found.");
    if (!isSupportedKnowledgeFile(file.name, file.contentType)) {
      return knowledgeError(415, "unsupported_file", "Knowledge documents must be PDF, DOCX, TXT or Markdown files.");
    }

    let result = await createKnowledgeDocument({
      tenantId: KNOWLEDGE_TENANT_ID,
      fileId: file.fileId,
      fileVersion: file.version,
      fileName: file.name,
      sourcePath: file.sourcePath,
      contentType: file.contentType,
      checksum: file.checksum,
      createdBy: session.user.username,
      title: input.title,
      documentType: input.documentType,
      category: input.category || "general",
      language: input.language,
      version: input.version,
      accessScope: input.accessScope,
      product: input.product,
      region: input.region,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });
    const latestFile = await getWorkspaceFileIndexSource(input.fileId);
    if (!latestFile) {
      await disableKnowledgeForFile(input.fileId, "file_moved_to_trash", KNOWLEDGE_TENANT_ID, session.user.username);
      return knowledgeError(409, "file_changed", "The source file changed. Refresh and try again.");
    }
    if (!isSupportedKnowledgeFile(latestFile.name, latestFile.contentType)) {
      await disableKnowledgeForFile(latestFile.fileId, "unsupported_file_type", KNOWLEDGE_TENANT_ID, session.user.username);
      return knowledgeError(409, "file_changed", "The source file changed to an unsupported type.");
    }
    if (latestFile.version !== file.version || latestFile.checksum !== file.checksum
      || latestFile.name !== file.name || latestFile.sourcePath !== file.sourcePath) {
      result = await createKnowledgeDocument({
        tenantId: KNOWLEDGE_TENANT_ID,
        fileId: latestFile.fileId,
        fileVersion: latestFile.version,
        fileName: latestFile.name,
        sourcePath: latestFile.sourcePath,
        contentType: latestFile.contentType,
        checksum: latestFile.checksum,
        createdBy: session.user.username,
        title: input.title,
        documentType: input.documentType,
        category: input.category || "general",
        language: input.language,
        version: input.version,
        accessScope: input.accessScope,
        product: input.product,
        region: input.region,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
      });
    }
    let queued = false;
    if (result.action !== "unchanged" || result.document.status !== "ready") {
      const job = await enqueueKnowledgeIndexJob({
        documentId: result.document.id,
        tenantId: KNOWLEDGE_TENANT_ID,
        requestedBy: session.user.username,
        reason: result.action === "reindex_required" ? "file_updated" : "document_added",
      });
      continueKnowledgeIndex(job.id);
      queued = true;
    }
    return knowledgeJson({ data: { document: knowledgeDocumentView(result.document) } }, { status: queued ? 202 : 200 });
  } catch (error) {
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) return knowledgeError(413, "request_too_large", "The knowledge settings are too large.");
    if (error instanceof WorkspaceFilesRepositoryError) return knowledgeError(error.status, error.code, error.message);
    if (error instanceof KnowledgeRepositoryError) return knowledgeError(error.status, error.code, error.message);
    if (error instanceof SyntaxError) return knowledgeError(400, "invalid_json", "The knowledge settings are invalid.");
    return knowledgeError(500, "knowledge_unavailable", "The knowledge document could not be saved.");
  }
}
