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
    fastWorkspaceOverviewAnswer: async () => null,
    fastInventoryAnswer: async () => null,
    fastPaymentTrackAnswer: async () => null,
    fastWeeklyScheduleAnswer: async () => null,
    runAgentTool: async () => JSON.stringify({ count: 0, orders: [] }),
    listSiteVisits: async () => [],
    listReimbursements: async () => [],
    getReportContent: async () => ({ content: "", revision: 0, updatedAt: null }),
    ...overrides,
  };
}

test("exact short greetings use a deterministic same-language fast path", async () => {
  const cases = [
    { message: "Hi", answer: /Hi!/u },
    { message: "Hello!", answer: /Hi!/u },
    { message: "你好。", answer: /你好/u },
    { message: "嗨！", answer: /你好/u },
  ];
  for (const { message, answer } of cases) {
    let dependencyCalls = 0;
    const trace = new AgentTrace();
    const result = await runDeterministicWorkflow(provider(), message, trace, dependencies({
      fastWorkspaceOverviewAnswer: async () => {
        dependencyCalls += 1;
        return null;
      },
      fastInventoryAnswer: async () => {
        dependencyCalls += 1;
        return null;
      },
      fastPaymentTrackAnswer: async () => {
        dependencyCalls += 1;
        return null;
      },
    }));
    assert.equal(result?.workflow, "greeting", message);
    assert.match(result?.answer || "", answer, message);
    assert.equal(dependencyCalls, 0, message);
    assert.equal(trace.snapshot().workflow, "greeting", message);
  }
});

test("greeting matching is anchored and preserves business intent", async () => {
  let paymentCalls = 0;
  const result = await runDeterministicWorkflow(
    provider(),
    "Hi, show outstanding payments",
    new AgentTrace(),
    dependencies({
      fastPaymentTrackAnswer: async () => {
        paymentCalls += 1;
        return { mode: "local", answer: "$500 outstanding.", suggestions: [] };
      },
    }),
  );
  assert.equal(result?.workflow, "outstanding_payments");
  assert.equal(paymentCalls, 1);

  for (const message of ["this", "hello project team", "你好，显示欠款"]) {
    const routed = await runDeterministicWorkflow(provider(), message, new AgentTrace(), dependencies());
    assert.notEqual(routed?.workflow, "greeting", message);
  }
});

test("the built-in workspace overview suggestion uses a deterministic read-only workflow", async () => {
  let overviewCalls = 0;
  const trace = new AgentTrace();
  const result = await runDeterministicWorkflow(
    provider(),
    "Give me a workspace overview",
    trace,
    dependencies({
      fastWorkspaceOverviewAnswer: async () => {
        overviewCalls += 1;
        return { mode: "local", answer: "Workspace overview: live totals.", suggestions: [] };
      },
    }),
  );
  assert.equal(result?.workflow, "workspace_overview");
  assert.equal(result?.answer, "Workspace overview: live totals.");
  assert.equal(overviewCalls, 1);
  assert.equal(trace.snapshot().workflow, "workspace_overview");
  assert.equal(trace.snapshot().steps[0]?.name, "workspace.overview");
});

test("registers exactly eight read-only E3 business skills", () => {
  assert.equal(E3_BUSINESS_SKILLS.length, 8);
  assert.ok(E3_BUSINESS_SKILLS.every((skill) => skill.readOnly));
});

test("registers the quotation summary as a deterministic workflow", () => {
  assert.ok(getBusinessSkill("quotations").deterministicWorkflows.includes("quotation_summary"));
});

