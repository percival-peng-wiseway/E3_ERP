import type { ErpUser } from "@/lib/auth/types";

export const AGENT_CONVERSATION_QUESTION_LIMIT = 2_000;
export const AGENT_CONVERSATION_ANSWER_LIMIT = 8_000;
export const AGENT_CONVERSATION_RETENTION_DAYS = 30;

export type AgentConversationAuditText = {
  /** Deterministically redacted, length-limited display text. Never the raw input. */
  text: string;
  truncated: boolean;
  redactionCount: number;
};

/**
 * Narrow write contract for the user-visible exchange only. Deliberately has no
 * fields for hidden reasoning, tool arguments/results, attachments or headers.
 */
export type AgentConversationAuditInput = {
  actorUsername: string;
  actorRole: ErpUser["role"];
  /** Existing opaque conversation hash. Non-hash values are hashed again before storage. */
  conversationKey: string | null;
  traceId: string | null;
  question: string;
  visibleAnswer: string;
};

export type AgentConversationAuditRecord = {
  id: string;
  createdAt: string;
  actorUsername: string;
  actorRole: ErpUser["role"];
  conversationKey: string;
  traceId: string | null;
  question: AgentConversationAuditText;
  answer: AgentConversationAuditText;
};

export type AgentConversationAuditList = {
  conversations: AgentConversationAuditRecord[];
  storage: "memory" | "d1";
};

export type AgentConversationAuditListOptions = {
  limit?: number;
  actorUsername?: string;
  conversationKey?: string;
};
