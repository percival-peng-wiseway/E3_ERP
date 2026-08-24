import { answerWithOpenAICompatible } from "@/lib/agent/deepseek";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/agent/request";
import {
  resolveAgentSettings,
  resolveEnvironmentAgentSettings,
  type ResolvedAgentSettings,
} from "@/lib/agent/settings";
import { localWorkspaceAnswer } from "@/lib/agent/tools";
import { getERPProvider, type AgentHistoryMessage } from "@/lib/erp";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AGENT_BODY = 32 * 1024;

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

function error(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

function safeErrorKind(value: unknown) {
  return value instanceof Error ? value.name : "UnknownError";
}

function cleanHistory(value: unknown): AgentHistoryMessage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const history: AgentHistoryMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => key !== "role" && key !== "content")
      || (candidate.role !== "user" && candidate.role !== "assistant")
      || typeof candidate.content !== "string" || candidate.content.length > 2_000) return null;
    history.push({ role: candidate.role, content: candidate.content });
  }
  return history.slice(-12);
}

function cleanRequest(value: unknown): { message: string; section?: string; history: AgentHistoryMessage[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["message", "section", "history"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || typeof body.message !== "string") return null;
  const message = body.message.trim();
  if (!message || message.length > 2_000) return null;
  if (body.section !== undefined && (typeof body.section !== "string" || body.section.length > 80)) return null;
  const history = cleanHistory(body.history);
  if (!history) return null;
  return {
    message,
    ...(typeof body.section === "string" && body.section.trim() ? { section: body.section.trim() } : {}),
    history,
  };
}

async function processAgentRequest(request: Request) {
  if (!isAuthorizedMutationRequest(request)) {
    return error(403, "forbidden", "Agent requests must come from the same-origin application.");
  }
  if (!requestHasJsonContentType(request)) {
    return error(415, "json_required", "Agent requests accept a JSON body only.");
  }

  let input;
  try {
    input = cleanRequest(await readLimitedAgentJson(request, MAX_AGENT_BODY));
  } catch (requestError) {
    if (requestError instanceof AgentRequestBodyTooLarge) {
      return error(413, "request_too_large", "Agent requests cannot exceed 32 KiB.");
    }
    if (requestError instanceof SyntaxError) {
      return error(400, "invalid_json", "The request body must be valid JSON.");
    }
    return error(400, "invalid_request", "The Agent request is invalid.");
  }
  if (!input) {
    return error(400, "invalid_request", "Enter a question of up to 2,000 characters with valid conversation history.");
  }

  const provider = getERPProvider();
  const warnings: string[] = [];
  let settings: ResolvedAgentSettings;
  try {
    settings = await resolveAgentSettings();
  } catch (settingsError) {
    // Do not log the exception message: a corrupt JSON document or upstream
    // error can contain saved credentials or response content.
    console.error(
      "Saved Agent settings unavailable; using environment/default configuration",
      safeErrorKind(settingsError),
    );
    settings = resolveEnvironmentAgentSettings();
    warnings.push(
      "Saved Agent settings are temporarily unavailable. The environment or default model configuration is being used.",
    );
  }
  let data;
  try {
    data = await answerWithOpenAICompatible({
      provider,
      message: input.message,
      history: input.history,
      section: input.section,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
  } catch (modelError) {
    // Model error messages can contain an upstream response body. Log only the
    // error class and keep the client warning generic.
    console.error("Agent model API unavailable; using local fallback", safeErrorKind(modelError));
    warnings.push("The model API is temporarily unavailable. Local read-only query mode is being used.");
    data = await localWorkspaceAnswer(provider, input.message);
  }

  return json({
    data,
    meta: {
      source: provider.source,
      generatedAt: new Date().toISOString(),
      configured: true,
      model: settings.model,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    },
  });
}

export async function POST(request: Request) {
  try {
    return await processAgentRequest(request);
  } catch (agentError) {
    console.error("Agent API error", safeErrorKind(agentError));
    return error(502, "agent_unavailable", "The Agent cannot process this request right now.");
  }
}
