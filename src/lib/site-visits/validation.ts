// Focused tests execute source TypeScript directly under Node ESM.
// @ts-expect-error -- explicit extension is required by that runtime.
import { SITE_VISIT_ACTIONS, SITE_VISIT_CHECK_ANSWERS } from "./types.ts";
import type {
  SiteVisitAction,
  SiteVisitActionInput,
  SiteVisitChecklistItem,
  SiteVisitCheckAnswer,
  SiteVisitCreateInput,
} from "./types";

export const SITE_VISIT_BUILT_IN_CHECKS = [
  { id: "roof_tiles_attention", label: "Roof tiles need attention" },
  { id: "switchboard_replacement", label: "Switchboard needs replacement" },
  { id: "ac_cable_run_under_20m", label: "AC Cable Run <20m" },
  { id: "roof_material", label: "Roof Material" },
  { id: "bat_location", label: "BAT Location" },
  { id: "fire_cement_sheet", label: "Fire Cement Sheet" },
  { id: "sub_switchboard", label: "Sub-Switchboard" },
  { id: "switch_upgrade", label: "Switch Upgrade" },
  { id: "backup_circuit", label: "Backup Circuit" },
  { id: "concrete_slab", label: "Concrete Slab" },
] as const;

const LEGACY_REQUIRED_CHECK_IDS = new Set([
  "roof_tiles_attention",
  "switchboard_replacement",
]);
const BUILT_IN_CHECK_IDS = new Set<string>(SITE_VISIT_BUILT_IN_CHECKS.map(({ id }) => id));
const MAX_SITE_VISIT_CUSTOM_CHECKS = 38;
export const MAX_SITE_VISIT_CHECKS = SITE_VISIT_BUILT_IN_CHECKS.length + MAX_SITE_VISIT_CUSTOM_CHECKS;

