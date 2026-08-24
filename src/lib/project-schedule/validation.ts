// Focused tests execute source TypeScript directly under Node ESM.
// @ts-expect-error -- explicit extension is required by that runtime.
import { PROJECT_SCHEDULE_STATUSES } from "./types.ts";
import type {
  ProjectScheduleCreateInput,
  ProjectSchedulePatchInput,
  ProjectScheduleStatus,
} from "./types";

const CREATE_FIELDS = new Set([
  "title",
  "scheduledDate",
  "startTime",
  "endTime",
  "assignee",
  "location",
  "notes",
]);
const PATCH_FIELDS = new Set([...CREATE_FIELDS, "status"]);
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function projectScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function projectScheduleTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function projectScheduleTimesAreOrdered(startTime: string | null, endTime: string | null) {
  if (endTime && !startTime) return false;
  return !startTime || !endTime || startTime < endTime;
}

function text(value: unknown, maximum: number, required: boolean) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum || UNSAFE_CONTROLS.test(normalized)) return null;
  return normalized;
}

function optionalTime(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return projectScheduleTime(value) ? value : undefined;
}

function onlyFields(body: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(body).every((field) => allowed.has(field));
}

export function parseProjectScheduleCreate(body: Record<string, unknown>): ProjectScheduleCreateInput | null {
  if (!onlyFields(body, CREATE_FIELDS)) return null;
  const title = text(body.title, 160, true);
  if (!title || !projectScheduleDate(body.scheduledDate)) return null;
  const startTime = optionalTime(body.startTime);
  const endTime = optionalTime(body.endTime);
  if (startTime === undefined || endTime === undefined || !projectScheduleTimesAreOrdered(startTime, endTime)) return null;
  const assignee = text(body.assignee ?? "", 120, false);
  const location = text(body.location ?? "", 240, false);
  const notes = text(body.notes ?? "", 5_000, false);
  if (assignee === null || location === null || notes === null) return null;
  return { title, scheduledDate: body.scheduledDate, startTime, endTime, assignee, location, notes };
}

export function parseProjectSchedulePatch(body: Record<string, unknown>): ProjectSchedulePatchInput | null {
  const fields = Object.keys(body);
  if (!fields.length || !onlyFields(body, PATCH_FIELDS)) return null;
  const patch: ProjectSchedulePatchInput = {};
  if ("title" in body) {
    const title = text(body.title, 160, true);
    if (!title) return null;
    patch.title = title;
  }
  if ("scheduledDate" in body) {
    if (!projectScheduleDate(body.scheduledDate)) return null;
    patch.scheduledDate = body.scheduledDate;
  }
  for (const field of ["startTime", "endTime"] as const) {
    if (!(field in body)) continue;
    const value = optionalTime(body[field]);
    if (value === undefined) return null;
    patch[field] = value;
  }
  for (const [field, maximum] of [
    ["assignee", 120],
    ["location", 240],
    ["notes", 5_000],
  ] as const) {
    if (!(field in body)) continue;
    const value = text(body[field], maximum, false);
    if (value === null) return null;
    patch[field] = value;
  }
  if ("status" in body) {
    if (typeof body.status !== "string"
      || !PROJECT_SCHEDULE_STATUSES.includes(body.status as ProjectScheduleStatus)) return null;
    patch.status = body.status as ProjectScheduleStatus;
  }
  return patch;
}
