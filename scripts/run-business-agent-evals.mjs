import { readFile } from "node:fs/promises";

const baseUrl = (process.env.E3_EVAL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const cookies = {
  default: process.env.E3_EVAL_COOKIE || "",
  admin: process.env.E3_EVAL_ADMIN_COOKIE || process.env.E3_EVAL_COOKIE || "",
  sales: process.env.E3_EVAL_SALES_COOKIE || "",
  pm: process.env.E3_EVAL_PM_COOKIE || "",
};
const cases = JSON.parse(await readFile(new URL("../evals/business-agent.json", import.meta.url), "utf8"));
const scored = [];

for (const entry of cases) {
  const cookie = cookies[entry.role || "default"];
  if (!cookie) {
    process.stdout.write(`SKIP ${entry.id}: no ${entry.role || "default"} eval cookie\n`);
    continue;
  }
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({ message: entry.message, conversation_id: `eval-${entry.id}` }),
  });
  const latency = performance.now() - started;
  const payload = await response.json().catch(() => ({}));
  const tools = Array.isArray(payload.tool_calls_summary) ? payload.tool_calls_summary : [];
  const checks = [];
  if (entry.expected_route) checks.push(["routing", payload.route === entry.expected_route]);
  if (entry.expected_tool) checks.push(["tool_selection", tools.some((item) => item.name === entry.expected_tool)]);
  if (entry.requires_citation) checks.push(["citation", Array.isArray(payload.citations) && payload.citations.length > 0]);
  if (entry.expected_error === "permission_denied") checks.push(["permission", tools.some((item) => item.status === "permission_denied")]);
  if (entry.expected_behavior === "abstain") checks.push(["abstention", payload.route === "clarification" || (Array.isArray(payload.limitations) && payload.limitations.length > 0));
  const passed = response.ok && checks.every(([, result]) => result);
  scored.push({ id: entry.id, passed, checks: Object.fromEntries(checks), latency, route: payload.route });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${entry.id} (${response.status}, ${Math.round(latency)}ms)\n`);
}

function ratio(name) {
  const relevant = scored.filter((entry) => Object.hasOwn(entry.checks, name));
  return relevant.length ? relevant.filter((entry) => entry.checks[name]).length / relevant.length : null;
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

const report = {
  cases_executed: scored.length,
  routing_accuracy: ratio("routing"),
  tool_selection_accuracy: ratio("tool_selection"),
  citation_accuracy: ratio("citation"),
  permission_block_rate: ratio("permission"),
  correct_abstention_rate: ratio("abstention"),
  p50_latency_ms: percentile(scored.map((entry) => entry.latency), 0.5),
  p95_latency_ms: percentile(scored.map((entry) => entry.latency), 0.95),
  flash_to_pro_escalation_rate: scored.length ? scored.filter((entry) => entry.route === "pro").length / scored.length : null,
  token_usage: null,
  note: "Tool argument and grounded fact scoring require fixture-aware upstreams; token usage is emitted only to privacy-safe server logs.",
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (scored.some((entry) => !entry.passed)) process.exitCode = 1;
