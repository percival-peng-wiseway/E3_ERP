import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./query-plan.ts";
const {
  AGENT_QUERY_PLAN_ARGUMENT_LIMIT,
  AGENT_QUERY_PLAN_VERSION,
  agentQueryPlanDiagnostics,
  buildAgentPlanResponseFormat,
  createDeterministicAgentQueryPlan,
  parseAgentQueryPlan,
} = await import(modulePath) as typeof import("./query-plan");

const allowed = ["search_inventory", "search_weekly_schedule"] as const;

function validDraft() {
  return {
    version: AGENT_QUERY_PLAN_VERSION,
    kind: "execute",
    intent: "Compare authorised stock and scheduled delivery evidence.",
    responseLanguage: "english",
    steps: [
      { id: "step_1", toolName: "search_inventory", arguments: JSON.stringify({ query: "BAT-ONE", status: "all", limit: 10 }) },
      { id: "step_2", toolName: "search_weekly_schedule", arguments: JSON.stringify({ query: "BAT-ONE", status: "all", limit: 10 }) },
    ],
    clarification: "",
  };
}

test("model plans preserve ordered read-only steps and evidence expectations", () => {
  const plan = parseAgentQueryPlan(JSON.stringify(validDraft()), allowed);
  assert.ok(plan);
  assert.equal(plan.origin, "model");
  assert.deepEqual(plan.steps.map((step) => [step.order, step.toolName, step.readOnly]), [
    [0, "search_inventory", true],
    [1, "search_weekly_schedule", true],
  ]);
  assert.deepEqual(plan.evidence, {
    expectedToolSources: ["search_inventory", "search_weekly_schedule"],
    minimumVerifiedSteps: 1,
    requireNonEmptyResult: true,
    reportUnavailableSources: true,
  });
});

test("validation rejects unknown tools, malformed arguments and callback-rejected arguments", () => {
  const unknown = validDraft();
  unknown.steps[0] = { ...unknown.steps[0], toolName: "delete_everything", arguments: "[]" };
  assert.equal(parseAgentQueryPlan(unknown, allowed), null);
  assert.equal(parseAgentQueryPlan(validDraft(), allowed, {
    validateArguments: (toolName, args) => toolName !== "search_inventory" || args.limit === 20,
  }), null);
});

test("validation enforces step bounds, unique IDs and JSON-object arguments", () => {
  const duplicate = validDraft();
  duplicate.steps[1] = { ...duplicate.steps[1], id: "step_1" };
  assert.equal(parseAgentQueryPlan(duplicate, allowed), null);
  assert.equal(parseAgentQueryPlan(validDraft(), allowed, { maximumSteps: 1 }), null);

  const arrayArgs = validDraft();
  arrayArgs.steps[0] = { ...arrayArgs.steps[0], arguments: "[]" };
  assert.equal(parseAgentQueryPlan(arrayArgs, allowed), null);

  const oversized = validDraft();
  oversized.steps[0] = { ...oversized.steps[0], arguments: JSON.stringify({ query: "x".repeat(AGENT_QUERY_PLAN_ARGUMENT_LIMIT) }) };
  assert.equal(parseAgentQueryPlan(oversized, allowed), null);
});

test("direct and clarification plans cannot smuggle tool execution", () => {
  const direct = { ...validDraft(), kind: "direct", steps: [], intent: "Reply to a greeting." };
  assert.ok(parseAgentQueryPlan(direct, allowed));
  assert.equal(parseAgentQueryPlan(direct, allowed, { allowDirect: false }), null);

  const clarify = { ...direct, kind: "clarify", clarification: "Which date range should I use?" };
  assert.ok(parseAgentQueryPlan(clarify, allowed));
  assert.equal(parseAgentQueryPlan({ ...clarify, steps: validDraft().steps }, allowed), null);
});

test("deterministic fallbacks cross the same allow-list and argument validation boundary", () => {
  const plan = createDeterministicAgentQueryPlan({
    intent: "Read an exact inventory item.",
    responseLanguage: "chinese",
    steps: [{ toolName: "search_inventory", arguments: { query: "KH10", status: "all", limit: 10 } }],
  }, allowed);
  assert.ok(plan);
  assert.equal(plan.origin, "deterministic");
  assert.equal(plan.steps[0]?.id, "step_1");
  assert.equal(plan.steps[0]?.arguments, '{"query":"KH10","status":"all","limit":10}');
});

test("diagnostics omit intent text, tool arguments and clarification", () => {
  const plan = parseAgentQueryPlan(validDraft(), allowed);
  assert.ok(plan);
  const diagnostics = agentQueryPlanDiagnostics(plan);
  assert.deepEqual(diagnostics.toolNames, ["search_inventory", "search_weekly_schedule"]);
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("BAT-ONE"), false);
  assert.equal(serialized.includes("Compare authorised"), false);
});

test("response format is strict JSON Schema and exposes only approved tools", () => {
  const format = buildAgentPlanResponseFormat(allowed, 12);
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(
    format.json_schema.schema.properties.steps.items.properties.toolName.enum,
    allowed,
  );
  assert.equal(format.json_schema.schema.properties.steps.maxItems, 12);
  assert.equal(format.json_schema.schema.additionalProperties, false);
  assert.equal(format.json_schema.schema.properties.steps.items.additionalProperties, false);
});
