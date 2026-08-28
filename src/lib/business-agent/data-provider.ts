import type { ERPProvider } from "../erp/provider";
import type {
  AgentAuthContext, FinanceApplication, FinanceStatus, InventoryRecord, KnowledgeDocument, OrderFinanceDetails, ProjectSnapshot, ToolEnvelope,
} from "./contracts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { FINANCE_STATUSES } from "./contracts.ts";

export interface BusinessDataProvider {
  getInventory(input: { sku: string; warehouse_id?: string }, context: AgentAuthContext): Promise<ToolEnvelope<InventoryRecord[]>>;
  searchKnowledge(input: { query: string; product?: string; region?: string; effective_date?: string; limit: number }, context: AgentAuthContext): Promise<ToolEnvelope<KnowledgeDocument[]>>;
  getProject(input: { project_id: string }, context: AgentAuthContext): Promise<ToolEnvelope<ProjectSnapshot>>;
  getOrderFinance(input: { order_no: string }, context: AgentAuthContext): Promise<ToolEnvelope<OrderFinanceDetails>>;
}

export type KnowledgeSearch = BusinessDataProvider["searchKnowledge"];

function unavailable<T>(source: string): ToolEnvelope<T> {
  return { ok: false, data: null, error_code: "unavailable", source, source_record_ids: [], updated_at: null, retryable: true };
}

function latest(values: Array<string | undefined>) {
  return values.filter(Boolean).sort().at(-1) || null;
}

async function safeJson(response: Response, maxBytes = 512 * 1024): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("oversized_response");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("oversized_response");
  return JSON.parse(text);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function nullableString(value: unknown, max = 500): string | null | undefined {
  return value === null ? null : string(value, max) ?? undefined;
}

