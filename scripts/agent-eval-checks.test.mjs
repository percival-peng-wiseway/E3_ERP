import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveAnswerCoverage,
  expectedAnswerCoverageMatch,
  expectedPlanDimensionsMatch,
  privacySafeTrace,
} from "./agent-eval-checks.mjs";

function safeTrace(roundOverrides = {}) {
  return {
    id: "22914774-6941-4284-95f6-e6d85118849e",
    createdAt: "2026-09-04T00:00:00.000Z",
    workflow: "structured_query_plan",
    outcome: "ok",
    durationMs: 20,
    steps: [
      { name: "planner.query_plan", kind: "model", status: "ok", durationMs: 8 },
      { name: "executor.evidence_synthesis", kind: "model", status: "ok", durationMs: 12 },
    ],
    promptVersion: "e3-agent-v3.1",
    skills: ["project_track"],
    toolsets: ["project_track"],
    memoryKeys: [],
    tools: [{ name: "search_payment_projects", status: "verified", durationMs: 2 }],
    modelRounds: [{
      model: "kimi-k3",
      stage: "planner",
      status: "ok",
      durationMs: 8,
      toolCallCount: 0,
      plannedStepCount: 1,
      planDimensions: { hasSalesFilter: true, hasCreatedRange: true },
      ...roundOverrides,
    }],
    abstained: false,
  };
}

test("plan dimension gate requires both privacy-safe Sales and created-range flags", () => {
  const expected = { hasSalesFilter: true, hasCreatedRange: true };
  assert.equal(expectedPlanDimensionsMatch(safeTrace().modelRounds, expected), true);
  assert.equal(expectedPlanDimensionsMatch(safeTrace({
    planDimensions: { hasSalesFilter: true, hasCreatedRange: false },
  }).modelRounds, expected), false);
  assert.equal(expectedPlanDimensionsMatch(safeTrace({ stage: "executor" }).modelRounds, expected), false);
  assert.equal(expectedPlanDimensionsMatch(safeTrace().modelRounds, { rawFilter: true }), false);
});

test("cross-domain answer gate requires four section/source associations", () => {
  const answer = [
    "### 送货与安装\n来源：Weekly Schedule\n本周项目已核实。",
    "### Site Visiting\nSource: Weekly Schedule\nThis week's visits were checked.",
    "### 库存关注项\n来源：Inventory\n有两个低库存项目。",
    "### 客户收款\n来源：Project Track\n应收余额已核实。",
  ].join("\n\n");
  const expected = [
    "deliveryInstallFromWeeklySchedule",
    "siteVisitingFromWeeklySchedule",
    "inventoryAttentionFromInventory",
    "customerCollectionsFromProjectTrack",
  ];
  assert.deepEqual(deriveAnswerCoverage(answer), {
    deliveryInstallFromWeeklySchedule: true,
    siteVisitingFromWeeklySchedule: true,
    inventoryAttentionFromInventory: true,
    customerCollectionsFromProjectTrack: true,
  });
  assert.equal(expectedAnswerCoverageMatch(answer, expected), true);
  assert.equal(expectedAnswerCoverageMatch(answer.replace("Project Track", "another system"), expected), false);
  assert.equal(Object.values(deriveAnswerCoverage(answer)).every((value) => typeof value === "boolean"), true);
});

test("trace privacy accepts only the fixed plan-dimension booleans", () => {
  assert.equal(privacySafeTrace(safeTrace()), true);
  assert.equal(privacySafeTrace(safeTrace({
    planDimensions: {
      hasSalesFilter: true,
      hasCreatedRange: true,
      rawArguments: "private",
    },
  })), false);
  assert.equal(privacySafeTrace(safeTrace({
    planDimensions: { hasSalesFilter: "yes", hasCreatedRange: true },
  })), false);
  assert.equal(privacySafeTrace({ ...safeTrace(), memoryKeys: "private request" }), false);
});
