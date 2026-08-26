import assert from "node:assert/strict";
import test from "node:test";

const skillsModule = "./skills.ts";
const { E3_BUSINESS_SKILLS, getBusinessSkill } = await import(skillsModule) as typeof import("./skills");
const workflowsModule = "./workflows.ts";
const { runDeterministicWorkflow } = await import(workflowsModule) as typeof import("./workflows");
const traceModule = "./trace.ts";
const { AgentTrace } = await import(traceModule) as typeof import("./trace");
import type { ERPProvider } from "../erp/provider";
import type { DeterministicWorkflowDependencies } from "./workflows";

function provider(overrides: Partial<ERPProvider> = {}): ERPProvider {
  return {
    source: "http",
    listInventory: async () => [],
    getInventoryItem: async () => null,
    listQuotations: async () => [],
    getQuotation: async () => null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<DeterministicWorkflowDependencies> = {},
): DeterministicWorkflowDependencies {
  return {
    fastInventoryAnswer: async () => null,
    fastPaymentTrackAnswer: async () => null,
    runAgentTool: async () => JSON.stringify({ count: 0, orders: [] }),
    listSiteVisits: async () => [],
    listReimbursements: async () => [],
    getReportContent: async () => ({ content: "", revision: 0, updatedAt: null }),
    ...overrides,
  };
}

test("registers exactly seven read-only E3 business skills", () => {
  assert.equal(E3_BUSINESS_SKILLS.length, 7);
  assert.ok(E3_BUSINESS_SKILLS.every((skill) => skill.readOnly));
});

test("registers the quotation summary as a deterministic workflow", () => {
  assert.ok(getBusinessSkill("quotations").deterministicWorkflows.includes("quotation_summary"));
});

test("the Skill registry uses the workflow names emitted by the harness", () => {
  assert.deepEqual(getBusinessSkill("inventory").deterministicWorkflows, ["inventory_query"]);
  assert.deepEqual(getBusinessSkill("quotations").deterministicWorkflows, ["quotation_summary"]);
  assert.deepEqual(getBusinessSkill("project_management").deterministicWorkflows, ["pending_deliveries"]);
  assert.deepEqual(getBusinessSkill("project_track").deterministicWorkflows, ["outstanding_payments"]);
  assert.deepEqual(getBusinessSkill("site_visits").deterministicWorkflows, ["site_visit_summary"]);
  assert.deepEqual(getBusinessSkill("reimbursements").deterministicWorkflows, ["reimbursement_summary"]);
  assert.deepEqual(getBusinessSkill("reports").deterministicWorkflows, ["reports_status"]);
  assert.equal(
    new Set(E3_BUSINESS_SKILLS.flatMap((skill) => skill.deterministicWorkflows)).size,
    7,
  );
});

test("runDeterministicWorkflow executes live quotation queries and records the selected workflow", async () => {
  let receivedStatus: string | undefined;
  const result = await runDeterministicWorkflow(provider({
    listQuotations: async (query) => {
      receivedStatus = query?.status;
      return [{
        id: "q-1",
        number: "QTN-1",
        customer: "Test Customer",
        status: "draft",
        subtotal: 100,
        tax: 10,
        total: 110,
        currency: "AUD",
        validUntil: "",
        createdAt: "2026-08-26T00:00:00.000Z",
        items: [],
      }];
    },
  }), "Show draft quotations", new AgentTrace(), dependencies());

  assert.equal(receivedStatus, "draft");
  assert.equal(result?.workflow, "quotation_summary");
  assert.match(result?.answer || "", /QTN-1/);
});

test("runDeterministicWorkflow never turns a delivery source error into a zero result", async () => {
  const trace = new AgentTrace();
  await assert.rejects(
    runDeterministicWorkflow(
      provider(),
      "Show deliveries pending PM review",
      trace,
      dependencies({
        runAgentTool: async () => JSON.stringify({
          error: { code: "data_unavailable", message: "temporarily unavailable" },
        }),
      }),
    ),
    /source is unavailable/,
  );
  assert.equal(trace.snapshot().workflow, "pending_deliveries");
  assert.equal(trace.snapshot().steps.at(-1)?.status, "error");
});

test("runDeterministicWorkflow passes through a live inventory answer", async () => {
  const trace = new AgentTrace();
  const result = await runDeterministicWorkflow(
    provider(),
    "Which stock items need attention?",
    trace,
    dependencies({
      fastInventoryAnswer: async () => ({ mode: "local", answer: "Two items.", suggestions: [] }),
    }),
  );
  assert.equal(result?.workflow, "inventory_query");
  assert.equal(result?.answer, "Two items.");
  assert.equal(trace.snapshot().steps[0]?.name, "inventory.live_query");
});

test("Project Track references do not get misrouted as inventory SKUs", async () => {
  let inventoryCalls = 0;
  let paymentCalls = 0;
  const result = await runDeterministicWorkflow(
    provider(),
    "How much is outstanding for PAY-2026-0002?",
    new AgentTrace(),
    dependencies({
      fastInventoryAnswer: async () => {
        inventoryCalls += 1;
        return null;
      },
      fastPaymentTrackAnswer: async () => {
        paymentCalls += 1;
        return { mode: "local", answer: "$500 outstanding.", suggestions: [] };
      },
    }),
  );
  assert.equal(result?.workflow, "outstanding_payments");
  assert.equal(inventoryCalls, 0);
  assert.equal(paymentCalls, 1);
});
