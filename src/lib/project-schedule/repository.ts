import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
// Focused tests execute source TypeScript directly under Node ESM.
// @ts-expect-error -- explicit extension is required by that runtime.
import * as projectScheduleValidation from "./validation.ts";
import type {
  ProjectScheduleCreateInput,
  ProjectScheduleJob,
  ProjectSchedulePatchInput,
  ProjectScheduleStatus,
} from "./types";

const {
  parseProjectScheduleCreate,
  parseProjectSchedulePatch,
  projectScheduleDate,
  projectScheduleTime,
  projectScheduleTimesAreOrdered,
} = projectScheduleValidation;

export class ProjectScheduleRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ProjectScheduleRepositoryError";
    this.status = status;
    this.code = code;
  }
}

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.PROJECT_SCHEDULE_DATA_DIR || path.join(process.cwd(), ".data", "project-schedule"),
);
const recordsPath = path.join(/* turbopackIgnore: true */ dataRoot, "records.json");
let mutationQueue: Promise<void> = Promise.resolve();
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAXIMUM_RANGE_DAYS = 400;

function withMutation<T>(work: () => Promise<T>) {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
}

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function legacyText(value: unknown, maximum: number) {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE_CONTROLS, "").trim().slice(0, maximum);
}

function normalizeStoredJob(value: unknown, fallbackTimestamp: string, seenIds: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectScheduleRepositoryError("Project Schedule data is invalid.", 500, "invalid_storage");
  }
  const source = value as Record<string, unknown>;
  const title = legacyText(source.title, 160);
  if (!title || !projectScheduleDate(source.scheduledDate)) {
    throw new ProjectScheduleRepositoryError("A stored schedule job is invalid.", 500, "invalid_storage");
  }
  let id = typeof source.id === "string" && ID_PATTERN.test(source.id) && !seenIds.has(source.id)
    ? source.id
    : randomUUID();
  while (seenIds.has(id)) id = randomUUID();
  seenIds.add(id);
  const startTime = source.startTime === null || source.startTime === undefined || source.startTime === ""
    ? null
    : projectScheduleTime(source.startTime) ? source.startTime : null;
  let endTime = source.endTime === null || source.endTime === undefined || source.endTime === ""
    ? null
    : projectScheduleTime(source.endTime) ? source.endTime : null;
  if (!projectScheduleTimesAreOrdered(startTime, endTime)) endTime = null;
  const status: ProjectScheduleStatus = source.status === "completed" ? "completed" : "scheduled";
  const createdAt = exactTimestamp(source.createdAt) ? source.createdAt : fallbackTimestamp;
  const updatedAt = exactTimestamp(source.updatedAt) ? source.updatedAt : createdAt;
  const job: ProjectScheduleJob = {
    id,
    title,
    scheduledDate: source.scheduledDate,
    startTime,
    endTime,
    assignee: legacyText(source.assignee, 120),
    location: legacyText(source.location, 240),
    notes: legacyText(source.notes, 5_000),
    status,
    createdAt,
    updatedAt,
  };
  const changed = JSON.stringify(job) !== JSON.stringify(source);
  return { job, changed };
}

async function readJobs() {
  await ensureStorage();
  try {
    const parsed: unknown = JSON.parse(await readFile(recordsPath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new ProjectScheduleRepositoryError("Project Schedule data is invalid.", 500, "invalid_storage");
    }
    const fallbackTimestamp = new Date().toISOString();
    const seenIds = new Set<string>();
    const normalized = parsed.map((value) => normalizeStoredJob(value, fallbackTimestamp, seenIds));
    return {
      jobs: normalized.map(({ job }) => job),
      changed: normalized.some(({ changed }) => changed),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { jobs: [] as ProjectScheduleJob[], changed: false };
    }
    throw error;
  }
}

async function writeJobs(jobs: ProjectScheduleJob[]) {
  await ensureStorage();
  const temporaryPath = path.join(dataRoot, `.records-${randomUUID()}.tmp`);
  let replaced = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(jobs, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, recordsPath);
    replaced = true;
  } finally {
    if (!replaced) await unlink(temporaryPath).catch(() => undefined);
  }
}

function nextTimestamp(previous: string) {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
}

function scheduleSort(left: ProjectScheduleJob, right: ProjectScheduleJob) {
  return left.scheduledDate.localeCompare(right.scheduledDate)
    || (left.startTime || "99:99").localeCompare(right.startTime || "99:99")
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function listProjectScheduleJobs(from: string, to: string) {
  return withMutation(async () => {
    const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (!projectScheduleDate(from) || !projectScheduleDate(to) || from > to || rangeDays > MAXIMUM_RANGE_DAYS) {
      throw new ProjectScheduleRepositoryError("Choose a valid schedule date range.", 400, "invalid_date_range");
    }
    const stored = await readJobs();
    if (stored.changed) await writeJobs(stored.jobs);
    return stored.jobs
      .filter((job) => job.scheduledDate >= from && job.scheduledDate <= to)
      .sort(scheduleSort);
  });
}

export function createProjectScheduleJob(input: ProjectScheduleCreateInput) {
  return withMutation(async () => {
    const normalized = parseProjectScheduleCreate(input as unknown as Record<string, unknown>);
    if (!normalized) {
      throw new ProjectScheduleRepositoryError("The schedule job is invalid.", 400, "invalid_job");
    }
    const stored = await readJobs();
    const timestamp = new Date().toISOString();
    const job: ProjectScheduleJob = {
      id: randomUUID(),
      ...normalized,
      status: "scheduled",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    stored.jobs.push(job);
    await writeJobs(stored.jobs);
    return job;
  });
}

export function updateProjectScheduleJob(id: string, input: ProjectSchedulePatchInput) {
  return withMutation(async () => {
    const normalized = parseProjectSchedulePatch(input as unknown as Record<string, unknown>);
    if (!normalized) {
      throw new ProjectScheduleRepositoryError("The schedule update is invalid.", 400, "invalid_job");
    }
    const stored = await readJobs();
    const index = stored.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new ProjectScheduleRepositoryError("Schedule job not found.", 404, "not_found");
    const current = stored.jobs[index];
    const updated: ProjectScheduleJob = {
      ...current,
      ...normalized,
      updatedAt: nextTimestamp(current.updatedAt),
    };
    if (!projectScheduleTimesAreOrdered(updated.startTime, updated.endTime)) {
      throw new ProjectScheduleRepositoryError("End time must be later than start time.", 400, "invalid_time_range");
    }
    stored.jobs[index] = updated;
    await writeJobs(stored.jobs);
    return updated;
  });
}

export function deleteProjectScheduleJob(id: string) {
  return withMutation(async () => {
    const stored = await readJobs();
    const index = stored.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new ProjectScheduleRepositoryError("Schedule job not found.", 404, "not_found");
    const [deleted] = stored.jobs.splice(index, 1);
    await writeJobs(stored.jobs);
    return deleted;
  });
}
