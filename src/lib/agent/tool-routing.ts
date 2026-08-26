export type FocusedAgentToolName =
  | "search_inventory"
  | "search_quotations"
  | "search_payment_projects";

function hasInventoryIdentifier(message: string): boolean {
  const candidates = message.match(/\b(?=[a-z0-9_-]{2,40}\b)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/giu) || [];
  return candidates.some((candidate) => !/^(?:pay|qtn)[_-]/iu.test(candidate));
}

/** Return a safe narrow tool set, or null when the model needs the full set. */
export function focusedAgentToolNames(message: string): FocusedAgentToolName[] | null {
  const intent = message.toLocaleLowerCase("en-AU");
  if (/\b(?:deliver(?:y|ies)?|project\s+management|schedule|site\s*visit|reimburse(?:ment)?|expense|report|announcement|notice|group\s+(?:chat|message)|install(?:ation|ing)?)\b|送货|排期|现场勘察|上门勘察|报销|公告|通知|群聊/u.test(intent)) {
    return null;
  }
  const names = new Set<FocusedAgentToolName>();
  if (/\b(?:qtn|quote|quotation)\b|报价/u.test(intent)) names.add("search_quotations");
  if (/\b(?:pay[-_][a-z0-9_-]*\d|payment|receivable|outstanding|unpaid|amount\s+due|balance\s+due|project\s+track)\b|尾款|未收(?:款)?|欠款|应收(?:款)?|项目追踪/u.test(intent)) {
    names.add("search_payment_projects");
  }
  if (/\b(?:inventory|stock|sku)\b|库存|存货/u.test(intent)
    || (!names.size && hasInventoryIdentifier(intent))) {
    names.add("search_inventory");
  }
  return names.size ? [...names] : null;
}
