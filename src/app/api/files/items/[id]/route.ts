import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { canAccessKnowledgeScope } from "@/lib/knowledge/config";
import {
  createKnowledgeDocument,
  disableKnowledgeForFile,
  enqueueKnowledgeIndexJob,
  KnowledgeRepositoryError,
  listKnowledgeDocuments,
  reactivateKnowledgeForFile,
} from "@/lib/knowledge/repository";
import { KNOWLEDGE_TENANT_ID } from "@/lib/knowledge/types";
import { continueKnowledgeIndex } from "@/app/api/knowledge/background";
import { isSupportedKnowledgeFile } from "@/app/api/knowledge/request";
import {
  moveWorkspaceItem,
  getWorkspaceFileIndexSource,
  listWorkspaceFileSubtreeIds,
  purgeWorkspaceItem,
  renameWorkspaceItem,
  restoreWorkspaceItem,
  trashWorkspaceItem,
  WorkspaceFilesRepositoryError,
} from "@/lib/workspace-files/repository";
import {
  declaredWorkspaceFilesBodyTooLarge,
  parseWorkspaceFileDelete,
  parseWorkspaceFileItemAction,
  readWorkspaceFilesJson,
  workspaceFileId,
  workspaceFilesError,
  workspaceFilesJson,
  workspaceFilesRequestIsJson,
  WorkspaceFilesRequestBodyTooLarge,
} from "@/lib/workspace-files/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PATCH_SIZE = 4 * 1024;
const MAX_DELETE_SIZE = 1024;

async function itemId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return workspaceFileId(id);
}

