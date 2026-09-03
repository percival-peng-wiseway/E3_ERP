import { erpCloudflareBindings, type ErpD1Database } from "@/lib/server/cloudflare-storage";
import type { AgentTraceContext, AgentTraceRecord } from "./trace-record";
import type { AgentTraceSnapshot } from "./trace";
import { sanitiseAgentTraceRecord } from "./trace-sanitizer";

const LOCAL_TRACE_LIMIT = 200;
const TRACE_RETENTION_DAYS = 30;
declare global {
  // Shared by the Agent write route and admin read route during local Next.js development.
  var __e3AgentTraceStore: AgentTraceRecord[] | undefined;
}

const localTraces = globalThis.__e3AgentTraceStore ||= [];

type TraceRow = {
  id: string;
  created_at: string;
  workflow: string | null;
  outcome: AgentTraceSnapshot["outcome"];
  duration_ms: number;
  prompt_version: string | null;
  skills_json: string;
  toolsets_json: string;
  memory_keys_json: string;
  steps_json: string;
  tools_json: string;
  model_rounds_json: string;
  abstained: number;
  actor_username: string;
  actor_role: AgentTraceRecord["actorRole"];
  conversation_key: string | null;
  message_length: number;
  history_message_count: number;
  attachment_count: number;
  request_language: AgentTraceRecord["requestLanguage"];
  data_source: string;
  model_status: AgentTraceRecord["modelStatus"];
  issue_codes_json: string;
};

export type AgentTraceList = {
  traces: AgentTraceRecord[];
  storage: "memory" | "d1";
};

function useLocalStore() {
  return process.env.NODE_ENV !== "production" && process.env.ERP_REMOTE_DATA_READ_ONLY !== "true";
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function fromRow(row: TraceRow): AgentTraceRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    workflow: row.workflow,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    promptVersion: row.prompt_version,
    skills: parseArray<AgentTraceSnapshot["skills"][number]>(row.skills_json),
    toolsets: parseArray<AgentTraceSnapshot["toolsets"][number]>(row.toolsets_json),
    memoryKeys: parseArray<AgentTraceSnapshot["memoryKeys"][number]>(row.memory_keys_json),
    steps: parseArray<AgentTraceSnapshot["steps"][number]>(row.steps_json),
    tools: parseArray<AgentTraceSnapshot["tools"][number]>(row.tools_json),
    modelRounds: parseArray<AgentTraceSnapshot["modelRounds"][number]>(row.model_rounds_json),
    abstained: row.abstained === 1,
    actorUsername: row.actor_username,
    actorRole: row.actor_role,
    conversationKey: row.conversation_key,
    messageLength: row.message_length,
    historyMessageCount: row.history_message_count,
    attachmentCount: row.attachment_count,
    requestLanguage: row.request_language,
    dataSource: row.data_source,
    modelStatus: row.model_status,
    issueCodes: parseArray<AgentTraceRecord["issueCodes"][number]>(row.issue_codes_json),
  };
}

async function requireTraceDatabase(): Promise<ErpD1Database> {
  const bindings = await erpCloudflareBindings();
  if (!bindings?.database) throw new Error("AgentTraceDatabaseUnavailable");
  return bindings.database;
}

/** Stores diagnostics only. Agent prompts, answers, tool inputs and tool outputs are never accepted here. */
export async function recordAgentTrace(trace: AgentTraceSnapshot, context: AgentTraceContext): Promise<void> {
  const safeTrace = sanitiseAgentTraceRecord(trace, context);
  if (useLocalStore()) {
    localTraces.unshift(safeTrace);
    if (localTraces.length > LOCAL_TRACE_LIMIT) localTraces.length = LOCAL_TRACE_LIMIT;
    return;
  }

  const database = await requireTraceDatabase();
  const result = await database.prepare(`
    INSERT INTO erp_agent_traces (
      id, created_at, workflow, outcome, duration_ms, prompt_version,
      skills_json, toolsets_json, memory_keys_json, steps_json, tools_json,
      model_rounds_json, abstained, actor_username, actor_role, conversation_key,
      message_length, history_message_count, attachment_count, request_language,
      data_source, model_status, issue_codes_json
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
      ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
    )
  `).bind(
    safeTrace.id,
    safeTrace.createdAt,
    safeTrace.workflow,
    safeTrace.outcome,
    safeTrace.durationMs,
    safeTrace.promptVersion,
    JSON.stringify(safeTrace.skills),
    JSON.stringify(safeTrace.toolsets),
    JSON.stringify(safeTrace.memoryKeys),
    JSON.stringify(safeTrace.steps),
    JSON.stringify(safeTrace.tools),
    JSON.stringify(safeTrace.modelRounds),
    safeTrace.abstained ? 1 : 0,
    safeTrace.actorUsername,
    safeTrace.actorRole,
    safeTrace.conversationKey,
    safeTrace.messageLength,
    safeTrace.historyMessageCount,
    safeTrace.attachmentCount,
    safeTrace.requestLanguage,
    safeTrace.dataSource,
    safeTrace.modelStatus,
    JSON.stringify(safeTrace.issueCodes),
  ).run();
  if (!result.success) throw new Error("AgentTraceWriteFailed");

  // Diagnostics have a short, fixed retention window and contain no request content.
  await database.prepare(`
    DELETE FROM erp_agent_traces
    WHERE datetime(created_at) < datetime('now', '-' || ?1 || ' days')
  `).bind(TRACE_RETENTION_DAYS).run();
}

export async function listAgentTraces(limit = 250): Promise<AgentTraceList> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 250;
  if (useLocalStore()) {
    return { traces: localTraces.slice(0, safeLimit).map((trace) => structuredClone(trace)), storage: "memory" };
  }

  const database = await requireTraceDatabase();
  const result = await database.prepare(`
    SELECT id, created_at, workflow, outcome, duration_ms, prompt_version,
      skills_json, toolsets_json, memory_keys_json, steps_json, tools_json,
      model_rounds_json, abstained, actor_username, actor_role, conversation_key,
      message_length, history_message_count, attachment_count, request_language,
      data_source, model_status, issue_codes_json
    FROM erp_agent_traces
    ORDER BY created_at DESC
    LIMIT ?1
  `).bind(safeLimit).all<TraceRow>();
  if (!result.success) throw new Error("AgentTraceReadFailed");
  return { traces: (result.results || []).map(fromRow), storage: "d1" };
}

export function resetLocalAgentTraceStoreForTest() {
  localTraces.length = 0;
}
