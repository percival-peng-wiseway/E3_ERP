const SAFE_TOOL_TRACE_KEYS = new Set(["name", "status", "durationMs"]);
const SAFE_STEP_TRACE_KEYS = new Set(["name", "kind", "status", "durationMs"]);
const SAFE_TRACE_KEYS = new Set([
  "id",
  "createdAt",
  "workflow",
  "outcome",
  "durationMs",
  "steps",
  "promptVersion",
  "skills",
  "toolsets",
  "memoryKeys",
  "tools",
  "modelRounds",
  "abstained",
]);
const SAFE_MODEL_TRACE_KEYS = new Set([
  "model",
  "stage",
  "status",
  "durationMs",
  "toolCallCount",
  "plannedStepCount",
  "planDimensions",
  "inputTokens",
  "outputTokens",
]);
const SAFE_PLAN_DIMENSION_KEYS = new Set(["hasSalesFilter", "hasCreatedRange"]);
const FORBIDDEN_TRACE_KEYS = new Set([
  "prompt",
  "rawPrompt",
  "answer",
  "rawAnswer",
  "message",
  "content",
  "argument",
  "arguments",
  "args",
  "result",
  "results",
  "cookie",
  "cookies",
  "apiKey",
  "token",
  "secret",
  "image",
  "base64",
]);
const TOOLSET_BY_TRACE_TOOL = new Map([
  ["get_workspace_overview", "workspace"],
  ["search_knowledge_base", "knowledge"],
  ["search_inventory", "inventory"],
  ["search_inventory_usage", "inventory"],
  ["search_product_activity", "inventory"],
  ["search_quotations", "quotations"],
  ["search_delivery_orders", "project_management"],
  ["search_payment_projects", "project_track"],
  ["search_weekly_schedule", "weekly_schedule"],
  ["search_site_visits", "site_visits"],
  ["search_project_schedule", "weekly_schedule"],
  ["search_reimbursements", "reimbursements"],
  ["read_reports_notes", "reports"],
  ["search_announcements", "communications"],
  ["search_group_messages", "communications"],
]);
const SAFE_DIAGNOSTIC_TOOL_NAMES = new Set([
  "weekly_business_summary_sources",
  "workflow_data_sources",
]);
const TOOL_STATUSES = new Set(["verified", "empty", "unavailable", "error"]);

const ANSWER_COVERAGE = {
  deliveryInstallFromWeeklySchedule: {
    section: /\bdeliver(?:y|ies|ed)?\b|\binstall(?:ation|ations|ed)?\b|送货|配送|交付|安装/iu,
    source: /\bweekly\s+schedule\b|周排程|周计划/iu,
  },
  siteVisitingFromWeeklySchedule: {
    section: /\bsite\s+visit(?:ing|s)?\b|现场(?:勘察|考察|访问)|上门(?:勘察|考察)?/iu,
    source: /\bweekly\s+schedule\b|周排程|周计划/iu,
  },
  inventoryAttentionFromInventory: {
    section: /\b(?:needs?\s+attention|low\s+stock|out\s+of\s+stock|reorder)\b|需(?:要)?关注|关注项|低库存|缺货|补货/iu,
    source: /\binventory\b|库存/iu,
  },
  customerCollectionsFromProjectTrack: {
    section: /\b(?:customer\s+payments?|collections?|receivables?|amounts?\s+due|outstanding\s+balances?)\b|客户收款|收款|回款|应收|欠款|待收款/iu,
    source: /\bproject\s+track(?:ing)?\b|项目(?:追踪|跟踪|进度表)/iu,
  },
};
const ANSWER_COVERAGE_KEYS = new Set(Object.keys(ANSWER_COVERAGE));

export function expectedList(entry, pluralKey, singularKey) {
  if (Array.isArray(entry?.[pluralKey])) return entry[pluralKey];
  return entry?.[singularKey] ? [entry[singularKey]] : [];
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function containsForbiddenTraceKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenTraceKey);
  return Object.entries(value).some(([key, nested]) => (
    FORBIDDEN_TRACE_KEYS.has(key) || containsForbiddenTraceKey(nested)
  ));
}

