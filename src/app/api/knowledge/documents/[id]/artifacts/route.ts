import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { getKnowledgeDocument, listActiveKnowledgeChunksForDocument } from "@/lib/knowledge/repository";
import { canAccessKnowledgeScope, KNOWLEDGE_VECTOR_CONFIG } from "@/lib/knowledge/config";
import { readMarkdownArtifact } from "@/lib/knowledge/markdown-artifact";
import { getWorkspaceFileContent, getWorkspaceFileIndexSource } from "@/lib/workspace-files/repository";
import { erpCloudflareBindings } from "@/lib/server/cloudflare-storage";
import { workspaceFileId } from "@/lib/workspace-files/request";
import { knowledgeJson, knowledgeError } from "../../../request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return knowledgeError(401, "authentication_required", "Sign in to view knowledge artifacts.");
  const id = workspaceFileId((await context.params).id);
  if (!id) return knowledgeError(400, "invalid_id", "Invalid document ID.");
  const format = request.nextUrl.searchParams.get("format");
  if (format && !["markdown", "vectors"].includes(format)) return knowledgeError(400, "invalid_format", "Invalid artifact format.");
  try {
    const document = await getKnowledgeDocument(id);
    if (!document || document.status === "disabled" || !canAccessKnowledgeScope(session.user.role, document.accessScope)) return knowledgeError(404, "not_found", "Document unavailable.");
    const file = await getWorkspaceFileContent({ actor: session.user, id: document.fileId });
    const source = file && await getWorkspaceFileIndexSource(document.fileId);
    if (!source) return knowledgeError(404, "not_found", "Source file unavailable.");
    if (source.checksum !== document.sourceChecksum || source.version !== document.fileVersion) return knowledgeError(409, "source_changed", "The source changed. Reindex this document first.");
    const markdown = await readMarkdownArtifact(document);
    // Never mix a previous generation's vectors with a newly converted source.
    const chunks = (await listActiveKnowledgeChunksForDocument(id)).filter(chunk => chunk.indexGeneration === document.indexGeneration);
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    const download = (body: string, extension: string, contentType: string) => new Response(body, { headers: { ...headers, "Content-Type": contentType, "Content-Disposition": `attachment; filename="knowledge.${extension}"; filename*=UTF-8''${encodeURIComponent(document.fileName.replace(/\.[^.]+$/, "") + "." + extension)}` } });
    if (format === "markdown") {
      if (!markdown) return knowledgeError(409, "not_converted", "Reindex this document to create its Markdown output.");
      return download(markdown.markdown, "md", "text/markdown; charset=utf-8");
    }
    if (format === "vectors") {
      if (document.status !== "ready" || !chunks.length) return knowledgeError(409, "not_indexed", "Vectorization is not complete for this generation.");
      const bindings = await erpCloudflareBindings();
      const saved = await bindings?.files?.get(`knowledge-artifacts/${id}/g${document.indexGeneration}/${document.sourceChecksum}/vectors.json`, "arrayBuffer");
      if (!saved) return knowledgeError(409, "not_saved", "Reindex this document to create its vector file.");
      return download(new TextDecoder().decode(saved), "vectors.json", "application/json; charset=utf-8");
    }
    return knowledgeJson({ data: { markdown, generation: document.indexGeneration, status: document.status,
      model: KNOWLEDGE_VECTOR_CONFIG.embeddingModel, dimensions: KNOWLEDGE_VECTOR_CONFIG.dimensions,
      chunks: chunks.map(chunk => ({ id: chunk.indexItemId, text: chunk.text, tokenCount: chunk.tokenCount, pageFrom: chunk.pageFrom, pageTo: chunk.pageTo })) } });
  } catch {
    return knowledgeError(503, "artifacts_unavailable", "Knowledge artifacts could not be loaded. Please retry.");
  }
}
