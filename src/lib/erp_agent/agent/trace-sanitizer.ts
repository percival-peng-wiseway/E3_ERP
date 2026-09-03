import type { AgentTraceSnapshot } from "./trace";
import type { AgentTraceContext, AgentTraceIssueCode, AgentTraceRecord } from "./trace-record";

const ISSUE_CODE_SET = new Set<AgentTraceIssueCode>([
  "abstained",
  "agent_error",
  "knowledge_disabled",
  "model_error",
  "model_unavailable",
  "settings_unavailable",
  "tool_empty",
  "tool_error",
  "tool_unavailable",
  "unsupported_attachment",
  "attachment_processing",
  "attachment_failed",
]);

function safeText(value: string | null, maximum = 120) {
  return value === null ? null : value.slice(0, maximum);
}

export function sanitiseAgentTrace(trace: AgentTraceSnapshot): AgentTraceSnapshot {
  return {
    id: trace.id.slice(0, 80),
    createdAt: trace.createdAt.slice(0, 40),
    workflow: safeText(trace.workflow),
    outcome: trace.outcome,
    durationMs: Math.max(0, Math.trunc(trace.durationMs)),
    promptVersion: safeText(trace.promptVersion),
    skills: trace.skills.slice(0, 32).map((value) => value.slice(0, 80)),
    toolsets: trace.toolsets.slice(0, 32).map((value) => value.slice(0, 80)),
    memoryKeys: trace.memoryKeys.slice(0, 32).map((value) => value.slice(0, 80)),
    steps: trace.steps.slice(0, 64).map((step) => ({
      name: step.name.slice(0, 120),
      kind: step.kind,
      status: step.status,
      durationMs: Math.max(0, Math.trunc(step.durationMs)),
    })),
    tools: trace.tools.slice(0, 64).map((tool) => ({
      name: tool.name.slice(0, 120),
      status: tool.status,
      durationMs: Math.max(0, Math.trunc(tool.durationMs)),
    })),
    modelRounds: trace.modelRounds.slice(0, 32).map((round) => ({
      model: round.model.slice(0, 120),
      status: round.status,
      durationMs: Math.max(0, Math.trunc(round.durationMs)),
      toolCallCount: Math.max(0, Math.trunc(round.toolCallCount)),
      ...(round.inputTokens === undefined ? {} : { inputTokens: Math.max(0, Math.trunc(round.inputTokens)) }),
      ...(round.outputTokens === undefined ? {} : { outputTokens: Math.max(0, Math.trunc(round.outputTokens)) }),
    })),
    abstained: trace.abstained === true,
  };
}

export function sanitiseAgentTraceRecord(trace: AgentTraceSnapshot, context: AgentTraceContext): AgentTraceRecord {
  const safeTrace = sanitiseAgentTrace(trace);
  const issueCodes = new Set<AgentTraceIssueCode>(
    context.issueCodes.filter((code): code is AgentTraceIssueCode => ISSUE_CODE_SET.has(code)),
  );
  if (safeTrace.abstained) issueCodes.add("abstained");
  if (safeTrace.outcome === "error") issueCodes.add("agent_error");
  if (safeTrace.tools.some((tool) => tool.status === "error")) issueCodes.add("tool_error");
  if (safeTrace.tools.some((tool) => tool.status === "unavailable")) issueCodes.add("tool_unavailable");
  if (safeTrace.tools.some((tool) => tool.status === "empty")) issueCodes.add("tool_empty");
  if (safeTrace.modelRounds.some((round) => round.status === "error")) issueCodes.add("model_error");

  return {
    ...safeTrace,
    actorUsername: context.actorUsername.slice(0, 40),
    actorRole: context.actorRole,
    conversationKey: context.conversationKey?.slice(0, 64) || null,
    messageLength: Math.max(0, Math.min(2_000, Math.trunc(context.messageLength))),
    historyMessageCount: Math.max(0, Math.min(20, Math.trunc(context.historyMessageCount))),
    attachmentCount: Math.max(0, Math.min(10, Math.trunc(context.attachmentCount))),
    requestLanguage: context.requestLanguage,
    dataSource: context.dataSource.slice(0, 80),
    modelStatus: context.modelStatus,
    issueCodes: [...issueCodes],
  };
}
