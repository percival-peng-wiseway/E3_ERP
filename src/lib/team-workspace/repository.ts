import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { ErpUser } from "../auth/types";
// @ts-expect-error Node source tests use explicit extensions.
import { applyEntry, TASK_LABELS, WorkError, type WorkEntry } from "./model.ts";
// @ts-expect-error Node source tests use explicit extensions.
import { imagePreviewType } from "./image-type.ts";
// @ts-expect-error Node source tests use explicit extensions.
import { erpCloudflareBindings, readVersionedDocument, writeVersionedDocument, CloudflareDocumentConflictError, CloudflareStorageConfigurationError, type ErpCloudflareBindings } from "../server/cloudflare-storage.ts";
const DOCUMENT_KEY = "team-workspace/entries";
const attachmentKey = (id: string) => `team-workspace/attachments/${id}`;
// Development keeps its isolated local data even when other modules use remote reads.
async function storage() {
  if (process.env.NODE_ENV !== "production") return null;
  const bindings = await erpCloudflareBindings();
  if (!bindings?.database || !bindings.files) throw new CloudflareStorageConfigurationError("Team Workspace requires ERP_DB and ERP_FILES.");
  return bindings;
}
const root = path.resolve(process.env.TEAM_WORKSPACE_DATA_DIR || path.join(process.cwd(), ".data", "team-workspace"));
const file = path.join(root, "entries.json");
let queue: Promise<unknown> = Promise.resolve();
function normalize(data: unknown): WorkEntry[] {
  if (!Array.isArray(data)) throw new Error("Invalid workspace storage");
  return data.map((entry: WorkEntry) => {
    const status = (value: string) => ({ todo: "start", in_progress: "wip", blocked: "feedback" }[value] || value) as WorkEntry["status"];
    const returned = entry.history.filter((item, index) => status(item.status) === "feedback" && index > 0 && status(entry.history[index - 1].status) === "review").at(-1);
    return { ...entry, assignedBy: entry.assignedBy || entry.history[0]?.by,
      employeeFeedback: entry.employeeFeedback ?? entry.history.filter(item => item.by === entry.owner && ["wip", "review"].includes(status(item.status))).at(-1)?.note ?? "",
      adminFeedback: entry.adminFeedback ?? returned?.note ?? "",
      status: status(entry.status), history: entry.history.map(item => ({ ...item, status: status(item.status) })) };
  });
}
async function readStored(bindings: ErpCloudflareBindings | null) {
  if (bindings?.database) {
    const document = await readVersionedDocument<WorkEntry[]>(bindings.database, DOCUMENT_KEY);
    return { entries: normalize(document.value || []), version: document.version };
  }
  try { return { entries: normalize(JSON.parse(await readFile(file, "utf8"))), version: 0 }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], version: 0 }; throw error; }
}
async function writeStored(entries: WorkEntry[], version: number, bindings: ErpCloudflareBindings | null) {
  if (bindings?.database) { await writeVersionedDocument(bindings.database, DOCUMENT_KEY, entries, version); return; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = path.join(root, `${crypto.randomUUID()}.tmp`);
  try { await writeFile(temp, JSON.stringify(entries), { mode: 0o600 }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => undefined); }
}
async function mutate<T>(work: (bindings: ErpCloudflareBindings | null) => Promise<T>) {
  const bindings = await storage();
  if (bindings) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await work(bindings); }
      catch (error) { if (!(error instanceof CloudflareDocumentConflictError)) throw error; }
    }
    throw new WorkError("The workspace changed while saving. Refresh and try again.", 409);
  }
  const result = queue.then(() => work(null)); queue = result.catch(() => undefined); return result;
}
export async function listEntries(): Promise<WorkEntry[]> {
  return (await readStored(await storage())).entries;
}
export function saveEntry(input: Record<string, unknown>, user: ErpUser, members: string[], admins: string[] = [], attachment?: { name: string; bytes: Uint8Array }) {
  const uploadId = crypto.randomUUID();
  let uploaded = false;
  return mutate(async bindings => {
    const { entries, version } = await readStored(bindings);
    const old = input.id ? entries.find(e => e.id === input.id) : undefined;
    if (input.id && !old) throw new WorkError("Entry no longer exists.", 404);
    const entry = applyEntry(input, user, members, old);
    if (attachment) {
      if (entry.kind !== "task" || !old) throw new WorkError("Save the task before adding files.");
      if (attachment.bytes.length > 10 * 1024 * 1024 || !attachment.bytes.length) throw new WorkError("Choose a file between 1 byte and 10 MB.");
      if ((entry.attachments || []).length >= 30) throw new WorkError("Maximum 30 files per task.");
      const id = uploadId;
      if (!uploaded) {
        if (bindings?.files) await bindings.files.put(attachmentKey(id), attachment.bytes);
        else {
          await mkdir(path.join(root, "attachments"), { recursive: true, mode: 0o700 });
          await writeFile(path.join(root, "attachments", id), attachment.bytes, { mode: 0o600 });
        }
        uploaded = true;
      }
      entry.attachments = [...(entry.attachments || []), { id, name: attachment.name.slice(0, 200), size: attachment.bytes.length, by: user.username, at: entry.updatedAt, previewType: imagePreviewType(attachment.bytes) }];
    }
    if (entry.kind === "task") {
      const recipients = new Set(admins);
      if (!old || entry.status === "feedback" || entry.status === "done" || old.owner !== entry.owner) recipients.add(entry.owner);
      const reason = !old ? "New task assigned" : attachment ? "New file uploaded" : old.status !== entry.status ? TASK_LABELS[entry.status] : "Task updated";
      entry.notifications = [...(entry.notifications || []).filter(item => !recipients.has(item.recipient)), ...Array.from(recipients, recipient => ({ id: crypto.randomUUID(), recipient, priority: "high" as const, message: `${reason}: ${entry.title}`, at: entry.updatedAt, read: false }))];
    }
    if (entry.kind === "weekly" && entries.some(e => e.id !== entry.id && e.kind === "weekly" && e.owner === entry.owner && e.date === entry.date)) throw new WorkError("You already have a plan for this week. Edit the existing plan.", 409);
    const updated = old ? entries.map(e => e.id === entry.id ? entry : e) : [entry, ...entries];
    await writeStored(updated, version, bindings);
    return entry;
  });
}

export async function readAttachment(taskId: string, fileId: string) {
  const entry = (await listEntries()).find(item => item.id === taskId && item.kind === "task");
  const attachment = entry?.attachments?.find(item => item.id === fileId);
  if (!attachment || !/^[a-f0-9-]{36}$/.test(attachment.id)) throw new WorkError("File not found.", 404);
  const bindings = await storage();
  if (bindings?.files) {
    const bytes = await bindings.files.get(attachmentKey(attachment.id), "arrayBuffer");
    if (!bytes) throw new WorkError("This file is not available yet. Please try again shortly.", 404);
    return { attachment, bytes: Buffer.from(bytes) };
  }
  return { attachment, bytes: await readFile(path.join(root, "attachments", attachment.id)) };
}
export function markNotificationRead(id: string, username: string) {
  return mutate(async bindings => {
    const { entries, version } = await readStored(bindings);
    let found = false;
    for (const entry of entries) {
      const notifications = entry.notifications || [];
      const target = notifications.findIndex(item => item.id === id && item.recipient === username);
      if (target < 0) continue;
      found = true;
      notifications.forEach((item, index) => { if (index <= target && item.recipient === username) item.read = true; });
    }
    if (!found) throw new WorkError("Notification not found.", 404);
    await writeStored(entries, version, bindings);
  });
}
