"use client";
import { useEffect, useState } from "react";
import type { ErpUser } from "@/lib/auth/types";
import { type WorkEntry } from "@/lib/team-workspace/model";
import styles from "./team-workspace.module.css";
export function TaskWorkflowActions({ entry, user, onSaved }: { entry: WorkEntry; user: ErpUser; onSaved: (entry: WorkEntry) => void }) {
  const [employee, setEmployee] = useState(entry.employeeFeedback || "");
  const [admin, setAdmin] = useState(entry.adminFeedback || "");
  const [employeeDirty, setEmployeeDirty] = useState(false);
  const [adminDirty, setAdminDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => { if (!employeeDirty) setEmployee(entry.employeeFeedback || ""); if (!adminDirty) setAdmin(entry.adminFeedback || ""); }, [entry.employeeFeedback, entry.adminFeedback, employeeDirty, adminDirty]);
  const canEmployee = user.username === entry.owner && entry.status !== "done";
  const canAdmin = user.role === "admin" && entry.status !== "done";
  async function submit(action: "save_employee" | "employee_review" | "admin_feedback" | "accept") {
    const update = (action === "save_employee" || action === "employee_review" ? employee : admin).trim();
    if (action !== "accept" && !update) { setError("Please enter feedback first."); return; }
    setBusy(true); setError(""); setSaved("");
    try {
      const response = await fetch("/api/team-workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...entry, history: undefined, attachments: undefined, notifications: undefined, action, update }) });
      const data = await response.json() as { entry: WorkEntry; error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to save.");
      if (action === "save_employee" || action === "employee_review") setEmployeeDirty(false); else setAdminDirty(false);
      onSaved(data.entry); setSaved(action === "accept" ? "Task accepted." : action === "employee_review" ? "Review requested." : "Feedback saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save."); }
    finally { setBusy(false); }
  }
  return <section className={styles.feedbackForms} aria-label="Task feedback">
    <div className={styles.feedbackBox}><label>Employee feedback<textarea rows={4} maxLength={4000} readOnly={!canEmployee} disabled={busy} value={employee} onChange={event => { setEmployee(event.target.value); setEmployeeDirty(true); }} placeholder="Work completed, current situation or anything to review…" /></label>
      <div className={styles.workflowButtons}><button type="button" disabled={busy || !canEmployee} onClick={() => void submit("save_employee")}>Save</button><button type="button" className={styles.primary} disabled={busy || !canEmployee || entry.status === "review"} onClick={() => void submit("employee_review")}>Request review</button></div>
    </div>
    <div className={styles.feedbackBox}><label>Admin feedback<textarea rows={4} maxLength={4000} readOnly={!canAdmin} disabled={busy} value={admin} onChange={event => { setAdmin(event.target.value); setAdminDirty(true); }} placeholder="Feedback or changes needed…" /></label>
      <div className={styles.workflowButtons}><button type="button" disabled={busy || !canAdmin} onClick={() => void submit("admin_feedback")}>Send feedback</button><button type="button" className={styles.primary} disabled={busy || !canAdmin || entry.status !== "review"} onClick={() => void submit("accept")}>Done</button></div>
      {canAdmin && entry.status !== "review" && <small>Done becomes available after the employee requests review.</small>}
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{saved && <p role="status" className={styles.notice}>{saved}</p>}
  </section>;
}
