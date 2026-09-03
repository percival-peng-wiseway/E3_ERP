import { readFile } from "node:fs/promises";

const baseUrl = (process.env.E3_EVAL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const cookie = process.env.E3_EVAL_COOKIE || "";
const cases = JSON.parse(await readFile(new URL("../evals/agent-business.json", import.meta.url), "utf8"));
let failed = 0;
let workflowPassed = 0;
let routingPassed = 0;
let abstentionPassed = 0;
const durations = [];
let inputTokens = 0;
let outputTokens = 0;

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

for (const entry of cases) {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ message: entry.query, history: [] }),
  });
  const payload = await response.json().catch(() => ({}));
  const workflow = payload?.data?.workflow;
  const tracedWorkflow = payload?.meta?.trace?.workflow;
  const trace = payload?.meta?.trace || {};
  const workflowOk = workflow === entry.expectedWorkflow && tracedWorkflow === workflow;
  const routingOk = (!entry.expectedSkill || trace.skills?.includes(entry.expectedSkill))
    && (!entry.expectedToolset || trace.toolsets?.includes(entry.expectedToolset));
  const abstentionOk = entry.expectedAbstained === undefined || trace.abstained === entry.expectedAbstained;
  const passed = response.ok
    && workflowOk
    && routingOk
    && abstentionOk
    && payload?.data?.mode === "local"
    && typeof payload?.data?.answer === "string";
  if (workflowOk) workflowPassed += 1;
  if (routingOk) routingPassed += 1;
  if (abstentionOk) abstentionPassed += 1;
  if (Number.isFinite(trace.durationMs)) durations.push(trace.durationMs);
  for (const round of trace.modelRounds || []) {
    inputTokens += Number(round.inputTokens) || 0;
    outputTokens += Number(round.outputTokens) || 0;
  }
  if (!passed) failed += 1;
  const traceNote = tracedWorkflow && tracedWorkflow !== workflow
    ? `, trace selected ${tracedWorkflow}`
    : "";
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${entry.name} (${response.status}, response ${workflow || "no deterministic workflow"}${traceNote})\n`);
}

process.stdout.write([
  `Trajectory summary: workflow ${workflowPassed}/${cases.length}`,
  `routing ${routingPassed}/${cases.length}`,
  `abstention ${abstentionPassed}/${cases.length}`,
  `latency p50=${percentile(durations, 0.5)}ms p95=${percentile(durations, 0.95)}ms`,
  `model tokens in=${inputTokens} out=${outputTokens}`,
].join(", ") + "\n");

if (failed) {
  process.stderr.write(`${failed} business eval(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${cases.length} live business evals passed.\n`);
}
