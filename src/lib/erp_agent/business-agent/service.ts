import { randomUUID } from "node:crypto";
import type { AgentAuthContext, AgentChatResponse, ToolEnvelope } from "./contracts";
import type { BusinessDataProvider } from "./data-provider";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { observe } from "../langfuse/tracing.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { summarizeText } from "../langfuse/privacy.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { resolveKimiConfig, runKimiAgent, type KimiConfig } from "./kimi-provider.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { requiredIdentifierClarification, routeMessage } from "./router.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { BusinessToolExecutor } from "./tools.ts";

export type AgentChatInput = { message: string; conversation_id?: string };

function clarification(requestId: string, answer: string): AgentChatResponse {
  return {
    answer, citations: [], model_used: "none", route: "clarification", tool_calls_summary: [],
    request_id: requestId, data_updated_at: null, limitations: [],
  };
}

function isChinese(message: string) {
  return /[\u3400-\u9fff]/u.test(message);
}

function reliableEvidenceAbstention(message: string) {
  return isChinese(message)
    ? "当前知识库没有返回足够可靠且你有权访问的资料，因此我无法确认答案。"
    : "The knowledge base did not return enough reliable, authorised evidence, so I cannot confirm an answer.";
}

function emitSafeTrace(value: Record<string, unknown>) {
  // Values are deliberately limited to request metadata, opaque principal hash,
  // tool names/status and timings. User text and tool/model payloads are excluded.
  console.info(JSON.stringify({ event: "business_agent_request", ...value }));
}

