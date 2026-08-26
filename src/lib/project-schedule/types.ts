export const PROJECT_SCHEDULE_STATUSES = ["scheduled", "completed"] as const;

export type ProjectScheduleStatus = (typeof PROJECT_SCHEDULE_STATUSES)[number];

export interface ProjectScheduleJob {
  id: string;
  title: string;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  assignee: string;
  location: string;
  notes: string;
  status: ProjectScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

export type ProjectScheduleCreateInput = Pick<
  ProjectScheduleJob,
  "title" | "scheduledDate" | "startTime" | "endTime" | "assignee" | "location" | "notes"
>;

export type ProjectSchedulePatchInput = Partial<Pick<
  ProjectScheduleJob,
  "title" | "scheduledDate" | "startTime" | "endTime" | "assignee" | "location" | "notes" | "status"
>>;

export const PROJECT_SCHEDULE_SOURCE_OVERRIDE_STATES = ["cancelled", "deleted"] as const;
export const PROJECT_SCHEDULE_SOURCE_OVERRIDE_ACTIONS = ["cancel", "restore", "delete"] as const;

export type ProjectScheduleSourceOverrideState = (typeof PROJECT_SCHEDULE_SOURCE_OVERRIDE_STATES)[number];
export type ProjectScheduleSourceOverrideAction = (typeof PROJECT_SCHEDULE_SOURCE_OVERRIDE_ACTIONS)[number];

export interface ProjectScheduleSourceOverride {
  entryId: string;
  state: ProjectScheduleSourceOverrideState;
  updatedAt: string;
  updatedBy: string;
}

export const PROJECT_SCHEDULE_SOURCE_ENTRY_ID_MAX_LENGTH = 512;

const SOURCE_ENTRY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_INVENTORY_SOURCE_ORDER_IDS = 200;

/**
 * Source-derived schedule entries use stable IDs that do not include their
 * mutable status or date. Inventory IDs are sorted and unique so one order
 * group cannot acquire multiple override records through alternate spellings.
 */
export function isProjectScheduleSourceEntryId(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length > PROJECT_SCHEDULE_SOURCE_ENTRY_ID_MAX_LENGTH) {
    return false;
  }

  if (value.startsWith("inventory:orders:")) {
    const encodedIds = value.slice("inventory:orders:".length);
    const parts = encodedIds.split(",");
    if (!parts.length || parts.length > MAXIMUM_INVENTORY_SOURCE_ORDER_IDS) return false;
    let previous = 0;
    for (const part of parts) {
      if (!/^[1-9]\d*$/.test(part)) return false;
      const id = Number(part);
      if (!Number.isSafeInteger(id) || id <= previous) return false;
      previous = id;
    }
    return true;
  }

  for (const prefix of ["payment-delivery:", "payment-installation:"] as const) {
    if (value.startsWith(prefix)) return SOURCE_ENTRY_UUID_PATTERN.test(value.slice(prefix.length));
  }
  if (value.startsWith("site-visit:")) {
    return SOURCE_ENTRY_UUID_PATTERN.test(value.slice("site-visit:".length));
  }
  return false;
}
