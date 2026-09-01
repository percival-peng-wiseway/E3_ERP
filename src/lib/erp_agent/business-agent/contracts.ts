export const FINANCE_STATUSES = [
  "not_applicable", "not_started", "draft", "submitted", "under_review",
  "approved", "rejected", "cancelled", "unknown",
] as const;

export type FinanceStatus = (typeof FINANCE_STATUSES)[number];
export type AgentPermission =
  | "inventory.read" | "knowledge.read" | "project.read" | "order.read"
  | "finance.read" | "subsidy.read";

export type AgentAuthContext = {
  principalHash: string;
  tenantId: string;
  role: string;
  permissions: ReadonlySet<AgentPermission>;
};

export type ToolErrorCode =
  | "invalid_input" | "permission_denied" | "not_found" | "unknown"
  | "unavailable" | "timeout" | "incomplete_data";

export type ToolEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error_code: ToolErrorCode | null;
  source: string;
  source_record_ids: string[];
  updated_at: string | null;
  retryable: boolean;
  incomplete_data?: boolean;
  policy_conflict?: boolean;
};

export type InventoryRecord = {
  sku: string;
  product_name: string;
  warehouse_id: string;
  warehouse_name: string;
  on_hand: number;
  reserved: number;
  available: number;
  incoming: number | null;
  uom: string;
};

export type KnowledgeDocument = {
  document_id: string;
  chunk_id?: string;
  file_id?: string;
  title: string;
  version: string;
  product: string | null;
  region: string | null;
  effective_from: string | null;
  effective_to: string | null;
  access_scope: string;
  page_number?: number | null;
  source_path?: string | null;
  heading_path?: string[];
  updated_at: string;
  excerpt: string;
};

export type ProjectSnapshot = {
  project_id: string;
  name: string;
  progress_percent: number | null;
  status: string;
  health_status: string;
  health_basis: string;
  estimated_completion_date: string | null;
  milestones: Array<{ name: string; status: string; due_date: string | null }>;
  budget_summary: { currency: string; approved: number | null; spent: number | null } | null;
  risks: Array<{ id: string; severity: string; summary: string }>;
  related_order_nos: string[];
};

export type FinanceApplication = {
  actually_applied: boolean | null;
  status: FinanceStatus;
  possibly_eligible: boolean | null;
  eligibility_basis: string | null;
};

export type OrderFinanceDetails = {
  order_no: string;
  order_status: string;
  customer_visible_summary: string;
  project_id: string | null;
  loan: FinanceApplication;
  subsidy: FinanceApplication;
};

export type Citation = {
  document_id: string;
  chunk_id?: string;
  file_id?: string;
  title: string;
  version: string;
  effective_from: string | null;
  source: string;
  page_number?: number | null;
  source_path?: string | null;
  heading_path?: string[];
  updated_at?: string;
};

export type AgentChatResponse = {
  answer: string;
  citations: Citation[];
  model_used: string;
  route: "flash" | "pro" | "clarification" | "unavailable";
  tool_calls_summary: Array<{ name: string; status: string; cached: boolean }>;
  request_id: string;
  data_updated_at: string | null;
  limitations: string[];
};