export function privacySafeTrace(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return false;
  if (!hasOnlyKeys(trace, SAFE_TRACE_KEYS)) return false;
  if (containsForbiddenTraceKey(trace)) return false;
  if (![trace.tools, trace.steps, trace.modelRounds, trace.skills, trace.toolsets, trace.memoryKeys].every(Array.isArray)) {
    return false;
  }
  const tools = Array.isArray(trace.tools) ? trace.tools : [];
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const modelRounds = Array.isArray(trace.modelRounds) ? trace.modelRounds : [];
  const skills = Array.isArray(trace.skills) ? trace.skills : [];
  const toolsets = Array.isArray(trace.toolsets) ? trace.toolsets : [];
  const memoryKeys = Array.isArray(trace.memoryKeys) ? trace.memoryKeys : [];
  return typeof trace.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f-]{27,72}$/iu.test(trace.id)
    && typeof trace.createdAt === "string"
    && !Number.isNaN(Date.parse(trace.createdAt))
    && (trace.workflow === null || (typeof trace.workflow === "string" && /^[a-z][a-z0-9_.-]{0,119}$/u.test(trace.workflow)))
    && ["ok", "fallback", "error"].includes(trace.outcome)
    && Number.isFinite(trace.durationMs)
    && (trace.promptVersion === null || (typeof trace.promptVersion === "string" && /^[a-z0-9][a-z0-9_.-]{0,119}$/iu.test(trace.promptVersion)))
    && typeof trace.abstained === "boolean"
    && skills.every((skill) => typeof skill === "string" && /^[a-z0-9][a-z0-9_:@.-]{0,119}$/iu.test(skill))
    && memoryKeys.every((key) => typeof key === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(key))
    && toolsets.every((toolset) => typeof toolset === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(toolset))
    && tools.every((tool) => hasOnlyKeys(tool, SAFE_TOOL_TRACE_KEYS)
      && typeof tool.name === "string"
      && (TOOLSET_BY_TRACE_TOOL.has(tool.name) || SAFE_DIAGNOSTIC_TOOL_NAMES.has(tool.name))
      && TOOL_STATUSES.has(tool.status)
      && Number.isFinite(tool.durationMs))
    && steps.every((step) => hasOnlyKeys(step, SAFE_STEP_TRACE_KEYS)
      && typeof step.name === "string"
      && /^[a-z][a-z0-9_.-]{0,119}$/u.test(step.name)
      && ["workflow", "tool", "model", "fallback"].includes(step.kind)
      && ["ok", "error", "skipped"].includes(step.status)
      && Number.isFinite(step.durationMs))
    && modelRounds.every((round) => hasOnlyKeys(round, SAFE_MODEL_TRACE_KEYS)
      && typeof round.model === "string"
      && round.model.length > 0
      && round.model.length <= 120
      && /^[a-z0-9][a-z0-9._:/-]*$/iu.test(round.model)
      && (round.stage === undefined || ["planner", "executor", "legacy"].includes(round.stage))
      && ["ok", "error"].includes(round.status)
      && Number.isFinite(round.durationMs)
      && Number.isFinite(round.toolCallCount)
      && (round.plannedStepCount === undefined || Number.isFinite(round.plannedStepCount))
      && (round.inputTokens === undefined || Number.isFinite(round.inputTokens))
      && (round.outputTokens === undefined || Number.isFinite(round.outputTokens))
      && (round.planDimensions === undefined || (
        hasOnlyKeys(round.planDimensions, SAFE_PLAN_DIMENSION_KEYS)
        && typeof round.planDimensions.hasSalesFilter === "boolean"
        && typeof round.planDimensions.hasCreatedRange === "boolean"
      )));
}

export function traceToolsetsAlign(traceTools, traceToolsets) {
  const observed = new Set(Array.isArray(traceToolsets) ? traceToolsets : []);
  return traceTools.every((tool) => {
    const requiredToolset = TOOLSET_BY_TRACE_TOOL.get(tool?.name);
    return !requiredToolset || observed.has(requiredToolset);
  });
}

export function expectedPlanDimensionsMatch(modelRounds, expected) {
  if (expected === undefined) return true;
  if (!hasOnlyKeys(expected, SAFE_PLAN_DIMENSION_KEYS)
    || Object.values(expected).some((value) => typeof value !== "boolean")) return false;
  const successfulPlannerRounds = (Array.isArray(modelRounds) ? modelRounds : []).filter((round) => (
    round?.stage === "planner" && round?.status === "ok"
  ));
  return successfulPlannerRounds.some((round) => Object.entries(expected).every(([key, value]) => (
    round.planDimensions?.[key] === value
  )));
}

function matchesWithinWindow(value, first, second, maximumDistance = 360) {
  const firstExpression = new RegExp(first.source, `${first.flags.replaceAll("g", "")}g`);
  const secondExpression = new RegExp(second.source, `${second.flags.replaceAll("g", "")}g`);
  const firstMatches = [...value.matchAll(firstExpression)];
  const secondMatches = [...value.matchAll(secondExpression)];
  return firstMatches.some((left) => secondMatches.some((right) => {
    const leftIndex = left.index ?? -maximumDistance - 1;
    const rightIndex = right.index ?? maximumDistance + 1;
    return Math.abs(leftIndex - rightIndex) <= maximumDistance;
  }));
}

/**
 * Derive fixed booleans in memory. The returned object cannot contain any
 * source text and is safe to aggregate, log or persist as evaluation output.
 */
export function deriveAnswerCoverage(answer) {
  const value = typeof answer === "string" ? answer.normalize("NFKC").slice(0, 50_000) : "";
  return Object.fromEntries(Object.entries(ANSWER_COVERAGE).map(([key, patterns]) => (
    [key, matchesWithinWindow(value, patterns.section, patterns.source)]
  )));
}

export function expectedAnswerCoverageMatch(answer, expectedKeys) {
  if (expectedKeys === undefined) return true;
  if (!Array.isArray(expectedKeys)
    || expectedKeys.some((key) => typeof key !== "string" || !ANSWER_COVERAGE_KEYS.has(key))) return false;
  const coverage = deriveAnswerCoverage(answer);
  return expectedKeys.every((key) => coverage[key] === true);
}
