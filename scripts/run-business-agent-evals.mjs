import { readFile } from "node:fs/promises";

const baseUrl = (process.env.E3_EVAL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const cookies = {
  default: process.env.E3_EVAL_COOKIE || "",
  admin: process.env.E3_EVAL_ADMIN_COOKIE || process.env.E3_EVAL_COOKIE || "",
  sales: process.env.E3_EVAL_SALES_COOKIE || "",
  pm: process.env.E3_EVAL_PM_COOKIE || "",
};
const [businessCases, knowledgeCases] = await Promise.all([
  readFile(new URL("../evals/business-agent.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../evals/knowledge-rag.json", import.meta.url), "utf8").then(JSON.parse),
]);
const cases = [...businessCases, ...knowledgeCases];
const scored = [];
const requireLive = process.env.E3_EVAL_REQUIRE_LIVE === "1";
const configuredMinimum = Number(process.env.E3_EVAL_MIN_CASES || (requireLive ? cases.length : 0));

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
  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  if (entry.requires_citation) {
    const topFive = citations.slice(0, 5);
    const recalled = entry.expected_document_id
      ? topFive.some((item) => item.document_id === entry.expected_document_id)
      : entry.expected_title_includes
        ? topFive.some((item) => typeof item.title === "string" && item.title.includes(entry.expected_title_includes))
        : topFive.length > 0;
    checks.push(["recall_at_5", recalled]);
  }
  if (entry.expected_document_id) checks.push(["document_id", citations.some((item) => item.document_id === entry.expected_document_id)]);
  if (entry.expected_title_includes) checks.push(["document_title", citations.some((item) => typeof item.title === "string" && item.title.includes(entry.expected_title_includes))]);
  if (entry.forbidden_document_id) checks.push(["citation_security", citations.every((item) => item.document_id !== entry.forbidden_document_id)]);
  if (entry.expected_version) checks.push(["version", citations.some((item) => item.version === entry.expected_version)]);
  if (entry.requires_file_id) checks.push(["file_id", citations.some((item) => typeof item.file_id === "string" && /^[0-9a-f-]{36}$/i.test(item.file_id))]);
  if (entry.requires_page_or_heading) checks.push(["location", citations.some((item) => Number.isSafeInteger(item.page_number) || (Array.isArray(item.heading_path) && item.heading_path.length > 0))]);
  if (entry.expected_error === "permission_denied") checks.push(["permission", tools.some((item) => item.status === "permission_denied")]);
  const answer = typeof payload.answer === "string" ? payload.answer.toLocaleLowerCase("en-AU") : "";
  if (entry.expected_behavior === "abstain") checks.push(["abstention", payload.route === "clarification"
    || answer.includes("knowledge base did not return enough reliable")
    || answer.includes("当前知识库没有返回足够可靠")]);
  if (Array.isArray(entry.answer_must_include)) checks.push(["answer_facts", entry.answer_must_include.every((term) => answer.includes(String(term).toLocaleLowerCase("en-AU")))]);
  if (Array.isArray(entry.answer_must_include_any)) checks.push(["answer_facts", entry.answer_must_include_any.some((term) => answer.includes(String(term).toLocaleLowerCase("en-AU")))]);
  if (Array.isArray(entry.answer_must_not_include)) checks.push(["answer_safety", entry.answer_must_not_include.every((term) => !answer.includes(String(term).toLocaleLowerCase("en-AU")))]);
  const factChecks = checks.filter(([name]) => name === "answer_facts").map(([, value]) => value);
  if (entry.requires_citation || factChecks.length) {
    checks.push(["groundedness", (!entry.requires_citation || citations.length > 0) && factChecks.every(Boolean)]);
  }
  if (entry.expected_version) checks.push(["freshness", citations.some((item) => item.version === entry.expected_version)]);
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
  recall_at_5: ratio("recall_at_5"),
  citation_correctness: ["document_id", "document_title", "citation_security", "version", "location"]
    .map(ratio).filter((value) => value !== null).reduce((sum, value, _index, values) => sum + value / values.length, 0),
  cited_document_accuracy: ratio("document_id"),
  cited_title_accuracy: ratio("document_title"),
  citation_security_rate: ratio("citation_security"),
  cited_location_accuracy: ratio("location"),
  grounded_fact_accuracy: ratio("answer_facts"),
  groundedness: ratio("groundedness"),
  answer_safety_rate: ratio("answer_safety"),
  permission_block_rate: ratio("permission"),
  correct_abstention_rate: ratio("abstention"),
  no_answer_recognition_rate: ratio("abstention"),
  permission_leak_prevention_rate: ratio("citation_security"),
  freshness_accuracy: ratio("freshness"),
  p50_latency_ms: percentile(scored.map((entry) => entry.latency), 0.5),
  p95_latency_ms: percentile(scored.map((entry) => entry.latency), 0.95),
  flash_to_pro_escalation_rate: scored.length ? scored.filter((entry) => entry.route === "pro").length / scored.length : null,
  token_usage: null,
  note: "Tool argument and grounded fact scoring require fixture-aware upstreams; token usage is emitted only to privacy-safe server logs.",
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (scored.length < configuredMinimum) {
  process.stderr.write(`Live eval gate failed: executed ${scored.length}, required ${configuredMinimum}.\n`);
  process.exitCode = 1;
} else if (scored.some((entry) => !entry.passed)) process.exitCode = 1;
