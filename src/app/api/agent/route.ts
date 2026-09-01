import { answerWithKimi, informationNotFound } from "@/lib/erp_agent/agent/kimi";
import { kimiRequestWarning, safeKimiErrorKind } from "@/lib/erp_agent/agent/kimi-error";
import { shouldUseKnowledgeConversationIntent } from "@/lib/erp_agent/agent/tool-routing";
import { resolveInventoryUsageMessage } from "@/lib/erp_agent/agent/inventory-usage";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/erp_agent/agent/request";
import {
  resolveKimiSettings,
  resolveEnvironmentKimiSettings,
  type ResolvedKimiSettings,
} from "@/lib/erp_agent/agent/settings";
import { AgentTrace } from "@/lib/erp_agent/agent/trace";
import { deterministicWorkflowDependencies } from "@/lib/erp_agent/agent/workflow-dependencies";
import { runDeterministicWorkflow } from "@/lib/erp_agent/agent/workflows";
import { getERPProvider, type AgentHistoryMessage } from "@/lib/erp";
import { agentAuthContext } from "@/lib/erp_agent/business-agent/auth";
import { getErpSession } from "@/lib/auth/session";
import {
  AgentAttachmentError,
  cleanAgentAttachmentIds,
  isKimiImageContentType,
  resolveAgentAttachments,
  resolveKimiImageParts,
} from "@/lib/erp_agent/agent/attachments";
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
  return safeKimiErrorKind(value) || (value instanceof Error ? value.name : "UnknownError");
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

function cleanRequest(value: unknown): {
  message: string;
  section?: string;
  history: AgentHistoryMessage[];
  conversation_id?: string;
  attachment_ids: string[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["message", "section", "history", "conversation_id", "attachments"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || typeof body.message !== "string") return null;
  const message = body.message.trim();
  if (!message || message.length > 2_000) return null;
  if (body.section !== undefined && (typeof body.section !== "string" || body.section.length > 80)) return null;
  if (body.conversation_id !== undefined && (typeof body.conversation_id !== "string"
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.conversation_id))) return null;
  const history = cleanHistory(body.history);
  const attachmentIds = cleanAgentAttachmentIds(body.attachments);
  if (!history || !attachmentIds) return null;
  return {
    message,
    ...(typeof body.section === "string" && body.section.trim() ? { section: body.section.trim() } : {}),
    ...(typeof body.conversation_id === "string" ? { conversation_id: body.conversation_id } : {}),
    history,
    attachment_ids: attachmentIds,
  };
}

async function processAgentRequest(request: Request) {
  if (!isAuthorizedMutationRequest(request)) {
    return error(403, "forbidden", "Agent requests must come from the same-origin application.");
  }
  const auth = agentAuthContext(request);
  const session = getErpSession(request);
  if (!auth || !session) {
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

  let attachments;
  try {
    attachments = await resolveAgentAttachments({ fileIds: input.attachment_ids, actor: session.user });
  } catch (attachmentError) {
    if (attachmentError instanceof AgentAttachmentError) {
      return error(attachmentError.status, attachmentError.code, attachmentError.message);
    }
    return error(503, "attachment_unavailable", "The attached files are temporarily unavailable.");
  }
  const pendingAttachment = attachments.find((attachment) => attachment.status === "processing");
  if (pendingAttachment) {
    return error(409, "attachment_processing", `“${pendingAttachment.name}” is still being prepared for Agent search.`);
  }
  const failedAttachment = attachments.find((attachment) => attachment.status === "failed");
  if (failedAttachment) {
    return error(409, "attachment_failed", `“${failedAttachment.name}” could not be prepared for Agent search.`);
  }
  const attachmentDocuments = attachments.flatMap((attachment) => attachment.knowledgeDocumentId
    ? [{ documentId: attachment.knowledgeDocumentId, name: attachment.name }]
    : []);
  let imageParts;
  try {
    imageParts = await resolveKimiImageParts({ attachments, actor: session.user });
  } catch (attachmentError) {
    if (attachmentError instanceof AgentAttachmentError) {
      return error(attachmentError.status, attachmentError.code, attachmentError.message);
    }
    return error(503, "attachment_unavailable", "The attached images are temporarily unavailable.");
  }

  const provider = getERPProvider(request);
  const workspaceMessage = resolveInventoryUsageMessage(input.message, input.history);
  const requiresKnowledge = attachmentDocuments.length > 0 || shouldUseKnowledgeConversationIntent(
    workspaceMessage,
    input.history.slice(-2).map((item) => item.content),
    {
      hasImages: imageParts.length > 0,
      hasAttachedKnowledgeDocuments: attachmentDocuments.length > 0,
    },
  );
  const modelRequest = imageParts.length > 0 || requiresKnowledge;
  const trace = new AgentTrace();
  const warnings: string[] = [];
  if (attachments.some((attachment) => attachment.status === "unsupported" && !isKimiImageContentType(attachment.contentType))) {
    warnings.push("The attachment was uploaded, but this Agent cannot analyse that file type yet.");
  }
  let modelStatus: "available" | "unavailable" | "not_checked" = "not_checked";
  let settings: ResolvedKimiSettings;
  try {
    settings = await resolveKimiSettings();
  } catch (settingsError) {
    // Do not log the exception message: a corrupt JSON document or upstream
    // error can contain saved credentials or response content.
    console.error(
      "Saved Agent settings unavailable; using environment/default configuration",
      safeErrorKind(settingsError),
    );
    settings = resolveEnvironmentKimiSettings();
    warnings.push(
      "Saved Agent settings are temporarily unavailable. The environment or default model configuration is being used.",
    );
  }
  let data;
  if (modelRequest && !settings.apiKey) {
    modelStatus = "unavailable";
    warnings.push("Kimi K2.6 must be configured before the Agent can answer this request.");
    trace.markOutcome("error");
    data = informationNotFound(input.message);
  } else {
    try {
      const workflowAnswer = modelRequest ? null : await trace.step(
        "harness.workflow",
        "workflow",
        () => runDeterministicWorkflow(provider, workspaceMessage, trace, deterministicWorkflowDependencies),
      );
      if (workflowAnswer) {
        data = workflowAnswer;
      } else if (!settings.apiKey) {
        modelStatus = "unavailable";
        warnings.push("Kimi K2.6 must be configured before the Agent can answer this request.");
        trace.markOutcome("error");
        data = informationNotFound(input.message);
      } else {
        modelStatus = "unavailable";
        data = await trace.step("model.kimi", "model", async () => {
          const answer = await answerWithKimi({
            provider,
            auth,
            message: input.message,
            history: input.history,
            section: input.section,
            conversationId: input.conversation_id,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.fastModel,
            attachmentDocuments,
            imageParts,
          });
          modelStatus = "available";
          return answer;
        });
      }
    } catch (primaryError) {
      // Errors can originate from a live deterministic source or from the model.
      // Their messages may contain upstream response bodies, so log only the class.
      console.error("Agent primary answer path unavailable; no fallback answer generated", safeErrorKind(primaryError));
      const modelWarning = modelStatus === "unavailable"
        ? kimiRequestWarning(primaryError, settings.region)
        : null;
      warnings.push(modelWarning
        ? `${modelWarning.message} No fallback answer was generated.`
        : modelStatus === "unavailable"
          ? "The model request failed. No fallback answer was generated."
          : "The required live workspace data could not be verified. No fallback answer was generated.");
      trace.markOutcome("error");
      data = informationNotFound(input.message);
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
      model: settings.fastModel,
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