export async function chatWithBusinessAgent(options: {
  input: AgentChatInput;
  auth: AgentAuthContext;
  dataProvider: BusinessDataProvider;
  kimiConfig?: KimiConfig | null;
  now?: () => number;
}): Promise<AgentChatResponse> {
  const now = options.now || Date.now;
  const started = now();
  const requestId = randomUUID();
  const decision = await observe({
    name: "route-business-query",
    asType: "chain",
    input: summarizeText(options.input.message),
    metadata: {
      messageCharacterCount: options.input.message.length,
      messageLanguage: isChinese(options.input.message) ? "zh" : "other",
    },
  }, async (observation) => {
    const routed = routeMessage(options.input.message);
    observation.update({
      output: {
        modelClass: routed.modelClass,
        requiredDomains: routed.requiredDomains,
        reason: routed.reason,
      },
      metadata: {
        modelClass: routed.modelClass,
        requiredDomains: routed.requiredDomains,
        reason: routed.reason,
      },
      statusMessage: routed.reason,
    });
    return routed;
  });
  const missing = requiredIdentifierClarification(options.input.message, decision.requiredDomains);
  if (missing) {
    emitSafeTrace({ request_id: requestId, principal_hash: options.auth.principalHash, tenant: options.auth.tenantId, route: "clarification", total_latency_ms: now() - started, final_status: "clarification" });
    return clarification(requestId, missing);
  }

  const config = options.kimiConfig === undefined ? resolveKimiConfig() : options.kimiConfig;
  if (!config) {
    return {
      answer: isChinese(options.input.message)
        ? "Agent 模型服务尚未配置，暂时无法安全处理此请求。"
        : "The Agent model is not configured, so this request cannot be handled safely yet.",
      citations: [], model_used: "none", route: "unavailable",
      tool_calls_summary: [], request_id: requestId, data_updated_at: null,
      limitations: ["服务器缺少 MOONSHOT_API_KEY。"],
    };
  }

  const executor = new BusinessToolExecutor(options.dataProvider, options.auth);
  const cache = new Map<string, ToolEnvelope<unknown>>();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("total_timeout")), 55_000);
  let result: Awaited<ReturnType<typeof runKimiAgent>>;
  let model = decision.modelClass === "pro" ? config.complexModel : config.flashModel;
  let route: "flash" | "pro" = decision.modelClass;
  let escalated = false;
  let escalationReason: string | null = null;
  const allToolCalls: AgentChatResponse["tool_calls_summary"] = [];
  let modelLatencyMs = 0;
  let toolLatencyMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const accumulate = (attempt: Awaited<ReturnType<typeof runKimiAgent>>) => {
    allToolCalls.push(...attempt.toolCalls);
    modelLatencyMs += attempt.modelLatencyMs;
    toolLatencyMs += attempt.toolLatencyMs;
    promptTokens += attempt.usage?.prompt_tokens || 0;
    completionTokens += attempt.usage?.completion_tokens || 0;
  };
  const runAttempt = (attemptModel: string, attemptRoute: "flash" | "pro", attemptNumber: number) => observe({
    name: "run-business-agent-attempt",
    asType: "chain",
    input: summarizeText(options.input.message),
    metadata: {
      attempt: attemptNumber,
      modelClass: attemptRoute,
      model: attemptModel,
      knowledgeRequired: decision.requiredDomains.includes("knowledge"),
      messageCharacterCount: options.input.message.length,
      messageLanguage: isChinese(options.input.message) ? "zh" : "other",
      hasConversationId: Boolean(options.input.conversation_id),
    },
  }, async (observation) => {
    const attempt = await runKimiAgent({
      config, model: attemptModel, message: options.input.message, conversationId: options.input.conversation_id,
      executor, cache, signal: controller.signal, knowledgeRequired: decision.requiredDomains.includes("knowledge"),
    });
    const attemptAccepted = attempt.valid && !attempt.exhausted && !attempt.incompleteData && !attempt.policyConflict;
    const attemptStatus = attempt.policyConflict ? "policy_conflict"
      : attempt.incompleteData ? "incomplete_data"
        : attempt.exhausted ? "tool_round_limit"
          : attempt.valid ? "completed" : "validation_failed";
    observation.update({
      output: {
        valid: attempt.valid,
        exhausted: attempt.exhausted,
        incompleteData: attempt.incompleteData,
        policyConflict: attempt.policyConflict,
        citationCount: attempt.citations.length,
        toolCallCount: attempt.toolCalls.length,
        answerCharacterCount: attempt.answer.length,
      },
      metadata: {
        attempt: attemptNumber,
        status: attemptStatus,
        modelClass: attemptRoute,
        model: attemptModel,
        valid: attempt.valid,
        exhausted: attempt.exhausted,
        incompleteData: attempt.incompleteData,
        policyConflict: attempt.policyConflict,
        citationCount: attempt.citations.length,
        toolCallCount: attempt.toolCalls.length,
        answerCharacterCount: attempt.answer.length,
      },
      level: attemptAccepted ? "DEFAULT" : "WARNING",
      statusMessage: attemptStatus,
    });
    return attempt;
  });
  try {
    result = await runAttempt(model, route, 1);
    accumulate(result);
    escalationReason = await observe({
      name: "decide-model-escalation",
      asType: "guardrail",
      input: {
        initialModelClass: decision.modelClass,
        valid: result.valid,
        exhausted: result.exhausted,
        incompleteData: result.incompleteData,
        policyConflict: result.policyConflict,
      },
      metadata: { attempt: 1, initialModelClass: decision.modelClass },
    }, async (observation) => {
      const reason = decision.modelClass === "flash" ? (
        result.policyConflict ? "policy_conflict"
          : result.incompleteData ? "incomplete_data"
            : !result.valid ? "invalid_schema"
              : result.exhausted ? "tool_round_limit" : null
      ) : null;
      observation.update({
        output: { escalate: Boolean(reason), reason: reason || "not_required" },
        metadata: { attempt: 1, escalate: Boolean(reason), reason: reason || "not_required" },
        level: reason ? "WARNING" : "DEFAULT",
        statusMessage: reason || "not_required",
      });
      return reason;
    });
    if (escalationReason) {
      escalated = true;
      model = config.complexModel;
      route = "pro";
      result = await runAttempt(model, route, 2);
      accumulate(result);
    }
  } finally {
    clearTimeout(timeout);
  }

  const response: AgentChatResponse = {
    answer: result.valid ? result.answer : reliableEvidenceAbstention(options.input.message),
    citations: result.citations,
    model_used: model,
    route,
    tool_calls_summary: allToolCalls,
    request_id: requestId,
    data_updated_at: result.updatedAt,
    limitations: result.valid ? result.limitations : [...result.limitations, "未生成未经验证的替代答案。"],
  };
  emitSafeTrace({
    request_id: requestId, principal_hash: options.auth.principalHash, tenant: options.auth.tenantId,
    route, model_used: model, routing_reason: escalationReason || decision.reason, tool_names: allToolCalls.map((item) => item.name),
    tool_latency_ms: toolLatencyMs, model_latency_ms: modelLatencyMs, total_latency_ms: now() - started,
    retry_count: 0, escalated_to_pro: escalated,
    input_tokens: promptTokens || undefined, output_tokens: completionTokens || undefined,
    final_status: result.valid ? "ok" : "abstained",
  });
  return response;
}