const CREATE_FIELDS = new Set([
  "projectName",
  "address",
  "contact",
  "reason",
  "requestedDate",
  "requestedTime",
]);
const ACTION_FIELDS: Record<SiteVisitAction, ReadonlySet<string>> = {
  update_request: new Set(["action", "expectedUpdatedAt", ...CREATE_FIELDS]),
  approve: new Set(["action", "expectedUpdatedAt"]),
  schedule: new Set(["action", "expectedUpdatedAt", "scheduledDate", "scheduledTime", "assignee"]),
  start: new Set(["action", "expectedUpdatedAt"]),
  save_visit: new Set([
    "action",
    "expectedUpdatedAt",
    "projectName",
    "address",
    "contact",
    "checklist",
    "notes",
  ]),
  complete: new Set(["action", "expectedUpdatedAt"]),
  reopen: new Set(["action", "expectedUpdatedAt"]),
  cancel: new Set(["action", "expectedUpdatedAt"]),
  restore: new Set(["action", "expectedUpdatedAt"]),
};
const CHECKLIST_FIELDS = new Set(["id", "label", "answer", "notes"]);
const CHECK_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function onlyFields(body: Record<string, unknown>, allowed: ReadonlySet<string>) {
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

export function siteVisitTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function initialSiteVisitChecklist(): SiteVisitChecklistItem[] {
  return SITE_VISIT_BUILT_IN_CHECKS.map((item) => ({
    ...item,
    answer: "not_checked",
    notes: "",
  }));
}

function parseChecklistItems(value: unknown): SiteVisitChecklistItem[] | null {
  if (!Array.isArray(value)
    || value.length < LEGACY_REQUIRED_CHECK_IDS.size
    || value.length > MAX_SITE_VISIT_CHECKS) return null;
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
  return checklist;
}

function normalizedChecklist(checklist: SiteVisitChecklistItem[]) {
  const existingById = new Map(checklist.map((item) => [item.id, item]));
  const normalized = [
    ...SITE_VISIT_BUILT_IN_CHECKS.map((definition) => {
      const existing = existingById.get(definition.id);
      return existing
        ? { ...existing, label: definition.label }
        : { ...definition, answer: "not_checked" as const, notes: "" };
    }),
    ...checklist.filter(({ id }) => !BUILT_IN_CHECK_IDS.has(id)),
  ];
  return normalized.length <= MAX_SITE_VISIT_CHECKS ? normalized : null;
}

export function parseSiteVisitChecklist(value: unknown): SiteVisitChecklistItem[] | null {
  const checklist = parseChecklistItems(value);
  if (!checklist) return null;
  const ids = new Set(checklist.map(({ id }) => id));
  if (SITE_VISIT_BUILT_IN_CHECKS.some(({ id }) => !ids.has(id))) return null;
  return normalizedChecklist(checklist);
}

export function normalizeStoredSiteVisitChecklist(value: unknown): SiteVisitChecklistItem[] | null {
  const checklist = parseChecklistItems(value);
  if (!checklist) return null;
  const ids = new Set(checklist.map(({ id }) => id));
  if ([...LEGACY_REQUIRED_CHECK_IDS].some((id) => !ids.has(id))) return null;
  return normalizedChecklist(checklist);
}

export function parseSiteVisitCreate(body: Record<string, unknown>): SiteVisitCreateInput | null {
  if (!onlyFields(body, CREATE_FIELDS)) return null;
  const projectName = text(body.projectName, 160, true);
  const address = text(body.address, 300, true);
  const contact = text(body.contact, 240, true);
  const reason = text(body.reason, 2_000, true);
  if (!projectName || !address || !contact || !reason
    || !siteVisitDate(body.requestedDate) || !siteVisitTime(body.requestedTime)) return null;
  return {
    projectName,
    address,
    contact,
    reason,
    requestedDate: body.requestedDate,
    requestedTime: body.requestedTime,
  };
}

function requestFields(body: Record<string, unknown>) {
  const projectName = text(body.projectName, 160, true);
  const address = text(body.address, 300, true);
  const contact = text(body.contact, 240, true);
  const reason = text(body.reason, 2_000, true);
  if (!projectName || !address || !contact || !reason
    || !siteVisitDate(body.requestedDate) || !siteVisitTime(body.requestedTime)) return null;
  return {
    projectName,
    address,
    contact,
    reason,
    requestedDate: body.requestedDate,
    requestedTime: body.requestedTime,
  };
}

export function parseSiteVisitAction(body: Record<string, unknown>): SiteVisitActionInput | null {
  const action = typeof body.action === "string"
    && SITE_VISIT_ACTIONS.includes(body.action as SiteVisitAction)
    ? body.action as SiteVisitAction
    : null;
  if (!action || !onlyFields(body, ACTION_FIELDS[action]) || !siteVisitTimestamp(body.expectedUpdatedAt)) return null;
  const version = { expectedUpdatedAt: body.expectedUpdatedAt };

  if (action === "update_request") {
    const fields = requestFields(body);
    return fields ? { action, ...version, ...fields } : null;
  }
  if (action === "schedule") {
    const assignee = text(body.assignee, 120, true);
    if (!assignee || !siteVisitDate(body.scheduledDate) || !siteVisitTime(body.scheduledTime)) return null;
    return {
      action,
      ...version,
      scheduledDate: body.scheduledDate,
      scheduledTime: body.scheduledTime,
      assignee,
    };
  }
  if (action === "save_visit") {
    const projectName = text(body.projectName, 160, true);
    const address = text(body.address, 300, true);
    // Legacy scheduled records may not have a contact. New requests still
    // require one, but an old record must remain saveable on site.
    const contact = text(body.contact, 240, false);
    const checklist = parseSiteVisitChecklist(body.checklist);
    const notes = text(body.notes, 10_000, false);
    if (!projectName || !address || contact === null || !checklist || notes === null) return null;
    return { action, ...version, projectName, address, contact, checklist, notes };
  }
  return { action, ...version } as SiteVisitActionInput;
}
