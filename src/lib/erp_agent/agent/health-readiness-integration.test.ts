import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [healthRoute, homeWorkspace] = await Promise.all([
  readFile(new URL("../../../app/api/agent/health/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
]);

test("agent health derives knowledge readiness from ERP-managed chunks and Vectorize", () => {
  for (const binding of ["ERP_DB", "ERP_FILES", "AI", "KNOWLEDGE_VECTORS"]) {
    assert.match(healthRoute, new RegExp(`\\["${binding}"\\]`));
  }
  assert.match(healthRoute, /getKnowledgeReadinessSnapshot/);
  assert.match(healthRoute, /knowledgeVectors\.describe/);
  assert.match(healthRoute, /knowledgeVectors\.getByIds/);
  assert.match(healthRoute, /vector\.id === readiness\.sampleIndexItemKey/);
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
