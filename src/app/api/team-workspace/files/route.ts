import { getErpSession } from "@/lib/auth/session";
import { listManagedErpUsers } from "@/lib/auth/user-repository";
import { isSameOriginRequest } from "@/lib/server/proxy-security";
import { listEntries, readAttachment, saveEntry } from "@/lib/team-workspace/repository";
import { imagePreviewType } from "@/lib/team-workspace/image-type";
import { WorkError } from "@/lib/team-workspace/model";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (error: string, status: number) => Response.json({ error }, { status });
export async function GET(request: Request) {
  if (!getErpSession(request)) return json("Sign in required.", 401);
  try {
    const query = new URL(request.url).searchParams;
    const { bytes, attachment } = await readAttachment(query.get("task") || "", query.get("file") || "");
    const previewType = query.get("preview") === "1" ? imagePreviewType(bytes) : undefined;
    return new Response(new Uint8Array(bytes), { headers: { "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Type": previewType || "application/octet-stream", "Content-Disposition": `${previewType ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, "%27")}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return json(error instanceof WorkError ? error.message : "Unable to download file.", error instanceof WorkError ? error.status : 500); }
}
export async function POST(request: Request) {
  const session = getErpSession(request);
  if (!session) return json("Sign in required.", 401);
  if (!isSameOriginRequest(request)) return json("Same-origin request required.", 403);
  try {
    const reader = request.body?.getReader(); if (!reader) return json("Choose a file.", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 11 * 1024 * 1024) { await reader.cancel(); return json("Maximum file size is 10 MB.", 413); } chunks.push(value); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
    const upload = form.get("file");
    if (!(upload instanceof File)) return json("Choose a file.", 400);
    const old = (await listEntries()).find(entry => entry.id === form.get("task") && entry.kind === "task");
    if (!old) return json("Task not found.", 404);
    const users = (await listManagedErpUsers()).filter(user => user.active);
    const entry = await saveEntry({ ...old, version: Number(form.get("version")), update: `Uploaded file: ${upload.name.slice(0,200)}` }, session.user, users.map(user => user.username), users.filter(user => user.role === "admin").map(user => user.username), { name: upload.name, bytes: new Uint8Array(await upload.arrayBuffer()) });
    return Response.json({ entry });
  } catch (error) { return json(error instanceof WorkError ? error.message : "Unable to upload file.", error instanceof WorkError ? error.status : 500); }
}
