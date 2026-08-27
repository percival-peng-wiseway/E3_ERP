export const PAYMENT_TRACK_STAGES = [
  "deposit_not_paid",
  "material_delivery",
  "installing",
  "waiting_coes",
  "stc_rebate",
  "done",
] as const;

export type PaymentTrackStage = (typeof PAYMENT_TRACK_STAGES)[number];

export const PAYMENT_TRACK_ROLES = ["sales", "specialist", "pm", "admin"] as const;

export type PaymentTrackRole = (typeof PAYMENT_TRACK_ROLES)[number];

export const PAYMENT_TRACK_SCHEDULE_ASSIGNEES = ["Leo", "Daniel"] as const;

export type PaymentTrackScheduleAssignee = (typeof PAYMENT_TRACK_SCHEDULE_ASSIGNEES)[number];

export const PAYMENT_TRACK_ACTIONS = [
  "acknowledge_deposit",
  "confirm_deposit",
  "prepare_delivery",
  "pre_schedule_delivery",
  "schedule_delivery",
  "mark_delivered",
  "acknowledge_collection",
  "confirm_collection",
  "pre_schedule_installation",
  "schedule_installation",
  "acknowledge_payment",
  "confirm_final_payment",
  "mark_installed",
  "mark_coes_received",
  "continue_to_stc",
  "confirm_stc_solar",
  "confirm_stc_battery",
  "confirm_solar_rebate",
  "skip_stage",
  "update_pm_notes",
] as const;

export type PaymentTrackAction = (typeof PAYMENT_TRACK_ACTIONS)[number];

export const PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH = 500;

export type PaymentTrackFileKind =
  | "contract"
  | "deposit_proof"
  | "collection_proof"
  | "final_payment_proof";

export type PaymentTrackUploadContentType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface PaymentTrackFile {
  id: string;
  kind: PaymentTrackFileKind;
  originalName: string;
  contentType: PaymentTrackUploadContentType;
  size: number;
  url: string;
  uploadedAt: string;
  uploadedByRole: PaymentTrackRole;
}

export interface PaymentTrackCustomer {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  addressLine1: string;
  suburb: string;
  state: string;
  postcode: string;
}

export interface PaymentTrackSpecialist {
  name: string;
  phone: string;
}

export interface PaymentTrackItem {
  id: string;
  category: string;
  description: string;
  model: string;
  quantity: number;
  capacity: string;
}

export interface PaymentTrackDeliverySelection {
  sku: string;
  quantity: number;
}

export interface PaymentTrackScheduleRequest {
  preferredDate: string;
  preferredTime: string;
  notes: string;
  submittedAt: string;
  submittedBy: string;
}

