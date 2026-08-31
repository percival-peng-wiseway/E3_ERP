import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, modelOrchestrator, homeWorkspace] = await Promise.all([
  readFile(new URL("../../app/api/agent/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./deepseek.ts", import.meta.url), "utf8"),
  readFile(new URL("../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
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
  assert.match(modelOrchestrator, /search_product_activity/u);
  assert.match(modelOrchestrator, /cannot create or execute new tool code/u);
  assert.match(modelOrchestrator, /Never add its accepted quotation/u);
});
