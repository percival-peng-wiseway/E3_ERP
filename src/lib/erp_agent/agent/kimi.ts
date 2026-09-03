import { createHash } from "node:crypto";
import type { ERPProvider } from "@/lib/erp";
import type { AgentAuthContext } from "@/lib/erp_agent/business-agent/contracts";
import type { AgentAnswer, AgentCitation, AgentHistoryMessage } from "@/lib/erp/types";
import type { KimiImagePart } from "./attachments";
import { focusedAgentToolNames, shouldUseKnowledgeConversationIntent } from "./tool-routing";
import { parseKnowledgeCitationSelection } from "./knowledge-citation-selection";
import { KimiRequestError, kimiHttpError, kimiNetworkError } from "./kimi-error";
import {
  executeRegisteredAgentTool,
  registeredAgentTool,
  selectRegisteredAgentTools,
  validateRegisteredAgentToolArguments,
} from "./tool-registry";
import { E3_BUSINESS_SKILLS, resolveAgentSkillPolicy, type BusinessSkillId } from "./skills";
import { controlledMemoryFromConversation, type AgentControlledMemory } from "./memory";
import { AGENT_PROMPT_VERSION, buildAgentSystemPrompt } from "./prompt-builder";
import type { AgentTrace } from "./trace";
import {
  ABSOLUTE_AGENT_QUERY_PLAN_MAX_STEPS,
  AGENT_QUERY_PLAN_VERSION,
  DEFAULT_AGENT_QUERY_PLAN_MAX_STEPS,
  buildAgentPlanResponseFormat,
  parseAgentQueryPlan,
  type AgentQueryPlan,
} from "./query-plan";
import {
  agentQueryPlanDimensions,
  clampAgentToolArgumentsToPrivacyConsent,
  deriveAgentQueryPolicyRequirements,
  validateAgentQueryPlanCoverage,
} from "./query-policy";

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const MAX_TOOL_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 4;
const MAX_OUTBOUND_BODY = 30 * 1024 * 1024;

const SUGGESTIONS = [
  "Give me a workspace overview",
  "Which stock items need attention?",
  "Show unscheduled Weekly Schedule work",
  "How much customer payment is outstanding?",
];

