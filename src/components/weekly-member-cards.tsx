"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ErpUser } from "@/lib/auth/types";
import { WEEKLY_MEMBERS, weeklyDateRanges, type WorkEntry } from "@/lib/team-workspace/model";
import styles from "./team-workspace.module.css";

type Props = {
  entries: WorkEntry[];
  week: string;
  currentUser: ErpUser;
  onSaved: (entry: WorkEntry) => void;
  onEditing: (editing: boolean) => void;
};

export function WeeklyMemberCards(props: Props) {
  const departments = ["Sales & Marketing", "Procurement", "Operation", "Finance & HR"] as const;
  return <div className={styles.departmentGrid}>
    {departments.map(department => <section key={department} className={styles.department} aria-label={department}>
      <header><h3>{department}</h3><span>{WEEKLY_MEMBERS.filter(member => member.departments.some(name => name === department)).length}</span></header>
      <div className={styles.memberGrid}>
        {WEEKLY_MEMBERS.filter(member => member.departments.some(name => name === department))
          .sort((a, b) => Number(a.departments[0] !== department) - Number(b.departments[0] !== department)
            || (department === "Operation" ? Number(b.username === "hogan") - Number(a.username === "hogan") : 0))
          .map(member => <MemberCard key={`${member.username}:${props.week}`} {...props}
            member={{ ...member, department }} entry={props.entries.find(entry => entry.kind === "weekly" && entry.owner === member.username && entry.date === props.week)} />)}
      </div>
    </section>)}
  </div>;
}

function MemberCard({ member, entry, entries, week, currentUser, onSaved, onEditing }: Props & {
  member: { username: string; displayName: string; department: string }; entry?: WorkEntry;
}) {
  const reportTitleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WorkEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const isOwner = currentUser.username === member.username;

  const ranges = weeklyDateRanges(week);
  const past = entries.filter(record => record.kind === "weekly" && record.owner === member.username && record.date < ranges.start)
    .sort((left, right) => right.date.localeCompare(left.date));
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);
  function close() {
    if (busy || (draft && !window.confirm("Discard unsaved weekly edits?"))) return;
    setDraft(null); setError(""); onEditing(false); setOpen(false);
  }

  function edit() {
    setDraft(entry ? { ...entry, update: "" } : {
      id: "", kind: "weekly", title: `${member.displayName}'s weekly update`, date: week,
      owner: member.username, content: "", goals: "", attendees: "", status: "start",
      progress: 0, update: "", version: 0, createdAt: "", updatedAt: "", history: [],
    });
    setError(""); setSaved(false); onEditing(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/team-workspace", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, update: "Updated last week's completed work and this week's plan." }),
      });
      const data = await response.json() as { entry: WorkEntry; error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to save your weekly update.");
      onSaved(data.entry); setDraft(null); setSaved(true); onEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save."); }
    finally { setBusy(false); }
  }

  const form = draft ? <form onSubmit={save}><fieldset disabled={busy}>
    <label>Completed last week <span className={styles.weekDates}>{dateRange(ranges.previousStart, ranges.previousEnd)}</span><textarea autoFocus rows={open ? 10 : 6} maxLength={12000} placeholder="What did you finish or achieve last week?" value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} /></label>
    <label>This Week Plan <span className={styles.weekDates}>{dateRange(ranges.start, ranges.end)}</span><textarea rows={open ? 10 : 6} maxLength={6000} placeholder="What will you focus on this week?" value={draft.goals} onChange={event => setDraft({ ...draft, goals: event.target.value })} /></label>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <footer><button type="button" onClick={() => { setDraft(null); setError(""); onEditing(false); }}>Cancel</button><button type="submit" className={styles.primary}>{busy ? "Saving…" : "Save update"}</button></footer>
  </fieldset></form> : null;
  const report = <>
    <div className={styles.weekContent}>
      <section><h4>Completed last week</h4><span className={styles.weekDates}>{dateRange(ranges.previousStart, ranges.previousEnd)}</span><p className={!entry?.content ? styles.memberPlaceholder : undefined}>{entry?.content || "No update yet."}</p></section>
      <section><h4>This Week Plan</h4><span className={styles.weekDates}>{dateRange(ranges.start, ranges.end)}</span><p className={!entry?.goals ? styles.memberPlaceholder : undefined}>{entry?.goals || "No plan added yet."}</p></section>
    </div>
    <footer><span>{entry ? `Updated ${new Date(entry.updatedAt).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Visible to everyone"}</span>{isOwner && <button type="button" onClick={() => { setOpen(true); edit(); }}>Update my card</button>}</footer>
    {saved && <p role="status" className={styles.notice}>Weekly update saved.</p>}
  </>;

  return <>
    <article className={styles.memberCard} aria-label={`${member.displayName} weekly card`}>
      <header><button type="button" className={styles.memberOpen} aria-label={`Open ${member.displayName} weekly records`} onClick={() => setOpen(true)}>
        <span className={styles.memberAvatar}>{member.displayName.slice(0, 1)}</span>
        <span><strong>{member.displayName}{isOwner && " · You"}</strong><small>{dateRange(ranges.start, ranges.end)}</small></span>
        <span aria-hidden="true">↗</span>
      </button><span className={styles.badge}>{entry ? "Updated" : "Not updated"}</span></header>
      {report}
      <button type="button" className={styles.openRecords} onClick={() => setOpen(true)}>Open weekly records · {past.length} previous {past.length === 1 ? "week" : "weeks"}</button>
    </article>
    {open && <dialog ref={dialogRef} className={styles.weekDialog} aria-labelledby={reportTitleId}
      onCancel={event => { event.preventDefault(); close(); }}>
      <header className={styles.weekDialogHeader}><div><span className={styles.eyebrow}>WEEKLY RECORDS</span><h2 id={reportTitleId}>{member.displayName}</h2><p>{member.department} · {dateRange(ranges.start, ranges.end)} · Monday – Friday</p></div><button autoFocus type="button" disabled={busy} aria-label="Close weekly records" onClick={close}>Close ×</button></header>
      <div className={`${styles.memberCard} ${styles.expandedWeek}`}>{form || report}</div>
      <section className={styles.pastWeeks}><h3>Previous weekly records <span>{past.length}</span></h3><p>Expand a week to view the previous week’s completed work and that week’s plan.</p>
        {past.length ? past.map(record => {
          const dates = weeklyDateRanges(record.date);
          return <details key={record.id} className={styles.pastWeek}>
            <summary>{dateRange(dates.start, dates.end)}<span>View weekly record</span></summary>
            <div className={styles.weekContent}>
              <section><h4>Completed last week</h4><span className={styles.weekDates}>{dateRange(dates.previousStart, dates.previousEnd)}</span><p>{record.content || "No update recorded."}</p></section>
              <section><h4>This Week Plan</h4><span className={styles.weekDates}>{dateRange(dates.start, dates.end)}</span><p>{record.goals || "No plan recorded."}</p></section>
            </div>
          </details>;
        }) : <div className={styles.emptyColumn}>No records before this week yet.</div>}
      </section>
    </dialog>}
  </>;
}

function dateRange(start: string, end: string) {
  const format = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  return `${format(start)} – ${format(end)}`;
}