export interface PaymentTrackReceipt {
  proof: PaymentTrackFile | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  confirmedAmountCents: number | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

export interface PaymentTrackFinalPayment extends PaymentTrackReceipt {
  id: string;
  createdAt: string;
}

export type PaymentTrackHistoryAction =
  | "created_manually"
  | "contract_imported"
  | "deposit_proof_uploaded"
  | "deposit_acknowledged"
  | "deposit_confirmed"
  | "delivery_items_prepared"
  | "delivery_pre_scheduled"
  | "delivery_scheduled"
  | "marked_delivered"
  | "collection_acknowledged"
  | "collection_proof_uploaded"
  | "collection_confirmed"
  | "installation_pre_scheduled"
  | "installation_scheduled"
  | "payment_acknowledged"
  | "final_payment_proof_uploaded"
  | "final_payment_confirmed"
  | "marked_installed"
  | "coes_received"
  | "continued_to_stc"
  | "stc_solar_confirmed"
  | "stc_battery_confirmed"
  | "solar_rebate_requirement_backfilled"
  | "solar_rebate_confirmed"
  | "stage_skipped"
  | "pm_notes_updated"
  | "completed";

export interface PaymentTrackHistoryEntry {
  id: string;
  action: PaymentTrackHistoryAction;
  at: string;
  actorRole: PaymentTrackRole;
  actorName: string;
  note: string | null;
}

export interface PaymentTrackProject {
  id: string;
  reference: string;
  quoteNumber: string;
  specialist: PaymentTrackSpecialist;
  customer: PaymentTrackCustomer;
  items: PaymentTrackItem[];
  currency: "AUD";
  balanceDueCents: number;
  outstandingCents: number;
  overpaymentCents: number;
  expectedDepositCents: number | null;
  stage: PaymentTrackStage;
  contract: PaymentTrackFile | null;
  deposit: PaymentTrackReceipt;
  deliverySelections: PaymentTrackDeliverySelection[];
  deliveryPreparedAt: string | null;
  deliveryPreparedBy: string | null;
  deliveryScheduleRequest: PaymentTrackScheduleRequest | null;
  deliveryScheduledFor: string | null;
  deliveryScheduledTime: string | null;
  deliveryAssignee: PaymentTrackScheduleAssignee | null;
  deliveredAt: string | null;
  collection: PaymentTrackReceipt;
  installationScheduleRequest: PaymentTrackScheduleRequest | null;
  installationScheduledFor: string | null;
  installationScheduledTime: string | null;
  installationAssignee: PaymentTrackScheduleAssignee | null;
  finalPayments: PaymentTrackFinalPayment[];
  installedAt: string | null;
  coesReceivedAt: string | null;
  stcSolarRequired: boolean;
  stcBatteryRequired: boolean;
  solarRebateRequired: boolean;
  stcSolarReceivedAt: string | null;
  stcBatteryReceivedAt: string | null;
  solarRebateReceivedAt: string | null;
  pmNotes: string;
  pmNotesUpdatedAt: string | null;
  pmNotesUpdatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  history: PaymentTrackHistoryEntry[];
}

export function isPaymentTrackProjectActive(
  project: Pick<PaymentTrackProject, "stage" | "outstandingCents">,
) {
  return project.stage !== "done" || project.outstandingCents > 0;
}

export function countActivePaymentTrackProjects(
  projects: ReadonlyArray<Pick<PaymentTrackProject, "stage" | "outstandingCents">>,
) {
  return projects.filter(isPaymentTrackProjectActive).length;
}

const FINAL_PAYMENT_OVERDUE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export function isFinalPaymentOverdue(
  project: Pick<PaymentTrackProject, "installedAt" | "outstandingCents">,
  now = Date.now(),
) {
  if (!project.installedAt || project.outstandingCents <= 0) return false;

  const installedAt = Date.parse(project.installedAt);
  return Number.isFinite(installedAt) && now - installedAt >= FINAL_PAYMENT_OVERDUE_AFTER_MS;
}

export interface PaymentTrackUpdatedEventDetail {
  activeProjectCount?: number;
  source?: string;
}

export interface PaymentTrackListResponse {
  data: PaymentTrackProject[];
  meta: {
    admin: boolean;
    configured: boolean;
    demoPassword?: string;
  };
}

export interface PaymentTrackMutationResponse {
  data: PaymentTrackProject;
}

export interface PaymentTrackAdminSession {
  admin: boolean;
  configured: boolean;
  demoPassword?: string;
}

export interface PaymentTrackAdminSessionResponse {
  data: PaymentTrackAdminSession;
}

export type PaymentTrackManualCreateRequest = {
  actorRole: "sales";
  quoteNumber: string;
  specialist: PaymentTrackSpecialist;
  customer: PaymentTrackCustomer;
  items: Array<Omit<PaymentTrackItem, "id">>;
  balanceDue: string;
  expectedDeposit: string | null;
  stcSolarRequired: boolean;
  stcBatteryRequired: boolean;
  solarRebateRequired?: boolean;
};

export type PaymentTrackActionRequest = {
  actorRole: PaymentTrackRole;
  action: PaymentTrackAction;
  amount?: string;
  paymentId?: string;
  preferredDate?: string;
  preferredTime?: string;
  deliveryDate?: string;
  deliveryTime?: string;
  deliveryAssignee?: PaymentTrackScheduleAssignee;
  deliverySelections?: PaymentTrackDeliverySelection[];
  selections?: PaymentTrackDeliverySelection[];
  expectedUpdatedAt?: string;
  installationDate?: string;
  installationTime?: string;
  installationAssignee?: PaymentTrackScheduleAssignee;
  actorName?: string;
  notes?: string;
  expectedPmNotesUpdatedAt?: string | null;
};

export type PaymentTrackPmNotesActionRequest = {
  action: "update_pm_notes";
  actorRole: "pm";
  actorName?: string;
  notes: string;
  expectedPmNotesUpdatedAt: string | null;
};
