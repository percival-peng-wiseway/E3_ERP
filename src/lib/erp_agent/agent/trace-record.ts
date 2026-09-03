import type { ErpUser } from "@/lib/auth/types";
import type { AgentTraceSnapshot } from "./trace";

export const AGENT_TRACE_ISSUE_CODES = [
  "abstained",
  "agent_error",
  "knowledge_disabled",
  "model_error",
  "model_unavailable",
  "skill_unavailable",
  "settings_unavailable",
  "tool_empty",
  "tool_error",
  "tool_unavailable",
  "unsupported_attachment",
  "attachment_processing",
  "attachment_failed",
] as const;

export type AgentTraceIssueCode = typeof AGENT_TRACE_ISSUE_CODES[number];
export type AgentTraceRequestLanguage = "chinese" | "english" | "mixed" | "other";
export type AgentTraceModelStatus = "available" | "unavailable" | "not_checked";

export type AgentTraceContext = {
  actorUsername: string;
  actorRole: ErpUser["role"];
  conversationKey: string | null;
  messageLength: number;
  historyMessageCount: number;
  attachmentCount: number;
  requestLanguage: AgentTraceRequestLanguage;
  dataSource: string;
  modelStatus: AgentTraceModelStatus;
  issueCodes: readonly AgentTraceIssueCode[];
};

export type AgentTraceRecord = AgentTraceSnapshot & AgentTraceContext;
