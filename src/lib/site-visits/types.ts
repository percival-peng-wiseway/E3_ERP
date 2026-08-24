export const SITE_VISIT_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type SiteVisitStatus = (typeof SITE_VISIT_STATUSES)[number];

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
  scheduledDate: string;
  scheduledTime: string;
  assignee: string;
  status: SiteVisitStatus;
  checklist: SiteVisitChecklistItem[];
  notes: string;
  photos: SiteVisitPhoto[];
  createdAt: string;
  updatedAt: string;
}

export type SiteVisitCreateInput = Pick<
  SiteVisit,
  "projectName" | "address" | "contact" | "scheduledDate" | "scheduledTime" | "assignee" | "notes"
>;

export type SiteVisitPatchInput = Partial<Pick<
  SiteVisit,
  | "projectName"
  | "address"
  | "contact"
  | "scheduledDate"
  | "scheduledTime"
  | "assignee"
  | "status"
  | "checklist"
  | "notes"
>>;

export interface SiteVisitPhotoUpload {
  bytes: Uint8Array;
  originalName: string;
  contentType: SiteVisitPhotoType;
  size: number;
}
