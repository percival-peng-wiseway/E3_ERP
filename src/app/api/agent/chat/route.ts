import { agentAuthContext } from "@/lib/business-agent/auth";
import { LiveBusinessDataProvider } from "@/lib/business-agent/data-provider";
import { chatWithBusinessAgent } from "@/lib/business-agent/service";
import { resolveDeepSeekSettings } from "@/lib/agent/settings";
import { AgentRequestBodyTooLarge, readLimitedAgentJson, requestHasJsonContentType } from "@/lib/agent/request";
import { getERPProvider } from "@/lib/erp";
import { searchKnowledgeBase } from "@/lib/knowledge/search-service";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 16 * 1024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function cleanInput(value: unknown): { message: string; conversation_id?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "message" && key !== "conversation_id")
    || typeof body.message !== "string" || !body.message.trim() || body.message.length > 2_000) return null;
  if (body.conversation_id !== undefined && (typeof body.conversation_id !== "string"
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.conversation_id))) return null;
  return { message: body.message.trim(), ...(typeof body.conversation_id === "string" ? { conversation_id: body.conversation_id } : {}) };
}

export async function POST(request: Request) {
  if (!isAuthorizedMutationRequest(request)) return json({ error: { code: "forbidden", message: "Same-origin request required." } }, 403);
  if (!requestHasJsonContentType(request)) return json({ error: { code: "json_required", message: "JSON body required." } }, 415);
  const auth = agentAuthContext(request);
  if (!auth) return json({ error: { code: "authentication_required", message: "Authentication required." } }, 401);
  let raw: unknown;
  try { raw = await readLimitedAgentJson(request, MAX_BODY); }
  catch (error) {
    return json({ error: { code: error instanceof AgentRequestBodyTooLarge ? "request_too_large" : "invalid_json", message: "Invalid request body." } }, error instanceof AgentRequestBodyTooLarge ? 413 : 400);
  }
  const input = cleanInput(raw);
  if (!input) return json({ error: { code: "invalid_request", message: "message and optional conversation_id are required." } }, 400);
  try {
    const deepSeek = await resolveDeepSeekSettings();
    return json(await chatWithBusinessAgent({
      input,
      auth,
      dataProvider: new LiveBusinessDataProvider(getERPProvider(request), searchKnowledgeBase),
      deepSeekConfig: deepSeek.apiKey ? {
        apiKey: deepSeek.apiKey,
        baseUrl: deepSeek.baseUrl,
        flashModel: deepSeek.fastModel,
        complexModel: deepSeek.complexModel,
      } : null,
    }));
  } catch (error) {
    console.error("Business Agent unavailable", error instanceof Error ? error.name : "UnknownError");
    return json({ error: { code: "agent_unavailable", message: "The Agent cannot process this request right now." } }, 502);
  }
}
