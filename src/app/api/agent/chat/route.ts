import { after } from "next/server";
import { agentAuthContext } from "@/lib/erp_agent/business-agent/auth";
import { LiveBusinessDataProvider } from "@/lib/erp_agent/business-agent/data-provider";
import { chatWithBusinessAgent } from "@/lib/erp_agent/business-agent/service";
import { resolveKimiSettings } from "@/lib/erp_agent/agent/settings";
import { AgentRequestBodyTooLarge, readLimitedAgentJson, requestHasJsonContentType } from "@/lib/erp_agent/agent/request";
import { getERPProvider } from "@/lib/erp";
import { searchKnowledgeBase } from "@/lib/knowledge/search-service";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import {
  hashedSessionId,
  scheduleLangfuseFlush,
  summarizeText,
  traceAgentRequest,
} from "@/lib/erp_agent/langfuse";

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
  scheduleLangfuseFlush(after);
  return traceAgentRequest({
    name: "answer-business-question",
    input: summarizeText(input.message),
    userId: auth.principalHash,
    ...(input.conversation_id ? {
      sessionId: hashedSessionId(input.conversation_id, `${auth.tenantId}\0${auth.principalHash}`),
    } : {}),
    tags: ["business-agent", "route:api-agent-chat", `tenant:${auth.tenantId}`, `role:${auth.role}`],
    traceMetadata: {
      route: "/api/agent/chat",
      tenantId: auth.tenantId,
      role: auth.role,
    },
    metadata: {
      route: "/api/agent/chat",
      tenantId: auth.tenantId,
      role: auth.role,
      permissionCount: auth.permissions.size,
      messageCharacterCount: input.message.length,
      messageLanguage: /[\u3400-\u9fff]/u.test(input.message) ? "zh" : "other",
      hasConversationId: Boolean(input.conversation_id),
    },
  }, async (observation) => {
    try {
      const kimi = await resolveKimiSettings();
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
      observation.update({
        output: summarizeText(response.answer),
        metadata: {
          status: response.route === "unavailable" ? "unavailable" : response.route === "clarification" ? "clarification" : "completed",
          route: response.route,
          model: response.model_used,
          answerCharacterCount: response.answer.length,
          citationCount: response.citations.length,
          toolCallCount: response.tool_calls_summary.length,
          limitationCount: response.limitations.length,
        },
        level: response.route === "unavailable" ? "WARNING" : "DEFAULT",
        statusMessage: response.route,
      });
      return json(response);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      observation.update({
        output: { status: "unavailable" },
        metadata: { status: "unavailable", errorName },
        level: "ERROR",
        statusMessage: errorName,
      });
      console.error("Business Agent unavailable", errorName);
      return json({ error: { code: "agent_unavailable", message: "The Agent cannot process this request right now." } }, 502);
    }
  });
}
