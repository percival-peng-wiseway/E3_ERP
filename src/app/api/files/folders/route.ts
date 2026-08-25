import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  createWorkspaceFolder,
  WorkspaceFilesRepositoryError,
} from "@/lib/workspace-files/repository";
import {
  declaredWorkspaceFilesBodyTooLarge,
  normalizeWorkspaceFileName,
  objectHasExactFields,
  readWorkspaceFilesJson,
  workspaceFileParentId,
  workspaceFilesError,
  workspaceFilesJson,
  workspaceFilesRequestIsJson,
  WorkspaceFilesRequestBodyTooLarge,
} from "@/lib/workspace-files/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 4 * 1024;

export async function POST(request: NextRequest) {
  const session = getErpSession(request);
  if (!session) {
    return workspaceFilesError(401, "authentication_required", "Sign in to create folders.");
  }
  if (!isAuthorizedMutationRequest(request)) {
    return workspaceFilesError(403, "forbidden", "This folder request is not allowed.");
  }
  if ([...request.nextUrl.searchParams.keys()].length) {
    return workspaceFilesError(400, "invalid_query", "Folder creation does not accept query parameters.");
  }
  if (!workspaceFilesRequestIsJson(request)) {
    return workspaceFilesError(415, "unsupported_media_type", "Send the folder as JSON.");
  }
  if (declaredWorkspaceFilesBodyTooLarge(request, MAX_JSON_SIZE)) {
    return workspaceFilesError(413, "request_too_large", "The folder request is too large.");
  }

  try {
    const body = await readWorkspaceFilesJson(request, MAX_JSON_SIZE);
    if (!objectHasExactFields(body, ["name"], ["parentId"])) {
      return workspaceFilesError(400, "invalid_folder", "The folder request contains invalid fields.");
    }
    const name = normalizeWorkspaceFileName(body.name);
    const parentId = workspaceFileParentId(body.parentId);
    if (!name || parentId === undefined) {
      return workspaceFilesError(400, "invalid_folder", "Choose a valid folder name and location.");
    }
    const item = await createWorkspaceFolder({ actor: session.user, parentId, name });
    return workspaceFilesJson({ data: { item } }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    if (error instanceof WorkspaceFilesRequestBodyTooLarge) {
      return workspaceFilesError(413, "request_too_large", "The folder request is too large.");
    }
    if (error instanceof SyntaxError) {
      return workspaceFilesError(400, "invalid_json", "The folder request is invalid.");
    }
    return workspaceFilesError(500, "create_failed", "The folder could not be created.");
  }
}
