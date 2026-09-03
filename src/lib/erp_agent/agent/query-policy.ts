import type { AgentQueryPlan, JsonValue } from "./query-plan";
import type { BusinessSkillId } from "./skills";
import type { AgentToolName, AgentToolsetId } from "./tool-registry";

/**
 * Server-owned policy layered on top of the model-produced query plan.
 *
 * The patterns intentionally recognise explicit ERP domains rather than trying
 * to reproduce the model's full semantic planning. A missed policy hint lets
 * the validated model plan proceed; a matched hint can only require additional
 * evidence, never grant a capability.
 */

export type AgentQueryPolicyInput = {
  /** The current user turn or the resolved managed-Skill prompt, never history. */
  latestMessage: string;
  knowledgeRequired?: boolean;
  managedSkill?: {
    id: string;
    source: "built_in" | "custom";
    capabilityIds: readonly BusinessSkillId[];
  } | null;
};

export type AgentQueryPolicyRequirements = {
  requiredToolNames: readonly AgentToolName[];
  /** Custom Skill capabilities require coverage, not every tool in a toolset. */
  requiredToolsets: readonly AgentToolsetId[];
  /** High-confidence semantic slots that a model plan is not allowed to omit. */
  argumentRequirements?: {
    searchPaymentProjects?: {
      salesRepresentative?: string;
      createdFrom?: string;
      createdTo?: string;
    };
    searchWeeklySchedule?: {
      from: string;
      to: string;
    };
  };
};

export type AgentQueryPlanDimensions = {
  hasSalesFilter: boolean;
  hasCreatedRange: boolean;
};

export type AgentQueryPlanCoverage = {
  ok: boolean;
  requiredToolNames: readonly AgentToolName[];
  plannedToolNames: readonly AgentToolName[];
  missingToolNames: readonly AgentToolName[];
  requiredToolsets: readonly AgentToolsetId[];
  plannedToolsets: readonly AgentToolsetId[];
  missingToolsets: readonly AgentToolsetId[];
  invalidRequiredToolNames: readonly string[];
  invalidRequiredToolsets: readonly string[];
  missingArgumentRequirements?: readonly string[];
};

export type AgentPrivacyConsent = {
  customerNames: boolean;
  assignees: boolean;
  cancelledRecords: boolean;
  contactDetails: boolean;
  locations: boolean;
  notes: boolean;
};

const REGISTERED_TOOL_NAMES = [
  "get_workspace_overview",
  "search_knowledge_base",
  "search_inventory",
  "search_inventory_usage",
  "search_product_activity",
  "search_quotations",
  "search_delivery_orders",
  "search_payment_projects",
  "search_weekly_schedule",
  "search_site_visits",
  "search_project_schedule",
  "search_reimbursements",
  "read_reports_notes",
  "search_announcements",
  "search_group_messages",
] as const satisfies readonly AgentToolName[];

const REGISTERED_TOOL_NAME_SET = new Set<string>(REGISTERED_TOOL_NAMES);

const TOOLSET_BY_TOOL = {
  get_workspace_overview: "workspace",
  search_knowledge_base: "knowledge",
  search_inventory: "inventory",
  search_inventory_usage: "inventory",
  search_product_activity: "inventory",
  search_quotations: "quotations",
  search_delivery_orders: "project_management",
  search_payment_projects: "project_track",
  search_weekly_schedule: "weekly_schedule",
  search_site_visits: "site_visits",
  search_project_schedule: "weekly_schedule",
  search_reimbursements: "reimbursements",
  read_reports_notes: "reports",
  search_announcements: "communications",
  search_group_messages: "communications",
} as const satisfies Record<AgentToolName, AgentToolsetId>;

const AGENT_TOOLSET_IDS = [
  "workspace",
  "knowledge",
  "inventory",
  "quotations",
  "project_management",
  "project_track",
  "weekly_schedule",
  "site_visits",
  "reimbursements",
  "reports",
  "communications",
] as const satisfies readonly AgentToolsetId[];
const AGENT_TOOLSET_ID_SET = new Set<string>(AGENT_TOOLSET_IDS);

