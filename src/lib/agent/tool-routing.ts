// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { inventorySkuCandidates, isBareInventorySkuLookup, isInventoryStockIntent, isInventoryUsageIntent } from "./inventory-usage.ts";

export type FocusedAgentToolName =
  | "search_inventory"
  | "search_inventory_usage"
  | "search_knowledge_base"
  | "search_quotations"
  | "search_delivery_orders"
  | "search_payment_projects"
  | "search_weekly_schedule";

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

export function shouldUseKnowledgeConversationIntent(
  message: string,
  recentHistory: readonly string[] = [],
) {
  const hasSku = inventorySkuCandidates(message).length > 0;
  if (hasSku && (isInventoryUsageIntent(message) || isInventoryStockIntent(message))) return false;
  return isKnowledgeConversationIntent(message, recentHistory);
}

/** Return a safe narrow tool set, or null when the model needs the full set. */
export function focusedAgentToolNames(message: string): FocusedAgentToolName[] | null {
  const intent = message.toLocaleLowerCase("en-AU");
  if (isKnowledgeIntent(intent)) return ["search_knowledge_base"];
  if (/\b(?:reimburse(?:ment)?|expense|report|announcement|notice|group\s+(?:chat|message))\b|报销|公告|通知|群聊/u.test(intent)) {
    return null;
  }
  if (isInventoryUsageIntent(intent) && hasInventoryIdentifier(intent)) {
    const usageTools: FocusedAgentToolName[] = ["search_inventory_usage"];
    if (isInventoryStockIntent(intent)) {
      usageTools.unshift("search_inventory");
    }
    return usageTools;
  }
  if (isInventoryStockIntent(intent) && hasInventoryIdentifier(intent)) return ["search_inventory"];
  const legacyProjectManagement = /\bproject\s+management\b|\bdeliveries?\s+(?:pending|waiting)\s+(?:for\s+)?pm\s+review\b|\bpending\s+pm\s+deliveries?\b|待\s*pm\s*审核.{0,8}送货/u.test(intent);
  const datedSchedule = /\b(?:weekly\s+schedule|today|tomorrow|this\s+week|next\s+week|last\s+week|schedul(?:e|ed|ing)|unscheduled|overdue)\b|周排程|周计划|今天|明天|本周|下周|上周|排期|逾期/u.test(intent);
  if (legacyProjectManagement && !datedSchedule) return ["search_delivery_orders"];
  const weeklyIntent = /\b(?:weekly\s+schedule|deliver(?:y|ies|ed)?|(?:pre[\s_-]*)?schedul(?:e|ed|ing)|unscheduled|overdue|install(?:ation|ations|ment|ments|ing|ed)?)\b|周排程|周计划|送货|排期|安装|逾期/u.test(intent);
  const unrelatedDataIntent = /\b(?:inventory|stock|sku|qtn|quote|quotation|payment|receivable|outstanding|unpaid|amount\s+due|balance\s+due)\b|库存|存货|报价|尾款|未收(?:款)?|欠款|应收(?:款)?/u.test(intent);
  if (weeklyIntent && !unrelatedDataIntent) return ["search_weekly_schedule"];
  if (weeklyIntent) return null;
  const names = new Set<FocusedAgentToolName>();
  if (/\b(?:qtn|quote|quotation)\b|报价/u.test(intent)) names.add("search_quotations");
  if (/\b(?:pay[-_][a-z0-9_-]*\d|cpec[-_]?\d+|payment|receivable|outstanding|unpaid|amount\s+due|balance\s+due|project\s+track)\b|尾款|未收(?:款)?|欠款|应收(?:款)?|项目追踪/u.test(intent)) {
    names.add("search_payment_projects");
  }
  if (/\b(?:inventory|stock|sku)\b|库存|存货/u.test(intent)
    || (!names.size && isBareInventorySkuLookup(message))) {
    names.add("search_inventory");
  }
  return names.size ? [...names] : null;
}
