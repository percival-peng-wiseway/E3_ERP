"use client";

import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Filter,
  MessageSquare,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentConversationAuditRecord } from "@/lib/erp_agent/agent/conversation-record";
import type { AgentTraceRecord } from "@/lib/erp_agent/agent/trace-record";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./agent-trace-workspace.module.css";

type TraceResponse = {
  data?: { traces: AgentTraceRecord[]; storage: "memory" | "d1"; generatedAt: string };
  error?: { message?: string };
};

type ConversationRecord = AgentConversationAuditRecord;

type ConversationResponse = {
  data?: {
    conversations: ConversationRecord[];
    storage: "memory" | "d1";
    generatedAt: string;
  };
  error?: { message?: string };
};

type WorkspaceView = "traces" | "conversations";

type ConversationThread = {
  key: string;
  conversationKey: string;
  actorUsername: string;
  actorRole: string;
  createdAt: string;
  records: ConversationRecord[];
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function label(value: string | null) {
  if (!value) return "Model route";
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function totalTokens(trace: AgentTraceRecord) {
  return trace.modelRounds.reduce((sum, round) => sum + (round.inputTokens || 0) + (round.outputTokens || 0), 0);
}

export function AgentTraceWorkspace({ compact = false }: { compact?: boolean }) {
  const [activeView, setActiveView] = useState<WorkspaceView>("traces");
  const [traces, setTraces] = useState<AgentTraceRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traceStorage, setTraceStorage] = useState<"memory" | "d1">("memory");
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [selectedConversationKey, setSelectedConversationKey] = useState<string | null>(null);
  const [conversationStorage, setConversationStorage] = useState<"memory" | "d1">("memory");
  const [loading, setLoading] = useState(true);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [userFilter, setUserFilter] = useState("all");
  const [conversationUserFilter, setConversationUserFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [traceError, setTraceError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [deletingConversationIds, setDeletingConversationIds] = useState<string[]>([]);
  const traceRequestRunning = useRef(false);
  const conversationRequestRunning = useRef(false);
  const conversationsLoadedRef = useRef(false);

  const loadTraces = useCallback(async (foreground = false) => {
    if (traceRequestRunning.current) return;
    traceRequestRunning.current = true;
    if (foreground) setRefreshing(true);
    try {
      const response = await fetch("/api/agent/traces?limit=500", { cache: "no-store" });
      const body = await readJsonResponse<TraceResponse>(response);
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message || "Unable to load Agent traces.");
      }
      setTraces(body.data.traces);
      setTraceStorage(body.data.storage);
      setSelectedId((current) => current && body.data?.traces.some((trace) => trace.id === current)
        ? current
        : body.data?.traces[0]?.id || null);
      setTraceError("");
    } catch (loadError) {
      setTraceError(loadError instanceof Error ? loadError.message : "Unable to load Agent traces.");
    } finally {
      traceRequestRunning.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadConversations = useCallback(async (foreground = false) => {
    if (conversationRequestRunning.current) return;
    conversationRequestRunning.current = true;
    if (foreground) setRefreshing(true);
    if (!conversationsLoadedRef.current) setConversationsLoading(true);
    try {
      const response = await fetch("/api/agent/conversations?limit=500", { cache: "no-store" });
      const body = await readJsonResponse<ConversationResponse>(response);
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message || "Unable to load Agent conversations.");
      }
      setConversations(body.data.conversations);
      setConversationStorage(body.data.storage);
      setConversationError("");
      setConversationsLoaded(true);
      conversationsLoadedRef.current = true;
    } catch (loadError) {
      setConversationError(loadError instanceof Error ? loadError.message : "Unable to load Agent conversations.");
    } finally {
      conversationRequestRunning.current = false;
      setConversationsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    if (activeView === "conversations") void loadConversations();
  }, [activeView, loadConversations]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (activeView === "traces") void loadTraces();
      else void loadConversations();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeView, autoRefresh, loadConversations, loadTraces]);

  const selected = traces.find((trace) => trace.id === selectedId) || null;
  const users = useMemo(() => [...new Set(traces.map((trace) => trace.actorUsername))].sort(), [traces]);
  const visibleTraces = useMemo(() => traces.filter((trace) => (
    (userFilter === "all" || trace.actorUsername === userFilter)
    && (outcomeFilter === "all" || trace.outcome === outcomeFilter)
    && (!issuesOnly || trace.issueCodes.length > 0)
  )), [issuesOnly, outcomeFilter, traces, userFilter]);
  const conversationUsers = useMemo(() => [...new Set(conversations.map((conversation) => conversation.actorUsername))].sort(), [conversations]);
  const conversationThreads = useMemo(() => {
    const grouped = new Map<string, ConversationRecord[]>();
    conversations.forEach((conversation) => {
      const key = `${conversation.actorUsername}::${conversation.conversationKey || conversation.id}`;
      const existing = grouped.get(key) || [];
      existing.push(conversation);
      grouped.set(key, existing);
    });
    return [...grouped.entries()].map(([key, records]): ConversationThread => {
      const ordered = [...records].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      const latest = ordered[ordered.length - 1];
      return {
        key,
        conversationKey: latest.conversationKey,
        actorUsername: latest.actorUsername,
        actorRole: latest.actorRole,
        createdAt: latest.createdAt,
        records: ordered,
      };
    }).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }, [conversations]);
  const visibleConversationThreads = useMemo(() => conversationThreads.filter((thread) => (
    conversationUserFilter === "all" || thread.actorUsername === conversationUserFilter
  )), [conversationThreads, conversationUserFilter]);
  const selectedConversationThread = conversationThreads.find((thread) => thread.key === selectedConversationKey) || null;

  useEffect(() => {
    if (selectedId && visibleTraces.some((trace) => trace.id === selectedId)) return;
    setSelectedId(visibleTraces[0]?.id || null);
  }, [selectedId, visibleTraces]);

  useEffect(() => {
    if (selectedConversationKey && visibleConversationThreads.some((thread) => thread.key === selectedConversationKey)) return;
    setSelectedConversationKey(visibleConversationThreads[0]?.key || null);
  }, [selectedConversationKey, visibleConversationThreads]);

  const deleteConversationRecords = useCallback(async (records: ConversationRecord[], scope: "exchange" | "conversation") => {
    if (records.length === 0) return;
    const confirmation = scope === "conversation"
      ? "Delete this entire stored conversation? This cannot be undone."
      : "Delete this stored exchange? This cannot be undone.";
    if (!window.confirm(confirmation)) return;

    const ids = records.map((record) => record.id);
    setDeletingConversationIds((current) => [...new Set([...current, ...ids])]);
    try {
      const response = await fetch("/api/agent/conversations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope === "conversation"
          ? { actorUsername: records[0].actorUsername, conversationKey: records[0].conversationKey }
          : { id: records[0].id }),
      });
      if (!response.ok) {
        const body = await readJsonResponse<ConversationResponse>(response);
        throw new Error(body.error?.message || "Unable to delete the stored conversation.");
      }
      setConversations((current) => current.filter((record) => !ids.includes(record.id)));
      setConversationError("");
    } catch (deleteError) {
      setConversationError(deleteError instanceof Error ? deleteError.message : "Unable to delete the stored conversation.");
      void loadConversations();
    } finally {
      setDeletingConversationIds((current) => current.filter((id) => !ids.includes(id)));
    }
  }, [loadConversations]);

  const stats = useMemo(() => {
    const successful = traces.filter((trace) => trace.outcome === "ok").length;
    const averageDuration = traces.length
      ? Math.round(traces.reduce((sum, trace) => sum + trace.durationMs, 0) / traces.length)
      : 0;
    return {
      successRate: traces.length ? Math.round((successful / traces.length) * 100) : 0,
      averageDuration,
      userCount: new Set(traces.map((trace) => trace.actorUsername)).size,
      issueCount: traces.filter((trace) => trace.issueCodes.length > 0).length,
    };
  }, [traces]);

  const selectedConversationLatest = selectedConversationThread?.records[selectedConversationThread.records.length - 1] || null;
  const selectedConversationTraceIds = selectedConversationThread
    ? [...new Set(selectedConversationThread.records.map((record) => record.traceId).filter((traceId): traceId is string => Boolean(traceId)))]
    : [];

  return (
    <section className={`${styles.workspace} ${compact ? styles.compact : ""}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>E3 AGENT · OBSERVABILITY</span>
          <h1>{activeView === "traces" ? "Agent execution traces" : "Agent conversations"}</h1>
          <p>{activeView === "traces"
            ? "Inspect every user's Agent sessions, routing, tools, model rounds and operational issues."
            : "Review the redacted questions and answers stored for each user's Agent conversations."}</p>
        </div>
        <div className={styles.controls}>
          <label className={styles.liveToggle}>
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span className={autoRefresh ? styles.liveDot : ""} />
            Live
          </label>
          <button
            type="button"
            onClick={() => void (activeView === "traces" ? loadTraces(true) : loadConversations(true))}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? styles.spinning : ""} size={15} /> Refresh
          </button>
        </div>
      </header>

      <div className={styles.viewTabs} role="tablist" aria-label="Agent observability views">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "traces"}
          className={activeView === "traces" ? styles.activeTab : ""}
          onClick={() => setActiveView("traces")}
        >
          <Activity size={15} /> Traces <span>{traces.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "conversations"}
          className={activeView === "conversations" ? styles.activeTab : ""}
          onClick={() => setActiveView("conversations")}
        >
          <MessageSquare size={15} /> Conversations <span>{conversations.length}</span>
        </button>
      </div>

      <div className={styles.privacyNote}>
        <ShieldCheck size={18} />
        {activeView === "traces" ? (
          <>
            <span><strong>Privacy-safe execution diagnostics.</strong> Trace metadata excludes message content, original attachment content and hidden reasoning. The separate conversation audit may retain redacted visible answers containing derived business information.</span>
            <small><Database size={13} /> {traceStorage === "d1" ? "Cloudflare D1 · all users · 30 days" : "Local memory · this server session"}</small>
          </>
        ) : (
          <>
            <span><strong>Redacted conversation audit.</strong> Visible questions and answers are sanitised before storage. Original attachment content and hidden reasoning are not stored; visible answers may contain derived business information.</span>
            <small><Database size={13} /> {conversationStorage === "d1" ? "Cloudflare D1 · all users · 30 days" : "Local memory · this server session"}</small>
          </>
        )}
      </div>

      {(activeView === "traces" ? traceError : conversationError) ? (
        <div className={styles.errorBanner}>
          <AlertTriangle size={17} />{activeView === "traces" ? traceError : conversationError}
        </div>
      ) : null}

      {activeView === "traces" ? <><div className={styles.stats}>
        <article><Activity size={18} /><div><strong>{traces.length}</strong><span>Recent traces</span></div></article>
        <article><CheckCircle2 size={18} /><div><strong>{stats.successRate}%</strong><span>Successful</span></div></article>
        <article><Clock3 size={18} /><div><strong>{stats.averageDuration} ms</strong><span>Average latency</span></div></article>
        <article><Bot size={18} /><div><strong>{stats.userCount}</strong><span>Users observed</span></div></article>
        <article><AlertTriangle size={18} /><div><strong>{stats.issueCount}</strong><span>Traces with issues</span></div></article>
      </div>

      <div className={styles.filterBar}>
        <span><Filter size={14} />Filters</span>
        <label>User<select value={userFilter} onChange={(event) => setUserFilter(event.target.value)}><option value="all">All users</option>{users.map((username) => <option key={username} value={username}>{username}</option>)}</select></label>
        <label>Outcome<select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)}><option value="all">All outcomes</option><option value="ok">OK</option><option value="fallback">Fallback</option><option value="error">Error</option></select></label>
        <label className={styles.issuesToggle}><input type="checkbox" checked={issuesOnly} onChange={(event) => setIssuesOnly(event.target.checked)} />Issues only</label>
        <small>{visibleTraces.length} of {traces.length} traces</small>
      </div>

      <div className={styles.traceGrid}>
        <aside className={styles.traceList} aria-label="Agent trace list">
          <div className={styles.panelTitle}><span>Live stream</span><small>Newest first</small></div>
          {loading ? <div className={styles.empty}>Loading traces…</div> : null}
          {!loading && traces.length === 0 ? (
            <div className={styles.empty}>No traces yet. Ask E3 Agent a question, then return here.</div>
          ) : null}
          {!loading && traces.length > 0 && visibleTraces.length === 0 ? <div className={styles.empty}>No traces match these filters.</div> : null}
          {visibleTraces.map((trace) => (
            <button
              className={`${styles.traceItem} ${selectedId === trace.id ? styles.selected : ""}`}
              key={trace.id}
              onClick={() => setSelectedId(trace.id)}
              type="button"
            >
              <span className={`${styles.statusDot} ${styles[trace.outcome]}`} />
              <span className={styles.traceItemBody}>
                <strong>{label(trace.workflow)}</strong>
                <small>@{trace.actorUsername} · {formatTime(trace.createdAt)}</small>
              </span>
              <span className={styles.traceTail}>{trace.issueCodes.length ? <b>{trace.issueCodes.length}</b> : null}<em>{trace.durationMs} ms</em></span>
            </button>
          ))}
        </aside>

        <article className={styles.detailPanel}>
          {!selected ? <div className={styles.empty}>Select a trace to inspect its execution path.</div> : (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <span className={`${styles.outcomeBadge} ${styles[selected.outcome]}`}>{selected.outcome}</span>
                  <h2>{label(selected.workflow)}</h2>
                  <code>@{selected.actorUsername} · {selected.actorRole} · {selected.id}</code>
                </div>
                <div className={styles.detailTiming}><Clock3 size={16} /><strong>{selected.durationMs} ms</strong><small>{formatTime(selected.createdAt)}</small></div>
              </div>

              <div className={styles.routeMeta}>
                <div><span>Conversation</span><strong>{selected.conversationKey || "Single turn"}</strong></div>
                <div><span>Request</span><strong>{selected.messageLength} chars · {selected.historyMessageCount} history · {selected.attachmentCount} files</strong></div>
                <div><span>Language</span><strong>{selected.requestLanguage}</strong></div>
                <div><span>Data source</span><strong>{selected.dataSource || "Unresolved"}</strong></div>
                <div><span>Model status</span><strong>{selected.modelStatus}</strong></div>
                <div><span>Prompt version</span><strong>{selected.promptVersion || "Deterministic"}</strong></div>
                <div><span>Skills</span><strong>{selected.skills.join(", ") || "None"}</strong></div>
                <div><span>Toolsets</span><strong>{selected.toolsets.join(", ") || "None"}</strong></div>
              </div>

              <section className={styles.detailSection}>
                <h3><AlertTriangle size={16} />Detected issues</h3>
                {selected.issueCodes.length === 0 ? <p className={styles.noIssues}><CheckCircle2 size={14} />No operational issues detected.</p> : (
                  <div className={styles.issueList}>{selected.issueCodes.map((issue) => <span key={issue}>{label(issue)}</span>)}</div>
                )}
              </section>

              <section className={styles.detailSection}>
                <h3><Route size={16} />Execution timeline</h3>
                {selected.steps.length === 0 ? <p className={styles.muted}>No timed workflow steps were recorded.</p> : (
                  <ol className={styles.timeline}>
                    {selected.steps.map((step, index) => (
                      <li key={`${step.name}-${index}`}>
                        <span className={`${styles.timelineDot} ${styles[step.status]}`} />
                        <div><strong>{label(step.name)}</strong><small>{step.kind} · {step.status}</small></div>
                        <time>{step.durationMs} ms</time>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <div className={styles.detailColumns}>
                <section className={styles.detailSection}>
                  <h3><Wrench size={16} />Tool calls</h3>
                  {selected.tools.length === 0 ? <p className={styles.muted}>No tools called.</p> : selected.tools.map((tool, index) => (
                    <div className={styles.compactRow} key={`${tool.name}-${index}`}>
                      <div><strong>{label(tool.name)}</strong><small>{tool.status}</small></div><span>{tool.durationMs} ms</span>
                    </div>
                  ))}
                </section>
                <section className={styles.detailSection}>
                  <h3><Bot size={16} />Model rounds</h3>
                  {selected.modelRounds.length === 0 ? <p className={styles.muted}>No model round used.</p> : selected.modelRounds.map((round, index) => (
                    <div className={styles.compactRow} key={`${round.model}-${index}`}>
                      <div><strong>{round.model}</strong><small>{round.stage ? `${label(round.stage)} · ` : ""}{round.status} · {round.stage === "planner" ? `${round.plannedStepCount || 0} planned steps` : `${round.toolCallCount} tool calls`} · {((round.inputTokens || 0) + (round.outputTokens || 0)).toLocaleString()} tokens</small></div>
                      <span>{round.durationMs} ms</span>
                    </div>
                  ))}
                </section>
              </div>
            </>
          )}
        </article>
      </div></> : <>
        <div className={styles.filterBar}>
          <span><Filter size={14} />Filters</span>
          <label>
            User
            <select value={conversationUserFilter} onChange={(event) => setConversationUserFilter(event.target.value)}>
              <option value="all">All users</option>
              {conversationUsers.map((username) => <option key={username} value={username}>{username}</option>)}
            </select>
          </label>
          <small>{visibleConversationThreads.length} of {conversationThreads.length} conversations · {conversations.length} exchanges</small>
        </div>

        <div className={`${styles.traceGrid} ${styles.conversationGrid}`}>
          <aside className={styles.traceList} aria-label="Agent conversation list">
            <div className={styles.panelTitle}><span>Conversation stream</span><small>Newest first</small></div>
            {conversationsLoading && !conversationsLoaded ? <div className={styles.empty}>Loading conversations…</div> : null}
            {!conversationsLoading && conversationsLoaded && conversations.length === 0 ? (
              <div className={styles.empty}>No stored conversations yet. New Agent questions will appear here.</div>
            ) : null}
            {!conversationsLoading && conversations.length > 0 && visibleConversationThreads.length === 0 ? (
              <div className={styles.empty}>No conversations match this user.</div>
            ) : null}
            {visibleConversationThreads.map((thread) => {
              const latest = thread.records[thread.records.length - 1];
              const redactionCount = thread.records.reduce((sum, record) => sum + record.question.redactionCount + record.answer.redactionCount, 0);
              return (
                <button
                  className={`${styles.traceItem} ${selectedConversationKey === thread.key ? styles.selected : ""}`}
                  key={thread.key}
                  onClick={() => setSelectedConversationKey(thread.key)}
                  type="button"
                >
                  <span className={`${styles.statusDot} ${styles.ok}`} />
                  <span className={styles.traceItemBody}>
                    <strong>{latest.question.text || "Redacted question"}</strong>
                    <small>@{thread.actorUsername} · {thread.records.length} exchange{thread.records.length === 1 ? "" : "s"} · {formatTime(thread.createdAt)}</small>
                  </span>
                  <span className={styles.traceTail}>
                    {redactionCount ? <b>{redactionCount}</b> : null}
                    <em>{thread.records.length} turns</em>
                  </span>
                </button>
              );
            })}
          </aside>

          <article className={styles.detailPanel}>
            {!selectedConversationThread || !selectedConversationLatest ? <div className={styles.empty}>Select a conversation to review its stored messages.</div> : (
              <>
                <div className={styles.detailHeader}>
                  <div>
                    <span className={styles.conversationBadge}>Conversation</span>
                    <h2>@{selectedConversationThread.actorUsername}</h2>
                    <code>{selectedConversationThread.actorRole} · {selectedConversationThread.conversationKey || "Single turn"}</code>
                  </div>
                  <div className={styles.detailHeaderSide}>
                    <div className={styles.detailTiming}>
                      <MessageSquare size={16} />
                      <strong>{selectedConversationThread.records.length} exchange{selectedConversationThread.records.length === 1 ? "" : "s"}</strong>
                      <small>Updated {formatTime(selectedConversationThread.createdAt)}</small>
                    </div>
                    <button
                      className={styles.deleteConversationButton}
                      type="button"
                      disabled={selectedConversationThread.records.some((record) => deletingConversationIds.includes(record.id))}
                      onClick={() => void deleteConversationRecords(selectedConversationThread.records, "conversation")}
                    >
                      <Trash2 size={14} /> Delete conversation
                    </button>
                  </div>
                </div>

                <div className={`${styles.routeMeta} ${styles.conversationMeta}`}>
                  <div><span>Conversation</span><strong>{selectedConversationThread.conversationKey || "Single turn"}</strong></div>
                  <div><span>Linked traces</span><strong>{selectedConversationTraceIds.length || "None"}</strong></div>
                  <div><span>Redactions</span><strong>{selectedConversationThread.records.reduce((sum, record) => sum + record.question.redactionCount + record.answer.redactionCount, 0)}</strong></div>
                  <div><span>Truncated fields</span><strong>{selectedConversationThread.records.reduce((sum, record) => sum + Number(record.question.truncated) + Number(record.answer.truncated), 0)}</strong></div>
                </div>

                <section className={styles.detailSection}>
                  <h3><MessageSquare size={16} />Visible conversation</h3>
                  <div className={styles.conversationThread}>
                    {selectedConversationThread.records.map((record, index) => (
                      <div className={styles.exchangeGroup} key={record.id}>
                        <div className={styles.exchangeHeader}>
                          <span>Exchange {index + 1} · {formatTime(record.createdAt)}</span>
                          <button
                            type="button"
                            disabled={deletingConversationIds.includes(record.id)}
                            onClick={() => void deleteConversationRecords([record], "exchange")}
                          >
                            <Trash2 size={13} /> {deletingConversationIds.includes(record.id) ? "Deleting…" : "Delete exchange"}
                          </button>
                        </div>
                        <article className={`${styles.messageCard} ${styles.userMessage}`}>
                          <header><span>User</span><small>@{record.actorUsername}</small></header>
                          <p>{record.question.text || "This question was removed during redaction."}</p>
                        </article>
                        <article className={`${styles.messageCard} ${styles.assistantMessage}`}>
                          <header><span>E3 Agent</span><small>Stored response</small></header>
                          <p>{record.answer.text || "This response was removed during redaction."}</p>
                        </article>
                      </div>
                    ))}
                  </div>
                </section>

                <p className={styles.auditNotice}>
                  <ShieldCheck size={15} /> This sanitised audit copy may contain derived business information from the visible answer. Original attachments and hidden reasoning are not stored.
                </p>
              </>
            )}
          </article>
        </div>
      </>}
    </section>
  );
}
