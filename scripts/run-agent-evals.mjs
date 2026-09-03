import { readFile } from "node:fs/promises";
import {
  expectedAnswerCoverageMatch,
  expectedList,
  expectedPlanDimensionsMatch,
  privacySafeTrace,
  traceToolsetsAlign,
} from "./agent-eval-checks.mjs";

const baseUrl = (process.env.E3_EVAL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const cookie = process.env.E3_EVAL_COOKIE || "";
const cases = JSON.parse(await readFile(new URL("../evals/agent-business.json", import.meta.url), "utf8"));
let failed = 0;
let workflowPassed = 0;
let routingPassed = 0;
let abstentionPassed = 0;
let toolCoveragePassed = 0;
let toolCoverageCaseCount = 0;
let planTrajectoryPassed = 0;
let planTrajectoryCaseCount = 0;
let planDimensionsPassed = 0;
let planDimensionsCaseCount = 0;
let answerCoveragePassed = 0;
let answerCoverageCaseCount = 0;
let tracePrivacyPassed = 0;
let structuredCaseCount = 0;
let structuredCasePassed = 0;
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
  const responseWorkflow = payload?.data?.workflow;
  const tracedWorkflow = payload?.meta?.trace?.workflow;
  const workflow = responseWorkflow || tracedWorkflow;
  const trace = payload?.meta?.trace || {};
  const expectedWorkflows = expectedList(entry, "expectedWorkflows", "expectedWorkflow");
  const expectedModes = expectedList(entry, "expectedModes", "expectedMode");
  const expectedSkills = expectedList(entry, "expectedSkills", "expectedSkill");
  const expectedToolsets = expectedList(entry, "expectedToolsets", "expectedToolset");
  const structuredCase = expectedWorkflows.includes("structured_query_plan");
  const traceTools = Array.isArray(trace.tools) ? trace.tools : [];
  const traceSteps = Array.isArray(trace.steps) ? trace.steps : [];
  const modelRounds = Array.isArray(trace.modelRounds) ? trace.modelRounds : [];
  const workflowOk = expectedWorkflows.includes(workflow)
    && tracedWorkflow === workflow
    && (!responseWorkflow || responseWorkflow === tracedWorkflow);
  const modeOk = expectedModes.length
    ? expectedModes.includes(payload?.data?.mode)
    : payload?.data?.mode === "local";
  const routingOk = expectedSkills.every((skill) => trace.skills?.includes(skill))
    && expectedToolsets.every((toolset) => trace.toolsets?.includes(toolset))
    && traceToolsetsAlign(traceTools, trace.toolsets);
  const abstentionOk = entry.expectedAbstained === undefined || trace.abstained === entry.expectedAbstained;
  const expectedTraceTools = expectedList(entry, "expectedTraceTools", "expectedTraceTool");
  const acceptedToolStatuses = Array.isArray(entry.expectedToolStatuses)
    ? new Set(entry.expectedToolStatuses)
    : structuredCase ? new Set(["verified", "empty"]) : null;
  const toolCoverageOk = expectedTraceTools.every((name) => traceTools.some((tool) => (
    tool?.name === name && (!acceptedToolStatuses || acceptedToolStatuses.has(tool.status))
  )));
  const declaredTraceSteps = expectedList(entry, "expectedTraceSteps", "expectedTraceStep");
  const declaredModelStages = expectedList(entry, "expectedModelStages", "expectedModelStage");
  const expectedTraceSteps = structuredCase && !declaredTraceSteps.length
    ? ["planner.query_plan", "executor.evidence_synthesis"]
    : declaredTraceSteps;
  const expectedModelStages = structuredCase && !declaredModelStages.length
    ? ["planner", "executor"]
    : declaredModelStages;
  const minimumModelRounds = Number.isSafeInteger(entry.minimumModelRounds)
    ? entry.minimumModelRounds
    : structuredCase ? 2 : 0;
  const planTrajectoryOk = expectedTraceSteps.every((name) => traceSteps.some((step) => (
    step?.name === name && step?.status === "ok"
  ))) && expectedModelStages.every((stage) => modelRounds.some((round) => (
    round?.stage === stage && round?.status === "ok"
  ))) && modelRounds.length >= minimumModelRounds;
  const planDimensionsOk = expectedPlanDimensionsMatch(modelRounds, entry.expectedPlanDimensions);
  // The answer is inspected only in process memory. Neither its contents nor
  // matched fragments are printed or included in the persistent eval report.
  const visibleAnswer = typeof payload?.data?.answer === "string" ? payload.data.answer : "";
  const answerCoverageOk = expectedAnswerCoverageMatch(visibleAnswer, entry.expectedAnswerCoverage);
  const privacyOk = privacySafeTrace(trace);
  const passed = response.ok
    && workflowOk
    && modeOk
    && routingOk
    && abstentionOk
    && toolCoverageOk
    && planTrajectoryOk
    && planDimensionsOk
    && answerCoverageOk
    && privacyOk
    && visibleAnswer.trim().length > 0;
  if (workflowOk) workflowPassed += 1;
  if (routingOk) routingPassed += 1;
  if (abstentionOk) abstentionPassed += 1;
  if (expectedTraceTools.length) {
    toolCoverageCaseCount += 1;
    if (toolCoverageOk) toolCoveragePassed += 1;
  }
  if (expectedTraceSteps.length || expectedModelStages.length || minimumModelRounds > 0) {
    planTrajectoryCaseCount += 1;
    if (planTrajectoryOk) planTrajectoryPassed += 1;
  }
  if (entry.expectedPlanDimensions !== undefined) {
    planDimensionsCaseCount += 1;
    if (planDimensionsOk) planDimensionsPassed += 1;
  }
  if (entry.expectedAnswerCoverage !== undefined) {
    answerCoverageCaseCount += 1;
    if (answerCoverageOk) answerCoveragePassed += 1;
  }
  if (privacyOk) tracePrivacyPassed += 1;
  if (structuredCase) {
    structuredCaseCount += 1;
    if (passed) structuredCasePassed += 1;
  }
  if (Number.isFinite(trace.durationMs)) durations.push(trace.durationMs);
  for (const round of modelRounds) {
    inputTokens += Number(round.inputTokens) || 0;
    outputTokens += Number(round.outputTokens) || 0;
  }
  if (!passed) failed += 1;
  const traceNote = tracedWorkflow && tracedWorkflow !== workflow
    ? `, trace selected ${tracedWorkflow}`
    : "";
  const failedChecks = [
    ["workflow", workflowOk],
    ["mode", modeOk],
    ["routing", routingOk],
    ["abstention", abstentionOk],
    ["tool coverage", toolCoverageOk],
    ["plan trajectory", planTrajectoryOk],
    ["plan dimensions", planDimensionsOk],
    ["answer coverage", answerCoverageOk],
    ["trace privacy", privacyOk],
  ].filter(([, ok]) => !ok).map(([name]) => name);
  const checkNote = failedChecks.length ? `, failed ${failedChecks.join("/")}` : "";
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${entry.name} (${response.status}, response ${workflow || "no workflow"}${traceNote}${checkNote})\n`);
}

process.stdout.write([
  `Trajectory summary: workflow ${workflowPassed}/${cases.length}`,
  `routing ${routingPassed}/${cases.length}`,
  `abstention ${abstentionPassed}/${cases.length}`,
  `tool coverage ${toolCoveragePassed}/${toolCoverageCaseCount}`,
  `plan trajectory ${planTrajectoryPassed}/${planTrajectoryCaseCount}`,
  `plan dimensions ${planDimensionsPassed}/${planDimensionsCaseCount}`,
  `answer coverage ${answerCoveragePassed}/${answerCoverageCaseCount}`,
  `trace privacy ${tracePrivacyPassed}/${cases.length}`,
  `structured plans ${structuredCasePassed}/${structuredCaseCount}`,
  `latency p50=${percentile(durations, 0.5)}ms p95=${percentile(durations, 0.95)}ms`,
  `model tokens in=${inputTokens} out=${outputTokens}`,
].join(", ") + "\n");

if (failed) {
  process.stderr.write(`${failed} business eval(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${cases.length} live business evals passed.\n`);
}
