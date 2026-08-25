import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as cloudflareStorage from "../server/cloudflare-storage.ts";
// Focused tests execute source TypeScript directly under Node ESM.
// @ts-expect-error -- explicit extension is required by that runtime.
import * as projectScheduleValidation from "./validation.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as projectScheduleTypes from "./types.ts";
import type {
  ProjectScheduleCreateInput,
  ProjectScheduleJob,
  ProjectSchedulePatchInput,
  ProjectScheduleSourceOverride,
  ProjectScheduleSourceOverrideAction,
  ProjectScheduleStatus,
} from "./types";

const {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
} = cloudflareStorage;

const {
  parseProjectScheduleCreate,
  parseProjectSchedulePatch,
  projectScheduleDate,
  projectScheduleTime,
  projectScheduleTimesAreOrdered,
} = projectScheduleValidation;

const {
  isProjectScheduleSourceEntryId,
  PROJECT_SCHEDULE_SOURCE_OVERRIDE_ACTIONS,
  PROJECT_SCHEDULE_SOURCE_OVERRIDE_STATES,
} = projectScheduleTypes;

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
const sourceOverridesPath = path.join(/* turbopackIgnore: true */ dataRoot, "source-overrides.json");
const CLOUDFLARE_DOCUMENT_KEY = "project-schedule/records";
const SOURCE_OVERRIDES_CLOUDFLARE_DOCUMENT_KEY = "project-schedule/source-overrides";
const MAXIMUM_STORAGE_RETRIES = 5;
let mutationQueue: Promise<void> = Promise.resolve();
let sourceOverrideMutationQueue: Promise<void> = Promise.resolve();
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HAS_UNSAFE_ACTOR_CONTROLS = /[\u0000-\u001F\u007F]/;
const MAXIMUM_RANGE_DAYS = 400;
const MAXIMUM_SOURCE_OVERRIDES = 2_000;
const MAXIMUM_OVERRIDE_ACTOR_LENGTH = 120;
const MAXIMUM_SOURCE_OVERRIDE_BYTES = 1_800_000;

function withMutation<T>(work: () => Promise<T>) {
  const retryingWork = async () => {
    for (let attempt = 0; attempt < MAXIMUM_STORAGE_RETRIES; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof CloudflareDocumentConflictError)) throw error;
      }
    }
    throw new ProjectScheduleRepositoryError(
      "Project Schedule changed while this request was being saved. Try again.",
      409,
      "storage_conflict",
    );
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function withSourceOverrideMutation<T>(work: () => Promise<T>) {
  const retryingWork = async () => {
    for (let attempt = 0; attempt < MAXIMUM_STORAGE_RETRIES; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof CloudflareDocumentConflictError)) throw error;
      }
    }
    throw new ProjectScheduleRepositoryError(
      "Weekly Schedule overrides changed while this request was being saved. Try again.",
      409,
      "storage_conflict",
    );
  };
  const result = sourceOverrideMutationQueue.then(retryingWork, retryingWork);
  sourceOverrideMutationQueue = result.then(() => undefined, () => undefined);
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

function normalizedJobs(parsed: unknown, version: number | null) {
  if (!Array.isArray(parsed)) {
    throw new ProjectScheduleRepositoryError("Project Schedule data is invalid.", 500, "invalid_storage");
  }
  const fallbackTimestamp = new Date().toISOString();
  const seenIds = new Set<string>();
  const normalized = parsed.map((value) => normalizeStoredJob(value, fallbackTimestamp, seenIds));
  return {
    jobs: normalized.map(({ job }) => job),
    changed: normalized.some(({ changed }) => changed),
    version,
  };
}

function invalidSourceOverrideStorage(message = "Weekly Schedule source override data is invalid."): never {
  throw new ProjectScheduleRepositoryError(message, 500, "invalid_storage");
}

function strictStoredActor(value: unknown) {
  if (typeof value !== "string"
    || !value.length
    || value !== value.trim()
    || value.length > MAXIMUM_OVERRIDE_ACTOR_LENGTH
    || HAS_UNSAFE_ACTOR_CONTROLS.test(value)) return null;
  return value;
}

function normalizedSourceOverrides(parsed: unknown, version: number | null) {
  if (!Array.isArray(parsed) || parsed.length > MAXIMUM_SOURCE_OVERRIDES) invalidSourceOverrideStorage();
  const seenEntryIds = new Set<string>();
  const overrides = parsed.map((value): ProjectScheduleSourceOverride => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidSourceOverrideStorage();
    const source = value as Record<string, unknown>;
    const fields = Object.keys(source).sort();
    if (fields.length !== 4
      || fields[0] !== "entryId"
      || fields[1] !== "state"
      || fields[2] !== "updatedAt"
      || fields[3] !== "updatedBy"
      || !isProjectScheduleSourceEntryId(source.entryId)
      || seenEntryIds.has(source.entryId)
      || typeof source.state !== "string"
      || !PROJECT_SCHEDULE_SOURCE_OVERRIDE_STATES.includes(source.state as ProjectScheduleSourceOverride["state"])
      || !exactTimestamp(source.updatedAt)) invalidSourceOverrideStorage();
    const updatedBy = strictStoredActor(source.updatedBy);
    if (!updatedBy) invalidSourceOverrideStorage();
    seenEntryIds.add(source.entryId);
    return {
      entryId: source.entryId,
      state: source.state as ProjectScheduleSourceOverride["state"],
      updatedAt: source.updatedAt,
      updatedBy,
    };
  });
  return { overrides, version };
}

