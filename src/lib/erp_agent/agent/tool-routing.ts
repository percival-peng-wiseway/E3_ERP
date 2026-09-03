// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { inventorySkuCandidates, isBareInventorySkuLookup, isInventoryStockIntent, isInventoryUsageIntent } from "./inventory-usage.ts";

export type FocusedAgentToolName =
  | "get_workspace_overview"
  | "search_inventory"
  | "search_inventory_usage"
  | "search_product_activity"
  | "search_knowledge_base"
  | "search_quotations"
  | "search_delivery_orders"
  | "search_payment_projects"
  | "search_weekly_schedule"
  | "search_site_visits"
  | "search_reimbursements"
  | "read_reports_notes"
  | "search_announcements"
  | "search_group_messages";

function hasInventoryIdentifier(message: string): boolean {
  return inventorySkuCandidates(message).length > 0;
}

export function isKnowledgeIntent(message: string): boolean {
  return /\b(?:policy|policies|procedure|procedures|process|manual|handbook|guide|guidance|knowledge\s*base|documentation|document|documented|warranty|warranties|specification|troubleshoot(?:ing)?|faq|internal\s+knowledge|kb[-_][a-z0-9_-]+|e\d{3,4})\b|\b(?:acceptance\s+tolerance|export\s+(?:acceptance|test))\b|政策|流程|程序|手册|指南|知识库|文档|文件规定|保修|质保|规范|故障排查|内部知识/iu.test(message);
}

export function isKnowledgeConversationIntent(message: string, recentHistory: readonly string[] = []): boolean {
  if (isKnowledgeIntent(message)) return true;
  const followUp = /^\s*(?:(?:and|also|then|so|what about|how about|why|how|when|where|which|can (?:i|we)|does that|is that)\b|(?:那|那么|还有|然后|为什么|怎么|何时|哪里|这个|它|第二次))/iu.test(message);
  return followUp && recentHistory.slice(-2).some(isKnowledgeIntent);
}

/**
 * Recognises a bounded week plus a request for facts about that period.
 * Keep this separate from generic words such as "completed" or "status" so
 * ordinary Project Track questions are not redirected to Weekly Schedule.
 */
