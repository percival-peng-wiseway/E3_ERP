import { answerWithOpenAICompatible, knowledgeAbstention } from "@/lib/agent/deepseek";
import { isKnowledgeConversationIntent } from "@/lib/agent/tool-routing";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/agent/request";
import {
  resolveAgentSettings,
  resolveDeepSeekSettings,
  resolveEnvironmentAgentSettings,
  preferredAgentModelSettings,
  type ResolvedAgentSettings,
} from "@/lib/agent/settings";
import { localWorkspaceAnswer } from "@/lib/agent/tools";
import { AgentTrace } from "@/lib/agent/trace";
import { deterministicWorkflowDependencies } from "@/lib/agent/workflow-dependencies";
import { runDeterministicWorkflow } from "@/lib/agent/workflows";
import { getERPProvider, type AgentHistoryMessage } from "@/lib/erp";
import { agentAuthContext } from "@/lib/business-agent/auth";
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
  const auth = agentAuthContext(request);
  if (!auth) {
    return error(401, "authentication_required", "Sign in to use E3 Agent.");
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

  const provider = getERPProvider(request);
  const knowledgeRequest = isKnowledgeConversationIntent(input.message, input.history.slice(-2).map((item) => item.content));
  const trace = new AgentTrace();
  const warnings: string[] = [];
  let modelStatus: "available" | "unavailable" | "not_checked" = "not_checked";
  let settings: ResolvedAgentSettings;
  try {
    const [legacySettings, deepSeekSettings] = await Promise.all([
      resolveAgentSettings(),
      resolveDeepSeekSettings(),
    ]);
    settings = preferredAgentModelSettings(legacySettings, deepSeekSettings);
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
    const workflowAnswer = knowledgeRequest ? null : await trace.step(
      "harness.route",
      "workflow",
      () => runDeterministicWorkflow(provider, input.message, trace, deterministicWorkflowDependencies),
    );
    if (workflowAnswer) {
      data = workflowAnswer;
    } else {
      modelStatus = "unavailable";
      data = await trace.step("model.openai_compatible", "model", async () => {
        const answer = await answerWithOpenAICompatible({
          provider,
          auth,
          message: input.message,
          history: input.history,
          section: input.section,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
        });
        modelStatus = "available";
        return answer;
      });
    }
  } catch (primaryError) {
    // Errors can originate from a live deterministic source or from the model.
    // Their messages may contain upstream response bodies, so log only the class.
    console.error("Agent primary answer path unavailable; using local fallback", safeErrorKind(primaryError));
    warnings.push(modelStatus === "unavailable"
      ? "Model unavailable. Local read-only mode is active."
      : "Live workspace query unavailable. Local read-only mode is active.");
    trace.markOutcome("fallback");
    try {
      data = knowledgeRequest
        ? knowledgeAbstention(input.message)
        : await trace.step("local.fallback", "fallback", () => localWorkspaceAnswer(provider, input.message));
    } catch (fallbackError) {
      trace.markOutcome("error");
      trace.emit();
      throw fallbackError;
    }
  }

  const traceSnapshot = trace.snapshot();
  trace.emit();

  return json({
    data,
    meta: {
      source: provider.source,
      generatedAt: new Date().toISOString(),
      configured: Boolean(settings.apiKey),
      modelStatus,
      model: settings.model,
      trace: traceSnapshot,
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
