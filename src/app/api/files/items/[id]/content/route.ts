import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  getWorkspaceFileContent,
  WorkspaceFilesRepositoryError,
} from "@/lib/workspace-files/repository";
import {
  parseWorkspaceFileContentMode,
  safeWorkspaceFileContentDisposition,
  workspaceFileId,
  workspaceFilesError,
} from "@/lib/workspace-files/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PREVIEW_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function itemId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return workspaceFileId(id);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = getErpSession(request);
  if (!session) {
    return workspaceFilesError(401, "authentication_required", "Sign in to open workspace files.");
  }
  const mode = parseWorkspaceFileContentMode(request.nextUrl.searchParams);
  if (!mode) return workspaceFilesError(400, "invalid_mode", "Choose preview or download mode.");
  const id = await itemId(context);
  if (!id) return workspaceFilesError(400, "invalid_id", "The file ID is invalid.");

  try {
    const content = await getWorkspaceFileContent({ actor: session.user, id });
    if (!content) return workspaceFilesError(404, "not_found", "File not found.");
    const contentType = content.item.contentType || "application/octet-stream";
    if (mode === "preview" && !PREVIEW_TYPES.has(contentType)) {
      return workspaceFilesError(415, "preview_unavailable", "This file type must be downloaded.");
    }
    const storedBytes = await content.read();
    const bytes = new Uint8Array(storedBytes.byteLength);
    bytes.set(storedBytes);
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": safeWorkspaceFileContentDisposition(
          mode === "preview" ? "inline" : "attachment",
          content.item.name,
        ),
        "content-length": String(bytes.byteLength),
        "content-security-policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
        "content-type": mode === "preview" ? contentType : "application/octet-stream",
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy": "camera=(), geolocation=(), microphone=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError) {
      const response = workspaceFilesError(error.status, error.code, error.message);
      if (error.code === "file_not_ready") response.headers.set("retry-after", "5");
      return response;
    }
    return workspaceFilesError(500, "file_unavailable", "The file is temporarily unavailable.");
  }
}
