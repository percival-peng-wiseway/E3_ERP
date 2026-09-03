import { createHash } from "node:crypto";
import { after } from "next/server";
import { answerWithKimi, informationNotFound, proposePersonalSkillWithKimi } from "@/lib/erp_agent/agent/kimi";
import { kimiRequestWarning, safeKimiErrorKind } from "@/lib/erp_agent/agent/kimi-error";
import { shouldUseKnowledgeConversationIntent } from "@/lib/erp_agent/agent/tool-routing";
import { resolveInventoryUsageMessage } from "@/lib/erp_agent/agent/inventory-usage";
import { resolveWeeklyFollowUpMessage } from "@/lib/erp_agent/agent/weekly-follow-up";
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
import { recordAgentTrace } from "@/lib/erp_agent/agent/trace-store";
import type {
  AgentTraceContext,
  AgentTraceIssueCode,
  AgentTraceRequestLanguage,
} from "@/lib/erp_agent/agent/trace-record";
import { controlledMemoryFromConversation } from "@/lib/erp_agent/agent/memory";
import { resolveAgentSkillPolicy, skillForWorkflow } from "@/lib/erp_agent/agent/skills";
import {
  ManagedSkillError,
  PERSONAL_SKILL_BUILDER_SKILL_ID,
  resolveInvokedManagedSkill,
} from "@/lib/erp_agent/agent/managed-skills";
import {
  isPersonalSkillBuilderIntent,
  personalSkillBuilderMessageIsSafe,
  PERSONAL_SKILL_BUILDER_PROMPT_VERSION,
  runPersonalSkillBuilder,
} from "@/lib/erp_agent/agent/skill-builder";
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
import { recordAgentConversationAudit } from "@/lib/erp_agent/agent/conversation-store";

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

function requestLanguage(value: string): AgentTraceRequestLanguage {
  const chinese = /[\u3400-\u9fff]/u.test(value);
  const english = /[a-z]/iu.test(value);
  if (chinese && english) return "mixed";
  if (chinese) return "chinese";
  if (english) return "english";
  return "other";
}

function conversationKey(username: string, conversationId?: string) {
  if (!conversationId) return null;
  return createHash("sha256").update(`${username}:${conversationId}`).digest("hex").slice(0, 24);
}

async function persistTrace(trace: AgentTrace, context: AgentTraceContext) {
  const snapshot = trace.snapshot();
  trace.emit();
  try {
    await recordAgentTrace(snapshot, context);
  } catch (traceError) {
    // Trace persistence must never prevent the Agent from returning an answer.
    console.error("Agent Trace persistence failed", safeErrorKind(traceError));
  }
  return snapshot;
}

async function persistConversationAudit(input: Parameters<typeof recordAgentConversationAudit>[0]) {
  try {
    await recordAgentConversationAudit(input);
  } catch (auditError) {
    // Conversation audit is best effort. Never expose storage errors or prevent
    // a valid Agent answer because audit storage is unavailable.
    console.error("Agent Conversation Audit persistence failed", safeErrorKind(auditError));
  }
}

function scheduleConversationAudit(input: Parameters<typeof recordAgentConversationAudit>[0]) {
  // OpenNext maps Next's after() lifecycle to the Worker execution context, so
  // a slow D1 audit write cannot delay the user-visible Agent response.
  after(() => persistConversationAudit(input));
}