const WORKSPACE_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function citationText(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

/** Parse only allow-listed fields from this turn's server tool result. */
export function citationsFromKnowledgeToolOutput(content: string): AgentCitation[] {
  let payload: unknown;
  try { payload = JSON.parse(content); } catch { return []; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const envelope = payload as Record<string, unknown>;
  if (envelope.ok !== true || !Array.isArray(envelope.data)) return [];
  const authorisedRecordIds = new Set(Array.isArray(envelope.source_record_ids)
    ? envelope.source_record_ids.filter((value): value is string => typeof value === "string")
    : []);
  if (!authorisedRecordIds.size) return [];
  const source = citationText(envelope.source, 100) || "knowledge_index";
  const citations: AgentCitation[] = [];
  const seen = new Set<string>();
  for (const raw of envelope.data.slice(0, 8)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const documentId = citationText(item.document_id, 100);
    const title = citationText(item.title, 300);
    const version = citationText(item.version, 80);
    if (!documentId || !title || !version) continue;
    const chunkId = citationText(item.chunk_id, 160);
    if (!authorisedRecordIds.has(documentId)
      || (chunkId ? !authorisedRecordIds.has(chunkId) : false)) continue;
    const key = `${documentId}:${chunkId || "document"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const effectiveFrom = item.effective_from === null ? null : citationText(item.effective_from, 50);
    const fileId = citationText(item.file_id, 100);
    const pageNumber = item.page_number === null ? null
      : typeof item.page_number === "number" && Number.isSafeInteger(item.page_number)
        && item.page_number >= 1 && item.page_number <= 100_000 ? item.page_number : undefined;
    const sourcePath = item.source_path === null ? null : citationText(item.source_path, 1_000);
    const headingPath = Array.isArray(item.heading_path)
      ? item.heading_path.map((entry) => citationText(entry, 300)).filter((entry): entry is string => Boolean(entry)).slice(0, 12)
      : undefined;
    const updatedAt = citationText(item.updated_at, 50);
    citations.push({
      documentId, title, version, effectiveFrom, source,
      ...(chunkId ? { chunkId } : {}),
      ...(fileId && WORKSPACE_FILE_ID.test(fileId) ? { fileId: fileId.toLocaleLowerCase("en-AU") } : {}),
      ...(pageNumber !== undefined ? { pageNumber } : {}),
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(headingPath?.length ? { headingPath } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return citations;
}

export function informationNotFound(message: string): AgentAnswer {
  const chinese = /[\u3400-\u9fff]/u.test(message);
  return {
    mode: "kimi",
    answer: chinese
      ? "找不到对应信息，请重试"
      : "No matching information was found. Please try again.",
    suggestions: chinese
      ? ["换一个更具体的关键词", "调整查询时间范围", "确认相关数据源可用"]
      : ["Try a more specific query", "Adjust the date range", "Check that the relevant data source is available"],
    citations: [],
  };
}

export const knowledgeAbstention = informationNotFound;

function productActivityIsVerified(content: string) {
  try {
    const value: unknown = JSON.parse(content);
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).complete === true
      && (value as Record<string, unknown>).found === true);
  } catch {
    return false;
  }
}

type ToolVerification = "verified" | "empty" | "unavailable";

function containsUnavailableMarker(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsUnavailableMarker(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.available === false) return true;
  return Object.values(record).some((item) => containsUnavailableMarker(item, depth + 1));
}

function toolOutputVerification(content: string): ToolVerification {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return "unavailable"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unavailable";
  const record = value as Record<string, unknown>;
  if (record.error || record.ok === false || record.incomplete_data === true || record.complete === false) {
    return "unavailable";
  }
  if (containsUnavailableMarker(record)) return "unavailable";
  if (Array.isArray(record.sourceWarnings) && record.sourceWarnings.length > 0) return "unavailable";
  if (record.inventoryOrdersAvailable === false || record.projectTrackAvailable === false) return "unavailable";
  // A zero-row page is not proof of an empty source when the tool says that
  // the returned page itself was truncated.
  if (record.truncated === true
    && (record.count === 0 || record.found === false)) return "unavailable";
  if (record.found === false) return "empty";
  if (record.complete === true) return "verified";
  if (typeof record.count === "number") return record.count > 0 ? "verified" : "empty";
  if (Array.isArray(record.data)) return record.data.length > 0 ? "verified" : "empty";
  if (typeof record.content === "string") return record.content.trim() ? "verified" : "empty";
  const usageArrays = ["deliveredOrders", "activeOrders", "cancelledOrders", "installedProjects", "projectCommitments"];
  if (usageArrays.some((key) => Array.isArray(record[key]))) {
    return usageArrays.some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0)
      ? "verified" : "empty";
  }
  return "unavailable";
}

function toolOutputLimitState(content: string) {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { truncated: false, lowerBound: false };
    const record = value as Record<string, unknown>;
    return {
      truncated: record.truncated === true,
      lowerBound: record.countIsLowerBound === true || record.totalAvailable === false,
    };
  } catch {
    return { truncated: false, lowerBound: false };
  }
}

function melbourneToday() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type KimiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type KimiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    strict: true;
    parameters: unknown;
  };
};

type KimiAssistantMessage = {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};

type KimiTextPart = { type: "text"; text: string };
type KimiMessage =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: string | Array<KimiImagePart | KimiTextPart> }
  | KimiAssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

type KimiPayload = {
  choices?: Array<{
    message?: KimiAssistantMessage;
    finish_reason?: "stop" | "tool_calls" | "length" | "content_filter" | string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
};

function isToolCall(value: unknown): value is KimiToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const call = value as Partial<KimiToolCall>;
  return typeof call.id === "string" && call.id.length > 0 && call.id.length <= 300
    && call.type === "function" && Boolean(call.function)
    && typeof call.function?.name === "string"
    && /^[a-zA-Z_][a-zA-Z0-9-_]{0,127}$/u.test(call.function.name)
    && typeof call.function?.arguments === "string" && call.function.arguments.length <= 8_192;
}

async function limitedResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) throw new Error("The model API returned an oversized response.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("The model API returned an oversized response.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function limitedPayload(response: Response): Promise<KimiPayload> {
  const bytes = await limitedResponseBytes(response);
  if (!bytes.byteLength) return {};
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as KimiPayload : {};
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

async function createCompletion(options: {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  messages: KimiMessage[];
  tools: readonly KimiToolDefinition[];
  forceToolName?: string;
  conversationId?: string;
  thinking?: "enabled" | "disabled" | null;
  reasoningEffort?: "low" | "high" | "max";
  responseFormat?: unknown;
  maxCompletionTokens?: number;
  timeoutMs?: number;
}) {
  const isK3 = /^kimi-k3(?:$|[-_.])/iu.test(options.model.trim());
  // K3 always reasons and uses the top-level reasoning_effort control. Sending
  // the K2.6 `thinking` object to K3 is an invalid protocol combination.
  const thinking = isK3
    ? null
    : options.thinking === undefined ? "disabled" : options.thinking;
  const reasoningEffort = isK3 ? options.reasoningEffort || "high" : undefined;
  const maxCompletionTokens = isK3
    ? Math.max(options.maxCompletionTokens || 4_000, 4_000)
    : options.maxCompletionTokens || 800;
  const body = JSON.stringify({
    model: options.model,
    messages: options.messages,
    ...(options.tools.length ? {
      tools: options.tools,
      tool_choice: options.forceToolName
        ? { type: "function", function: { name: options.forceToolName } }
        : "auto",
    } : {}),
    stream: false,
    ...(thinking ? { thinking: { type: thinking } } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    max_completion_tokens: maxCompletionTokens,
    ...(options.conversationId ? {
      prompt_cache_key: `conv_${createHash("sha256").update(options.conversationId).digest("hex").slice(0, 32)}`,
    } : {}),
  });
  if (Buffer.byteLength(body, "utf8") > MAX_OUTBOUND_BODY) {
    throw new Error("The Agent conversation exceeded the safe context limit.");
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(options.baseUrl), {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      // Cloudflare Workers supports follow/manual but rejects redirect="error"
      // before the request is sent. Manual mode preserves the same SSRF safety
      // property when redirects are explicitly rejected below.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs || 35_000),
    });
  } catch {
    throw kimiNetworkError();
  }
  if (response.status >= 300 && response.status < 400) {
    throw kimiNetworkError();
  }
  if (!response.ok) {
    // Never parse an upstream error body: it is untrusted and may contain echoed
    // request content or credentials. Status alone is sufficient for diagnosis.
    throw kimiHttpError(response.status);
  }
  let payload: KimiPayload;
  try {
    payload = await limitedPayload(response);
  } catch {
    throw new KimiRequestError("invalid_response");
  }
  const choice = payload.choices?.[0];
  const message = choice?.message;
  if (!message || message.role !== "assistant") throw new Error("The model API did not return an assistant message.");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!calls.every(isToolCall) || calls.length > MAX_CALLS_PER_ROUND
    || new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new Error("The model API returned invalid tool calls.");
  }
  const offeredToolNames = new Set(options.tools.map((tool) => tool.function.name));
  if (calls.some((call) => !offeredToolNames.has(call.function.name))) {
    throw new Error("The model API requested an unavailable tool.");
  }
  if (choice?.finish_reason !== (calls.length ? "tool_calls" : "stop")) {
    throw new Error("The model API returned an incomplete response.");
  }
  const assistant = {
    role: "assistant",
    content: typeof message.content === "string" ? message.content.slice(0, 20_000) : null,
    ...(typeof message.reasoning_content === "string"
      ? { reasoning_content: message.reasoning_content.slice(0, 50_000) } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  } satisfies KimiAssistantMessage;
  return {
    message: assistant,
    usage: {
      inputTokens: Number.isSafeInteger(payload.usage?.prompt_tokens) ? payload.usage?.prompt_tokens : undefined,
      outputTokens: Number.isSafeInteger(payload.usage?.completion_tokens) ? payload.usage?.completion_tokens : undefined,
    },
  };
}

export const PERSONAL_SKILL_PROPOSAL_TOOL = {
  type: "function",
  function: {
    name: "propose_personal_skill",
    description: "Return either one clarification question or one bounded personal read-only Skill proposal.",
    strict: true,
    parameters: {
      anyOf: [{
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["clarify"] },
          question: { type: "string" },
        },
        required: ["action", "question"],
      }, {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["create"] },
          skill: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              trigger: { type: "string" },
              prompt: { type: "string" },
              enabled: { type: "boolean", enum: [true] },
              capabilityIds: {
                type: "array",
                items: { type: "string", enum: E3_BUSINESS_SKILLS.map(({ id }) => id) },
              },
            },
            required: ["name", "description", "trigger", "prompt", "enabled", "capabilityIds"],
          },
        },
        required: ["action", "skill"],
      }],
    },
  },
} as const satisfies KimiToolDefinition;

export async function proposePersonalSkillWithKimi(options: {
  message: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  trace?: AgentTrace;
}): Promise<unknown> {
  const allowedCapabilities = E3_BUSINESS_SKILLS
    .map(({ id, name }) => `${id} (${name})`)
    .join(", ");
  const system = [
    "You prepare a proposal for one personal E3 Agent Skill after the user explicitly requested its creation.",
    "This is proposal generation only. You cannot save, update, delete or execute anything.",
    "Use only the latest user message. Do not infer consent or requirements from earlier conversation.",
    "A Skill is manually triggered and read-only. It may answer questions or summarize authorised ERP data, but it cannot run automatically, monitor in the background, notify people, send messages, approve work, or modify ERP data.",
    `Choose the smallest relevant capabilityIds only from: ${allowedCapabilities}.`,
    "Never output owner, username, permissions, roles, credentials, URLs, code, tool definitions or extra fields.",
    "The skill.prompt must describe only a read operation and begin with a read verb such as Summarize, Show, List, Find, Explain, Compare, Check, Calculate, Read, 总结, 显示, 查看, 列出, 查找, 说明, 比较, 检查, 统计 or 读取.",
    "Use action=create only when the current message states a clear repeatable task and an exact trigger phrase can be derived. Include skill with enabled=true.",
    "Otherwise use action=clarify with one short question asking the user to restate a complete explicit creation request, including task, data and trigger phrase. Omit skill for clarification and omit question for creation.",
    "Call propose_personal_skill exactly once and do not provide ordinary assistant text.",
  ].join("\n");
  const modelStartedAt = Date.now();
  let completion: Awaited<ReturnType<typeof createCompletion>>;
  try {
    completion = await createCompletion({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: options.message.slice(0, 2_000) },
      ],
      tools: [PERSONAL_SKILL_PROPOSAL_TOOL],
      forceToolName: PERSONAL_SKILL_PROPOSAL_TOOL.function.name,
    });
    options.trace?.recordModelRound({
      model: options.model,
      status: "ok",
      durationMs: Date.now() - modelStartedAt,
      toolCallCount: completion.message.tool_calls?.length || 0,
      ...(completion.usage.inputTokens !== undefined ? { inputTokens: completion.usage.inputTokens } : {}),
      ...(completion.usage.outputTokens !== undefined ? { outputTokens: completion.usage.outputTokens } : {}),
    });
  } catch (error) {
    options.trace?.recordModelRound({
      model: options.model,
      status: "error",
      durationMs: Date.now() - modelStartedAt,
      toolCallCount: 0,
    });
    throw error;
  }
  const calls = completion.message.tool_calls || [];
  if (calls.length !== 1 || calls[0].function.name !== PERSONAL_SKILL_PROPOSAL_TOOL.function.name) {
    return null;
  }
  try {
    return JSON.parse(calls[0].function.arguments) as unknown;
  } catch {
    return null;
  }
}

export async function answerWithKimi(options: {
  provider: ERPProvider;
  auth: AgentAuthContext;
  message: string;
  history?: AgentHistoryMessage[];
  section?: string;
  conversationId?: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  attachmentDocuments?: readonly { documentId: string; name: string }[];
  imageParts?: readonly KimiImagePart[];
  enabledSkills?: ReadonlySet<BusinessSkillId>;
  memory?: AgentControlledMemory;
  trace?: AgentTrace;
  traceSkillTags?: readonly string[];
  requireVerifiedTool?: boolean;
}): Promise<AgentAnswer> {
  const { provider, auth, message, history = [], section, apiKey, baseUrl, model, trace } = options;
  const attachmentDocuments = (options.attachmentDocuments || []).slice(0, 4);
  const imageParts = (options.imageParts || []).slice(0, 4);
  const enabledSkills = options.enabledSkills || resolveAgentSkillPolicy().enabled;
  const requireVerifiedTool = options.requireVerifiedTool === true;
  const memory = options.memory || controlledMemoryFromConversation(message, history);
  const knowledgeRequired = attachmentDocuments.length > 0
    || shouldUseKnowledgeConversationIntent(
      message,
      history.slice(-2).map((item) => item.content),
      {
        hasImages: imageParts.length > 0,
        hasAttachedKnowledgeDocuments: attachmentDocuments.length > 0,
      },
    );
  const system = buildAgentSystemPrompt({
    businessDate: melbourneToday(),
    section,
    knowledgeRequired,
    imageCount: imageParts.length,
    attachedKnowledgeDocumentCount: attachmentDocuments.length,
    enabledSkills,
    memory,
  });

  const messages: KimiMessage[] = [
    { role: "system", content: system },
    ...history.slice(-12).map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) } as KimiMessage)),
    { role: "user", content: imageParts.length
      ? [...imageParts, { type: "text", text: message }]
      : message },
  ];
  const focusedNames = requireVerifiedTool
    ? null
    : knowledgeRequired
      ? ["search_knowledge_base"] as const
      : imageParts.length > 0
        ? null
        : focusedAgentToolNames(message);
  const selection = requireVerifiedTool
    ? selectRegisteredAgentTools({
      enabledSkills,
      ...(imageParts.length > 0 ? { excludeNames: ["search_knowledge_base"] as const } : {}),
      permissions: auth.permissions,
    })
    : knowledgeRequired
      ? selectRegisteredAgentTools({ enabledSkills, focusedNames, permissions: auth.permissions })
      : imageParts.length > 0
        ? selectRegisteredAgentTools({ enabledSkills, excludeNames: ["search_knowledge_base"], permissions: auth.permissions })
        : selectRegisteredAgentTools({ enabledSkills, focusedNames, permissions: auth.permissions });
  const tools = selection.definitions;
  trace?.selectRoute({
    promptVersion: AGENT_PROMPT_VERSION,
    skills: [...(options.traceSkillTags || []), ...selection.skills],
    toolsets: selection.toolsets,
    memoryKeys: memory.keys,
  });
  const abstain = () => {
    trace?.markAbstained();
    return informationNotFound(message);
  };
  if (knowledgeRequired && !selection.names.includes("search_knowledge_base")) return abstain();
  if (focusedNames && selection.names.length !== focusedNames.length) return abstain();
  if (requireVerifiedTool && selection.skills.length !== enabledSkills.size) return abstain();
  if (requireVerifiedTool && tools.length === 0) return abstain();
  const requiredToolsets = new Set(selection.toolsets);
  const observedToolsets = new Set(selection.toolsets.slice(0, 0));
  const groundedCitationsByChunk = new Map<string, AgentCitation>();
  let knowledgeSearchAttempted = false;
  let productActivityAttempted = false;
  let productActivityVerified = true;
  let verifiedToolObserved = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const modelStartedAt = Date.now();
    let completion: Awaited<ReturnType<typeof createCompletion>>;
    try {
      completion = await createCompletion({
        apiKey,
        baseUrl,
        model,
        messages,
        tools,
        ...(round === 0 && tools.length === 1 ? { forceToolName: tools[0].function.name } : {}),
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      });
      trace?.recordModelRound({
        model,
        status: "ok",
        durationMs: Date.now() - modelStartedAt,
        toolCallCount: completion.message.tool_calls?.length || 0,
        ...(completion.usage.inputTokens !== undefined ? { inputTokens: completion.usage.inputTokens } : {}),
        ...(completion.usage.outputTokens !== undefined ? { outputTokens: completion.usage.outputTokens } : {}),
      });
    } catch (error) {
      trace?.recordModelRound({
        model,
        status: "error",
        durationMs: Date.now() - modelStartedAt,
        toolCallCount: 0,
      });
      throw error;
    }
    const assistant = completion.message;
    messages.push(assistant);
    const calls = assistant.tool_calls || [];
    if (!calls.length) {
      const answer = assistant.content?.trim();
      if (!answer) throw new Error("The model API did not return displayable text.");
      if (requireVerifiedTool && (
        !verifiedToolObserved
        || [...requiredToolsets].some((toolset) => !observedToolsets.has(toolset))
      )) return abstain();
      if (knowledgeRequired) {
        const selected = parseKnowledgeCitationSelection(answer);
        const citations = selected
          ? selected.chunkIds.map((chunkId) => groundedCitationsByChunk.get(chunkId))
          : [];
        const passed = knowledgeSearchAttempted && Boolean(selected)
          && citations.length > 0 && citations.every(Boolean);
        if (!passed || !selected) return abstain();
        return {
          mode: "kimi",
          answer: selected.answer,
          suggestions: SUGGESTIONS,
          citations: citations.filter((citation): citation is AgentCitation => Boolean(citation)),
        };
      }
      if (requireVerifiedTool && !verifiedToolObserved) return abstain();
      return { mode: "kimi", answer, suggestions: SUGGESTIONS };
    }
    const outputs = await Promise.all(calls.map(async (call) => {
      const toolStartedAt = Date.now();
      let content: string;
      try {
        content = await executeRegisteredAgentTool(provider, call.function, auth, enabledSkills, {
          knowledgeDocumentIds: attachmentDocuments.map((item) => item.documentId),
        });
      } catch (error) {
        trace?.recordTool({
          name: call.function.name,
          status: "error",
          durationMs: Date.now() - toolStartedAt,
        });
        throw error;
      }
      if (call.function.name === "search_product_activity") {
        productActivityAttempted = true;
        productActivityVerified = productActivityVerified && productActivityIsVerified(content);
      }
      if (call.function.name === "search_knowledge_base") {
        knowledgeSearchAttempted = true;
        for (const citation of citationsFromKnowledgeToolOutput(content)) {
          if (citation.chunkId) groundedCitationsByChunk.set(citation.chunkId, citation);
        }
      }
      const verification = toolOutputVerification(content);
      const registration = registeredAgentTool(call.function.name);
      trace?.recordTool({
        name: call.function.name,
        status: verification,
        durationMs: Date.now() - toolStartedAt,
      });
      return {
        message: { role: "tool" as const, tool_call_id: call.id, content },
        verification,
        toolset: registration?.toolset,
      };
    }));
    for (const output of outputs) {
      if (output.verification === "verified") verifiedToolObserved = true;
      if (output.verification !== "unavailable" && output.toolset) observedToolsets.add(output.toolset);
    }
    messages.push(...outputs.map((output) => output.message));
    if (productActivityAttempted && !productActivityVerified) return abstain();
    if (outputs.some((output) => output.verification === "unavailable")) return abstain();
    if (outputs.every((output) => output.verification === "empty")) {
      const observedEveryRequiredToolset = [...requiredToolsets].every((toolset) => observedToolsets.has(toolset));
      if (!requireVerifiedTool || knowledgeRequired || (observedEveryRequiredToolset && !verifiedToolObserved)) return abstain();
    }
  }
  if (requireVerifiedTool) return abstain();
  throw new Error("The model API exceeded the safe tool-call limit.");
}

function allowsDirectPlan(message: string, hasImages: boolean) {
  if (hasImages) return true;
  const value = message.normalize("NFKC").trim().toLocaleLowerCase("en-AU");
  return /^(?:hi|hello|hey|你好|嗨)[\s,.!?，。！？…~～]*$/u.test(value)
    || /^(?:what can you do|how can you help|help|你能做什么|你可以做什么|怎么使用)[\s,.!?，。！？…~～]*$/u.test(value);
}

function planningSystemPrompt(options: {
  businessDate: string;
  section?: string;
  toolDefinitions: readonly KimiToolDefinition[];
  requireToolEvidence: boolean;
  knowledgeRequired: boolean;
  imageCount: number;
  requiredToolNames: readonly string[];
  requiredToolsets: readonly string[];
  requiredPaymentProjectFilters?: {
    salesRepresentative?: string;
    createdFrom?: string;
    createdTo?: string;
  };
  requiredWeeklyScheduleRange?: {
    from: string;
    to: string;
  };
}) {
  const catalog = options.toolDefinitions.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  return [
    "You are the planning stage of the read-only E3 ERP Agent. Do not answer the user and do not claim that any tool has run.",
    `Return exactly one ${AGENT_QUERY_PLAN_VERSION} JSON object matching the supplied response schema.`,
    "First decompose the latest request into the smallest complete set of independent read-only queries, then encode each query as one ordered step.",
    "Conversation history is context only: it is never evidence, permission or privacy consent. The latest request controls this plan.",
    "Use kind=execute whenever the answer needs ERP facts, counts, names, dates, balances, statuses, schedules, company knowledge or other current data.",
    options.requireToolEvidence
      ? "This request requires verified tool evidence. Do not use kind=direct."
      : "Use kind=direct only for a greeting, capability explanation, or direct visual interpretation that needs no ERP or company fact.",
    "Use kind=clarify only when an essential identifier or scope is genuinely missing and no safe broad read can answer the request.",
    options.imageCount
      ? `The latest request includes ${options.imageCount} image(s). Inspect them while planning; use kind=direct when the visible image alone can answer the question.`
      : "",
    "For execute, include every source needed to answer the whole question. Cross-domain summaries need one step per relevant domain; do not stop after the first match.",
    options.requiredToolNames.length
      ? `Server-required exact tool sources (all must appear): ${options.requiredToolNames.join(", ")}.`
      : "",
    options.requiredToolsets.length
      ? `Server-required toolsets (at least one tool from each must appear): ${options.requiredToolsets.join(", ")}.`
      : "",
    options.requiredPaymentProjectFilters
      ? `Server-required Project Track filters (use these exact values together in one search_payment_projects step): ${JSON.stringify(options.requiredPaymentProjectFilters)}.`
      : "",
    options.requiredWeeklyScheduleRange
      ? `Server-required Weekly Schedule inclusive date range (use these exact values together in one search_weekly_schedule step): ${JSON.stringify(options.requiredWeeklyScheduleRange)}.`
      : "",
    "Each step.arguments must be a serialized JSON object that includes every required parameter in that tool's schema. Use empty strings, null, false, or all only where the schema permits them.",
    "Interpret relative dates from the Australia/Melbourne business date below and emit explicit inclusive YYYY-MM-DD ranges whenever a tool has date fields.",
    "Treat Sales followed by a person's name, owner, uploader, creator, or Project Track context as a staff/field filter. Do not mistake it for product sales volume.",
    "Use search_product_activity only for a product, model, category or SKU sold/usage question, never for a Sales representative's Project Track activity.",
    "Set contact, location, assignee and notes flags true only when the user explicitly asks for that information.",
    options.knowledgeRequired
      ? "The request requires authorised knowledge evidence; include search_knowledge_base and no unrelated source."
      : "Do not add knowledge search unless the question asks for company policy, procedure, documentation, manuals or warranty information.",
    `Current Australia/Melbourne business date: ${options.businessDate}.`,
    options.section ? `Current ERP section: ${options.section.slice(0, 80)}.` : "",
    `Allowed read-only tool catalog: ${JSON.stringify(catalog)}`,
  ].filter(Boolean).join("\n");
}

function synthesisSystemPrompt(
  base: string,
  incompleteData: boolean,
  mixedEmptyEvidence: boolean,
  crossDomain: boolean,
  limitedDetails: boolean,
  lowerBoundCount: boolean,
) {
  return [
    base,
    "A server-validated query plan has already been executed. Organize the final answer from the attached tool-result messages; do not request or imply additional tool calls.",
    "Keep counts and field meanings exactly as returned. Never merge records from different sources unless the result explicitly provides a canonical aggregate.",
    incompleteData
      ? "At least one planned source was unavailable. Clearly label the answer as partial, identify the unavailable source by its tool label, and never describe the result as complete."
      : "All executed source statuses are included in the evidence. Do not invent records that are absent from it.",
    mixedEmptyEvidence
      ? "One or more planned sources returned a verified zero-match result while another source returned records. Report each zero as zero/no matches and still synthesize the non-empty evidence; this is not a whole-answer abstention."
      : "",
    crossDomain
      ? "For a cross-domain answer, create one clearly named section per requested business topic and put its canonical source label beside that section. Use these exact labels where applicable: Weekly Schedule, Inventory, Project Track, Project Management, Quotations, Site Visiting, Reimbursements, Reports, Knowledge Base, Announcements, Group Messages. If delivery/installation and Site Visiting both came from search_weekly_schedule, keep them as separate requested-topic sections and label both Source: Weekly Schedule."
      : "",
    limitedDetails
      ? "At least one result is truncated. Preserve its total count when totalAvailable is not false, state returned versus total, and never claim that the displayed rows are the complete detail list."
      : "",
    lowerBoundCount
      ? "At least one source exposes only a count lower bound. Describe that number as 'at least' and never as an exact total."
      : "",
  ].join("\n");
}

/**
 * Universal plan -> authorise -> execute -> verify -> synthesize path.
 * The planner never receives credentials and its output cannot bypass the
 * existing Tool Registry, permission checks or tool argument validators.
 */
export async function answerWithPlannedKimi(options: {
  provider: ERPProvider;
  auth: AgentAuthContext;
  message: string;
  history?: AgentHistoryMessage[];
  section?: string;
  conversationId?: string;
  apiKey: string;
  baseUrl: string;
  plannerModel: string;
  executorModel: string;
  attachmentDocuments?: readonly { documentId: string; name: string }[];
  imageParts?: readonly KimiImagePart[];
  enabledSkills?: ReadonlySet<BusinessSkillId>;
  memory?: AgentControlledMemory;
  trace?: AgentTrace;
  traceSkillTags?: readonly string[];
  requireVerifiedTool?: boolean;
  privacyMessage?: string;
  managedSkill?: {
    id: string;
    source: "built_in" | "custom";
    capabilityIds: readonly BusinessSkillId[];
  } | null;
}): Promise<AgentAnswer> {
  const {
    provider,
    auth,
    message,
    history = [],
    section,
    conversationId,
    apiKey,
    baseUrl,
    plannerModel,
    executorModel,
    trace,
  } = options;
  const attachmentDocuments = (options.attachmentDocuments || []).slice(0, 4);
  const imageParts = (options.imageParts || []).slice(0, 4);
  const enabledSkills = options.enabledSkills || resolveAgentSkillPolicy().enabled;
  const requireVerifiedTool = options.requireVerifiedTool === true;
  const privacyMessage = options.privacyMessage ?? message;
  const memory = options.memory || controlledMemoryFromConversation(message, history);
  const knowledgeRequired = attachmentDocuments.length > 0
    || shouldUseKnowledgeConversationIntent(
      message,
      history.slice(-2).map((item) => item.content),
      {
        hasImages: imageParts.length > 0,
        hasAttachedKnowledgeDocuments: attachmentDocuments.length > 0,
      },
    );
  const policyRequirements = deriveAgentQueryPolicyRequirements({
    latestMessage: message,
    knowledgeRequired,
    managedSkill: options.managedSkill,
  });
  const strictHistoricalWeeklyRange = /\b(?:last|previous)\s+week\b|(?:上|前)(?:周|星期)/iu.test(message);
  const knowledgeFocusedNames = [...new Set([
    "search_knowledge_base" as const,
    ...policyRequirements.requiredToolNames,
  ])];
  const selection = knowledgeRequired
    ? selectRegisteredAgentTools({
      enabledSkills,
      // Pure knowledge questions retain the smallest possible catalog. When
      // the current turn explicitly names an ERP domain, include only those
      // additionally required sources. A managed Skill may require a choice
      // within one or more toolsets, so its already capability-scoped catalog
      // remains available for the planner to make that bounded choice.
      ...(policyRequirements.requiredToolsets.length
        ? {}
        : { focusedNames: knowledgeFocusedNames }),
      permissions: auth.permissions,
    })
    : selectRegisteredAgentTools({
      enabledSkills,
      ...(imageParts.length ? { excludeNames: ["search_knowledge_base"] as const } : {}),
      permissions: auth.permissions,
    });
  const abstain = () => {
    trace?.markAbstained();
    return informationNotFound(message);
  };
  if (!selection.names.length
    || (knowledgeRequired && !selection.names.includes("search_knowledge_base"))
    || (requireVerifiedTool && selection.skills.length !== enabledSkills.size)
    || policyRequirements.requiredToolNames.some((name) => !selection.names.includes(name))
    || policyRequirements.requiredToolsets.some((toolset) => !selection.toolsets.includes(toolset))) {
    return abstain();
  }

  const requireToolEvidence = knowledgeRequired
    || requireVerifiedTool
    || !allowsDirectPlan(message, imageParts.length > 0);
  const plannerMessages: KimiMessage[] = [
    {
      role: "system",
      content: planningSystemPrompt({
        businessDate: melbourneToday(),
        section,
        toolDefinitions: selection.definitions,
        requireToolEvidence,
        knowledgeRequired,
        imageCount: imageParts.length,
        requiredToolNames: policyRequirements.requiredToolNames,
        requiredToolsets: policyRequirements.requiredToolsets,
        requiredPaymentProjectFilters: policyRequirements.argumentRequirements?.searchPaymentProjects,
        requiredWeeklyScheduleRange: policyRequirements.argumentRequirements?.searchWeeklySchedule,
      }),
    },
    ...history.slice(-8).map((item) => ({
      role: item.role,
      content: item.content.slice(0, 2_000),
    } as KimiMessage)),
    { role: "user", content: imageParts.length
      ? [...imageParts, { type: "text", text: message }]
      : message },
  ];
  const plannerMaximumSteps = Math.min(
    ABSOLUTE_AGENT_QUERY_PLAN_MAX_STEPS,
    Math.max(
      DEFAULT_AGENT_QUERY_PLAN_MAX_STEPS,
      policyRequirements.requiredToolNames.length + policyRequirements.requiredToolsets.length,
    ),
  );
  const responseFormat = buildAgentPlanResponseFormat([...selection.names], plannerMaximumSteps);
  const requestPlan = async (model: string): Promise<AgentQueryPlan> => {
    const startedAt = Date.now();
    try {
      const completion = await createCompletion({
        apiKey,
        baseUrl,
        model,
        messages: plannerMessages,
        tools: [],
        conversationId,
        reasoningEffort: "high",
        responseFormat,
        maxCompletionTokens: 4_000,
        timeoutMs: model === "kimi-k3" ? 55_000 : 35_000,
      });
      const parsedPlan = parseAgentQueryPlan(
        completion.message.content || "",
        selection.names,
        {
          maximumSteps: plannerMaximumSteps,
          allowDirect: !requireToolEvidence,
          validateArguments: (toolName, args) => validateRegisteredAgentToolArguments(toolName, args),
        },
      );
      if (!parsedPlan || (parsedPlan.kind !== "clarify"
        && !validateAgentQueryPlanCoverage(parsedPlan, policyRequirements).ok)) {
        throw new Error("The model returned an invalid query plan.");
      }
      const privacyClampedSteps = parsedPlan.steps.map((step) => {
        const argumentsJson = clampAgentToolArgumentsToPrivacyConsent(
          step.toolName,
          step.arguments,
          privacyMessage,
        );
        if (!argumentsJson) throw new Error("The model returned an invalid query plan.");
        const parsedArguments = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (!validateRegisteredAgentToolArguments(step.toolName, parsedArguments)) {
          throw new Error("The model returned an invalid query plan.");
        }
        return { ...step, arguments: argumentsJson };
      });
      const plan: AgentQueryPlan = { ...parsedPlan, steps: privacyClampedSteps };
      const finalCoverage = validateAgentQueryPlanCoverage(plan, policyRequirements);
      if (plan.kind !== "clarify" && !finalCoverage.ok) {
        throw new Error("The model returned an invalid query plan.");
      }
      trace?.recordModelRound({
        model,
        stage: "planner",
        status: "ok",
        durationMs: Date.now() - startedAt,
        toolCallCount: 0,
        plannedStepCount: plan.steps.length,
        planDimensions: agentQueryPlanDimensions(plan, policyRequirements),
        ...(completion.usage.inputTokens !== undefined ? { inputTokens: completion.usage.inputTokens } : {}),
        ...(completion.usage.outputTokens !== undefined ? { outputTokens: completion.usage.outputTokens } : {}),
      });
      return plan;
    } catch (error) {
      trace?.recordModelRound({
        model,
        stage: "planner",
        status: "error",
        durationMs: Date.now() - startedAt,
        toolCallCount: 0,
        plannedStepCount: 0,
      });
      throw error;
    }
  };
  const planWork = async () => {
    try {
      return await requestPlan(plannerModel);
    } catch (plannerError) {
      if (plannerModel === executorModel) throw plannerError;
      // A planner entitlement or transient failure must not take the whole
      // Agent offline. The same validated boundary is reused with K2.6.
      trace?.markOutcome("fallback");
      return requestPlan(executorModel);
    }
  };
  const plan = trace
    ? await trace.step("planner.query_plan", "model", planWork)
    : await planWork();
  trace?.selectWorkflow(plan.kind === "execute" ? "structured_query_plan" : `structured_query_plan_${plan.kind}`);

  const plannedRegistrations = plan.steps
    .map((step) => registeredAgentTool(step.toolName))
    .filter((registration): registration is NonNullable<typeof registration> => Boolean(registration));
  trace?.selectRoute({
    promptVersion: AGENT_PROMPT_VERSION,
    skills: [
      ...(options.traceSkillTags || []),
      ...new Set(plannedRegistrations.map((registration) => registration.skill)),
    ],
    toolsets: [...new Set(plannedRegistrations.map((registration) => registration.toolset))],
    memoryKeys: memory.keys,
  });

  if (plan.kind === "clarify") {
    trace?.markAbstained();
    return { mode: "kimi", answer: plan.clarification, suggestions: SUGGESTIONS };
  }

  const groundedCitationsByChunk = new Map<string, AgentCitation>();
  let knowledgeSearchAttempted = false;
  const outputs = plan.kind === "execute"
    ? await Promise.all(plan.steps.map(async (step) => {
      const toolStartedAt = Date.now();
      let content: string;
      try {
        content = await executeRegisteredAgentTool(
          provider,
          { name: step.toolName, arguments: step.arguments },
          auth,
          enabledSkills,
          {
            knowledgeDocumentIds: attachmentDocuments.map((item) => item.documentId),
            weeklyScheduleStrictDateRange: strictHistoricalWeeklyRange,
          },
        );
      } catch {
        // Keep independent sources independent: an unexpected failure becomes
        // bounded unavailable evidence rather than rejecting every parallel
        // result. No exception text or source payload enters diagnostics.
        content = JSON.stringify({
          error: {
            code: "data_unavailable",
            message: "This workspace data is temporarily unavailable.",
          },
        });
      }
      if (step.toolName === "search_knowledge_base") {
        knowledgeSearchAttempted = true;
        for (const citation of citationsFromKnowledgeToolOutput(content)) {
          if (citation.chunkId) groundedCitationsByChunk.set(citation.chunkId, citation);
        }
      }
      const verification = toolOutputVerification(content);
      const limitState = toolOutputLimitState(content);
      const registration = registeredAgentTool(step.toolName);
      trace?.recordTool({
        name: step.toolName,
        status: verification,
        durationMs: Date.now() - toolStartedAt,
      });
      return {
        call: {
          id: step.id,
          type: "function" as const,
          function: { name: step.toolName, arguments: step.arguments },
        },
        message: { role: "tool" as const, tool_call_id: step.id, content },
        verification,
        ...limitState,
        toolset: registration?.toolset,
      };
    }))
    : [];

  const unavailableOutputs = outputs.filter((output) => output.verification === "unavailable");
  const verifiedOutputs = outputs.filter((output) => output.verification === "verified");
  const availableOutputs = outputs.filter((output) => output.verification !== "unavailable");
  const observedToolsets = new Set(availableOutputs.flatMap((output) => output.toolset ? [output.toolset] : []));
  const requiredToolsets = requireVerifiedTool
    ? selection.toolsets
    : policyRequirements.requiredToolsets;
  if (plan.kind === "execute" && (
    outputs.length === 0
    || availableOutputs.length === 0
    || outputs.every((output) => output.verification === "empty")
    || (knowledgeRequired && (!knowledgeSearchAttempted || verifiedOutputs.length === 0))
    || (requireVerifiedTool && (
      unavailableOutputs.length > 0
      || verifiedOutputs.length === 0
      || [...requiredToolsets].some((toolset) => !observedToolsets.has(toolset))
    ))
  )) return abstain();

  const incompleteData = unavailableOutputs.length > 0;
  const mixedEmptyEvidence = outputs.some((output) => output.verification === "empty")
    && verifiedOutputs.length > 0;
  const crossDomain = new Set(outputs.flatMap((output) => output.toolset ? [output.toolset] : [])).size > 1;
  const limitedDetails = outputs.some((output) => output.truncated);
  const lowerBoundCount = outputs.some((output) => output.lowerBound);
  const baseSystem = buildAgentSystemPrompt({
    businessDate: melbourneToday(),
    section,
    knowledgeRequired,
    imageCount: imageParts.length,
    attachedKnowledgeDocumentCount: attachmentDocuments.length,
    enabledSkills,
    memory,
  });
  const synthesisMessages: KimiMessage[] = [
    { role: "system", content: synthesisSystemPrompt(
      baseSystem,
      incompleteData,
      mixedEmptyEvidence,
      crossDomain,
      limitedDetails,
      lowerBoundCount,
    ) },
    ...history.slice(-12).map((item) => ({
      role: item.role,
      content: item.content.slice(0, 2_000),
    } as KimiMessage)),
    { role: "user", content: imageParts.length
      ? [...imageParts, { type: "text", text: message }]
      : message },
    ...(outputs.length ? [{
      role: "assistant" as const,
      content: null,
      tool_calls: outputs.map((output) => output.call),
    } satisfies KimiAssistantMessage, ...outputs.map((output) => output.message)] : []),
  ];
  const synthesize = async () => {
    const startedAt = Date.now();
    try {
      const completion = await createCompletion({
        apiKey,
        baseUrl,
        model: executorModel,
        messages: synthesisMessages,
        tools: [],
        conversationId,
        thinking: "disabled",
        maxCompletionTokens: 1_200,
      });
      trace?.recordModelRound({
        model: executorModel,
        stage: "executor",
        status: "ok",
        durationMs: Date.now() - startedAt,
        toolCallCount: 0,
        ...(completion.usage.inputTokens !== undefined ? { inputTokens: completion.usage.inputTokens } : {}),
        ...(completion.usage.outputTokens !== undefined ? { outputTokens: completion.usage.outputTokens } : {}),
      });
      return completion.message;
    } catch (error) {
      trace?.recordModelRound({
        model: executorModel,
        stage: "executor",
        status: "error",
        durationMs: Date.now() - startedAt,
        toolCallCount: 0,
      });
      throw error;
    }
  };
  const assistant = trace
    ? await trace.step("executor.evidence_synthesis", "model", synthesize)
    : await synthesize();
  const answer = assistant.content?.trim();
  if (!answer) throw new Error("The model API did not return displayable text.");

  if (knowledgeRequired) {
    const selected = parseKnowledgeCitationSelection(answer);
    const citations = selected
      ? selected.chunkIds.map((chunkId) => groundedCitationsByChunk.get(chunkId))
      : [];
    if (!selected || citations.length === 0 || citations.some((citation) => !citation)) return abstain();
    return {
      mode: "kimi",
      answer: selected.answer,
      suggestions: SUGGESTIONS,
      citations: citations.filter((citation): citation is AgentCitation => Boolean(citation)),
      ...(incompleteData ? { incompleteData: true } : {}),
    };
  }
  return {
    mode: "kimi",
    answer,
    suggestions: SUGGESTIONS,
    ...(incompleteData ? { incompleteData: true } : {}),
  };
}
