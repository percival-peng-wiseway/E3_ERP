export type AgentDomain = "inventory" | "knowledge" | "project" | "order" | "finance" | "subsidy";

const DOMAIN_PATTERNS: Array<[AgentDomain, RegExp]> = [
  ["inventory", /\b(?:sku|stock|inventory|warehouse|on.hand|reserved|available|incoming)\b|库存|仓库|现货/iu],
  ["knowledge", /\b(?:policy|procedure|process|knowledge|faq|document|documentation|manual|handbook|guide|guidance|warranty|specification|troubleshoot|eligib)\w*\b|\b(?:kb[-_][a-z0-9_-]+|e\d{3,4}|acceptance\s+tolerance|export\s+(?:acceptance|test))\b|政策|流程|程序|知识库|文档|手册|指南|保修|质保|规范|故障排查|资格/iu],
  ["project", /\b(?:project|milestone|completion|budget|risk|progress)\b|项目|里程碑|预算|风险|进度/iu],
  ["order", /\b(?:order|sales order)\b|订单/iu],
  ["finance", /\b(?:loan|finance|financing)\b|贷款|融资/iu],
  ["subsidy", /\b(?:subsidy|rebate|grant|stc)\b|补贴|返利/iu],
];

export type RouteDecision = {
  modelClass: "flash" | "pro";
  requiredDomains: AgentDomain[];
  reason: string;
};

export function routeMessage(message: string): RouteDecision {
  const requiredDomains = DOMAIN_PATTERNS.filter(([, pattern]) => pattern.test(message)).map(([domain]) => domain);
  const specificFinanceJudgement = /\b(?:customer|client|order|project)\b.*\b(?:eligib|qualif|loan|subsidy|rebate)\w*\b|(?:客户|订单|项目).*(?:资格|贷款|补贴)/iu.test(message);
  if (requiredDomains.length >= 2) {
    return { modelClass: "pro", requiredDomains, reason: "required_domains_gte_2" };
  }
  if (specificFinanceJudgement) {
    return { modelClass: "pro", requiredDomains, reason: "customer_finance_eligibility" };
  }
  return { modelClass: "flash", requiredDomains, reason: "single_domain_or_simple" };
}

export function requiredIdentifierClarification(message: string, domains: readonly AgentDomain[]): string | null {
  if (domains.includes("inventory") && !domains.includes("knowledge") && !/\b[A-Z0-9][A-Z0-9._-]{2,}\b/u.test(message)) {
    return "请提供要查询的 SKU（如有需要也请提供仓库）。";
  }
  if (domains.includes("project") && !domains.includes("knowledge") && !/(?:\b(?:PRJ|PROJ|PROJECT)[_-][A-Z0-9-]{2,}\b|\b(?:PRJ|PROJ)\d{2,}\b)/iu.test(message)) {
    return "请提供项目编号。";
  }
  if ((domains.includes("order") || domains.includes("finance") || domains.includes("subsidy"))
    && !/(?:\b(?:SO|ORD|ORDER)[_-][A-Z0-9-]{2,}\b|\b(?:SO|ORD)\d{2,}\b)/iu.test(message)) {
    return "请提供订单号。";
  }
  return null;
}
