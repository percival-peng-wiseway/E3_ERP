export const REIMBURSEMENT_STATUSES = [
  "submitted",
  "pending_payment",
  "reimbursed",
  "rejected",
] as const;

export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const REIMBURSEMENT_ACTIONS = ["approve", "reject", "mark_paid"] as const;

export type ReimbursementAction = (typeof REIMBURSEMENT_ACTIONS)[number];

export type ReimbursementHistoryAction =
  | "submitted"
  | "approved"
  | "rejected"
  | "marked_paid";

export interface ReimbursementInvoice {
  originalName: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  size: number;
  url: string;
}

export interface ReimbursementHistoryEntry {
  id: string;
  action: ReimbursementHistoryAction;
  at: string;
  actor: "claimant" | "admin";
  note: string | null;
}

export interface ReimbursementClaim {
  id: string;
  reference: string;
  claimantName: string;
  claimantEmail?: string;
  department?: string;
  expenseDate: string;
  category?: string;
  description?: string;
  note: string;
  amountCents: number;
  currency: "AUD";
  invoice: ReimbursementInvoice;
  status: ReimbursementStatus;
  submittedAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  paidBy: string | null;
  paymentReference: string | null;
  history: ReimbursementHistoryEntry[];
}

export interface ReimbursementListResponse {
  data: ReimbursementClaim[];
  meta: {
    admin: boolean;
  };
}

export interface ReimbursementAdminSession {
  admin: boolean;
  configured: boolean;
  demoPassword?: string;
}

export interface ReimbursementMutationResponse {
  data: ReimbursementClaim;
}