function finiteOrNull(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeDocuments(value: unknown): KnowledgeDocument[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const result: KnowledgeDocument[] = [];
  for (const raw of value) {
    const item = object(raw);
    if (!item) return null;
    const document_id = string(item.document_id, 100); const title = string(item.title, 300);
    const version = string(item.version, 80); const access_scope = string(item.access_scope, 80);
    const updated_at = string(item.updated_at, 50); const rawExcerpt = string(item.excerpt, 8_000);
    const excerpt = rawExcerpt === null ? null : rawExcerpt.slice(0, 4_000);
    const product = nullableString(item.product, 100); const region = nullableString(item.region, 80);
    const effective_from = nullableString(item.effective_from, 50); const effective_to = nullableString(item.effective_to, 50);
    const chunk_id = item.chunk_id === undefined ? undefined : string(item.chunk_id, 160);
    const file_id = item.file_id === undefined ? undefined : string(item.file_id, 100);
    const page_number = item.page_number === undefined || item.page_number === null
      ? item.page_number as null | undefined
      : typeof item.page_number === "number" && Number.isSafeInteger(item.page_number) && item.page_number >= 1 && item.page_number <= 100_000
        ? item.page_number
        : undefined;
    const source_path = item.source_path === undefined ? undefined : nullableString(item.source_path, 1_000);
    const heading_path = item.heading_path === undefined ? undefined : Array.isArray(item.heading_path)
      ? item.heading_path.map((entry) => string(entry, 300)).slice(0, 12)
      : undefined;
    if (!document_id || !title || !version || access_scope === null || !updated_at || excerpt === null
      || product === undefined || region === undefined || effective_from === undefined || effective_to === undefined) return null;
    if ((item.chunk_id !== undefined && !chunk_id) || (item.file_id !== undefined && !file_id)
      || (item.page_number !== undefined && item.page_number !== null && page_number === undefined)
      || (item.source_path !== undefined && source_path === undefined)
      || (item.heading_path !== undefined && (!heading_path || heading_path.includes(null)))) return null;
    result.push({
      document_id, title, version, product, region, effective_from, effective_to, updated_at, excerpt,
      access_scope,
      ...(chunk_id ? { chunk_id } : {}), ...(file_id ? { file_id } : {}),
      ...(page_number !== undefined ? { page_number } : {}), ...(source_path !== undefined ? { source_path } : {}),
      ...(heading_path ? { heading_path: heading_path as string[] } : {}),
    });
  }
  return result;
}

function sanitizeProject(value: unknown): ProjectSnapshot | null {
  const item = object(value); if (!item) return null;
  const project_id = string(item.project_id, 100); const name = string(item.name, 300);
  const status = string(item.status, 80); const health_status = string(item.health_status, 80);
  const health_basis = string(item.health_basis, 1_000); const progress_percent = finiteOrNull(item.progress_percent);
  const estimated_completion_date = nullableString(item.estimated_completion_date, 50);
  if (!project_id || !name || !status || !health_status || !health_basis || progress_percent === undefined || estimated_completion_date === undefined) return null;
  if (!Array.isArray(item.milestones) || item.milestones.length > 30 || !Array.isArray(item.risks) || item.risks.length > 20
    || !Array.isArray(item.related_order_nos) || item.related_order_nos.length > 30) return null;
  const milestones = item.milestones.map((raw) => {
    const value = object(raw); const due_date = nullableString(value?.due_date, 50);
    return value && string(value.name, 300) && string(value.status, 80) && due_date !== undefined
      ? { name: string(value.name, 300)!, status: string(value.status, 80)!, due_date } : null;
  });
  const risks = item.risks.map((raw) => {
    const value = object(raw);
    return value && string(value.id, 100) && string(value.severity, 80) && string(value.summary, 1_000)
      ? { id: string(value.id, 100)!, severity: string(value.severity, 80)!, summary: string(value.summary, 1_000)! } : null;
  });
  const orders = item.related_order_nos.map((raw) => string(raw, 100));
  if (milestones.includes(null) || risks.includes(null) || orders.includes(null)) return null;
  let budget_summary: ProjectSnapshot["budget_summary"] = null;
  if (item.budget_summary !== null) {
    const budget = object(item.budget_summary); const approved = finiteOrNull(budget?.approved); const spent = finiteOrNull(budget?.spent);
    if (!budget || !string(budget.currency, 10) || approved === undefined || spent === undefined) return null;
    budget_summary = { currency: string(budget.currency, 10)!, approved, spent };
  }
  return { project_id, name, progress_percent, status, health_status, health_basis, estimated_completion_date,
    milestones: milestones as ProjectSnapshot["milestones"], budget_summary, risks: risks as ProjectSnapshot["risks"], related_order_nos: orders as string[] };
}

function sanitizeFinance(value: unknown): FinanceApplication | null {
  const item = object(value); if (!item) return null;
  const status = string(item.status, 30) as FinanceStatus | null;
  const actually_applied = item.actually_applied === null || typeof item.actually_applied === "boolean" ? item.actually_applied : undefined;
  const possibly_eligible = item.possibly_eligible === null || typeof item.possibly_eligible === "boolean" ? item.possibly_eligible : undefined;
  const eligibility_basis = nullableString(item.eligibility_basis, 1_000);
  return status && FINANCE_STATUSES.includes(status) && actually_applied !== undefined && possibly_eligible !== undefined && eligibility_basis !== undefined
    ? { status, actually_applied, possibly_eligible, eligibility_basis } : null;
}

function sanitizeOrder(value: unknown): OrderFinanceDetails | null {
  const item = object(value); if (!item) return null;
  const order_no = string(item.order_no, 100); const order_status = string(item.order_status, 80);
  const customer_visible_summary = string(item.customer_visible_summary, 2_000); const project_id = nullableString(item.project_id, 100);
  const loan = sanitizeFinance(item.loan); const subsidy = sanitizeFinance(item.subsidy);
  return order_no && order_status && customer_visible_summary !== null && project_id !== undefined && loan && subsidy
    ? { order_no, order_status, customer_visible_summary, project_id, loan, subsidy } : null;
}

function sanitizedEnvelope<T>(value: unknown, sanitize: (data: unknown) => T | null, fallbackSource: string): ToolEnvelope<T> | null {
  const raw = object(value); if (!raw || typeof raw.ok !== "boolean") return null;
  const data = raw.data === null ? null : sanitize(raw.data);
  if (raw.data !== null && data === null) return null;
  const validErrors = new Set([null, "invalid_input", "permission_denied", "not_found", "unknown", "unavailable", "timeout", "incomplete_data"]);
  if (!validErrors.has(raw.error_code as string | null)) return null;
  const ids = Array.isArray(raw.source_record_ids) ? raw.source_record_ids.map((id) => string(id, 100)).slice(0, 50) : [];
  if (ids.includes(null)) return null;
  return {
    ok: raw.ok, data, error_code: raw.error_code as ToolEnvelope<T>["error_code"],
    source: string(raw.source, 100) || fallbackSource, source_record_ids: ids as string[],
    updated_at: nullableString(raw.updated_at, 50) ?? null, retryable: raw.retryable === true,
    ...(raw.incomplete_data === true ? { incomplete_data: true } : {}),
    ...(raw.policy_conflict === true ? { policy_conflict: true } : {}),
  };
}

async function internalGet<T>(baseUrl: string | undefined, path: string, context: AgentAuthContext, sanitize: (data: unknown) => T | null): Promise<ToolEnvelope<T>> {
  if (!baseUrl?.trim()) return unavailable<T>("unconfigured_erp_api");
  const token = process.env.ERP_API_TOKEN?.trim();
  if (!token) return unavailable<T>("unconfigured_erp_api_auth");
  try {
    const url = new URL(path, baseUrl.trim().replace(/\/+$/, "") + "/");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json", Authorization: `Bearer ${token}`,
        "X-ERP-Tenant": context.tenantId, "X-ERP-Role": context.role,
        "X-ERP-Permissions": [...context.permissions].join(","),
      },
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 403) return { ...unavailable<T>(url.origin), error_code: "permission_denied", retryable: false };
    if (response.status === 404) return { ...unavailable<T>(url.origin), error_code: "not_found", retryable: false };
    if (!response.ok) return unavailable<T>(url.origin);
    const payload = sanitizedEnvelope(await safeJson(response), sanitize, url.origin);
    return payload || unavailable<T>(url.origin);
  } catch (error) {
    return { ...unavailable<T>("erp_service_api"), error_code: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "unavailable" };
  }
}

