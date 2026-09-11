import { getErpSession } from "@/lib/auth/session";
import { listManagedErpUsers } from "@/lib/auth/user-repository";
import { isSameOriginRequest } from "@/lib/server/proxy-security";
import { listEntries, saveEntry, markNotificationRead } from "@/lib/team-workspace/repository";
import { WorkError } from "@/lib/team-workspace/model";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function members() { return (await listManagedErpUsers()).filter(u => u.active).map(({ username, displayName, role }) => ({ username, displayName, role })); }
export async function GET(request: Request) {
  if (!getErpSession(request)) return json({ error: "Sign in required." }, 401);
  try { return json({ entries: await listEntries(), members: await members() }); }
  catch { return json({ error: "Unable to load the workspace." }, 500); }
}
export async function POST(request: Request) {
  const session = getErpSession(request);
  if (!session) return json({ error: "Sign in required." }, 401);
  if (!isSameOriginRequest(request)) return json({ error: "Same-origin request required." }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON required." }, 415);
  try {
    const reader = request.body?.getReader(); if (!reader) return json({ error: "Empty request." }, 400);
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 64000) { await reader.cancel(); return json({ error: "Entry is too large." }, 413); } chunks.push(value); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "Invalid entry." }, 400);
    if (input.action === "read_notification" && typeof input.id === "string") {
      await markNotificationRead(input.id, session.user.username); return json({ ok: true });
    }
    const team = await members();
    const entry = await saveEntry(input, session.user, team.map(u => u.username), team.filter(u => u.role === "admin").map(u => u.username));
    return json({ entry });
  } catch (error) { if (error instanceof WorkError) return json({ error: error.message }, error.status); if (error instanceof SyntaxError) return json({ error: "Invalid JSON." }, 400); return json({ error: "Unable to save. Your changes have not been discarded; try again." }, 500); }
}
