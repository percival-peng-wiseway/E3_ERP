"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Home, LogOut, RefreshCw } from "lucide-react";
import type { ErpUser } from "@/lib/auth/types";
import { addDays, addressLabel, customerLabel, melbourneDate, weekStart, WORK_LABELS, type TimetableEvent } from "@/lib/timetable/types";
import { InstallationDetailsDialog } from "./installation-details-dialog";
import { TeamWorkspace } from "./team-workspace";
import styles from "./installer-workspace.module.css";

export function InstallerWorkspace({ currentUser }: { currentUser: ErpUser }) {
  const [page, setPage] = useState<"home" | "timetable" | "team">("home");
  const [events, setEvents] = useState<TimetableEvent[]>([]);
  const [selected, setSelected] = useState<TimetableEvent | null>(null);
  const [week, setWeek] = useState(() => weekStart(melbourneDate()));
  const [kind, setKind] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [signingOut, setSigningOut] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch("/api/timetable", { cache: "no-store", signal });
      const body = await response.json() as { data: TimetableEvent[]; error?: string; warnings?: string[] };
      if (!response.ok) throw new Error(body.error || "Unable to load Time Table.");
      if (!signal?.aborted) { setEvents(body.data); setWarnings(body.warnings || []); setError(""); }
    } catch (e) {
      if (!signal?.aborted) { setEvents([]); setError(e instanceof Error ? e.message : "Unable to load Time Table."); }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    let active: AbortController | undefined;
    const refresh = () => { if (document.hidden) return; active?.abort(); active = new AbortController(); void load(active.signal); };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active?.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  const today = melbourneDate();
  const visible = events.filter((event) => (kind === "all" || event.kind === kind)
    && (page === "home" ? !event.completed && !event.cancelled : event.date >= week && event.date <= addDays(week, 6)));
  async function signOut() {
    setSigningOut(true);
    try { const response = await fetch("/api/auth/logout", { method: "POST" }); if (!response.ok) throw new Error("Unable to sign out."); window.location.assign("/login"); }
    catch { setError("Unable to sign out. Please try again."); setSigningOut(false); }
  }
  const card = (event: TimetableEvent) => <button type="button" key={event.id} className={styles.card} onClick={() => setSelected(event)}>
    <span className={styles.badges}><span>{WORK_LABELS[event.kind]}</span><span>{event.cancelled ? "Cancelled" : event.completed ? "Complete" : event.date < today ? "Overdue" : "Scheduled"}</span></span>
    <strong>{customerLabel(event.details)}</strong>
    <span>{event.date} · {event.time || "Time not set"}</span>
    <span>{addressLabel(event.details) || "Address not set"}</span>
    <span>Assigned to: {event.assignee || "Unassigned"}</span>
    <small>View installation details →</small>
  </button>;
  return <div className={styles.workspace}>
    <header className={styles.header}><strong>E3 Energy</strong><span>{currentUser.displayName} · Installer</span><button type="button" disabled={signingOut} onClick={() => void signOut()}><LogOut size={16} />Sign out</button></header>
    <nav className={styles.nav} aria-label="ERP module navigation"><button type="button" aria-current={page === "home" ? "page" : undefined} onClick={() => setPage("home")}><Home size={17} />Home</button><button type="button" aria-current={page === "timetable" ? "page" : undefined} onClick={() => setPage("timetable")}><CalendarDays size={17} />Time Table</button>{<button type="button" aria-current={page === "team" ? "page" : undefined} onClick={() => setPage("team")}><CalendarDays size={17} />Team Workspace</button>}</nav>
    {page === "team" ? <main className={styles.main}><TeamWorkspace currentUser={currentUser} /></main> : <main className={styles.main}><div className={styles.toolbar}><div><h1>{page === "home" ? "My Action Reminders" : "Time Table"}</h1><p>Installation and delivery · Melbourne time</p></div><button type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={16} />Refresh</button></div>
      <div className={styles.toolbar}><label>Work type <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All work</option>{Object.entries(WORK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {page === "timetable" ? <div className={styles.weekControls}><button type="button" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">←</button><label>Week of <input aria-label="Week date" type="date" value={week} onChange={(e) => { if (e.target.value) setWeek(weekStart(e.target.value)); }} /></label><button type="button" onClick={() => setWeek(weekStart(today))}>Today</button><button type="button" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">→</button></div> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}{warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}
      {loading ? <p role="status">Refreshing schedule…</p> : null}
      {!loading && !error && !visible.length ? <p className={styles.empty}>{page === "home" ? "No installation or delivery reminders" : "No work scheduled this week"}</p> : null}
      {page === "home" ? <div className={styles.cards}>{visible.map(card)}</div> : <div className={styles.weekGrid}>{Array.from({ length: 7 }, (_, index) => addDays(week, index)).map((date) => <section key={date} className={date === today ? styles.today : ""}><h2>{new Date(`${date}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })}</h2>{visible.filter((e) => e.date === date).map(card)}</section>)}</div>}
    </main>}
    {selected ? <InstallationDetailsDialog key={selected.id} projectId={selected.id.startsWith("payment-") ? selected.details.id : undefined} initialDetails={selected.details} onClose={() => setSelected(null)} /> : null}
  </div>;
}
