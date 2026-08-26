import type { AgentAnswer, ERPProvider, QuotationStatus } from "@/lib/erp";
import type { AgentTrace } from "./trace";

export type DeterministicWorkflowName =
  | "inventory_query"
  | "outstanding_payments"
  | "quotation_summary"
  | "pending_deliveries"
  | "site_visit_summary"
  | "reimbursement_summary"
  | "reports_status";

export type DeterministicWorkflowResult = AgentAnswer & { workflow: DeterministicWorkflowName };

export type DeterministicWorkflowDependencies = {
  fastInventoryAnswer: (message: string) => Promise<AgentAnswer | null>;
  fastPaymentTrackAnswer: (message: string) => Promise<AgentAnswer | null>;
  runAgentTool: (
    provider: ERPProvider,
    call: { name: string; arguments: string },
  ) => Promise<string>;
  listSiteVisits: () => Promise<Array<{ status: string }>>;
  listReimbursements: (options: { includeAll: true }) => Promise<Array<{
    status: string;
    amountCents: number;
  }>>;
  getReportContent: () => Promise<{
    content: string;
    revision: number;
    updatedAt?: string | null;
  }>;
};

const suggestions = [
  "Which stock items need attention?",
  "Show quotations currently being drafted",
  "Show deliveries pending PM review",
  "How much customer payment is outstanding?",
];

