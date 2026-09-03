import { createHash, randomUUID } from "node:crypto";
import { erpCloudflareBindings, type ErpD1Database } from "@/lib/server/cloudflare-storage";
import {
  AGENT_CONVERSATION_ANSWER_LIMIT,
  AGENT_CONVERSATION_QUESTION_LIMIT,
  AGENT_CONVERSATION_RETENTION_DAYS,
  type AgentConversationAuditInput,
  type AgentConversationAuditList,
  type AgentConversationAuditListOptions,
  type AgentConversationAuditRecord,
} from "./conversation-record";
import {
  sanitiseConversationAuditAnswer,
  sanitiseConversationAuditQuestion,
  sanitiseConversationAuditText,
} from "./conversation-sanitizer";

const LOCAL_CONVERSATION_LIMIT = 500;
const HASHED_CONVERSATION_KEY = /^[a-f0-9]{24,64}$/i;
const SAFE_RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_TRACE_ID = /^[a-z0-9_-]{1,80}$/i;
const STRICT_ACTOR_USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

declare global {
  // Shared by the Agent write route and admin read route during local development.
  var __e3AgentConversationAuditStore: AgentConversationAuditRecord[] | undefined;
}

const localConversations = globalThis.__e3AgentConversationAuditStore ||= [];

type ConversationRow = {
  id: string;
  created_at: string;
  actor_username: string;
  actor_role: AgentConversationAuditRecord["actorRole"];
  conversation_key: string;
  trace_id: string | null;
  question_text: string;
  answer_text: string;
  question_truncated: number;
  answer_truncated: number;
  question_redaction_count: number;
  answer_redaction_count: number;
};

function safeErrorKind(value: unknown) {
  return value instanceof Error ? value.name : "UnknownError";
}

function safeActorUsername(value: string) {
  const safe = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  return safe || "unknown";
}

function opaqueConversationKey(input: AgentConversationAuditInput, id: string) {
  if (input.conversationKey && HASHED_CONVERSATION_KEY.test(input.conversationKey)) {
    return input.conversationKey.toLowerCase();
  }
  // A caller can never cause a raw conversation identifier to reach storage.
  const seed = input.conversationKey || input.traceId || id;
  return createHash("sha256")
    .update(`e3-agent-conversation:${safeActorUsername(input.actorUsername)}:${seed}`)
    .digest("hex")
    .slice(0, 24);
}

function safeTraceId(value: string | null) {
  return value && SAFE_TRACE_ID.test(value) ? value : null;
}

function sanitiseWrite(input: AgentConversationAuditInput): AgentConversationAuditRecord {
  const id = randomUUID();
  return {
    id,
    createdAt: new Date().toISOString(),
    actorUsername: safeActorUsername(input.actorUsername),
    actorRole: input.actorRole,
    conversationKey: opaqueConversationKey(input, id),
    traceId: safeTraceId(input.traceId),
    question: sanitiseConversationAuditQuestion(input.question),
    answer: sanitiseConversationAuditAnswer(input.visibleAnswer),
  };
}

function fromRow(row: ConversationRow): AgentConversationAuditRecord {
  // Apply the same allow-list on reads in case a database was populated by an
  // older application version or manually edited.
  const question = sanitiseConversationAuditText(row.question_text, AGENT_CONVERSATION_QUESTION_LIMIT);
  const answer = sanitiseConversationAuditText(row.answer_text, AGENT_CONVERSATION_ANSWER_LIMIT);
  return {
    id: SAFE_RECORD_ID.test(row.id) ? row.id : "invalid-record-id",
    createdAt: row.created_at.slice(0, 40),
    actorUsername: safeActorUsername(row.actor_username),
    actorRole: row.actor_role,
    conversationKey: HASHED_CONVERSATION_KEY.test(row.conversation_key)
      ? row.conversation_key.toLowerCase()
      : createHash("sha256").update(row.conversation_key).digest("hex").slice(0, 24),
    traceId: safeTraceId(row.trace_id),
    question: {
      ...question,
      truncated: row.question_truncated === 1 || question.truncated,
      redactionCount: Math.max(0, Math.trunc(row.question_redaction_count)) + question.redactionCount,
    },
    answer: {
      ...answer,
      truncated: row.answer_truncated === 1 || answer.truncated,
      redactionCount: Math.max(0, Math.trunc(row.answer_redaction_count)) + answer.redactionCount,
    },
  };
}

function pruneLocalConversations() {
  const cutoff = Date.now() - AGENT_CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  for (let index = localConversations.length - 1; index >= 0; index -= 1) {
    const createdAt = Date.parse(localConversations[index].createdAt);
    if (!Number.isFinite(createdAt) || createdAt < cutoff) localConversations.splice(index, 1);
  }
  if (localConversations.length > LOCAL_CONVERSATION_LIMIT) {
    localConversations.length = LOCAL_CONVERSATION_LIMIT;
  }
}

function writeLocal(record: AgentConversationAuditRecord) {
  localConversations.unshift(structuredClone(record));
  pruneLocalConversations();
}

function deleteLocal(id: string) {
  const index = localConversations.findIndex((record) => record.id === id);
  if (index < 0) return false;
  localConversations.splice(index, 1);
  return true;
}

function deleteLocalConversation(actorUsername: string, conversationKey: string) {
  let deletedCount = 0;
  for (let index = localConversations.length - 1; index >= 0; index -= 1) {
    const record = localConversations[index];
    if (record.actorUsername === actorUsername && record.conversationKey === conversationKey) {
      localConversations.splice(index, 1);
      deletedCount += 1;
    }
  }
  return deletedCount;
}

