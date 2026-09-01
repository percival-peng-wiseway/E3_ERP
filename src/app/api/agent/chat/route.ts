import { agentAuthContext } from "@/lib/erp_agent/business-agent/auth";
import { LiveBusinessDataProvider } from "@/lib/erp_agent/business-agent/data-provider";
import { chatWithBusinessAgent } from "@/lib/erp_agent/business-agent/service";
import { resolveKimiSettings } from "@/lib/erp_agent/agent/settings";
import { kimiRequestWarning, safeKimiErrorKind } from "@/lib/erp_agent/agent/kimi-error";
import { AgentRequestBodyTooLarge, readLimitedAgentJson, requestHasJsonContentType } from "@/lib/erp_agent/agent/request";
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
  let kimiRegion: "china" | "international" | undefined;
  try {
    const kimi = await resolveKimiSettings();
    kimiRegion = kimi.region;
    const response = await chatWithBusinessAgent({
      input,
      auth,
      dataProvider: new LiveBusinessDataProvider(getERPProvider(request), searchKnowledgeBase),
      kimiConfig: kimi.apiKey ? {
        apiKey: kimi.apiKey,
        baseUrl: kimi.baseUrl,
        flashModel: kimi.fastModel,
        complexModel: kimi.complexModel,
      } : null,
    });
    return json(response);
  } catch (error) {
    console.error(
      "Business Agent unavailable",
      safeKimiErrorKind(error) || (error instanceof Error ? error.name : "UnknownError"),
    );
    const modelWarning = kimiRequestWarning(error, kimiRegion);
    return json({ error: {
      code: modelWarning?.code || "agent_unavailable",
      message: modelWarning?.message || "The Agent cannot process this request right now.",
    } }, 502);
  }
}
