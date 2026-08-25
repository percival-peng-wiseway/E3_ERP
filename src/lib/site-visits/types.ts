export const SITE_VISIT_STATUSES = [
  "pending_approval",
  "approved",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type SiteVisitStatus = (typeof SITE_VISIT_STATUSES)[number];

export type SiteVisitActiveStatus = Exclude<SiteVisitStatus, "cancelled">;
export type SiteVisitCancellableStatus = Exclude<SiteVisitActiveStatus, "completed">;

export const SITE_VISIT_ACTIONS = [
  "update_request",
  "approve",
  "schedule",
  "start",
  "save_visit",
  "complete",
  "reopen",
  "cancel",
  "restore",
] as const;

export type SiteVisitAction = (typeof SITE_VISIT_ACTIONS)[number];

export const SITE_VISIT_CHECK_ANSWERS = [
  "not_checked",
  "yes",
  "no",
  "unknown",
] as const;

export type SiteVisitCheckAnswer = (typeof SITE_VISIT_CHECK_ANSWERS)[number];

export const SITE_VISIT_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type SiteVisitPhotoType = (typeof SITE_VISIT_PHOTO_TYPES)[number];

export interface SiteVisitChecklistItem {
  id: string;
  label: string;
  answer: SiteVisitCheckAnswer;
  notes: string;
}

export interface SiteVisitPhoto {
  id: string;
  originalName: string;
  contentType: SiteVisitPhotoType;
  size: number;
  createdAt: string;
  url: string;
}

export interface SiteVisit {
  id: string;
  projectName: string;
  address: string;
  contact: string;
  reason: string;
  requestedDate: string;
  requestedTime: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  assignee: string;
  status: SiteVisitStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  scheduledAt: string | null;
  scheduledBy: string | null;
  cancelledFrom: SiteVisitCancellableStatus | null;
  checklist: SiteVisitChecklistItem[];
  notes: string;
  photos: SiteVisitPhoto[];
  createdAt: string;
  updatedAt: string;
}

export function isSiteVisitOngoing(visit: Pick<SiteVisit, "status">) {
  return visit.status !== "completed" && visit.status !== "cancelled";
}

export function countOngoingSiteVisits(
  visits: ReadonlyArray<Pick<SiteVisit, "status">>,
) {
  return visits.filter(isSiteVisitOngoing).length;
}

export interface SiteVisitListResponse {
  data: {
    visits: SiteVisit[];
  };
}

export type SiteVisitCreateInput = Pick<
  SiteVisit,
  "projectName" | "address" | "contact" | "reason" | "requestedDate" | "requestedTime"
>;

type VersionedSiteVisitAction = {
  expectedUpdatedAt: string;
};

export type SiteVisitActionInput =
  | (VersionedSiteVisitAction & {
    action: "update_request";
    projectName: string;
    address: string;
    contact: string;
    reason: string;
    requestedDate: string;
    requestedTime: string;
  })
  | (VersionedSiteVisitAction & { action: "approve" })
  | (VersionedSiteVisitAction & {
    action: "schedule";
    scheduledDate: string;
    scheduledTime: string;
    assignee: string;
  })
  | (VersionedSiteVisitAction & { action: "start" })
  | (VersionedSiteVisitAction & {
    action: "save_visit";
    projectName: string;
    address: string;
    contact: string;
    checklist: SiteVisitChecklistItem[];
    notes: string;
  })
  | (VersionedSiteVisitAction & { action: "complete" })
  | (VersionedSiteVisitAction & { action: "reopen" })
  | (VersionedSiteVisitAction & { action: "cancel" })
  | (VersionedSiteVisitAction & { action: "restore" });

export type SiteVisitActor = {
  role: "admin" | "pm" | "sales" | "specialist";
  name: string;
};

export interface SiteVisitPhotoUpload {
  bytes: Uint8Array;
  originalName: string;
  contentType: SiteVisitPhotoType;
  size: number;
}
