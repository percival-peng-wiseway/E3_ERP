import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [healthRoute, homeWorkspace] = await Promise.all([
  readFile(new URL("../../app/api/agent/health/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
]);

test("agent health derives knowledge readiness from ERP-managed documents and active chunks", () => {
  assert.match(healthRoute, /!bindings\?\.database \|\| !bindings\.files \|\| !bindings\.knowledgeSearch/);
  assert.match(healthRoute, /getKnowledgeReadinessSnapshot/);
  assert.match(healthRoute, /knowledgeSearch\.items\.list/);
  assert.match(healthRoute, /item\.key === readiness\.sampleIndexItemKey && item\.status === "completed"/);
  assert.match(healthRoute, /readyDocuments:/);
  assert.match(healthRoute, /activeChunks:/);
  assert.match(healthRoute, /assess: assessKnowledgeReadiness/);
});

test("Home Agent presents model and administrator knowledge readiness separately", () => {
  assert.match(homeWorkspace, /title="Language model status only"/);
  assert.match(homeWorkspace, /isAdmin && \(/);
  assert.match(homeWorkspace, /agentKnowledgeStatus\.label/);
  assert.match(homeWorkspace, /fetch\("\/api\/agent\/health"/);
});
