import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, modelOrchestrator, promptBuilder, homeWorkspace, settingsRoute, settingsDialog, settingsModule] = await Promise.all([
  readFile(new URL("../../../app/api/agent/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./kimi.ts", import.meta.url), "utf8"),
  readFile(new URL("./prompt-builder.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../app/api/settings/agent/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../components/agent-settings-dialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("./settings.ts", import.meta.url), "utf8"),
]);

test("Agent failures return the fixed no-information response without local downgrade", () => {
  assert.match(route, /data = informationNotFound\(input\.message\)/u);
  assert.doesNotMatch(route, /localWorkspaceAnswer|local\.fallback|using local fallback/u);
  assert.match(modelOrchestrator, /找不到对应信息，请重试/u);
  assert.match(modelOrchestrator, /No matching information was found\. Please try again\./u);
  assert.doesNotMatch(homeWorkspace, /Local mode/u);
  assert.match(homeWorkspace, /Model unavailable/u);
});

test("product activity is a controlled cross-source model tool", () => {
  assert.match(promptBuilder, /search_product_activity/u);
  assert.match(promptBuilder, /cannot create tools, execute arbitrary code/u);
  assert.match(promptBuilder, /Never add its accepted quotation/u);
});

test("Kimi builds multimodal content arrays with thinking disabled", () => {
  assert.match(modelOrchestrator, /thinking: \{ type: "disabled" \}/u);
  assert.match(modelOrchestrator, /max_completion_tokens: 800/u);
  assert.match(modelOrchestrator, /\[...imageParts, \{ type: "text", text: message \}\]/u);
  assert.match(modelOrchestrator, /prompt_cache_key/u);
  assert.match(modelOrchestrator, /mode: "kimi"/u);
  assert.match(route, /const modelRequest = buildingPersonalSkill \|\| imageParts\.length > 0 \|\| requiresKnowledge/u);
  assert.match(route, /if \(modelRequest && !settings\.apiKey\)/u);
  assert.match(route, /kimiRequestWarning\(primaryError, settings\.region\)/u);
  assert.doesNotMatch(modelOrchestrator, /modelErrorDetail|error\?\.message/u);
  assert.doesNotMatch(modelOrchestrator, /reasoning_effort/u);
});

test("Agent settings accept only an API key and trusted region while the server owns endpoint and model", () => {
  assert.match(settingsRoute, /parseAgentSettingsInput/u);
  assert.match(settingsRoute, /export async function GET\(request: Request\)/u);
  assert.match(settingsRoute, /Administrator access is required to view Agent settings/u);
  assert.match(settingsModule, /export function saveAgentSettings\(/u);
  assert.match(settingsDialog, /Region choices map only to official Moonshot endpoints/u);
  assert.match(settingsDialog, /value="china"/u);
  assert.match(settingsDialog, /value="international"/u);
  assert.match(settingsDialog, /required=\{settings\.source !== "saved"\}/u);
  assert.doesNotMatch(settingsDialog, /setBaseUrl|setModel|name="baseUrl"/u);
});