async function readJobs() {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    return normalizedJobs(document.value ?? [], document.version);
  }

  await ensureStorage();
  try {
    return normalizedJobs(JSON.parse(await readFile(recordsPath, "utf8")), null);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { jobs: [] as ProjectScheduleJob[], changed: false, version: null };
    }
    throw error;
  }
}

async function readSourceOverrides() {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    try {
      const document = await readVersionedDocument<unknown>(
        bindings.database,
        SOURCE_OVERRIDES_CLOUDFLARE_DOCUMENT_KEY,
      );
      const value = document.version === 0 && document.value === null ? [] : document.value;
      return normalizedSourceOverrides(value, document.version);
    } catch (error) {
      if (error instanceof SyntaxError) invalidSourceOverrideStorage();
      throw error;
    }
  }

  await ensureStorage();
  try {
    return normalizedSourceOverrides(JSON.parse(await readFile(sourceOverridesPath, "utf8")), null);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { overrides: [] as ProjectScheduleSourceOverride[], version: null };
    }
    if (error instanceof SyntaxError) invalidSourceOverrideStorage();
    throw error;
  }
}

async function writeJobs(jobs: ProjectScheduleJob[], expectedVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(bindings.database, CLOUDFLARE_DOCUMENT_KEY, jobs, expectedVersion);
    return;
  }

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

async function writeSourceOverrides(overrides: ProjectScheduleSourceOverride[], expectedVersion: number | null) {
  if (new TextEncoder().encode(JSON.stringify(overrides)).byteLength > MAXIMUM_SOURCE_OVERRIDE_BYTES) {
    throw new ProjectScheduleRepositoryError(
      "Weekly Schedule has reached the source override storage limit.",
      409,
      "override_limit_reached",
    );
  }
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(
      bindings.database,
      SOURCE_OVERRIDES_CLOUDFLARE_DOCUMENT_KEY,
      overrides,
      expectedVersion,
    );
    return;
  }

  await ensureStorage();
  const temporaryPath = path.join(dataRoot, `.source-overrides-${randomUUID()}.tmp`);
  let replaced = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, sourceOverridesPath);
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
    if (stored.changed) await writeJobs(stored.jobs, stored.version);
    return stored.jobs
      .filter((job) => job.scheduledDate >= from && job.scheduledDate <= to)
      .sort(scheduleSort);
  });
}

export async function listProjectScheduleSourceOverrides() {
  const stored = await readSourceOverrides();
  return [...stored.overrides].sort((left, right) => left.entryId.localeCompare(right.entryId));
}

export function applyProjectScheduleSourceOverride(
  entryId: string,
  action: ProjectScheduleSourceOverrideAction,
  updatedBy: string,
) {
  return withSourceOverrideMutation(async () => {
    if (!isProjectScheduleSourceEntryId(entryId)) {
      throw new ProjectScheduleRepositoryError("The Weekly Schedule source entry ID is invalid.", 400, "invalid_entry_id");
    }
    if (!PROJECT_SCHEDULE_SOURCE_OVERRIDE_ACTIONS.includes(action)) {
      throw new ProjectScheduleRepositoryError("The Weekly Schedule override action is invalid.", 400, "invalid_action");
    }
    const actor = strictStoredActor(updatedBy);
    if (!actor) {
      throw new ProjectScheduleRepositoryError("The Weekly Schedule override actor is invalid.", 400, "invalid_actor");
    }

    const stored = await readSourceOverrides();
    const index = stored.overrides.findIndex((override) => override.entryId === entryId);
    const current = index < 0 ? null : stored.overrides[index];

    if (action === "restore") {
      if (!current) {
        throw new ProjectScheduleRepositoryError("Weekly Schedule source override not found.", 404, "not_found");
      }
      if (current.state === "deleted") {
        throw new ProjectScheduleRepositoryError("A deleted Weekly Schedule source entry cannot be restored.", 409, "deleted_entry");
      }
      stored.overrides.splice(index, 1);
      await writeSourceOverrides(stored.overrides, stored.version);
      return null;
    }

    if (action === "cancel" && current?.state === "deleted") {
      throw new ProjectScheduleRepositoryError("A deleted Weekly Schedule source entry cannot be cancelled.", 409, "deleted_entry");
    }
    if (!current && stored.overrides.length >= MAXIMUM_SOURCE_OVERRIDES) {
      throw new ProjectScheduleRepositoryError(
        "Weekly Schedule has reached the source override limit.",
        409,
        "override_limit_reached",
      );
    }

    const override: ProjectScheduleSourceOverride = {
      entryId,
      state: action === "delete" ? "deleted" : "cancelled",
      updatedAt: current ? nextTimestamp(current.updatedAt) : new Date().toISOString(),
      updatedBy: actor,
    };
    if (index < 0) stored.overrides.push(override);
    else stored.overrides[index] = override;
    stored.overrides.sort((left, right) => left.entryId.localeCompare(right.entryId));
    await writeSourceOverrides(stored.overrides, stored.version);
    return override;
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
    await writeJobs(stored.jobs, stored.version);
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
    await writeJobs(stored.jobs, stored.version);
    return updated;
  });
}

export function deleteProjectScheduleJob(id: string) {
  return withMutation(async () => {
    const stored = await readJobs();
    const index = stored.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new ProjectScheduleRepositoryError("Schedule job not found.", 404, "not_found");
    const [deleted] = stored.jobs.splice(index, 1);
    await writeJobs(stored.jobs, stored.version);
    return deleted;
  });
}