function isChinese(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function money(value: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

function answer(workflow: DeterministicWorkflowName, text: string): DeterministicWorkflowResult {
  return { workflow, mode: "local", answer: text, suggestions };
}

function quotationStatus(message: string): QuotationStatus | undefined {
  if (/draft|drafting|草稿|起草/u.test(message)) return "draft";
  if (/accepted|done|完成|接受/u.test(message)) return "accepted";
  if (/rejected|拒绝/u.test(message)) return "rejected";
  return undefined;
}

function hasInventoryIdentifier(message: string): boolean {
  const candidates = message.match(/\b(?=[a-z0-9_-]{2,40}\b)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/giu) || [];
  return candidates.some((candidate) => !/^(?:pay|qtn)[_-]/iu.test(candidate));
}

export async function runDeterministicWorkflow(
  provider: ERPProvider,
  rawMessage: string,
  trace: AgentTrace,
  dependencies: DeterministicWorkflowDependencies,
): Promise<DeterministicWorkflowResult | null> {
  const message = rawMessage.trim().toLocaleLowerCase("en-AU");

  const runInventoryWorkflow = async (): Promise<DeterministicWorkflowResult | null> => {
    trace.selectWorkflow("inventory_query");
    const result = await trace.step("inventory.live_query", "tool", () => dependencies.fastInventoryAnswer(rawMessage));
    return result ? { ...result, workflow: "inventory_query" } : null;
  };

  if (/low[\s-]*stock|out[\s-]*of[\s-]*stock|over[\s-]*stock|(?:inventory|stock|items?).{0,30}(?:need|needs|requiring).{0,10}attention|need(?:s|ing)?\s+attention|inventory\s+(?:overview|summary)|stock\s+(?:overview|summary)|低库存|缺货|积压|补货|需要关注|库存(?:概况|总览)/u.test(message)) {
    return runInventoryWorkflow();
  }

  if (/outstanding|unpaid|amount\s+due|balance\s+due|receivable|尾款|未收(?:款)?|欠款|应收(?:款)?/u.test(message)) {
    trace.selectWorkflow("outstanding_payments");
    const result = await trace.step("project_track.outstanding", "tool", () => dependencies.fastPaymentTrackAnswer(rawMessage));
    return result ? { ...result, workflow: "outstanding_payments" } : null;
  }

  if (/(?:quotation|quote|报价).*(?:count|summary|list|show|draft|done|多少|概况|列出|显示|草稿|完成)|(?:count|summary|list|show|多少|概况|列出|显示).*(?:quotation|quote|报价)/u.test(message)) {
    trace.selectWorkflow("quotation_summary");
    const status = quotationStatus(message);
    const items = await trace.step("quotations.live_query", "tool", () => provider.listQuotations({ status }));
    const active = items.filter((item) => item.status === "draft" || item.status === "sent");
    const shown = items.slice(0, 10);
    const lines = shown.map((item) => `- **${item.number}** · ${item.customer} · ${item.status} · ${money(item.total)}`).join("\n");
    const summary = status
      ? `${items.length} quotation(s) match status **${status}**.`
      : `${items.length} live quotation(s); ${active.length} are active, worth ${money(active.reduce((sum, item) => sum + item.total, 0))}.`;
    return answer("quotation_summary", `${summary}${lines ? `\n\n${lines}` : ""}${items.length > shown.length ? `\n\n${items.length - shown.length} more not shown.` : ""}`);
  }

  if (/(?:deliver|delivery|pm).*(?:pending|review|待审核|待处理)|(?:pending|待审核|待处理).*(?:deliver|delivery|送货)/u.test(message)) {
    trace.selectWorkflow("pending_deliveries");
    const payload = await trace.step("deliveries.pending", "tool", async () => {
      const raw = await dependencies.runAgentTool(provider, {
        name: "search_delivery_orders",
        arguments: JSON.stringify({ query: "", status: "pending", limit: 20, include_contact_details: false }),
      });
      const parsed = JSON.parse(raw) as {
        count?: number;
        orders?: Array<{ customer?: string; items?: unknown[] }>;
        error?: unknown;
      };
      if (parsed.error) throw new Error("Project Management source is unavailable.");
      return parsed;
    });
    const lines = (payload.orders || []).map((item) => `- ${item.customer || "Unnamed customer"}`).join("\n");
    return answer("pending_deliveries", `${payload.count || 0} deliveries are pending PM review.${lines ? `\n\n${lines}` : ""}`);
  }

  if (/(?:site\s*visit|现场勘察|上门勘察).*(?:summary|pending|scheduled|today|概况|待处理|已排期|今天)/u.test(message)) {
    trace.selectWorkflow("site_visit_summary");
    const visits = await trace.step("site_visits.list", "tool", () => dependencies.listSiteVisits());
    const pending = visits.filter((item) => item.status === "pending_approval").length;
    const scheduled = visits.filter((item) => item.status === "scheduled").length;
    const text = isChinese(rawMessage)
      ? `现场勘察共 **${visits.length}** 条：待审批 **${pending}** 条，已排期 **${scheduled}** 条。`
      : `Site Visiting has **${visits.length}** requests: **${pending}** pending approval and **${scheduled}** scheduled.`;
    return answer("site_visit_summary", text);
  }

  if (/(?:reimburse|expense|报销).*(?:summary|pending|payment|概况|待处理|付款)/u.test(message)) {
    trace.selectWorkflow("reimbursement_summary");
    const claims = await trace.step("reimbursements.list", "tool", () => dependencies.listReimbursements({ includeAll: true }));
    const submitted = claims.filter((item) => item.status === "submitted").length;
    const pending = claims.filter((item) => item.status === "pending_payment");
    const pendingTotal = pending.reduce((sum, item) => sum + item.amountCents, 0) / 100;
    return answer("reimbursement_summary", `${claims.length} reimbursement claims: ${submitted} awaiting review and ${pending.length} awaiting payment (${money(pendingTotal)}).`);
  }

  if (/(?:report|needs document|需求文档).*(?:status|summary|updated|状态|概况|更新)/u.test(message)) {
    trace.selectWorkflow("reports_status");
    const report = await trace.step("reports.read_metadata", "tool", () => dependencies.getReportContent());
    return answer("reports_status", report.content.trim()
      ? `The Reports needs document is revision ${report.revision}, contains ${report.content.length.toLocaleString("en-AU")} characters and was updated ${report.updatedAt || "at an unknown time"}.`
      : "The Reports needs document is empty.");
  }

  if (hasInventoryIdentifier(message)) return runInventoryWorkflow();

  return null;
}
