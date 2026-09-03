import assert from "node:assert/strict";
import test from "node:test";

const traceModule = "./trace.ts";
const { AgentTrace } = await import(traceModule) as typeof import("./trace");
const sanitiserModule = "./trace-sanitizer.ts";
const { sanitiseAgentTrace, sanitiseAgentTraceRecord } = await import(sanitiserModule) as typeof import("./trace-sanitizer");

test("Trace backend stores only the structured diagnostic allow-list", () => {
  const trace = new AgentTrace();
  trace.selectWorkflow("inventory_attention");
  trace.selectRoute({ skills: ["inventory"], toolsets: ["inventory"] });
  trace.recordTool({ name: "get_inventory_status", status: "verified", durationMs: 4 });
  trace.recordModelRound({
    model: "kimi-k3",
    stage: "planner",
    status: "ok",
    durationMs: 12,
    toolCallCount: 0,
    plannedStepCount: 999,
    planDimensions: {
      hasSalesFilter: true,
      hasCreatedRange: false,
    },
  });
  const snapshot = trace.snapshot() as typeof trace extends never ? never : ReturnType<typeof trace.snapshot> & {
    prompt?: string;
    answer?: string;
    toolArguments?: unknown;
  };
  snapshot.prompt = "private question";
  snapshot.answer = "private answer";
  snapshot.toolArguments = { customer: "private" };

  const safeSnapshot = sanitiseAgentTrace(snapshot);
  assert.equal(safeSnapshot.workflow, "inventory_attention");
  const stored = safeSnapshot as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(stored, "prompt"), false);
  assert.equal(Object.hasOwn(stored, "answer"), false);
  assert.equal(Object.hasOwn(stored, "toolArguments"), false);
  assert.deepEqual(safeSnapshot.modelRounds[0], {
    model: "kimi-k3",
    stage: "planner",
    status: "ok",
    durationMs: 12,
    toolCallCount: 0,
    plannedStepCount: 16,
    planDimensions: {
      hasSalesFilter: true,
      hasCreatedRange: false,
    },
  });
});

test("all-user Trace records keep safe conversation metadata and derive problem codes", () => {
  const trace = new AgentTrace();
  trace.markAbstained();
  trace.recordTool({ name: "search_knowledge_base", status: "unavailable", durationMs: 8 });
  const record = sanitiseAgentTraceRecord(trace.snapshot(), {
    actorUsername: "percival",
    actorRole: "admin",
    conversationKey: "d41d8cd98f00b204e9800998",
    messageLength: 42,
    historyMessageCount: 4,
    attachmentCount: 1,
    requestLanguage: "chinese",
    dataSource: "cloudflare",
    modelStatus: "unavailable",
    issueCodes: ["model_unavailable", "skill_unavailable"],
  });
  assert.equal(record.actorUsername, "percival");
  assert.equal(record.messageLength, 42);
  assert.deepEqual([...record.issueCodes].sort(), ["abstained", "model_unavailable", "skill_unavailable", "tool_unavailable"]);
  assert.equal(Object.hasOwn(record, "message"), false);
  assert.equal(Object.hasOwn(record, "answer"), false);
});