async function knowledgeDocumentsByFileId() {
  const documents = await listKnowledgeDocuments({ tenantId: KNOWLEDGE_TENANT_ID, includeDisabled: true });
  return new Map(documents.map((document) => [document.fileId, document]));
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = getErpSession(request);
  if (!session) {
    return workspaceFilesError(401, "authentication_required", "Sign in to change workspace files.");
  }
  if (!isAuthorizedMutationRequest(request)) {
    return workspaceFilesError(403, "forbidden", "This file request is not allowed.");
  }
  if ([...request.nextUrl.searchParams.keys()].length) {
    return workspaceFilesError(400, "invalid_query", "File changes do not accept query parameters.");
  }
  const id = await itemId(context);
  if (!id) return workspaceFilesError(400, "invalid_id", "The file or folder ID is invalid.");
  if (!workspaceFilesRequestIsJson(request)) {
    return workspaceFilesError(415, "unsupported_media_type", "Send the file action as JSON.");
  }
  if (declaredWorkspaceFilesBodyTooLarge(request, MAX_PATCH_SIZE)) {
    return workspaceFilesError(413, "request_too_large", "The file action is too large.");
  }

  try {
    const body = await readWorkspaceFilesJson(request, MAX_PATCH_SIZE);
    const action = parseWorkspaceFileItemAction(body);
    if (!action) {
      return workspaceFilesError(400, "invalid_action", "Choose a valid file action and current version.");
    }

    const targetFileIds = await listWorkspaceFileSubtreeIds(id);
    const targetKnowledgeByFileId = await knowledgeDocumentsByFileId();
    const targetKnowledgeDocuments = targetFileIds.map((fileId) => targetKnowledgeByFileId.get(fileId) || null);
    if (targetKnowledgeDocuments.some((document) => document
      && !canAccessKnowledgeScope(session.user.role, document.accessScope))) {
      return workspaceFilesError(404, "not_found", "File not found.");
    }

    let item;
    const lifecycleFileIds = action.action === "trash" || action.action === "restore"
      ? targetFileIds
      : [];
    if (action.action === "rename") {
      item = await renameWorkspaceItem({ actor: session.user, id, ...action });
    } else if (action.action === "move") {
      item = await moveWorkspaceItem({ actor: session.user, id, ...action });
    } else {
      item = action.action === "trash"
        ? await trashWorkspaceItem({ actor: session.user, id, expectedVersion: action.expectedVersion })
        : await restoreWorkspaceItem({ actor: session.user, id, expectedVersion: action.expectedVersion });
      const lifecycleKnowledgeByFileId = action.action === "trash"
        ? targetKnowledgeByFileId
        : await knowledgeDocumentsByFileId();
      await Promise.all(lifecycleFileIds.map(async (fileId) => {
        if (action.action === "trash") {
          await disableKnowledgeForFile(fileId, "file_moved_to_trash", KNOWLEDGE_TENANT_ID, session.user.username);
          return;
        }
        const document = lifecycleKnowledgeByFileId.get(fileId);
        if (document?.disabledReason === "file_moved_to_trash") {
          const source = await getWorkspaceFileIndexSource(fileId);
          if (!source) return;
          const refreshed = await createKnowledgeDocument({
            tenantId: KNOWLEDGE_TENANT_ID,
            fileId,
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
          });
          const reactivated = refreshed.document.status === "disabled"
            ? await reactivateKnowledgeForFile(fileId, KNOWLEDGE_TENANT_ID, session.user.username)
            : refreshed.document;
          const job = await enqueueKnowledgeIndexJob({
            documentId: reactivated.id,
            tenantId: KNOWLEDGE_TENANT_ID,
            requestedBy: session.user.username,
            reason: "file_restored",
          });
          await continueKnowledgeIndex(job.id);
        }
      }));
    }

    if (action.action === "rename" || action.action === "move") {
      const currentKnowledgeByFileId = await knowledgeDocumentsByFileId();
      await Promise.all(targetFileIds.map(async (fileId) => {
        const currentDocument = currentKnowledgeByFileId.get(fileId);
        if (!currentDocument) return;
        const source = await getWorkspaceFileIndexSource(fileId);
        if (!source) return;
        if (!isSupportedKnowledgeFile(source.name, source.contentType)) {
          await disableKnowledgeForFile(fileId, "unsupported_file_type", KNOWLEDGE_TENANT_ID, session.user.username);
          return;
        }
        const result = await createKnowledgeDocument({
          tenantId: KNOWLEDGE_TENANT_ID,
          fileId,
          fileVersion: source.version,
          fileName: source.name,
          sourcePath: source.sourcePath,
          contentType: source.contentType,
          checksum: source.checksum,
          createdBy: session.user.username,
          title: currentDocument.title,
          documentType: currentDocument.documentType,
          category: currentDocument.category,
          language: currentDocument.language,
          version: currentDocument.version,
          accessScope: currentDocument.accessScope,
          product: currentDocument.product,
          region: currentDocument.region,
          effectiveFrom: currentDocument.effectiveFrom,
          effectiveTo: currentDocument.effectiveTo,
          tags: currentDocument.tags,
        });
        if (currentDocument.status === "disabled" && currentDocument.disabledReason !== "unsupported_file_type") {
          await disableKnowledgeForFile(
            fileId,
            currentDocument.disabledReason || "disabled_by_admin",
            KNOWLEDGE_TENANT_ID,
            session.user.username,
          );
          return;
        }
        if (result.action !== "unchanged") {
          const job = await enqueueKnowledgeIndexJob({
            documentId: result.document.id,
            tenantId: KNOWLEDGE_TENANT_ID,
            requestedBy: session.user.username,
            reason: "file_metadata_updated",
          });
          await continueKnowledgeIndex(job.id);
        }
      }));
    }

    return workspaceFilesJson({ data: { item } });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    if (error instanceof KnowledgeRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) {
      return workspaceFilesError(413, "request_too_large", "The file action is too large.");
    }
    if (error instanceof SyntaxError) {
      return workspaceFilesError(400, "invalid_json", "The file action is invalid.");
    }
    return workspaceFilesError(500, "update_failed", "The file or folder could not be changed.");
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = getErpSession(request);
  if (!session) {
    return workspaceFilesError(401, "authentication_required", "Sign in to permanently delete workspace files.");
  }
  if (!isAuthorizedMutationRequest(request)) {
    return workspaceFilesError(403, "forbidden", "This delete request is not allowed.");
  }
  if (session.user.role !== "admin") {
    return workspaceFilesError(403, "admin_required", "Only Administrators can permanently delete files.");
  }
  if ([...request.nextUrl.searchParams.keys()].length) {
    return workspaceFilesError(400, "invalid_query", "Permanent delete does not accept query parameters.");
  }
  const id = await itemId(context);
  if (!id) return workspaceFilesError(400, "invalid_id", "The file or folder ID is invalid.");
  if (!workspaceFilesRequestIsJson(request)) {
    return workspaceFilesError(415, "unsupported_media_type", "Send the current file version as JSON.");
  }
  if (declaredWorkspaceFilesBodyTooLarge(request, MAX_DELETE_SIZE)) {
    return workspaceFilesError(413, "request_too_large", "The delete request is too large.");
  }

  try {
    const body = await readWorkspaceFilesJson(request, MAX_DELETE_SIZE);
    const expectedVersion = parseWorkspaceFileDelete(body);
    if (!expectedVersion) {
      return workspaceFilesError(400, "invalid_delete", "Provide the current file version before deleting it.");
    }
    const lifecycleFileIds = await listWorkspaceFileSubtreeIds(id);
    await Promise.all(lifecycleFileIds.map((fileId) => disableKnowledgeForFile(
      fileId,
      "file_permanently_deleted",
      KNOWLEDGE_TENANT_ID,
      session.user.username,
    )));
    const result = await purgeWorkspaceItem({ actor: session.user, id, expectedVersion });
    return workspaceFilesJson({ data: result });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    if (error instanceof KnowledgeRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) {
      return workspaceFilesError(413, "request_too_large", "The delete request is too large.");
    }
    if (error instanceof SyntaxError) {
      return workspaceFilesError(400, "invalid_json", "The delete request is invalid.");
    }
    return workspaceFilesError(500, "delete_failed", "The file or folder could not be permanently deleted.");
  }
}
