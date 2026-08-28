import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { continueKnowledgeIndex } from "@/app/api/knowledge/background";
import {
  type AutomaticKnowledgeIndexResult,
  registerAutomaticKnowledgeIndex,
} from "@/lib/knowledge/automatic-index";
import {
  getWorkspaceFileIndexSource,
  uploadWorkspaceFile,
  WorkspaceFilesRepositoryError,
} from "@/lib/workspace-files/repository";
import {
  declaredWorkspaceFilesBodyTooLarge,
  formHasExactFields,
  normalizeWorkspaceFileName,
  readWorkspaceFilesForm,
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_FILE_MAX_MULTIPART_BYTES,
  workspaceFileParentId,
  workspaceFileSignatureMatches,
  workspaceFilesError,
  workspaceFilesJson,
  WorkspaceFilesRequestBodyTooLarge,
  workspaceFilesRequestIsMultipart,
  workspaceFileUploadType,
} from "@/lib/workspace-files/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const session = getErpSession(request);
  if (!session) {
    return workspaceFilesError(401, "authentication_required", "Sign in to upload files.");
  }
  if (!isAuthorizedMutationRequest(request)) {
    return workspaceFilesError(403, "forbidden", "This upload request is not allowed.");
  }
  if ([...request.nextUrl.searchParams.keys()].length) {
    return workspaceFilesError(400, "invalid_query", "File uploads do not accept query parameters.");
  }
  if (!workspaceFilesRequestIsMultipart(request)) {
    return workspaceFilesError(415, "unsupported_media_type", "Upload one file as multipart form data.");
  }
  if (declaredWorkspaceFilesBodyTooLarge(request, WORKSPACE_FILE_MAX_MULTIPART_BYTES)) {
    return workspaceFilesError(413, "file_too_large", "Files must be 20 MB or smaller.");
  }

  try {
    const form = await readWorkspaceFilesForm(request, WORKSPACE_FILE_MAX_MULTIPART_BYTES);
    if (!formHasExactFields(form, ["file"], ["parentId"])) {
      return workspaceFilesError(400, "invalid_form", "Attach exactly one file and a valid destination folder.");
    }
    const file = form.get("file");
    const parentId = workspaceFileParentId(form.get("parentId"));
    if (!(file instanceof File) || parentId === undefined) {
      return workspaceFilesError(400, "invalid_form", "Attach exactly one file and a valid destination folder.");
    }
    const originalName = normalizeWorkspaceFileName(file.name);
    if (!originalName || file.size < 1 || file.size > WORKSPACE_FILE_MAX_BYTES) {
      return workspaceFilesError(400, "invalid_file", "Choose one named file between 1 byte and 20 MB.");
    }
    const contentType = workspaceFileUploadType(originalName, file.type);
    if (!contentType) {
      return workspaceFilesError(415, "unsupported_file", "Use a PDF, image, text, CSV, Word, Excel or PowerPoint file.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size || !workspaceFileSignatureMatches(contentType, bytes)) {
      return workspaceFilesError(415, "invalid_file_content", "The file contents do not match its type.");
    }

    const item = await uploadWorkspaceFile({
      actor: session.user,
      parentId,
      upload: {
        bytes,
        originalName,
        contentType,
        size: bytes.byteLength,
      },
    });
    let knowledgeIndex: AutomaticKnowledgeIndexResult;
    try {
      const source = await getWorkspaceFileIndexSource(item.id);
      knowledgeIndex = source
        ? await registerAutomaticKnowledgeIndex({ file: source, requestedBy: session.user.username })
        : {
            eligible: true,
            status: "failed",
            documentId: null,
            jobId: null,
            errorCode: "source_unavailable",
          };
      if (knowledgeIndex.status === "queued" && knowledgeIndex.jobId) {
        continueKnowledgeIndex(knowledgeIndex.jobId);
      }
    } catch {
      // The Files object and metadata are already durable. Knowledge setup is
      // deliberately observable but must never turn a successful upload into
      // a lost or falsely failed file.
      knowledgeIndex = {
        eligible: true,
        status: "failed",
        documentId: null,
        jobId: null,
        errorCode: "knowledge_registration_failed",
      };
    }
    return workspaceFilesJson({ data: { item, knowledgeIndex } }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) {
      return workspaceFilesError(413, "file_too_large", "Files must be 20 MB or smaller.");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return workspaceFilesError(400, "invalid_form", "The upload form is invalid.");
    }
    return workspaceFilesError(500, "upload_failed", "The file could not be uploaded.");
  }
}