function useLocalStore() {
  return process.env.NODE_ENV !== "production" && process.env.ERP_REMOTE_DATA_READ_ONLY !== "true";
}

async function requireConversationDatabase(): Promise<ErpD1Database> {
  const database = (await erpCloudflareBindings())?.database;
  if (!database) throw new Error("ConversationAuditDatabaseUnavailable");
  return database;
}

async function cleanupExpiredConversations(database: ErpD1Database) {
  try {
    const result = await database.prepare(`
      DELETE FROM erp_agent_conversations
      WHERE datetime(created_at) < datetime('now', '-' || ?1 || ' days')
    `).bind(AGENT_CONVERSATION_RETENTION_DAYS).run();
    if (!result.success) throw new Error("ConversationAuditRetentionCleanupFailed");
  } catch (storageError) {
    // Reads still enforce the cutoff even when physical cleanup cannot run.
    console.error("Conversation Audit retention cleanup failed", safeErrorKind(storageError));
  }
}

/**
 * Persists only the sanitised user-visible exchange. Raw prompts/answers and
 * hidden model/tool/attachment data are never placed in D1 or local memory.
 */
export async function recordAgentConversationAudit(
  input: AgentConversationAuditInput,
): Promise<AgentConversationAuditRecord> {
  const record = sanitiseWrite(input);
  if (useLocalStore()) {
    writeLocal(record);
    return structuredClone(record);
  }

  const database = await requireConversationDatabase();
  const result = await database.prepare(`
    INSERT INTO erp_agent_conversations (
      id, created_at, actor_username, actor_role, conversation_key, trace_id,
      question_text, answer_text, question_truncated, answer_truncated,
      question_redaction_count, answer_redaction_count
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  `).bind(
    record.id,
    record.createdAt,
    record.actorUsername,
    record.actorRole,
    record.conversationKey,
    record.traceId,
    record.question.text,
    record.answer.text,
    record.question.truncated ? 1 : 0,
    record.answer.truncated ? 1 : 0,
    record.question.redactionCount,
    record.answer.redactionCount,
  ).run();
  if (!result.success) throw new Error("ConversationAuditWriteFailed");

  // Retention cleanup is best effort and must not turn a successful write into
  // a duplicate in the memory fallback.
  await cleanupExpiredConversations(database);
  return structuredClone(record);
}

export async function listAgentConversationAudits(
  options: AgentConversationAuditListOptions = {},
): Promise<AgentConversationAuditList> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(500, Math.trunc(options.limit || 100)))
    : 100;
  const actorUsername = options.actorUsername ? safeActorUsername(options.actorUsername) : null;
  const conversationKey = options.conversationKey && HASHED_CONVERSATION_KEY.test(options.conversationKey)
    ? options.conversationKey.toLowerCase()
    : null;
  if (useLocalStore()) {
    pruneLocalConversations();
    const conversations = localConversations
      .filter((record) => !actorUsername || record.actorUsername === actorUsername)
      .filter((record) => !conversationKey || record.conversationKey === conversationKey)
      .slice(0, limit)
      .map((record) => structuredClone(record));
    return { conversations, storage: "memory" };
  }

  const database = await requireConversationDatabase();
  await cleanupExpiredConversations(database);
  const result = await database.prepare(`
    SELECT id, created_at, actor_username, actor_role, conversation_key, trace_id,
      question_text, answer_text, question_truncated, answer_truncated,
      question_redaction_count, answer_redaction_count
    FROM erp_agent_conversations
    WHERE datetime(created_at) >= datetime('now', '-' || ?4 || ' days')
      AND (?2 IS NULL OR actor_username = ?2)
      AND (?3 IS NULL OR conversation_key = ?3)
    ORDER BY created_at DESC
    LIMIT ?1
  `).bind(limit, actorUsername, conversationKey, AGENT_CONVERSATION_RETENTION_DAYS).all<ConversationRow>();
  if (!result.success) throw new Error("ConversationAuditReadFailed");
  return { conversations: (result.results || []).map(fromRow), storage: "d1" };
}

export async function deleteAgentConversationAudit(id: string): Promise<boolean> {
  if (!SAFE_RECORD_ID.test(id)) return false;
  if (useLocalStore()) return deleteLocal(id);
  const database = await requireConversationDatabase();
  const result = await database.prepare("DELETE FROM erp_agent_conversations WHERE id = ?1")
    .bind(id)
    .run();
  if (!result.success) throw new Error("ConversationAuditDeleteFailed");
  return (result.meta?.changes || 0) > 0;
}

/** Deletes one user's complete hashed conversation in one D1 statement. */
export async function deleteAgentConversationAuditSession(
  actorUsername: string,
  conversationKey: string,
): Promise<number> {
  if (!STRICT_ACTOR_USERNAME.test(actorUsername)
    || !HASHED_CONVERSATION_KEY.test(conversationKey)) {
    throw new TypeError("ConversationAuditDeleteInvalidSelector");
  }
  const safeConversationKey = conversationKey.toLowerCase();
  if (useLocalStore()) return deleteLocalConversation(actorUsername, safeConversationKey);
  const database = await requireConversationDatabase();
  const result = await database.prepare(`
    DELETE FROM erp_agent_conversations
    WHERE actor_username = ?1 AND conversation_key = ?2
  `).bind(actorUsername, safeConversationKey).run();
  if (!result.success) throw new Error("ConversationAuditSessionDeleteFailed");
  return Math.max(0, Math.trunc(result.meta?.changes || 0));
}

export function resetLocalAgentConversationAuditStoreForTest() {
  localConversations.length = 0;
}
