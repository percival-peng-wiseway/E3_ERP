import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  moveWorkspaceItem,
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

    let item;
    if (action.action === "rename") {
      item = await renameWorkspaceItem({ actor: session.user, id, ...action });
    } else if (action.action === "move") {
      item = await moveWorkspaceItem({ actor: session.user, id, ...action });
    } else {
      item = action.action === "trash"
        ? await trashWorkspaceItem({ actor: session.user, id, expectedVersion: action.expectedVersion })
        : await restoreWorkspaceItem({ actor: session.user, id, expectedVersion: action.expectedVersion });
    }

    return workspaceFilesJson({ data: { item } });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
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
    const result = await purgeWorkspaceItem({ actor: session.user, id, expectedVersion });
    return workspaceFilesJson({ data: result });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
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
