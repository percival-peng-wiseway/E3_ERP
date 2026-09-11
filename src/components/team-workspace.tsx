"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ClipboardList, Target, Plus, RefreshCw, X, ArrowRight } from "lucide-react";
import type { ErpUser } from "@/lib/auth/types";
import { canEdit, monday, isWeeklyMember, taskReminders, TASK_LABELS, type WorkEntry, type WorkKind, type WorkStatus } from "@/lib/team-workspace/model";
import { TaskWorkflowActions } from "./task-workflow-actions";
import { TaskFiles } from "./task-files";
import { WeeklyMemberCards } from "./weekly-member-cards";
import styles from "./team-workspace.module.css";
const labels = TASK_LABELS;
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
export function TeamWorkspace({ currentUser, openTaskTarget }: { currentUser: ErpUser; openTaskTarget?: { entityId: string; requestId: number } }) {
  const openedTarget = useRef<number | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<WorkKind>("weekly");
  const [entries, setEntries] = useState<WorkEntry[]>([]);
  const [members, setMembers] = useState<ErpUser[]>([]);
  const [week, setWeek] = useState(() => monday(today()));
  const [weeklyEditing, setWeeklyEditing] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<WorkEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { const res = await fetch("/api/team-workspace", { cache: "no-store" }); const data = await res.json() as { entries: WorkEntry[]; members: ErpUser[]; error?: string }; if (!res.ok) throw new Error(data.error); setEntries(data.entries); setMembers(data.members); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to load workspace."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (document.hidden) return;
      try { const response = await fetch("/api/team-workspace", { cache: "no-store" });
        if (response.ok) { const data = await response.json() as { entries: WorkEntry[] }; setEntries(data.entries); }
      } catch { /* Keep the current view; manual refresh exposes loading errors. */ }
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!openTaskTarget || openedTarget.current === openTaskTarget.requestId) return;
    const entry = entries.find(item => item.id === openTaskTarget.entityId && item.kind === "task");
    if (!entry) return;
    openedTarget.current = openTaskTarget.requestId; setTab("task"); setFilter("all"); setSelected(entry); setEditing(false);
  }, [entries, openTaskTarget]);
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected?.id]);
  const notifications = taskReminders(entries, currentUser.username);
  async function openNotification(id: string, entry: WorkEntry) {
    setTab("task"); setFilter("all"); setSelected(entry); setEditing(false);
    try { const response = await fetch("/api/team-workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read_notification", id }) });
      if (!response.ok) throw new Error("Unable to mark notification as read.");
      setEntries(previous => previous.map(record => ({ ...record, notifications: record.notifications?.map(item => record.id === entry.id && item.recipient === currentUser.username && (entry.notifications || []).some(seen => seen.id === item.id) ? { ...item, read: true } : item) })));
    } catch { setError("Unable to mark notification as read. Please try again."); }
  }
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy && !editing) setSelected(null); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [selected, busy, editing]);
  useEffect(() => {
    if (!weeklyEditing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [weeklyEditing]);
  const name = (username: string) => members.find(m => m.username === username)?.displayName || username;
  const canCreate = tab !== "weekly" && (tab !== "task" || currentUser.role === "admin");
  const visible = entries.filter(e => e.kind === tab && (tab !== "weekly" || e.date === week) && (filter === "all" || e.owner === filter)).sort((a,b) => b.date.localeCompare(a.date));
  function create() {
    setFilter("all");
    const existing = tab === "weekly" ? entries.find(e => e.kind === "weekly" && e.date === week && e.owner === currentUser.username) : undefined;
    setSelected(existing || { id: "", kind: tab, title: tab === "weekly" ? `${currentUser.displayName}'s weekly plan` : "", date: tab === "weekly" ? week : today(), owner: currentUser.username, content: "", goals: "", attendees: "", status: "start", progress: 0, update: "", version: 0, createdAt: "", updatedAt: "", history: [] });
    setEditing(true); setError("");
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true); setError("");
    try { const res = await fetch("/api/team-workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...selected, history: undefined, attachments: undefined, notifications: undefined }) }); const data = await res.json() as { entry: WorkEntry; error?: string }; if (!res.ok) throw new Error(data.error); setEntries(previous => [data.entry, ...previous.filter(e => e.id !== data.entry.id)]); setSelected(data.entry); setEditing(false); setNotice("Saved to your workspace."); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); } finally { setBusy(false); }
  }
  const field = (key: keyof WorkEntry, value: string | number) => setSelected(previous => previous ? { ...previous, [key]: value } : previous);
  const requirementsLocked = selected?.kind === "task" && currentUser.role !== "admin";
  const detailPanel = selected ? <section ref={detailRef} className={styles.inlineTask} role="region" aria-labelledby="team-entry-title"><header><div><span className={styles.eyebrow}>{selected.kind === "meeting" ? "MEETING RECORD" : selected.kind === "weekly" ? "WEEKLY PLAN" : "ASSIGNED TASK"}</span><h2 id="team-entry-title">{editing ? selected.id ? "Edit entry" : "Create entry" : selected.title}</h2></div><button aria-label="Close entry" disabled={busy} onClick={() => { if (!editing || window.confirm("Discard unsaved edits?")) { setSelected(null); setEditing(false); setError(""); } }}><X size={20} /></button></header>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {editing ? <form onSubmit={save} className={styles.form}><fieldset disabled={busy}><label>Title<input autoFocus required maxLength={160} value={selected.title} disabled={requirementsLocked} onChange={e => field("title", e.target.value)} /></label><div className={styles.two}><label>{selected.kind === "weekly" ? "Week of" : selected.kind === "meeting" ? "Meeting date" : "Due date"}<input required type="date" value={selected.date} disabled={requirementsLocked} onChange={e => field("date", e.target.value)} /></label>{selected.kind === "task" && <label>Assigned to<select value={selected.owner} disabled={requirementsLocked} onChange={e => field("owner", e.target.value)}>{members.map(m => <option key={m.username} value={m.username}>{m.displayName}</option>)}</select></label>}</div>
      {selected.kind === "meeting" && <label>Attendees<input maxLength={2000} placeholder="Names of meeting participants" value={selected.attendees} onChange={e => field("attendees", e.target.value)} /></label>}
      <label>{selected.kind === "meeting" ? "Agenda & meeting notes" : "Request / requirements"}<textarea rows={6} maxLength={12000} value={selected.content} disabled={requirementsLocked} onChange={e => field("content", e.target.value)} /></label><label>{selected.kind === "meeting" ? "Decisions & action items" : "Goals / expected outcome"}<textarea rows={4} maxLength={6000} value={selected.goals} disabled={requirementsLocked} onChange={e => field("goals", e.target.value)} /></label>

      <label>Progress reply<textarea rows={3} maxLength={4000} placeholder="What changed? Any blockers or next steps?" value={selected.update} onChange={e => field("update", e.target.value)} /></label><footer><button type="button" onClick={() => { const original = entries.find(e => e.id === selected.id); setSelected(original || null); setEditing(false); setError(""); }}>Cancel</button><button className={styles.primary} type="submit">{busy ? "Saving…" : "Save changes"}</button></footer></fieldset></form> : <div className={styles.taskDetailLayout}>
        <section className={styles.taskInformation}>
          <dl><div><dt>Expected completion</dt><dd>{new Date(`${selected.date}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })}</dd></div>
          <div><dt>Assigned by</dt><dd>{name(selected.assignedBy || selected.history[0]?.by || "—")}</dd></div>
          <div><dt>Assigned to</dt><dd>{name(selected.owner)}</dd></div></dl>
          <h3>Task content</h3><p>{selected.content || "No task description yet."}</p>
          {selected.goals && <><h3>Expected outcome</h3><p>{selected.goals}</p></>}
          {currentUser.role === "admin" && <button type="button" onClick={() => { setSelected({ ...selected, update: "" }); setEditing(true); }}>Edit task</button>}
        </section>
        <section className={styles.taskResponsePanel}>
          <TaskFiles key={selected.id} entry={selected} editable={canEdit(selected, currentUser)} onSaved={entry => { setSelected(entry); setEntries(previous => [entry, ...previous.filter(item => item.id !== entry.id)]); }} />
          <div className={styles.simpleTaskStatus}><span>Status</span><strong data-status={selected.status}>{labels[selected.status]}</strong></div>
          <TaskWorkflowActions key={selected.id} entry={selected} user={currentUser} onSaved={entry => { setSelected(entry); setEntries(previous => [entry, ...previous.filter(item => item.id !== entry.id)]); }} />
        </section>
      </div>}
    </section> : null;
  const card = (entry: WorkEntry) => selected?.id === entry.id ? <div key={entry.id} className={styles.expandedTaskCard}>{detailPanel}</div> : <button className={styles.card} key={entry.id} onClick={() => { setSelected(entry); setEditing(false); setError(""); }}>
    <span className={styles.cardMeta}>{entry.kind === "weekly" ? "Week of " : ""}{entry.date}<span className={styles.badge} data-status={entry.status}>{labels[entry.status]}</span></span>
    <strong>{entry.title}</strong><span className={styles.excerpt}>{entry.content || entry.goals || "Open task to view requirements and take the next step"}</span>
    {entry.kind === "task" && entry.date < today() && entry.status !== "done" ? <span className={styles.overdue}>Overdue</span> : null}
    <span className={styles.cardFooter}><span className={styles.avatar}>{name(entry.owner).slice(0,1)}</span>{name(entry.owner)}<ArrowRight size={16} /></span>
  </button>;
  return <section className={styles.workspace}>
    <header className={styles.heading}><div><span className={styles.eyebrow}>TEAM COLLABORATION {process.env.NODE_ENV === "development" && <span>Local preview</span>}</span><h1>Team Workspace</h1><p>Weekly plans, assigned work and administrator acceptance.</p></div><button onClick={() => void load()} disabled={loading || busy || weeklyEditing}><RefreshCw size={16} />Refresh</button></header>
    <div className={styles.stats} style={{ gridTemplateColumns: "repeat(2, 1fr)" }}><div><Target size={21} /><span><strong>{entries.filter(e => e.kind === "weekly" && e.date === week && isWeeklyMember(e.owner)).length}</strong>/ 6 updated · week of {week}</span></div><div><ClipboardList size={21} /><span><strong>{entries.filter(e => e.kind === "task" && e.status !== "done").length}</strong>Open assigned tasks</span></div></div>
    <details className={styles.taskNotifications}><summary>My task reminders · {notifications.length} tasks <span>High priority</span></summary>
      {!notifications.length && <p>No unread task notifications.</p>}{notifications.map(notification => <button type="button" key={notification.id} onClick={() => { if (weeklyEditing && !window.confirm("Discard unsaved weekly edits?")) return; setWeeklyEditing(false); void openNotification(notification.id, notification.entry); }}><strong>High</strong><span>{notification.message}<small>{new Date(notification.at).toLocaleString("en-AU")}</small></span></button>)}
    </details>
    <nav className={styles.tabs} aria-label="Collaboration spaces">{([["weekly", "Weekly tasks & goals", Target], ["task", "Task assignments", ClipboardList]] as const).map(([id, label, Icon]) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => { if (weeklyEditing && !window.confirm("Discard unsaved weekly edits?")) return; setWeeklyEditing(false); setTab(id); setFilter("all"); }}><Icon size={17} />{label}</button>)}</nav>
    <div className={styles.toolbar}><div><h2>{tab === "meeting" ? "Meetings & decisions" : tab === "weekly" ? "Last week & this week" : "Assigned tasks"}</h2><p>{tab === "meeting" ? "Capture the agenda, notes and next steps." : tab === "weekly" ? "Team updates by department. Review last week’s achievements and this week’s plan." : "One card per task — requirements, files, replies and acceptance in one place."}</p></div><div className={styles.filters}>{tab === "weekly" && <label>Week of<input type="date" value={week} onChange={e => { if (!e.target.value || (weeklyEditing && !window.confirm("Discard unsaved weekly edits?"))) return; setWeeklyEditing(false); setWeek(monday(e.target.value)); }} /></label>}{tab !== "weekly" && <label>{tab === "meeting" ? "Organizer" : "Team member"}<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Everyone</option>{members.map(m => <option key={m.username} value={m.username}>{m.displayName}{m.username === currentUser.username ? " (me)" : ""}</option>)}</select></label>}{canCreate && <button className={styles.primary} onClick={create} disabled={loading}><Plus size={16} />{tab === "meeting" ? "New meeting" : "Create request"}</button>}</div></div>
    {!selected && error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {selected && !selected.id && <div className={styles.newTaskCard}>{detailPanel}</div>}
    {loading ? <p className={styles.empty}>Loading workspace…</p> : tab === "weekly" ? <WeeklyMemberCards entries={entries} week={week} currentUser={currentUser} onEditing={setWeeklyEditing} onSaved={entry => setEntries(previous => [entry, ...previous.filter(item => item.id !== entry.id)])} /> : tab === "task" ? <div className={styles.taskCardGrid}>{visible.length ? visible.map(card) : <div className={styles.empty}>No assigned tasks yet.</div>}</div> : visible.length ? <div className={styles.cards}>{visible.map(card)}</div> : <div className={styles.empty}><Target size={30} /><h3>Keep your next meeting in one place</h3><p>Create a meeting record with attendees, notes and action items.</p>{canCreate && <button className={styles.primary} onClick={create}>Create first meeting</button>}</div>}

  </section>;
}
