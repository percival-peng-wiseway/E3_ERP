import type { ErpUser } from "../auth/types";

export const WEEKLY_MEMBERS = [
  { username: "ruihan", displayName: "RuiHan", department: "Sales & Marketing" },
  { username: "sam", displayName: "Sam", department: "Sales & Marketing" },
  { username: "wendy", displayName: "Wendy", department: "Operation" },
  { username: "hogan", displayName: "Hogan", department: "Operation" },
  { username: "kevin", displayName: "Kevin", department: "Procurement" },
  { username: "jiaqi", displayName: "JiaQi", department: "Finance & HR" },
] as const;
export function isWeeklyMember(username: string) {
  return WEEKLY_MEMBERS.some(member => member.username === username);
}

export type WorkKind = "meeting" | "weekly" | "task";
export type WorkStatus = "start" | "wip" | "feedback" | "review" | "done";
export type WorkEntry = {
  id: string; kind: WorkKind; title: string; date: string; owner: string;
  content: string; goals: string; attendees: string; status: WorkStatus;
  progress: number; update: string; version: number; createdAt: string; updatedAt: string;
  assignedBy?: string;
  employeeFeedback?: string;
  adminFeedback?: string;
  attachments?: { id: string; name: string; size: number; by: string; at: string; previewType?: string }[];
  notifications?: { id: string; recipient: string; priority: "high"; message: string; at: string; read: boolean }[];
  history: { at: string; by: string; status: WorkStatus; progress: number; note: string }[];
};
export const TASK_LABELS: Record<WorkStatus, string> = { start: "Submitted", wip: "In progress", review: "Awaiting acceptance", feedback: "Changes requested", done: "Done" };
export type TaskAction = "start_work" | "submit_review" | "request_changes" | "accept";
export function taskActions(entry: WorkEntry, user: ErpUser): { action: TaskAction; label: string }[] {
  if (entry.kind !== "task" || !canEdit(entry, user)) return [];
  if (entry.status === "start" || entry.status === "feedback") return [{ action: "start_work", label: entry.status === "feedback" ? "Continue work" : "Start work" }];
  if (entry.status === "wip") return [{ action: "submit_review", label: "Complete & submit for acceptance" }];
  if (entry.status === "review" && user.role === "admin") return [{ action: "request_changes", label: "Request changes" }, { action: "accept", label: "Accept & mark Done" }];
  return [];
}
/** Only the original assigner and current assignee receive task notifications. */
export function taskNotificationRecipients(entry: WorkEntry): Set<string> {
  return new Set([entry.assignedBy || entry.history[0]?.by, entry.owner].filter((username): username is string => Boolean(username)));
}
export function taskReminders(entries: WorkEntry[], username: string) {
  return entries.filter(entry => entry.kind === "task" && taskNotificationRecipients(entry).has(username)).flatMap(entry => {
    const latest = (entry.notifications || []).filter(item => item.recipient === username && !item.read).slice().reverse().sort((a, b) => b.at.localeCompare(a.at))[0];
    return latest ? [{ ...latest, entry }] : [];
  }).sort((a,b) => b.at.localeCompare(a.at));
}
export class WorkError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function canEdit(entry: WorkEntry, user: ErpUser) {
  return entry.kind === "meeting" ? entry.owner === user.username || user.role === "admin"
    : entry.kind === "weekly" ? entry.owner === user.username && isWeeklyMember(user.username)
    : user.role === "admin" || entry.owner === user.username;
}
export function monday(date: string) {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}
/** Calendar arithmetic in UTC keeps date-only weeks stable across Melbourne DST. */
export function weeklyDateRanges(week: string) {
  const start = monday(week);
  const offset = (days: number) => {
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  return { start, end: offset(6), previousStart: offset(-7), previousEnd: offset(-1) };
}

export function applyEntry(raw: Record<string, unknown>, user: ErpUser, members: string[], old?: WorkEntry): WorkEntry {
  const kind = raw.kind;
  if (kind === "meeting") throw new WorkError("Meeting records are no longer enabled.", 403);
  if (!["meeting", "weekly", "task"].includes(String(kind))) throw new WorkError("Invalid entry type.");
  if (old && (old.kind !== kind || !canEdit(old, user))) throw new WorkError("You cannot edit this entry.", 403);
  if (kind === "weekly" && !isWeeklyMember(user.username)) throw new WorkError("Weekly cards are currently enabled for the six selected team members only.", 403);
  if (!old && kind === "task" && user.role !== "admin") throw new WorkError("Only administrators can assign tasks.", 403);
  if (old && raw.version !== old.version) throw new WorkError("This entry changed. Refresh and reopen it before saving.", 409);
  const str = (key: string, max: number, required = false) => {
    if (typeof raw[key] !== "string") throw new WorkError(`Invalid ${key}.`);
    const value = (raw[key] as string).trim();
    if (value.length > max || (required && !value)) throw new WorkError(`Please check ${key} (maximum ${max} characters).`);
    return value;
  };
  const title = str("title", 160, true), date = str("date", 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new WorkError("Choose a valid date.");
  const owner = kind === "task" ? str("owner", 100, true) : old?.owner || user.username;
  if (kind === "task" && !members.includes(owner)) throw new WorkError("Choose an active team member.");
  const content = str("content", 12000), goals = str("goals", 6000), attendees = str("attendees", 2000), update = str("update", 4000);
  let status = raw.status as WorkStatus;
  if (kind === "task") {
    if (!old) { if (status !== "start" || raw.action) throw new WorkError("New requests must start as Submitted."); }
    else if (["save_employee", "employee_review", "admin_feedback"].includes(String(raw.action))) {
      if (old.status === "done") throw new WorkError("This task has already been accepted.", 403);
      if (raw.action === "admin_feedback") {
        if (user.role !== "admin") throw new WorkError("Only administrators can send feedback.", 403);
        if (!update) throw new WorkError("Enter your feedback first.");
        status = "feedback";
      } else {
        if (user.username !== old.owner) throw new WorkError("Only the assigned employee can update this response.", 403);
        if (!update) throw new WorkError("Enter the employee feedback first.");
        if (raw.action === "employee_review") {
          if (old.status === "review") throw new WorkError("This task is already waiting for review.");
          status = "review";
        } else status = old.status === "start" || old.status === "feedback" ? "wip" : old.status;
      }
    }
    else if (raw.action) {
      const allowed = taskActions(old, user).find(item => item.action === raw.action);
      if (!allowed) throw new WorkError("This action is not permitted at the current stage.", 403);
      if (raw.action === "request_changes" && !update) throw new WorkError("Explain what needs to be changed before returning this task.");
      status = ({ start_work: "wip", submit_review: "review", request_changes: "feedback", accept: "done" } as const)[allowed.action];
    } else if (status !== old.status) throw new WorkError("Use the task action buttons to change its stage.", 403);
  }
  if (!["start", "wip", "feedback", "review", "done"].includes(status)) throw new WorkError("Invalid status.");
  if (kind !== "task" && (typeof raw.progress !== "number" || !Number.isInteger(raw.progress) || raw.progress < 0 || raw.progress > 100)) throw new WorkError("Invalid progress.");
  if (old?.kind === "task" && user.role !== "admin" && (owner !== old.owner || title !== old.title || date !== old.date || content !== old.content || goals !== old.goals || attendees !== old.attendees)) throw new WorkError("Only administrators can change task assignments and requirements.", 403);
  const at = new Date().toISOString();
  const progress = kind === "task" ? 0 : raw.progress as number;
  return { id: old?.id || crypto.randomUUID(), kind: kind as WorkKind, title, date: kind === "weekly" ? monday(date) : date, owner, content, goals, attendees, status, progress, update,
    assignedBy: old?.assignedBy || (old ? old.history[0]?.by : user.username),
    employeeFeedback: raw.action === "save_employee" || raw.action === "employee_review" ? update : old?.employeeFeedback || "",
    adminFeedback: raw.action === "admin_feedback" || raw.action === "request_changes" || raw.action === "accept" && update ? update : old?.adminFeedback || "",
    attachments: old?.attachments || [], notifications: old?.notifications || [],
    version: (old?.version || 0) + 1, createdAt: old?.createdAt || at, updatedAt: at,
    history: [...(old?.history || []), { at, by: user.username, status, progress, note: update || (kind === "task" && raw.action ? TASK_LABELS[status] : old ? "Entry updated" : "Entry created") }] };
}