test("the Skill registry uses the workflow names emitted by the harness", () => {
  assert.deepEqual(getBusinessSkill("inventory").deterministicWorkflows, ["inventory_query"]);
  assert.deepEqual(getBusinessSkill("quotations").deterministicWorkflows, ["quotation_summary"]);
  assert.deepEqual(getBusinessSkill("project_management").deterministicWorkflows, ["pending_deliveries"]);
  assert.deepEqual(getBusinessSkill("project_track").deterministicWorkflows, ["project_track_query", "outstanding_payments"]);
  assert.deepEqual(getBusinessSkill("weekly_schedule").deterministicWorkflows, ["weekly_schedule_query"]);
  assert.deepEqual(getBusinessSkill("site_visits").deterministicWorkflows, ["site_visit_summary"]);
  assert.deepEqual(getBusinessSkill("reimbursements").deterministicWorkflows, ["reimbursement_summary"]);
  assert.deepEqual(getBusinessSkill("reports").deterministicWorkflows, ["reports_status"]);
  assert.equal(
    new Set(E3_BUSINESS_SKILLS.flatMap((skill) => skill.deterministicWorkflows)).size,
    9,
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

test("generic Project Track questions use the live repository workflow without a model", async () => {
  let paymentCalls = 0;
  const trace = new AgentTrace();
  const result = await runDeterministicWorkflow(
    provider(),
    "Show the projects in Project Track",
    trace,
    dependencies({
      fastPaymentTrackAnswer: async () => {
        paymentCalls += 1;
        return { mode: "local", answer: "Three live projects.", suggestions: [] };
      },
    }),
  );
  assert.equal(result?.workflow, "project_track_query");
  assert.equal(result?.answer, "Three live projects.");
  assert.equal(paymentCalls, 1);
  assert.equal(trace.snapshot().steps[0]?.name, "project_track.live_query");
});

test("Weekly Schedule questions use the live aggregate workflow without a model", async () => {
  let weeklyCalls = 0;
  const trace = new AgentTrace();
  const result = await runDeterministicWorkflow(
    provider(),
    "What is on the weekly schedule?",
    trace,
    dependencies({
      fastWeeklyScheduleAnswer: async () => {
        weeklyCalls += 1;
        return { mode: "local", answer: "Five scheduled jobs.", suggestions: [] };
      },
    }),
  );
  assert.equal(result?.workflow, "weekly_schedule_query");
  assert.equal(result?.answer, "Five scheduled jobs.");
  assert.equal(weeklyCalls, 1);
  assert.equal(trace.snapshot().steps[0]?.name, "weekly_schedule.live_query");
});

test("last-week and overdue wording stays on the Weekly Schedule workflow", async () => {
  for (const message of ["Show completed jobs last week", "Show deliveries last week", "Show overdue Weekly Schedule work", "显示上周安装任务"]) {
    let weeklyCalls = 0;
    const result = await runDeterministicWorkflow(
      provider(),
      message,
      new AgentTrace(),
      dependencies({
        fastWeeklyScheduleAnswer: async () => {
          weeklyCalls += 1;
          return { mode: "local", answer: "Live weekly result.", suggestions: [] };
        },
      }),
    );
    assert.equal(result?.workflow, "weekly_schedule_query", message);
    assert.equal(weeklyCalls, 1, message);
  }
});

test("explicit Project Track unscheduled questions are not misrouted to Weekly Schedule", async () => {
  let weeklyCalls = 0;
  let paymentCalls = 0;
  const result = await runDeterministicWorkflow(
    provider(),
    "Show unscheduled projects in Project Track",
    new AgentTrace(),
    dependencies({
      fastWeeklyScheduleAnswer: async () => {
        weeklyCalls += 1;
        return null;
      },
      fastPaymentTrackAnswer: async () => {
        paymentCalls += 1;
        return { mode: "local", answer: "One unscheduled project.", suggestions: [] };
      },
    }),
  );
  assert.equal(result?.workflow, "project_track_query");
  assert.equal(weeklyCalls, 0);
  assert.equal(paymentCalls, 1);
});

test("dated Project Track schedule questions use the Weekly aggregate", async () => {
  for (const message of ["Show Project Track projects scheduled this week", "Project Track installations tomorrow", "显示项目追踪上周送货任务"]) {
    let weeklyCalls = 0;
    let paymentCalls = 0;
    const result = await runDeterministicWorkflow(
      provider(),
      message,
      new AgentTrace(),
      dependencies({
        fastWeeklyScheduleAnswer: async () => {
          weeklyCalls += 1;
          return { mode: "local", answer: "Dated Project Track schedule.", suggestions: [] };
        },
        fastPaymentTrackAnswer: async () => {
          paymentCalls += 1;
          return null;
        },
      }),
    );
    assert.equal(result?.workflow, "weekly_schedule_query", message);
    assert.equal(weeklyCalls, 1, message);
    assert.equal(paymentCalls, 0, message);
  }
});
