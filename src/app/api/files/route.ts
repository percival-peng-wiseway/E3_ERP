import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  listWorkspaceFiles,
  WorkspaceFilesRepositoryError,
} from "@/lib/workspace-files/repository";
import {
  parseWorkspaceFilesListQuery,
  workspaceFilesError,
  workspaceFilesJson,
} from "@/lib/workspace-files/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = getErpSession(request);
  if (!session) {
    return workspaceFilesError(401, "authentication_required", "Sign in to access workspace files.");
  }

  const query = parseWorkspaceFilesListQuery(request.nextUrl.searchParams);
  if (!query) return workspaceFilesError(400, "invalid_query", "The file list query is invalid.");

  try {
    const listing = await listWorkspaceFiles({
      actor: session.user,
      ...query,
    });
    return workspaceFilesJson({ data: listing });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    return workspaceFilesError(500, "storage_unavailable", "Workspace files are temporarily unavailable.");
  }
}
