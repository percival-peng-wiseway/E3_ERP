import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { canAccessKnowledgeScope } from "@/lib/knowledge/config";
import { KNOWLEDGE_TENANT_ID } from "@/lib/knowledge/types";
import { listActiveKnowledgeChunkCounts, listKnowledgeDocuments } from "@/lib/knowledge/repository";
import { knowledgeDocumentView } from "@/app/api/knowledge/view";
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
  if (query.view === "knowledge" && session.user.role !== "admin") {
    return workspaceFilesError(403, "admin_required", "Only Administrators can inspect knowledge resources.");
  }

  try {
    const listing = await listWorkspaceFiles({
      actor: session.user,
      ...query,
    });
    const documents = await listKnowledgeDocuments({
      tenantId: KNOWLEDGE_TENANT_ID,
      includeDisabled: true,
    });
    const chunkCounts = session.user.role === "admin"
      ? await listActiveKnowledgeChunkCounts(KNOWLEDGE_TENANT_ID)
      : new Map<string, number>();
    const knowledgeByFileId = new Map(documents.map((document) => [document.fileId, document]));
    listing.items = listing.items
      .filter((item) => {
        const document = knowledgeByFileId.get(item.id);
        if (query.view === "knowledge") return Boolean(document);
        return !document || canAccessKnowledgeScope(session.user.role, document.accessScope);
      })
      .map((item) => {
        if (session.user.role !== "admin") return item;
        const document = knowledgeByFileId.get(item.id);
        return {
          ...item,
          knowledge: document
            ? knowledgeDocumentView(document, chunkCounts.get(document.id) || 0)
            : null,
        };
      });
    return workspaceFilesJson({ data: listing });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      return workspaceFilesError(error.status, error.code, error.message);
    }
    return workspaceFilesError(500, "storage_unavailable", "Workspace files are temporarily unavailable.");
  }
}