export function isWeeklyPeriodFactIntent(message: string): boolean {
  const intent = message.normalize("NFKC").toLocaleLowerCase("en-AU");
  const english = /\b(?:(?:this|current|next|last)\s+week(?:'s)?\s+(?:(?:work|activity)\s+)?(?:summary|overview|status|situation|progress|completed?\s+(?:work|jobs?|tasks?))|(?:completed?\s+(?:work|jobs?|tasks?)|(?:work|activity)\s+(?:summary|overview|status|situation|progress)|summary|overview|status|situation|progress)\s+(?:for\s+)?(?:this|current|next|last)\s+week|what\s+did\s+(?:we|the\s+team)\s+(?:complete|finish|do)\s+(?:this|current|next|last)\s+week|how\s+many\s+(?:jobs?|tasks?|orders?|work\s+items?)\s+(?:did\s+(?:we|the\s+team)\s+)?(?:complete|finish)\s+(?:this|current|next|last)\s+week)\b/u;
  const chinese = /(?:本周|下周|上周)(?:的)?(?:(?:工作|任务|业务)(?:的)?)?(?:情况|汇总|总结|概况|状态|进展|完成情况)|(?:本周|下周|上周)(?:的)?(?:已)?完成(?:的)?(?:工作|任务|情况)?|(?:本周|下周|上周)(?:的)?(?:一共|总共)?有?(?:多少|几)(?:个|条|单|项)?|(?:本周|下周|上周)(?:的)?(?:都|一共|总共)?(?:做|完成)了?(?:什么|哪些)|(?:本周|下周|上周)(?:的)?有?哪些(?:客户|项目)(?:完成|做)了?/u;
  return english.test(intent) || chinese.test(intent);
}

export function shouldUseKnowledgeConversationIntent(
  message: string,
  recentHistory: readonly string[] = [],
  context: {
    hasImages?: boolean;
    hasAttachedKnowledgeDocuments?: boolean;
  } = {},
) {
  if (/\breports?\s+needs\s+document\b|报告需求文档|需求文档状态/iu.test(message)) return false;
  const hasSku = inventorySkuCandidates(message).length > 0;
  if (hasSku && (isInventoryUsageIntent(message) || isInventoryStockIntent(message))) return false;
  if (context.hasImages && !context.hasAttachedKnowledgeDocuments) {
    const explicitlyRequestsInternalKnowledge = /\b(?:knowledge\s*base|internal|company|corporate|our)\s+(?:policy|procedure|process|manual|handbook|guide|documentation|document|warranty|specification)\b|\b(?:search|check|query|look\s+up)\s+(?:the\s+)?(?:knowledge\s*base|internal\s+(?:policy|manual|documentation))\b|知识库|(?:内部|公司)(?:政策|流程|程序|手册|指南|文档|规定|保修|质保|规范)|(?:查询|搜索|查找)(?:知识库|内部资料)/iu.test(message);
    if (!explicitlyRequestsInternalKnowledge) {
      // A screenshot, scan or photo can itself contain words such as
      // "document", "manual" or "warranty". In that case Kimi should inspect
      // the visible image instead of forcing an unrelated company-KB search.
      return false;
    }
  }
  return isKnowledgeConversationIntent(message, recentHistory);
}

/** Return a safe narrow tool set, or null when the model needs the full set. */
export function focusedAgentToolNames(message: string): FocusedAgentToolName[] | null {
  const intent = message.toLocaleLowerCase("en-AU");
  if (/\b(?:reimburse(?:ment)?|expense)\b|报销|费用/u.test(intent)) return ["search_reimbursements"];
  if (/\b(?:report|reports|needs\s+document)\b|报告|需求文档/u.test(intent)) return ["read_reports_notes"];
  if (/\b(?:announcements?|notices?)\b|公告|通知/u.test(intent)) return ["search_announcements"];
  if (/\bgroup\s+(?:chat|message|discussion)\b|群聊|群消息/u.test(intent)) return ["search_group_messages"];
  if (/\bworkspace\s+(?:overview|summary)\b|工作区(?:总览|概况)/u.test(intent)) return ["get_workspace_overview"];
  if (isKnowledgeIntent(intent)) return ["search_knowledge_base"];
  if (isInventoryUsageIntent(intent) && hasInventoryIdentifier(intent)) {
    const usageTools: FocusedAgentToolName[] = ["search_inventory_usage"];
    if (isInventoryStockIntent(intent)) {
      usageTools.unshift("search_inventory");
    }
    return usageTools;
  }
  const productActivity = /\b(?:sold|sell|sales\s+(?:volume|quantity|count)|units?\s+sold|product\s+activity)\b|卖了|销售(?:量|数量)?|销量|售出|出货量/iu.test(intent);
  if (productActivity) return ["search_product_activity"];
  if (isInventoryStockIntent(intent) && hasInventoryIdentifier(intent)) return ["search_inventory"];
  const siteVisitIntent = /\bsite\s*visit(?:ing|s)?\b|现场勘察|上门勘察/iu.test(intent);
  const nonSiteBusinessIntent = /\b(?:inventory|stock|sku|qtn|quote|quotation|payment|receivable|outstanding|unpaid|amount\s+due|balance\s+due|deliver(?:y|ies|ed)?|install(?:ation|ations|ment|ments|ing|ed)?|project\s+track|reimburse(?:ment)?|expense)\b|库存|存货|报价|尾款|未收(?:款)?|欠款|应收(?:款)?|送货|配送|安装|项目追踪|报销/u.test(intent);
  if (siteVisitIntent && !nonSiteBusinessIntent) return ["search_site_visits"];
  if (siteVisitIntent) return null;
  const legacyProjectManagement = /\bproject\s+management\b|\bdeliveries?\s+(?:pending|waiting)\s+(?:for\s+)?pm\s+review\b|\bpending\s+pm\s+deliveries?\b|待\s*pm\s*审核.{0,8}送货/u.test(intent);
  const datedSchedule = /\b(?:weekly\s+schedule|today|tomorrow|this\s+week|next\s+week|last\s+week|schedul(?:e|ed|ing)|unscheduled|overdue)\b|周排程|周计划|今天|明天|本周|下周|上周|排期|逾期/u.test(intent);
  if (legacyProjectManagement && !datedSchedule) return ["search_delivery_orders"];
  const weeklyIntent = isWeeklyPeriodFactIntent(intent)
    || /\b(?:weekly\s+schedule|deliver(?:y|ies|ed)?|(?:pre[\s_-]*)?schedul(?:e|ed|ing)|unscheduled|overdue|install(?:ation|ations|ment|ments|ing|ed)?)\b|周排程|周计划|送货|排期|安装|逾期/u.test(intent);
  const inventoryDataIntent = /\b(?:inventory|stock|sku)\b|库存|存货|仓库/u.test(intent);
  const inventoryDeliveryIntent = /\b(?:inventory|stock|warehouse)\s+(?:material\s+)?deliver(?:y|ies|ed)?\b|(?:库存|存货|仓库).{0,4}(?:送货|配送|送达)/u.test(intent);
  const otherDataIntent = /\b(?:qtn|quote|quotation|payment|receivable|outstanding|unpaid|amount\s+due|balance\s+due|reimburse(?:ment)?|expense)\b|报价|尾款|未收(?:款)?|欠款|应收(?:款)?|收款|付款|回款|报销|费用/u.test(intent);
  if (weeklyIntent && !otherDataIntent && (!inventoryDataIntent || inventoryDeliveryIntent)) {
    return ["search_weekly_schedule"];
  }
  if (weeklyIntent) return null;
  const names = new Set<FocusedAgentToolName>();
  if (/\b(?:qtn|quote|quotation)\b|报价/u.test(intent)) names.add("search_quotations");
  if (/\b(?:pay[-_][a-z0-9_-]*\d|cpec[-_]?\d+|payment|receivable|outstanding|unpaid|amount\s+due|balance\s+due|project\s+track)\b|尾款|未收(?:款)?|欠款|应收(?:款)?|收款|付款|回款|项目追踪/u.test(intent)) {
    names.add("search_payment_projects");
  }
  if (/\b(?:inventory|stock|sku)\b|库存|存货/u.test(intent)
    || (!names.size && isBareInventorySkuLookup(message))) {
    names.add("search_inventory");
  }
  return names.size ? [...names] : null;
}
