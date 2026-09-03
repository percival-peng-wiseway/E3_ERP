"use client";

import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Filter,
  RefreshCw,
  Route,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTraceRecord } from "@/lib/erp_agent/agent/trace-record";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./agent-trace-workspace.module.css";

type TraceResponse = {
  data?: { traces: AgentTraceRecord[]; storage: "memory" | "d1"; generatedAt: string };
  error?: { message?: string };
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
  const [traces, setTraces] = useState<AgentTraceRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storage, setStorage] = useState<"memory" | "d1">("memory");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [userFilter, setUserFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [error, setError] = useState("");
  const requestRunning = useRef(false);

  const loadTraces = useCallback(async (foreground = false) => {
    if (requestRunning.current) return;
    requestRunning.current = true;
    if (foreground) setRefreshing(true);
    try {
      const response = await fetch("/api/agent/traces?limit=500", { cache: "no-store" });
      const body = await readJsonResponse<TraceResponse>(response);
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message || "Unable to load Agent traces.");
      }
      setTraces(body.data.traces);
      setStorage(body.data.storage);
      setSelectedId((current) => current && body.data?.traces.some((trace) => trace.id === current)
        ? current
        : body.data?.traces[0]?.id || null);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Agent traces.");
    } finally {
      requestRunning.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadTraces();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadTraces]);

  const selected = traces.find((trace) => trace.id === selectedId) || null;
  const users = useMemo(() => [...new Set(traces.map((trace) => trace.actorUsername))].sort(), [traces]);
  const visibleTraces = useMemo(() => traces.filter((trace) => (
    (userFilter === "all" || trace.actorUsername === userFilter)
    && (outcomeFilter === "all" || trace.outcome === outcomeFilter)
    && (!issuesOnly || trace.issueCodes.length > 0)
  )), [issuesOnly, outcomeFilter, traces, userFilter]);

  useEffect(() => {
    if (selectedId && visibleTraces.some((trace) => trace.id === selectedId)) return;
    setSelectedId(visibleTraces[0]?.id || null);
  }, [selectedId, visibleTraces]);

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

  return (
    <section className={`${styles.workspace} ${compact ? styles.compact : ""}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>E3 AGENT · OBSERVABILITY</span>
          <h1>Agent execution traces</h1>
          <p>Inspect every user&apos;s Agent sessions, routing, tools, model rounds and operational issues.</p>
        </div>
        <div className={styles.controls}>
          <label className={styles.liveToggle}>
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span className={autoRefresh ? styles.liveDot : ""} />
            Live
          </label>
          <button type="button" onClick={() => void loadTraces(true)} disabled={refreshing}>
            <RefreshCw className={refreshing ? styles.spinning : ""} size={15} /> Refresh
          </button>
        </div>
      </header>

      <div className={styles.privacyNote}>
        <ShieldCheck size={18} />
        <span><strong>Privacy-safe conversation diagnostics.</strong> User identity and request metadata are stored; raw questions, answers, hidden reasoning, tool payloads and attachments are not.</span>
        <small><Database size={13} /> {storage === "d1" ? "Cloudflare D1 · all users · 30 days" : "Local memory · this server session"}</small>
      </div>

      {error ? <div className={styles.errorBanner}><AlertTriangle size={17} />{error}</div> : null}

      <div className={styles.stats}>
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
                      <div><strong>{round.model}</strong><small>{round.status} · {round.toolCallCount} tool calls · {((round.inputTokens || 0) + (round.outputTokens || 0)).toLocaleString()} tokens</small></div>
                      <span>{round.durationMs} ms</span>
                    </div>
                  ))}
                </section>
              </div>
            </>
          )}
        </article>
      </div>
    </section>
  );
}
