import {
  SITE_VISIT_CHECK_ANSWERS,
  SITE_VISIT_STATUSES,
  type SiteVisitChecklistItem,
  type SiteVisitCheckAnswer,
  type SiteVisitCreateInput,
  type SiteVisitPatchInput,
  type SiteVisitStatus,
} from "./types";

export const SITE_VISIT_BUILT_IN_CHECKS = [
  { id: "roof_tiles_attention", label: "Roof tiles need attention" },
  { id: "switchboard_replacement", label: "Switchboard needs replacement" },
] as const;

const CREATE_FIELDS = new Set([
  "projectName",
  "address",
  "contact",
  "scheduledDate",
  "scheduledTime",
  "assignee",
  "notes",
]);
const PATCH_FIELDS = new Set([...CREATE_FIELDS, "status", "checklist"]);
const CHECKLIST_FIELDS = new Set(["id", "label", "answer", "notes"]);
const CHECK_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function onlyFields(body: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(body).every((field) => allowed.has(field));
}

function text(value: unknown, maximum: number, required: boolean) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum || UNSAFE_CONTROLS.test(normalized)) return null;
  return normalized;
}

export function siteVisitDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function siteVisitTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function initialSiteVisitChecklist(): SiteVisitChecklistItem[] {
  return SITE_VISIT_BUILT_IN_CHECKS.map((item) => ({
    ...item,
    answer: "not_checked",
    notes: "",
  }));
}

export function parseSiteVisitChecklist(value: unknown): SiteVisitChecklistItem[] | null {
  if (!Array.isArray(value) || value.length < SITE_VISIT_BUILT_IN_CHECKS.length || value.length > 40) return null;

  const ids = new Set<string>();
  const checklist: SiteVisitChecklistItem[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const source = candidate as Record<string, unknown>;
    if (!onlyFields(source, CHECKLIST_FIELDS)) return null;
    const id = text(source.id, 64, true);
    const label = text(source.label, 160, true);
    const notes = text(source.notes ?? "", 2_000, false);
    if (!id || !CHECK_ID_PATTERN.test(id) || ids.has(id) || !label || notes === null) return null;
    if (typeof source.answer !== "string"
      || !SITE_VISIT_CHECK_ANSWERS.includes(source.answer as SiteVisitCheckAnswer)) return null;
    ids.add(id);
    checklist.push({ id, label, answer: source.answer as SiteVisitCheckAnswer, notes });
  }

  if (SITE_VISIT_BUILT_IN_CHECKS.some(({ id }) => !ids.has(id))) return null;
  return checklist;
}

export function parseSiteVisitCreate(body: Record<string, unknown>): SiteVisitCreateInput | null {
  if (!onlyFields(body, CREATE_FIELDS)) return null;
  const projectName = text(body.projectName, 160, true);
  const address = text(body.address, 300, true);
  const contact = text(body.contact ?? "", 240, false);
  const assignee = text(body.assignee ?? "", 120, false);
  const notes = text(body.notes ?? "", 10_000, false);
  if (!projectName || !address || contact === null || assignee === null || notes === null
    || !siteVisitDate(body.scheduledDate) || !siteVisitTime(body.scheduledTime)) return null;
  return {
    projectName,
    address,
    contact,
    scheduledDate: body.scheduledDate,
    scheduledTime: body.scheduledTime,
    assignee,
    notes,
  };
}

export function parseSiteVisitPatch(body: Record<string, unknown>): SiteVisitPatchInput | null {
  const fields = Object.keys(body);
  if (!fields.length || !onlyFields(body, PATCH_FIELDS)) return null;

  const patch: SiteVisitPatchInput = {};
  for (const [field, maximum, required] of [
    ["projectName", 160, true],
    ["address", 300, true],
    ["contact", 240, false],
    ["assignee", 120, false],
    ["notes", 10_000, false],
  ] as const) {
    if (!(field in body)) continue;
    const value = text(body[field], maximum, required);
    if (value === null || (required && !value)) return null;
    patch[field] = value;
  }
  if ("scheduledDate" in body) {
    if (!siteVisitDate(body.scheduledDate)) return null;
    patch.scheduledDate = body.scheduledDate;
  }
  if ("scheduledTime" in body) {
    if (!siteVisitTime(body.scheduledTime)) return null;
    patch.scheduledTime = body.scheduledTime;
  }
  if ("status" in body) {
    if (typeof body.status !== "string" || !SITE_VISIT_STATUSES.includes(body.status as SiteVisitStatus)) return null;
    patch.status = body.status as SiteVisitStatus;
  }
  if ("checklist" in body) {
    const checklist = parseSiteVisitChecklist(body.checklist);
    if (!checklist) return null;
    patch.checklist = checklist;
  }
  return patch;
}