const BUILT_IN_WEEKLY_SUMMARY_TOOLS = [
  "search_weekly_schedule",
  "search_inventory",
  "search_payment_projects",
] as const satisfies readonly AgentToolName[];
const WEEKLY_BUSINESS_SUMMARY_SKILL_ID = "weekly-business-summary";

const WEEK_PERIOD = /\b(?:this|last|previous|next|current)\s+week\b|\bweekly\b|\bweek\s+(?:of|ending|starting)\b|(?:本|这|上|下|前|当前)(?:周|星期)|每周|周度/iu;
const WEEKLY_WORK_TOPIC = /\b(?:schedule|scheduled|work|jobs?|deliver(?:y|ies|ed)?|install(?:ation|ed|ment)?|site\s*visits?)\b|(?:安排|排期|日程|工单|工作|任务|送货|配送|交付|安装|现场(?:勘察|考察|访问)|上门)/iu;
const GENERIC_WEEK_SUMMARY = /\b(?:this|last|previous|next|current)\s+week(?:'s)?\s+(?:summary|overview|activity|situation|progress)\b|\b(?:summary|overview)\s+(?:for\s+)?(?:this|last|previous|next|current)\s+week\b|(?:本|这|上|下|前|当前)(?:周|星期)(?:的)?(?:情况|汇总|总结|概览|状态|进展|完成情况)/iu;

const DOMAIN_PATTERNS: readonly [RegExp, readonly AgentToolName[]][] = [
  [/\b(?:workspace\s+(?:overview|summary)|overview\s+of\s+(?:the\s+)?workspace)\b|(?:工作区|系统|业务)(?:概览|总览)/iu, ["get_workspace_overview"]],
  [/\b(?:knowledge\s*base|internal\s+(?:documents?|documentation))\b|(?:知识库|内部(?:文档|资料))/iu, ["search_knowledge_base"]],
  [/\b(?:inventory|stock)\b|(?:库存|存货)/iu, ["search_inventory"]],
  [/\b(?:quotations?|quotes?)\b|(?:报价单|报价记录|报价)/iu, ["search_quotations"]],
  [/\bproject\s+management\b|\bdelivery\s+orders?\b|(?:项目管理|送货单|配送单)/iu, ["search_delivery_orders"]],
  [/\bproject\s+track(?:ing)?\b|(?:项目跟踪|项目追踪|项目进度表)/iu, ["search_payment_projects"]],
  [/\b(?:payments?|receivables?|payment\s+collection|amounts?\s+due|outstanding\s+balances?)\b|(?:付款|收款|回款|应收|欠款|尾款|定金|待收款|未付款)/iu, ["search_payment_projects"]],
  [/\bsite\s*visits?\b|(?:现场(?:勘察|考察|访问)|上门(?:勘察|考察)?)/iu, ["search_site_visits"]],
  [/\breimbursements?\b|\bexpense\s+claims?\b|(?:报销|费用申请)/iu, ["search_reimbursements"]],
  [/\b(?:reports?\s+(?:page|notes?|records?)|shared\s+reports?)\b|(?:报告页面|报告记录|共享报告|报表)/iu, ["read_reports_notes"]],
  [/\b(?:announcements?|public\s+notices?)\b|(?:公告|通知栏)/iu, ["search_announcements"]],
  [/\b(?:group\s+(?:messages?|chat)|internal\s+discussion)\b|(?:群组消息|群聊(?:消息|记录)?|内部讨论)/iu, ["search_group_messages"]],
  [/\bproduct\s+(?:activity|sales|usage)\b|(?:产品|商品)(?:活动|销量|销售|使用情况)|销量/iu, ["search_product_activity"]],
];

const DELIVERY_OR_INSTALL = /\b(?:deliver(?:y|ies|ed)?|install(?:ation|ed|ment)?)\b|(?:送货|配送|交付|安装)/iu;
const SITE_VISIT = /\bsite\s*visits?\b|(?:现场(?:勘察|考察|访问)|上门(?:勘察|考察)?)/iu;
const EXPLICIT_PROJECT_MANAGEMENT = /\bproject\s+management\b|\bdelivery\s+orders?\b|(?:项目管理|送货单|配送单)/iu;
const PROJECT_TRACK = /\bproject\s+track(?:ing)?\b|(?:项目跟踪|项目追踪|项目进度表)/iu;
const CREATED_SCOPE = /\b(?:creat(?:e|ed|ion)|add(?:ed|ition)?|upload(?:ed)?|enter(?:ed|y)|submitted?)\b|(?:创建|添加|上传|新增|录入|提交)/iu;

function isAgentToolName(value: string): value is AgentToolName {
  return REGISTERED_TOOL_NAME_SET.has(value);
}

function isAgentToolsetId(value: string): value is AgentToolsetId {
  return AGENT_TOOLSET_ID_SET.has(value);
}

function normalizedMessage(value: string) {
  return value.normalize("NFKC").trim().slice(0, 8_000);
}

function melbourneCalendarDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekRange(today: string, offsetWeeks: number) {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const from = addCalendarDays(today, -((weekday + 6) % 7) + offsetWeeks * 7);
  return { from, to: addCalendarDays(from, 6) };
}

function requestedDateRange(message: string, now: Date) {
  const dates = [...message.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)]
    .map((match) => match[0])
    .filter((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
  if (dates.length >= 2) {
    const [first, second] = dates;
    return first <= second ? { from: first, to: second } : { from: second, to: first };
  }
  if (dates.length === 1) return { from: dates[0], to: dates[0] };

  const today = melbourneCalendarDate(now);
  if (/\b(?:last|previous)\s+week\b|(?:上|前)(?:周|星期)/iu.test(message)) return weekRange(today, -1);
  if (/\bnext\s+week\b|下(?:周|星期)/iu.test(message)) return weekRange(today, 1);
  if (/\b(?:this|current)\s+week\b|(?:本|这|当前)(?:周|星期)/iu.test(message)) return weekRange(today, 0);
  if (/\byesterday\b|昨天/iu.test(message)) {
    const yesterday = addCalendarDays(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (/\btoday\b|今天/iu.test(message)) return { from: today, to: today };
  return null;
}

function createdDateRange(message: string, now: Date) {
  return CREATED_SCOPE.test(message) ? requestedDateRange(message, now) : null;
}

function salesRepresentative(message: string) {
  const marker = /\bsales\b(?:\s+(?:representative|rep|owner))?\s*(?:(?:is|was)\s+|[:：=\-–—]\s*)?/iu.exec(message);
  if (!marker) return null;
  const tail = message.slice(marker.index + marker[0].length).trimStart();
  const stop = /[,，;；。.!?！？]|\b(?:in|during)\s+(?:this|last|previous|next|current)\s+week\b|\b(?:this|last|previous|next|current)\s+week\b|(?:在|于)?(?:本|这|上|下|前|当前)(?:周|星期)|\b(?:creat(?:e|ed|ion)|add(?:ed|ition)?|upload(?:ed)?|enter(?:ed|y)|submitted?|project\s+track(?:ing)?|with|and|who|that|has|had|did)\b|(?:创建|添加|上传|新增|录入|提交|的项目|有几|多少)/iu.exec(tail);
  const candidate = tail.slice(0, stop?.index ?? tail.length)
    .trim()
    .replace(/^[\s:：=\-–—]+|[\s:：=\-–—]+$/gu, "")
    .replace(/\s+/gu, " ");
  if (!candidate || candidate.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M}\p{N} .'’_-]*$/u.test(candidate)) return null;
  if (/^(?:team|person|people|staff|user|owner|representative|rep|情况|人员|员工|负责人)$/iu.test(candidate)) return null;
  return candidate;
}

function paymentProjectArgumentRequirements(message: string, now: Date) {
  if (!PROJECT_TRACK.test(message)) return null;
  const representative = salesRepresentative(message);
  const range = createdDateRange(message, now);
  if (!representative && !range) return null;
  return {
    ...(representative ? { salesRepresentative: representative } : {}),
    ...(range ? { createdFrom: range.from, createdTo: range.to } : {}),
  };
}

/** Derive exact-source and toolset coverage requirements for a query plan. */
export function deriveAgentQueryPolicyRequirements(
  input: AgentQueryPolicyInput,
  now = new Date(),
): AgentQueryPolicyRequirements {
  const message = normalizedMessage(input.latestMessage);
  const required = new Set<AgentToolName>();
  const requiredToolsets = new Set<AgentToolsetId>();
  const add = (names: readonly AgentToolName[]) => names.forEach((name) => required.add(name));
  const weeklyCanonical = (WEEK_PERIOD.test(message) && WEEKLY_WORK_TOPIC.test(message))
    || GENERIC_WEEK_SUMMARY.test(message);

  if (input.knowledgeRequired) required.add("search_knowledge_base");

  if (input.managedSkill?.id === WEEKLY_BUSINESS_SUMMARY_SKILL_ID
    && input.managedSkill.source === "built_in") {
    add(BUILT_IN_WEEKLY_SUMMARY_TOOLS);
  } else if (input.managedSkill) {
    // A capability grants a choice among the registered tools in that toolset.
    // Requiring every concrete tool would, for example, turn a request for an
    // announcement into an unnecessary Group-message disclosure.
    for (const capability of input.managedSkill.capabilityIds) {
      requiredToolsets.add(capability);
    }
  }

  if (weeklyCanonical) required.add("search_weekly_schedule");

  for (const [pattern, tools] of DOMAIN_PATTERNS) {
    if (!pattern.test(message)) continue;
    // A week-scoped delivery/install/site-visiting question must use the full
    // Weekly Schedule aggregate, rather than a narrower repository endpoint.
    if (weeklyCanonical
      && ((tools.includes("search_site_visits") && SITE_VISIT.test(message))
        || (tools.includes("search_delivery_orders") && DELIVERY_OR_INSTALL.test(message)
          && !EXPLICIT_PROJECT_MANAGEMENT.test(message)))) {
      continue;
    }
    add(tools);
  }

  if (!weeklyCanonical && DELIVERY_OR_INSTALL.test(message)) {
    required.add("search_delivery_orders");
  }

  const paymentProjectRequirements = paymentProjectArgumentRequirements(message, now);
  const weeklyScheduleRequirements = required.has("search_weekly_schedule")
    ? requestedDateRange(message, now)
    : null;
  const argumentRequirements = {
    ...(paymentProjectRequirements ? { searchPaymentProjects: paymentProjectRequirements } : {}),
    ...(weeklyScheduleRequirements ? { searchWeeklySchedule: weeklyScheduleRequirements } : {}),
  };
  return {
    requiredToolNames: [...required],
    requiredToolsets: [...requiredToolsets],
    ...(Object.keys(argumentRequirements).length ? {
      argumentRequirements,
    } : {}),
  };
}

/**
 * Convenience projection for callers that only need exact server-required
 * sources. Custom managed-Skill capabilities are exposed as toolsets by
 * deriveAgentQueryPolicyRequirements instead.
 */
export function deriveRequiredAgentToolNames(input: AgentQueryPolicyInput): readonly AgentToolName[] {
  return deriveAgentQueryPolicyRequirements(input).requiredToolNames;
}

/** Validate that the plan cannot silently omit server-required evidence. */
export function validateAgentQueryPlanCoverage(
  plan: Pick<AgentQueryPlan, "kind" | "steps"> | null,
  requirements: readonly (AgentToolName | string)[] | AgentQueryPolicyRequirements,
): AgentQueryPlanCoverage {
  const legacyNames = Array.isArray(requirements)
    ? requirements as readonly (AgentToolName | string)[]
    : null;
  const structured = legacyNames ? null : requirements as AgentQueryPolicyRequirements;
  const requestedToolNames: readonly (AgentToolName | string)[] = legacyNames
    || structured?.requiredToolNames
    || [];
  const requestedToolsets: readonly (AgentToolsetId | string)[] = structured?.requiredToolsets || [];
  const required: AgentToolName[] = [];
  const invalidRequiredToolNames: string[] = [];
  for (const candidate of [...new Set(requestedToolNames)]) {
    if (isAgentToolName(candidate)) required.push(candidate);
    else invalidRequiredToolNames.push(candidate);
  }
  const requiredToolsets: AgentToolsetId[] = [];
  const invalidRequiredToolsets: string[] = [];
  for (const candidate of [...new Set(requestedToolsets)]) {
    if (isAgentToolsetId(candidate)) requiredToolsets.push(candidate);
    else invalidRequiredToolsets.push(candidate);
  }
  const planned = plan?.kind === "execute"
    ? [...new Set(plan.steps.map((step) => step.toolName).filter(isAgentToolName))]
    : [];
  const plannedSet = new Set(planned);
  const missing = required.filter((name) => !plannedSet.has(name));
  const plannedToolsets = [...new Set(planned.map((name) => TOOLSET_BY_TOOL[name]))];
  const plannedToolsetSet = new Set(plannedToolsets);
  const missingToolsets = requiredToolsets.filter((toolset) => !plannedToolsetSet.has(toolset));
  const paymentRequirements = structured?.argumentRequirements?.searchPaymentProjects;
  const paymentArguments = plan?.kind === "execute"
    ? plan.steps
      .filter((step) => step.toolName === "search_payment_projects")
      .map((step) => {
        try {
          const value: unknown = JSON.parse(step.arguments);
          return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      })
      .filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
  const normalizeFilter = (value: unknown) => typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU")
    : "";
  const matchesPaymentRequirements = !paymentRequirements || (paymentArguments.length > 0 && paymentArguments.every((args) => (
    (!paymentRequirements.salesRepresentative
      || normalizeFilter(args.sales_representative) === normalizeFilter(paymentRequirements.salesRepresentative))
    && (!paymentRequirements.createdFrom || args.created_from === paymentRequirements.createdFrom)
    && (!paymentRequirements.createdTo || args.created_to === paymentRequirements.createdTo)
  )));
  const weeklyRequirements = structured?.argumentRequirements?.searchWeeklySchedule;
  const weeklyArguments = plan?.kind === "execute"
    ? plan.steps.filter((step) => step.toolName === "search_weekly_schedule").flatMap((step) => {
      try {
        const value: unknown = JSON.parse(step.arguments);
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    })
    : [];
  const matchesWeeklyRequirements = !weeklyRequirements || (weeklyArguments.length > 0 && weeklyArguments.every((args) => (
    args.from === weeklyRequirements.from && args.to === weeklyRequirements.to
  )));
  return {
    ok: Boolean(plan)
      && invalidRequiredToolNames.length === 0
      && invalidRequiredToolsets.length === 0
      && missing.length === 0
      && missingToolsets.length === 0
      && matchesPaymentRequirements
      && matchesWeeklyRequirements,
    requiredToolNames: required,
    plannedToolNames: planned,
    missingToolNames: missing,
    requiredToolsets,
    plannedToolsets,
    missingToolsets,
    invalidRequiredToolNames,
    invalidRequiredToolsets,
    ...(!matchesPaymentRequirements || !matchesWeeklyRequirements ? {
      missingArgumentRequirements: [
        ...(!matchesPaymentRequirements ? ["search_payment_projects.filters"] : []),
        ...(!matchesWeeklyRequirements ? ["search_weekly_schedule.date_range"] : []),
      ],
    } : {}),
  };
}

/** Privacy-safe booleans for live plan-contract evaluation; no values are retained. */
export function agentQueryPlanDimensions(
  plan: Pick<AgentQueryPlan, "kind" | "steps"> | null,
  requirements: AgentQueryPolicyRequirements,
): AgentQueryPlanDimensions {
  const expected = requirements.argumentRequirements?.searchPaymentProjects;
  const args = plan?.kind === "execute"
    ? plan.steps.filter((step) => step.toolName === "search_payment_projects").flatMap((step) => {
      try {
        const value: unknown = JSON.parse(step.arguments);
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    })
    : [];
  const normalize = (value: unknown) => typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU")
    : "";
  return {
    hasSalesFilter: args.some((value) => Boolean(normalize(value.sales_representative))
      && (!expected?.salesRepresentative
        || normalize(value.sales_representative) === normalize(expected.salesRepresentative))),
    hasCreatedRange: args.some((value) => typeof value.created_from === "string"
      && typeof value.created_to === "string"
      && (!expected?.createdFrom || value.created_from === expected.createdFrom)
      && (!expected?.createdTo || value.created_to === expected.createdTo)),
  };
}

const CONSENT_TERM_SOURCES = {
  customerNames: String.raw`\bcustomer(?:'s)?\s+(?:name|names)\b|\bwhich\s+customers?\b|\bwho\s+(?:used|bought|ordered|received)\b|客户(?:姓名|名字|名称)|哪些客户|谁(?:使用|购买|买了|下单|收到)`,
  assignees: String.raw`\bassignees?\b|\bassigned\s+to\b|\bwho\s+(?:is|was)\s+(?:assigned|responsible)\b|\b(?:installer|driver|handler|responsible\s+person)\b|分配给谁|谁(?:负责|安装|配送|送货)|负责人|经办人|安装人员|司机`,
  cancelledRecords: String.raw`\bcancelled\b|\bcanceled\b|\bcancellations?\b|已取消|取消(?:的)?(?:订单|项目|工单|记录)`,
  contactDetails: String.raw`\bcontact\s+(?:details?|information|info)\b|\b(?:phone|telephone|mobile)(?:\s+number)?\b|\be-?mail(?:\s+address)?\b|联系方式|联系电话|电话号码|手机号|电话|邮箱|电邮`,
  locations: String.raw`\b(?:customer|project|job|site|visit)?\s*address(?:es)?\b|\blocations?\b|\bwhere\s+(?:is|was|are|were)\b|(?:客户|项目|施工|工作|现场|拜访)?地址|地点|位置`,
  notes: String.raw`\b(?:pm\s+)?notes?\b|\bremarks?\b|\bvisit\s+comments?\b|PM\s*备注|项目备注|现场记录|拜访记录|备注`,
} as const;

function precedingClause(text: string, index: number) {
  const prefix = text.slice(Math.max(0, index - 96), index);
  const boundaries = [...prefix.matchAll(/[.!?;。！？；]|(?:[,，]|\b(?:and|then)\b)\s*(?:(?:but\s+)?(?:show|include|return|give|provide|list|display)\b|(?:显示|展示|包括|包含|返回|提供|查看))|\b(?:but|however|instead|only)\b|(?:但是|不过|而是|只要)/giu)];
  const last = boundaries.at(-1);
  return last?.index === undefined ? prefix : prefix.slice(last.index + last[0].length);
}

function consentMatchIsNegated(text: string, index: number, length: number) {
  const before = precedingClause(text, index);
  const after = text.slice(index + length, index + length + 56);
  if (/\bnot\s+only\s*$/iu.test(before) || /不仅\s*$/u.test(before)) return false;
  const negatedBefore = /(?:\b(?:do\s+not|don't|dont|never|without|exclude|excluding|omit|hide|no|not|skip)\b[\s\S]{0,56}|(?:不要|别|无需|不需要|不用|不必|禁止|排除|隐藏|跳过|不看|不显示|不包含|勿|未).{0,28})$/iu.test(before);
  const negatedAfter = /^\s*(?:(?:is|are|should|must|need(?:ed)?)\s+)?(?:not\b|unneeded\b|unnecessary\b|excluded\b|omitted\b)|^\s*(?:不要|不需要|不用|无需|不看|不显示|排除)/iu.test(after);
  return negatedBefore || negatedAfter;
}

function explicitlyConsents(text: string, source: string) {
  const expression = new RegExp(source, "giu");
  for (const match of text.matchAll(expression)) {
    if (match.index !== undefined && !consentMatchIsNegated(text, match.index, match[0].length)) return true;
  }
  return false;
}

/**
 * Extract explicit disclosure consent from this turn only. Broad requests such
 * as "show everything" deliberately do not opt into private fields.
 */
export function deriveLatestMessagePrivacyConsent(latestMessage: string): AgentPrivacyConsent {
  const message = normalizedMessage(latestMessage);
  return {
    customerNames: explicitlyConsents(message, CONSENT_TERM_SOURCES.customerNames),
    assignees: explicitlyConsents(message, CONSENT_TERM_SOURCES.assignees),
    cancelledRecords: explicitlyConsents(message, CONSENT_TERM_SOURCES.cancelledRecords),
    contactDetails: explicitlyConsents(message, CONSENT_TERM_SOURCES.contactDetails),
    locations: explicitlyConsents(message, CONSENT_TERM_SOURCES.locations),
    notes: explicitlyConsents(message, CONSENT_TERM_SOURCES.notes),
  };
}

type ConsentKey = keyof AgentPrivacyConsent;
type ToolPrivacyFlags = Readonly<Record<string, ConsentKey | readonly ConsentKey[]>>;

const TOOL_PRIVACY_FLAGS: Partial<Record<AgentToolName, ToolPrivacyFlags>> = {
  search_inventory_usage: {
    include_customer_names: "customerNames",
    include_assignees: "assignees",
    include_cancelled: "cancelledRecords",
  },
  search_product_activity: { include_customer_names: "customerNames" },
  // This legacy field exposes a broad contact projection, so a request for an
  // individual category is insufficient consent. It may be enabled only when
  // the current turn explicitly requests every category returned together.
  search_delivery_orders: {
    include_contact_details: ["contactDetails", "locations", "assignees"],
  },
  search_payment_projects: {
    include_assignee: "assignees",
    include_location: "locations",
    include_customer_contact_details: "contactDetails",
    include_pm_notes: "notes",
  },
  search_weekly_schedule: {
    include_assignee: "assignees",
    include_location: "locations",
    include_customer_contact_details: "contactDetails",
    include_notes: "notes",
  },
  search_site_visits: {
    include_assignee: "assignees",
    include_location: "locations",
    include_customer_contact_details: "contactDetails",
    include_notes: "notes",
  },
  search_project_schedule: {
    include_contact_details: ["assignees", "locations"],
    include_notes: "notes",
  },
};

function allowedByConsent(consent: AgentPrivacyConsent, keys: ConsentKey | readonly ConsentKey[]) {
  const requested: readonly ConsentKey[] = typeof keys === "string" ? [keys] : keys;
  return requested.every((key) => consent[key]);
}

/** Return the exact include_* permissions applicable to one registered tool. */
export function deriveAgentToolPrivacyConsent(
  toolName: AgentToolName | string,
  latestMessage: string,
): Readonly<Record<string, boolean>> | null {
  if (!isAgentToolName(toolName)) return null;
  const consent = deriveLatestMessagePrivacyConsent(latestMessage);
  const policy = TOOL_PRIVACY_FLAGS[toolName] || {};
  return Object.fromEntries(Object.entries(policy).map(([flag, keys]) => (
    [flag, allowedByConsent(consent, keys)]
  )));
}

function safeJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4_000;
  if (Array.isArray(value)) return value.length <= 100 && value.every((entry) => safeJsonValue(entry, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && entries.every(([key, entry]) => (
    key.length <= 100
    && key !== "__proto__"
    && key !== "constructor"
    && key !== "prototype"
    && safeJsonValue(entry, depth + 1)
  ));
}

/**
 * Clamp model-produced include_* flags to current-turn consent. This function
 * never changes non-privacy arguments and returns null for malformed/unknown
 * input so callers can reject the plan before accessing a data source.
 */
export function clampAgentToolArgumentsToPrivacyConsent(
  toolName: AgentToolName | string,
  argumentsJson: string,
  latestMessage: string,
): string | null {
  if (!isAgentToolName(toolName)
    || typeof argumentsJson !== "string"
    || Buffer.byteLength(argumentsJson, "utf8") > 8_192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !safeJsonValue(parsed)) return null;

  const args = { ...(parsed as Record<string, JsonValue>) };
  const consent = deriveAgentToolPrivacyConsent(toolName, latestMessage);
  if (!consent) return null;
  for (const key of Object.keys(args)) {
    if (key.startsWith("include_") && !Object.hasOwn(consent, key)) args[key] = false;
  }
  for (const [flag, permitted] of Object.entries(consent)) {
    args[flag] = args[flag] === true && permitted;
  }
  return JSON.stringify(args);
}
