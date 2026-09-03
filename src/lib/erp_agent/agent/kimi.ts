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
  selectRegisteredAgentTools,
  type AgentToolDefinition,
} from "./tool-registry";
import { resolveAgentSkillPolicy, type BusinessSkillId } from "./skills";
import { controlledMemoryFromConversation, type AgentControlledMemory } from "./memory";
import { AGENT_PROMPT_VERSION, buildAgentSystemPrompt } from "./prompt-builder";
import type { AgentTrace } from "./trace";

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

function toolOutputVerification(content: string): ToolVerification {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return "unavailable"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unavailable";
  const record = value as Record<string, unknown>;
  if (record.error || record.ok === false || record.incomplete_data === true || record.complete === false) {
    return "unavailable";
  }
  if (Array.isArray(record.sourceWarnings) && record.sourceWarnings.length > 0) return "unavailable";
  if (record.inventoryOrdersAvailable === false || record.projectTrackAvailable === false) return "unavailable";
  if (record.found === false) return "empty";
  if (typeof record.count === "number") return record.count > 0 ? "verified" : "empty";
  if (Array.isArray(record.data)) return record.data.length > 0 ? "verified" : "empty";
  if (typeof record.content === "string") return record.content.trim() ? "verified" : "empty";
  const usageArrays = ["deliveredOrders", "activeOrders", "cancelledOrders", "installedProjects", "projectCommitments"];
  if (usageArrays.some((key) => Array.isArray(record[key]))) {
    return usageArrays.some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0)
      ? "verified" : "empty";
  }
  return "verified";
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
  tools: readonly AgentToolDefinition[];
  forceToolName?: string;
  conversationId?: string;
}) {
  const body = JSON.stringify({
    model: options.model,
    messages: options.messages,
    tools: options.tools,
    tool_choice: options.forceToolName
      ? { type: "function", function: { name: options.forceToolName } }
      : "auto",
    stream: false,
    thinking: { type: "disabled" },
    max_completion_tokens: 800,
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
      signal: AbortSignal.timeout(35_000),
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
  if (calls.some((call) => !offeredToolNames.has(call.function.name as AgentToolDefinition["function"]["name"]))) {
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
}): Promise<AgentAnswer> {
  const { provider, auth, message, history = [], section, apiKey, baseUrl, model, trace } = options;
  const attachmentDocuments = (options.attachmentDocuments || []).slice(0, 4);
  const imageParts = (options.imageParts || []).slice(0, 4);
  const enabledSkills = options.enabledSkills || resolveAgentSkillPolicy().enabled;
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
  const focusedNames = knowledgeRequired
    ? ["search_knowledge_base"] as const
    : imageParts.length > 0
      ? null
      : focusedAgentToolNames(message);
  const selection = knowledgeRequired
    ? selectRegisteredAgentTools({ enabledSkills, focusedNames, permissions: auth.permissions })
    : imageParts.length > 0
      ? selectRegisteredAgentTools({ enabledSkills, excludeNames: ["search_knowledge_base"], permissions: auth.permissions })
      : selectRegisteredAgentTools({ enabledSkills, focusedNames: focusedAgentToolNames(message), permissions: auth.permissions });
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
  const groundedCitationsByChunk = new Map<string, AgentCitation>();
  let knowledgeSearchAttempted = false;
  let productActivityAttempted = false;
  let productActivityVerified = true;

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
      trace?.recordTool({
        name: call.function.name,
        status: verification,
        durationMs: Date.now() - toolStartedAt,
      });
      return {
        message: { role: "tool" as const, tool_call_id: call.id, content },
        verification,
      };
    }));
    messages.push(...outputs.map((output) => output.message));
    if (productActivityAttempted && !productActivityVerified) return abstain();
    if (outputs.some((output) => output.verification === "unavailable")
      || outputs.every((output) => output.verification === "empty")) {
      return abstain();
    }
  }
  throw new Error("The model API exceeded the safe tool-call limit.");
}