function visibleConversationAnswer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = (value as Record<string, unknown>).answer;
  return typeof answer === "string" && answer.trim() ? answer.trim() : null;
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
  request_id?: string;
  skill_id?: string;
  attachment_ids: string[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["message", "section", "history", "conversation_id", "request_id", "skill_id", "attachments"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || typeof body.message !== "string") return null;
  const message = body.message.trim();
  if (!message || message.length > 2_000) return null;
  if (body.section !== undefined && (typeof body.section !== "string" || body.section.length > 80)) return null;
  if (body.conversation_id !== undefined && (typeof body.conversation_id !== "string"
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.conversation_id))) return null;
  if (body.request_id !== undefined && (typeof body.request_id !== "string"
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.request_id))) return null;
  if (body.skill_id !== undefined && (typeof body.skill_id !== "string"
    || !/^(?:weekly-business-summary|personal-skill-builder|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(body.skill_id))) return null;
  const history = cleanHistory(body.history);
  const attachmentIds = cleanAgentAttachmentIds(body.attachments);
  if (!history || !attachmentIds) return null;
  return {
    message,
    ...(typeof body.section === "string" && body.section.trim() ? { section: body.section.trim() } : {}),
    ...(typeof body.conversation_id === "string" ? { conversation_id: body.conversation_id } : {}),
    ...(typeof body.request_id === "string" ? { request_id: body.request_id } : {}),
    ...(typeof body.skill_id === "string" ? { skill_id: body.skill_id.toLocaleLowerCase("en-AU") } : {}),
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

  const trace = new AgentTrace();
  const issueCodes = new Set<AgentTraceIssueCode>();
  let modelStatus: AgentTraceContext["modelStatus"] = "not_checked";
  let traceDataSource = "unresolved";
  const hashedConversationKey = conversationKey(session.user.username, input.conversation_id);
  const traceContext = (): AgentTraceContext => ({
    actorUsername: session.user.username,
    actorRole: session.user.role,
    conversationKey: hashedConversationKey,
    messageLength: input.message.length,
    historyMessageCount: input.history.length,
    attachmentCount: input.attachment_ids.length,
    requestLanguage: requestLanguage(input.message),
    dataSource: traceDataSource,
    modelStatus,
    issueCodes: [...issueCodes],
  });
  const tracedError = async (status: number, code: string, message: string) => {
    const traceSnapshot = await persistTrace(trace, traceContext());
    scheduleConversationAudit({
      actorUsername: session.user.username,
      actorRole: session.user.role,
      conversationKey: hashedConversationKey,
      traceId: traceSnapshot.id,
      question: input.message,
      visibleAnswer: message,
    });
    return error(status, code, message);
  };

  let attachments;
  try {
    attachments = await resolveAgentAttachments({ fileIds: input.attachment_ids, actor: session.user });
  } catch (attachmentError) {
    if (attachmentError instanceof AgentAttachmentError) {
      trace.markOutcome("error");
      trace.markAbstained();
      issueCodes.add("attachment_failed");
      return tracedError(attachmentError.status, attachmentError.code, attachmentError.message);
    }
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("attachment_failed");
    return tracedError(503, "attachment_unavailable", "The attached files are temporarily unavailable.");
  }
  const pendingAttachment = attachments.find((attachment) => attachment.status === "processing");
  if (pendingAttachment) {
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("attachment_processing");
    return tracedError(409, "attachment_processing", `“${pendingAttachment.name}” is still being prepared for Agent search.`);
  }
  const failedAttachment = attachments.find((attachment) => attachment.status === "failed");
  if (failedAttachment) {
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("attachment_failed");
    return tracedError(409, "attachment_failed", `“${failedAttachment.name}” could not be prepared for Agent search.`);
  }
  const attachmentDocuments = attachments.flatMap((attachment) => attachment.knowledgeDocumentId
    ? [{ documentId: attachment.knowledgeDocumentId, name: attachment.name }]
    : []);
  let imageParts;
  try {
    imageParts = await resolveKimiImageParts({ attachments, actor: session.user });
  } catch (attachmentError) {
    if (attachmentError instanceof AgentAttachmentError) {
      trace.markOutcome("error");
      trace.markAbstained();
      issueCodes.add("attachment_failed");
      return tracedError(attachmentError.status, attachmentError.code, attachmentError.message);
    }
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("attachment_failed");
    return tracedError(503, "attachment_unavailable", "The attached images are temporarily unavailable.");
  }

  const provider = getERPProvider(request);
  traceDataSource = provider.source;
  const skillPolicy = resolveAgentSkillPolicy();
  let managedSkill: Awaited<ReturnType<typeof resolveInvokedManagedSkill>> = null;
  let managedSkillLookupSucceeded = false;
  try {
    managedSkill = await resolveInvokedManagedSkill({
      skillId: input.skill_id,
      message: input.message,
      owner: { principalHash: auth.principalHash, username: session.user.username },
    });
    managedSkillLookupSucceeded = true;
  } catch (skillError) {
    if (skillError instanceof ManagedSkillError) {
      trace.markOutcome("error");
      trace.markAbstained();
      issueCodes.add("skill_unavailable");
      return tracedError(skillError.status, skillError.code, skillError.message);
    }
    if (input.skill_id) {
      trace.markOutcome("error");
      trace.markAbstained();
      issueCodes.add("skill_unavailable");
      return tracedError(503, "skill_unavailable", "The selected Skill is temporarily unavailable.");
    }
    console.error("Agent managed Skill lookup failed", safeErrorKind(skillError));
  }
  if (managedSkillLookupSucceeded && !managedSkill && !input.skill_id
    && isPersonalSkillBuilderIntent(input.message)) {
    managedSkill = await resolveInvokedManagedSkill({
      skillId: PERSONAL_SKILL_BUILDER_SKILL_ID,
      message: input.message,
      owner: { principalHash: auth.principalHash, username: session.user.username },
    });
  }
  const buildingPersonalSkill = managedSkill?.id === PERSONAL_SKILL_BUILDER_SKILL_ID;
  if (buildingPersonalSkill && process.env.NODE_ENV !== "production"
    && process.env.ERP_REMOTE_DATA_READ_ONLY === "true") {
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("skill_unavailable");
    return tracedError(403, "remote_read_only", "Skill changes are disabled while local development uses read-only cloud data.");
  }
  if (buildingPersonalSkill && input.attachment_ids.length) {
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("skill_unavailable");
    return tracedError(400, "skill_builder_text_only", "Create a Skill from one explicit text request without attachments.");
  }
  if (buildingPersonalSkill && !input.request_id) {
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("skill_unavailable");
    return tracedError(400, "skill_builder_request_id_required", "Retry this Skill request from the current E3 Agent interface.");
  }
  if (buildingPersonalSkill && !personalSkillBuilderMessageIsSafe(input.message)) {
    trace.markOutcome("error");
    trace.markAbstained();
    issueCodes.add("skill_unavailable");
    return tracedError(400, "skill_builder_sensitive_request", "Remove credentials, email addresses, webhooks and external links before creating a Skill.");
  }
  const executionMessage = managedSkill?.source === "custom" ? managedSkill.prompt : input.message;
  const weeklyFollowUpMessage = !managedSkill && input.attachment_ids.length === 0
    ? resolveWeeklyFollowUpMessage(executionMessage, input.history)
    : executionMessage;
  const workspaceMessage = resolveInventoryUsageMessage(weeklyFollowUpMessage, input.history);
  const enabledSkills = new Set([...skillPolicy.enabled].filter((skill) => (
    !managedSkill || managedSkill.capabilityIds.includes(skill)
  )));
  const memory = controlledMemoryFromConversation(input.message, input.history);
  const requiresKnowledge = !buildingPersonalSkill && (attachmentDocuments.length > 0 || shouldUseKnowledgeConversationIntent(
    workspaceMessage,
    input.history.slice(-2).map((item) => item.content),
    {
      hasImages: imageParts.length > 0,
      hasAttachedKnowledgeDocuments: attachmentDocuments.length > 0,
    },
  ));
  const modelRequest = buildingPersonalSkill || imageParts.length > 0 || requiresKnowledge;
  const warnings: string[] = [];
  if (skillPolicy.rejected.length) {
    // Configuration values are deliberately not emitted: only the count is safe
    // and sufficient to diagnose an invalid Skill allow-list.
    console.warn("E3 Agent ignored unrecognised configured Skills", skillPolicy.rejected.length);
  }
  if (attachments.some((attachment) => attachment.status === "unsupported" && !isKimiImageContentType(attachment.contentType))) {
    warnings.push("The attachment was uploaded, but this Agent cannot analyse that file type yet.");
    issueCodes.add("unsupported_attachment");
  }
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
    issueCodes.add("settings_unavailable");
  }
  let data;
  let skillMutation: {
    type: "created";
    skill: { id: string; name: string; trigger: string; version: number; capabilityIds: string[] };
  } | null = null;
  if (buildingPersonalSkill) {
    trace.selectWorkflow("personal_skill_builder");
    trace.selectRoute({
      promptVersion: PERSONAL_SKILL_BUILDER_PROMPT_VERSION,
      skills: [`managed:${PERSONAL_SKILL_BUILDER_SKILL_ID}@v1`],
      toolsets: [],
      memoryKeys: [],
    });
    const builderApiKey = settings.apiKey;
    const builderModelState: { status: AgentTraceContext["modelStatus"] } = {
      status: modelStatus,
    };
    const modelUnavailable = new Error("Personal Skill Builder requires a configured model.");
    modelUnavailable.name = "SkillBuilderModelUnavailable";
    try {
      const result = await trace.step("personal_skill_builder.create", "workflow", () => runPersonalSkillBuilder({
        message: input.message,
        owner: { principalHash: auth.principalHash, username: session.user.username },
        requestId: input.request_id!,
        propose: async ({ message }) => {
          if (!builderApiKey) throw modelUnavailable;
          builderModelState.status = "unavailable";
          modelStatus = "unavailable";
          const proposal = await proposePersonalSkillWithKimi({
            message,
            apiKey: builderApiKey,
            baseUrl: settings.baseUrl,
            model: settings.fastModel,
            trace,
          });
          builderModelState.status = "available";
          modelStatus = "available";
          return proposal;
        },
      }));
      trace.selectWorkflow(result.status === "created"
        ? "personal_skill_builder_created"
        : "personal_skill_builder_clarification");
      if (result.status === "clarification") trace.markAbstained();
      data = {
        mode: builderModelState.status === "available" ? "kimi" as const : "local" as const,
        answer: result.answer,
        suggestions: result.status === "created"
          ? [result.skill.trigger, requestLanguage(input.message) === "chinese" ? "再创建一个 Skill" : "Create another Skill"]
          : [requestLanguage(input.message) === "chinese" ? "创建 Skill：总结本周送货和库存，触发词是本周业务简报" : "Create a Skill: summarize weekly deliveries and inventory, triggered by Weekly business brief"],
      };
      if (result.status === "created") {
        skillMutation = {
          type: "created",
          skill: {
            id: result.skill.id,
            name: result.skill.name,
            trigger: result.skill.trigger,
            version: result.skill.version,
            capabilityIds: [...result.skill.capabilityIds],
          },
        };
      }
    } catch (builderError) {
      console.error("Personal Skill Builder failed without creating a fallback Skill", safeErrorKind(builderError));
      const missingModel = builderError === modelUnavailable;
      const modelWarning = !missingModel && builderModelState.status === "unavailable"
        ? kimiRequestWarning(builderError, settings.region)
        : null;
      warnings.push(missingModel
        ? "Kimi K2.6 must be configured before the Agent can draft a personal Skill. No Skill was created."
        : modelWarning
          ? `${modelWarning.message} No Skill was created.`
          : builderModelState.status === "unavailable"
            ? "The model request failed. No Skill was created."
            : "The personal Skill could not be saved. No Skill was created.");
      trace.markOutcome("error");
      trace.markAbstained();
      if (missingModel) {
        builderModelState.status = "unavailable";
        modelStatus = "unavailable";
        issueCodes.add("model_unavailable");
      } else {
        issueCodes.add(builderModelState.status === "unavailable" ? "model_error" : "skill_unavailable");
      }
      data = {
        mode: "local" as const,
        answer: missingModel
          ? requestLanguage(input.message) === "chinese"
            ? "当前模型尚未配置，因此没有创建 Skill。你仍可通过 My Agent Skills 手动添加。"
            : "The model is not configured, so no Skill was created. You can still add one manually in My Agent Skills."
          : requestLanguage(input.message) === "chinese"
            ? "这次没有创建 Skill，请稍后重试或在 My Agent Skills 中手动添加。"
            : "No Skill was created. Try again later or add it manually in My Agent Skills.",
        suggestions: [requestLanguage(input.message) === "chinese" ? "创建 Skill：总结本周送货和库存" : "Create a Skill: summarize weekly deliveries and inventory"],
      };
    }
  } else if (requiresKnowledge && !enabledSkills.has("knowledge")) {
    modelStatus = "not_checked";
    warnings.push("The knowledge capability is not enabled for this Agent environment.");
    issueCodes.add("knowledge_disabled");
    trace.selectRoute({ skills: [], toolsets: [], memoryKeys: memory.keys });
    trace.markAbstained();
    data = informationNotFound(input.message);
  } else if (modelRequest && !settings.apiKey) {
    modelStatus = "unavailable";
    warnings.push("Kimi K2.6 must be configured before the Agent can answer this request.");
    issueCodes.add("model_unavailable");
    trace.markOutcome("error");
    trace.markAbstained();
    data = informationNotFound(input.message);
  } else {
    try {
      const workflowAnswer = modelRequest || managedSkill?.source === "custom" ? null : await trace.step(
        "harness.workflow",
        "workflow",
        () => runDeterministicWorkflow(
          provider,
          workspaceMessage,
          trace,
          deterministicWorkflowDependencies,
          {
            enabledSkills,
            managedSkillId: managedSkill?.id,
          },
        ),
      );
      if (workflowAnswer) {
        const workflow = trace.snapshot().workflow;
        if (workflowAnswer.incompleteData) {
          // Only structured diagnostics are recorded. The unavailable marker
          // intentionally carries no source payload, tool arguments or result.
          trace.markOutcome("fallback");
          trace.recordTool({
            name: workflow === "weekly_schedule_query"
              ? "search_weekly_schedule"
              : workflow === "weekly_business_summary"
                ? "weekly_business_summary_sources"
                : "workflow_data_sources",
            status: "unavailable",
            durationMs: 0,
          });
          issueCodes.add("tool_unavailable");
        }
        const workflowSkill = workflow ? skillForWorkflow(workflow) : null;
        trace.selectRoute({
          skills: managedSkill
            ? [`managed:${managedSkill.id}@v${managedSkill.version}`, ...enabledSkills]
            : workflowSkill ? [workflowSkill] : [],
          toolsets: managedSkill ? [...enabledSkills] : workflowSkill ? [workflowSkill] : [],
          memoryKeys: memory.keys,
        });
        data = workflowAnswer;
      } else if (!settings.apiKey) {
        modelStatus = "unavailable";
        warnings.push("Kimi K2.6 must be configured before the Agent can answer this request.");
        issueCodes.add("model_unavailable");
        trace.markOutcome("error");
        trace.markAbstained();
        data = informationNotFound(input.message);
      } else {
        modelStatus = "unavailable";
        data = await trace.step("model.kimi", "model", async () => {
          const answer = await answerWithKimi({
            provider,
            auth,
            message: workspaceMessage,
            history: input.history,
            section: input.section,
            conversationId: input.conversation_id,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.fastModel,
            attachmentDocuments,
            imageParts,
            enabledSkills,
            memory,
            trace,
            traceSkillTags: managedSkill ? [`managed:${managedSkill.id}@v${managedSkill.version}`] : [],
            requireVerifiedTool: managedSkill?.source === "custom",
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
      trace.markAbstained();
      issueCodes.add(modelStatus === "unavailable" ? "model_error" : "agent_error");
      data = informationNotFound(input.message);
    }
  }

  const traceSnapshot = await persistTrace(trace, traceContext());
  const visibleAnswer = visibleConversationAnswer(data);
  if (visibleAnswer) {
    scheduleConversationAudit({
      actorUsername: session.user.username,
      actorRole: session.user.role,
      conversationKey: hashedConversationKey,
      traceId: traceSnapshot.id,
      question: input.message,
      visibleAnswer,
    });
  }

  return json({
    data,
    meta: {
      source: provider.source,
      generatedAt: new Date().toISOString(),
      configured: Boolean(settings.apiKey),
      modelStatus,
      model: settings.fastModel,
      skillPolicy: skillPolicy.source,
      enabledSkillCount: enabledSkills.size,
      ...(managedSkill ? {
        managedSkill: { id: managedSkill.id, name: managedSkill.name, version: managedSkill.version },
      } : {}),
      ...(skillMutation ? { skillMutation } : {}),
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
