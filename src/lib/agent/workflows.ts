import type { AgentAnswer, ERPProvider, QuotationStatus } from "@/lib/erp";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { hasInventoryUsageReference, inventorySkuCandidates, isBareInventorySkuLookup, isInventoryStockIntent, isInventoryUsageIntent } from "./inventory-usage.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { isRebateReceiptAmountIntent } from "./rebate-receipts.ts";
import type { AgentTrace } from "./trace";

export type DeterministicWorkflowName =
  | "greeting"
  | "workspace_overview"
  | "inventory_query"
  | "outstanding_payments"
  | "project_track_query"
  | "weekly_schedule_query"
  | "quotation_summary"
  | "pending_deliveries"
  | "site_visit_summary"
  | "reimbursement_summary"
  | "reports_status";

export type DeterministicWorkflowResult = AgentAnswer & { workflow: DeterministicWorkflowName };

export type DeterministicWorkflowDependencies = {
  fastWorkspaceOverviewAnswer: (provider: ERPProvider, message: string) => Promise<AgentAnswer | null>;
  fastInventoryAnswer: (message: string) => Promise<AgentAnswer | null>;
  fastPaymentTrackAnswer: (message: string) => Promise<AgentAnswer | null>;
  fastWeeklyScheduleAnswer: (provider: ERPProvider, message: string) => Promise<AgentAnswer | null>;
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
  "Show unscheduled Weekly Schedule work",
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

function greetingAnswer(rawMessage: string): DeterministicWorkflowResult | null {
  const message = rawMessage.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  const trailingPunctuation = String.raw`[\s,.!?，。！？…~～]*`;
  const englishGreeting = new RegExp(`^(?:hi|hello)${trailingPunctuation}$`, "u");
  const chineseGreeting = new RegExp(`^(?:你好|嗨)${trailingPunctuation}$`, "u");
  if (chineseGreeting.test(message)) {
    return {
      workflow: "greeting",
      mode: "local",
      answer: "你好！想查看 E3 ERP 里的什么内容？",
      suggestions: ["查看工作区总览", "哪些库存需要关注？", "显示未排期的 Weekly Schedule 任务"],
    };
  }
  if (!englishGreeting.test(message)) return null;
  return {
    workflow: "greeting",
    mode: "local",
    answer: "Hi! What would you like to check in E3 ERP?",
    suggestions: ["Give me a workspace overview", "Which stock items need attention?", "Show unscheduled Weekly Schedule work"],
  };
}

function hasWorkspaceOverviewIntent(rawMessage: string) {
  const message = rawMessage.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  return /^(?:(?:give|show)\s+me\s+|show\s+)?(?:a\s+|the\s+)?workspace\s+(?:overview|summary)[\s,.!?，。！？…~～]*$/u.test(message)
    || /^(?:给我|显示|查看)?(?:工作区|业务)(?:总览|概况)[\s,.!?，。！？…~～]*$/u.test(message);
}

function quotationStatus(message: string): QuotationStatus | undefined {
  if (/draft|drafting|草稿|起草/u.test(message)) return "draft";
  if (/accepted|done|完成|接受/u.test(message)) return "accepted";
  if (/rejected|拒绝/u.test(message)) return "rejected";
  return undefined;
}

function hasInventoryIdentifier(message: string): boolean {
  return inventorySkuCandidates(message).length > 0;
}

function hasProjectTrackIntent(message: string): boolean {
  return isRebateReceiptAmountIntent(message)
    || /\b(?:project\s*track(?:ing)?|working\s+in\s+progress|wip|waiting\s+coes|stc\s+rebate|pay[-_][a-z0-9_-]*\d|cpec[-_]?\d+)\b|项目(?:追踪|跟踪|进度)|项目看板/u.test(message)
    || /(?:show|list|find|search|get|what|which|how\s+many|give\s+me|查看|显示|列出|查找).{0,24}(?:projects?|项目)/u.test(message);
}

function hasWeeklyScheduleIntent(message: string): boolean {
  const explicitlyWeekly = /\bweekly\s+schedule\b|\b(?:this|current|next|last)\s+week(?:'s)?\s+(?:schedule|jobs?|work|deliveries|installations|site\s*visits?)\b|\b(?:deliveries|installations|site\s*visits?|completed\s+jobs?|delivered|installed)\s+(?:this|next|last)\s+week\b|\b(?:today|tomorrow)(?:'s)?\s+(?:schedule|jobs?|deliveries|installations|site\s*visits?)\b|周排程|周计划|(?:本周|下周|上周)(?:安排|排期|日程|送货|安装|任务|完成)/u.test(message);
  if (explicitlyWeekly) return true;
  const projectScheduleWithDate = hasProjectTrackIntent(message)
    && /\b(?:today|tomorrow|this\s+week|current\s+week|next\s+week|last\s+week|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b|今天|明天|本周|下周|上周/u.test(message)
    && /\b(?:schedule|scheduled|delivery|deliveries|delivered|installation|installations|installed|work|jobs?)\b|排期|安排|送货|安装|任务/u.test(message);
  if (projectScheduleWithDate) return true;
  if (hasProjectTrackIntent(message)) return false;
  return /\b(?:schedule|scheduled|unscheduled|pre[\s_-]*scheduled|overdue)\b|(?:今天|明天).{0,12}(?:安排|排期|送货|安装|任务)|未排期|预排期|待排期|逾期/u.test(message);
}

export async function runDeterministicWorkflow(
  provider: ERPProvider,
  rawMessage: string,
  trace: AgentTrace,
  dependencies: DeterministicWorkflowDependencies,
): Promise<DeterministicWorkflowResult | null> {
  const message = rawMessage.trim().toLocaleLowerCase("en-AU");

  const greeting = greetingAnswer(rawMessage);
  if (greeting) {
    trace.selectWorkflow("greeting");
    return greeting;
  }

  if (hasWorkspaceOverviewIntent(rawMessage)) {
    trace.selectWorkflow("workspace_overview");
    const workspaceOverview = await trace.step("workspace.overview", "tool", () => (
      dependencies.fastWorkspaceOverviewAnswer(provider, rawMessage)
    ));
    return workspaceOverview ? { ...workspaceOverview, workflow: "workspace_overview" } : null;
  }

  const runInventoryWorkflow = async (stepName = "inventory.live_query"): Promise<DeterministicWorkflowResult | null> => {
    trace.selectWorkflow("inventory_query");
    const result = await trace.step(stepName, "tool", () => dependencies.fastInventoryAnswer(rawMessage));
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

  if (isInventoryUsageIntent(message) && hasInventoryUsageReference(message)) {
    return runInventoryWorkflow("inventory.usage_query");
  }

  if (isInventoryStockIntent(message) && hasInventoryIdentifier(message)) {
    return runInventoryWorkflow();
  }

  if (hasWeeklyScheduleIntent(message)) {
    trace.selectWorkflow("weekly_schedule_query");
    const result = await trace.step("weekly_schedule.live_query", "tool", () => (
      dependencies.fastWeeklyScheduleAnswer(provider, rawMessage)
    ));
    return result ? { ...result, workflow: "weekly_schedule_query" } : null;
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

  if (hasProjectTrackIntent(message)) {
    trace.selectWorkflow("project_track_query");
    const result = await trace.step("project_track.live_query", "tool", () => dependencies.fastPaymentTrackAnswer(rawMessage));
    return result ? { ...result, workflow: "project_track_query" } : null;
  }

  if (isBareInventorySkuLookup(rawMessage)) return runInventoryWorkflow();

  return null;
}