export class LiveBusinessDataProvider implements BusinessDataProvider {
  private readonly erp: ERPProvider;
  private readonly knowledgeSearch?: KnowledgeSearch;

  constructor(erp: ERPProvider, knowledgeSearch?: KnowledgeSearch) {
    this.erp = erp;
    this.knowledgeSearch = knowledgeSearch;
  }

  async getInventory(input: { sku: string; warehouse_id?: string }): Promise<ToolEnvelope<InventoryRecord[]>> {
    try {
      const items = await this.erp.listInventory({ search: input.sku, warehouse: input.warehouse_id, limit: 20 });
      const exact = items.filter((item) => item.sku.toLocaleLowerCase("en-AU") === input.sku.toLocaleLowerCase("en-AU"));
      if (!exact.length) return { ...unavailable<InventoryRecord[]>("inventory_service"), error_code: "not_found", retryable: false };
      return {
        ok: true,
        data: exact.map((item) => ({
          sku: item.sku, product_name: item.name, warehouse_id: item.warehouse, warehouse_name: item.warehouse,
          on_hand: item.onHand, reserved: item.reserved, available: item.available, incoming: null, uom: item.uom,
        })),
        error_code: null,
        source: "inventory_service",
        source_record_ids: exact.map((item) => item.id),
        updated_at: latest(exact.map((item) => item.updatedAt)),
        retryable: false,
        // null means the upstream contract does not expose incoming stock; quantities
        // that are present remain authoritative and are never derived by the Agent.
      };
    } catch {
      return unavailable<InventoryRecord[]>("inventory_service");
    }
  }

  async searchKnowledge(input: { query: string; product?: string; region?: string; effective_date?: string; limit: number }, context: AgentAuthContext) {
    if (this.knowledgeSearch) {
      try {
        const result = sanitizedEnvelope(await this.knowledgeSearch(input, context), sanitizeDocuments, "knowledge_index");
        return result || unavailable<KnowledgeDocument[]>("knowledge_index");
      } catch {
        return unavailable<KnowledgeDocument[]>("knowledge_index");
      }
    }
    const query = new URLSearchParams({ query: input.query, limit: String(input.limit) });
    for (const key of ["product", "region", "effective_date"] as const) if (input[key]) query.set(key, input[key]!);
    return internalGet<KnowledgeDocument[]>(process.env.ERP_KNOWLEDGE_API_URL, `search?${query}`, context, sanitizeDocuments);
  }

  getProject(input: { project_id: string }, context: AgentAuthContext) {
    return internalGet<ProjectSnapshot>(process.env.ERP_PROJECT_API_URL, `projects/${encodeURIComponent(input.project_id)}/snapshot`, context, sanitizeProject);
  }

  getOrderFinance(input: { order_no: string }, context: AgentAuthContext) {
    return internalGet<OrderFinanceDetails>(process.env.ERP_ORDER_API_URL, `orders/${encodeURIComponent(input.order_no)}/finance`, context, sanitizeOrder);
  }
}
