import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, modelOrchestrator, promptBuilder, homeWorkspace, settingsRoute, settingsDialog, settingsModule, toolExecutor] = await Promise.all([
  readFile(new URL("../../../app/api/agent/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./kimi.ts", import.meta.url), "utf8"),
  readFile(new URL("./prompt-builder.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../app/api/settings/agent/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../components/agent-settings-dialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("./settings.ts", import.meta.url), "utf8"),
  readFile(new URL("./tools.ts", import.meta.url), "utf8"),
]);

test("Agent failures return the fixed no-information response without local downgrade", () => {
  assert.match(route, /data = informationNotFound\(input\.message\)/u);
  assert.doesNotMatch(route, /localWorkspaceAnswer|local\.fallback|using local fallback/u);
  assert.match(modelOrchestrator, /找不到对应信息，请重试/u);
  assert.match(modelOrchestrator, /No matching information was found\. Please try again\./u);
  assert.doesNotMatch(homeWorkspace, /Local mode/u);
  assert.match(homeWorkspace, /Model unavailable/u);
});

test("partial deterministic answers are surfaced as structured fallback diagnostics", () => {
  assert.match(toolExecutor, /const incompleteData = sourceWarnings\.length > 0/u);
  assert.match(toolExecutor, /verified entries \(partial data\)/u);
  assert.match(toolExecutor, /\{ incompleteData: true \}/u);
  assert.match(route, /if \(workflowAnswer\.incompleteData\)/u);
  assert.match(route, /trace\.markOutcome\("fallback"\)/u);
  assert.match(route, /name: workflow === "weekly_schedule_query"[\s\S]*?"search_weekly_schedule"/u);
  assert.match(route, /status: "unavailable"/u);
  assert.match(route, /issueCodes\.add\("tool_unavailable"\)/u);
  assert.doesNotMatch(route, /recordTool\(\{[\s\S]*?(?:arguments|result|sourceWarnings):/u);
});

test("product activity is a controlled cross-source model tool", () => {
  assert.match(promptBuilder, /search_product_activity/u);
  assert.match(promptBuilder, /cannot create tools, execute arbitrary code/u);
  assert.match(promptBuilder, /Never add its accepted quotation/u);
});

test("Kimi separates structured planning from evidence synthesis", () => {
  assert.match(modelOrchestrator, /thinking: "disabled"/u);
  assert.match(modelOrchestrator, /max_completion_tokens: maxCompletionTokens/u);
  assert.match(modelOrchestrator, /reasoning_effort: reasoningEffort/u);
  assert.match(modelOrchestrator, /buildAgentPlanResponseFormat/u);
  assert.match(modelOrchestrator, /parseAgentQueryPlan/u);
  assert.match(modelOrchestrator, /planner\.query_plan/u);
  assert.match(modelOrchestrator, /executor\.evidence_synthesis/u);
  assert.match(modelOrchestrator, /executeRegisteredAgentTool/u);
  assert.match(modelOrchestrator, /\[...imageParts, \{ type: "text", text: message \}\]/u);
  assert.match(modelOrchestrator, /prompt_cache_key/u);
  assert.match(modelOrchestrator, /mode: "kimi"/u);
  assert.match(modelOrchestrator, /validateRegisteredAgentToolArguments/u);
  assert.match(modelOrchestrator, /validateAgentQueryPlanCoverage/u);
  assert.match(modelOrchestrator, /clampAgentToolArgumentsToPrivacyConsent/u);
  assert.match(modelOrchestrator, /weeklyScheduleStrictDateRange: strictHistoricalWeeklyRange/u);
  assert.match(route, /const modelRequest = buildingPersonalSkill \|\| imageParts\.length > 0 \|\| requiresKnowledge/u);
  assert.match(route, /if \(modelRequest && !settings\.apiKey\)/u);
  assert.match(route, /kimiRequestWarning\(primaryError, settings\.region\)/u);
  assert.doesNotMatch(modelOrchestrator, /modelErrorDetail|error\?\.message/u);
  assert.match(route, /structuredPlanFirst = Boolean\(settings\.apiKey\)/u);
  assert.match(route, /workflowAnswer = structuredPlanFirst \? null/u);
  assert.doesNotMatch(route, /preserveWeeklyKernel/u);
});

test("Agent settings keep the endpoint fixed while validating configurable planner and executor models", () => {
  assert.match(settingsRoute, /parseAgentSettingsInput/u);
  assert.match(settingsRoute, /export async function GET\(request: Request\)/u);
  assert.match(settingsRoute, /Administrator access is required to view Agent settings/u);
  assert.match(settingsModule, /export function saveAgentSettings\(/u);
  assert.match(settingsDialog, /Region choices map only to official Moonshot endpoints/u);
  assert.match(settingsDialog, /value="china"/u);
  assert.match(settingsDialog, /value="international"/u);
  assert.match(settingsDialog, /required=\{settings\.source !== "saved"\}/u);
  assert.match(settingsDialog, /Planner model/u);
  assert.match(settingsDialog, /Executor model/u);
  assert.match(settingsDialog, /advertised by that API account/u);
  assert.doesNotMatch(settingsDialog, /setBaseUrl|name="baseUrl"/u);
});
