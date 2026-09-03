import assert from "node:assert/strict";
import test from "node:test";
import type { AgentQueryPlan } from "./query-plan";
import type { AgentToolName } from "./tool-registry";

const modulePath = "./query-policy.ts";
const {
  agentQueryPlanDimensions,
  clampAgentToolArgumentsToPrivacyConsent,
  deriveAgentQueryPolicyRequirements,
  deriveAgentToolPrivacyConsent,
  deriveLatestMessagePrivacyConsent,
  deriveRequiredAgentToolNames,
  validateAgentQueryPlanCoverage,
} = await import(modulePath) as typeof import("./query-policy");

function executionPlan(...toolNames: AgentToolName[]): Pick<AgentQueryPlan, "kind" | "steps"> {
  return {
    kind: "execute",
    steps: toolNames.map((toolName, order) => ({
      id: `step_${order + 1}`,
      order,
      toolName,
      arguments: "{}",
      readOnly: true,
    })),
  };
}

test("knowledge and every explicitly named ERP domain derive registered evidence tools", () => {
  const cases: readonly [string, AgentToolName][] = [
    ["Give me a workspace overview", "get_workspace_overview"],
    ["Search the knowledge base", "search_knowledge_base"],
    ["Show inventory stock", "search_inventory"],
    ["List quotations", "search_quotations"],
    ["Check Project Management", "search_delivery_orders"],
    ["Check Project Track", "search_payment_projects"],
    ["Show outstanding payments", "search_payment_projects"],
    ["Show Site Visits", "search_site_visits"],
    ["查看报销", "search_reimbursements"],
    ["Read the Reports notes", "read_reports_notes"],
    ["显示公告", "search_announcements"],
    ["Search group messages", "search_group_messages"],
    ["Show product activity for batteries", "search_product_activity"],
  ];
  for (const [latestMessage, expected] of cases) {
    assert.ok(deriveRequiredAgentToolNames({ latestMessage }).includes(expected), latestMessage);
  }
  assert.deepEqual(
    deriveRequiredAgentToolNames({ latestMessage: "Please answer from the attached file", knowledgeRequired: true }),
    ["search_knowledge_base"],
  );
});

test("week-scoped schedule, delivery, installation and Site Visiting use the canonical aggregate", () => {
  for (const latestMessage of [
    "Show last week's schedule",
    "What deliveries happened this week?",
    "上周安装情况",
    "总结本周现场勘察",
    "What work happened this week?",
    "上周情况",
  ]) {
    const tools = deriveRequiredAgentToolNames({ latestMessage });
    assert.ok(tools.includes("search_weekly_schedule"), latestMessage);
    assert.equal(tools.includes("search_site_visits"), false, latestMessage);
    assert.equal(tools.includes("search_delivery_orders"), false, latestMessage);
  }

  assert.deepEqual(deriveRequiredAgentToolNames({ latestMessage: "Show pending Site Visits" }), ["search_site_visits"]);
  assert.deepEqual(deriveRequiredAgentToolNames({ latestMessage: "Show delivery activity" }), ["search_delivery_orders"]);
  assert.equal(
    deriveRequiredAgentToolNames({ latestMessage: "Summarize H3 product activity and quotations this week" })
      .includes("search_weekly_schedule"),
    false,
  );
});

test("the built-in weekly summary has a fixed complete evidence floor", () => {
  assert.deepEqual(deriveRequiredAgentToolNames({
    latestMessage: "Summarize this week",
    managedSkill: {
      id: "weekly-business-summary",
      source: "built_in",
      capabilityIds: ["weekly_schedule", "site_visits", "inventory", "project_track"],
    },
  }), ["search_weekly_schedule", "search_inventory", "search_payment_projects"]);
});

test("custom managed-Skill capabilities become required source coverage", () => {
  assert.deepEqual(deriveAgentQueryPolicyRequirements({
    latestMessage: "Run my saved review",
    managedSkill: {
      id: "0a1527c3-c548-4e28-8b67-dd57db81852f",
      source: "custom",
      capabilityIds: ["inventory", "quotations", "communications"],
    },
  }), {
    requiredToolNames: [],
    requiredToolsets: ["inventory", "quotations", "communications"],
  });

  const announcementOnly = deriveAgentQueryPolicyRequirements({
    latestMessage: "Show the latest announcement",
    managedSkill: {
      id: "0a1527c3-c548-4e28-8b67-dd57db81852f",
      source: "custom",
      capabilityIds: ["communications"],
    },
  });
  assert.deepEqual(announcementOnly.requiredToolNames, ["search_announcements"]);
  assert.deepEqual(announcementOnly.requiredToolsets, ["communications"]);
});

test("coverage rejects omissions, direct answers and unknown server requirements", () => {
  const complete = validateAgentQueryPlanCoverage(
    executionPlan("search_inventory", "search_payment_projects", "search_inventory"),
    ["search_inventory", "search_payment_projects"],
  );
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.plannedToolNames, ["search_inventory", "search_payment_projects"]);

  const omitted = validateAgentQueryPlanCoverage(
    executionPlan("search_inventory"),
    ["search_inventory", "search_payment_projects"],
  );
  assert.equal(omitted.ok, false);
  assert.deepEqual(omitted.missingToolNames, ["search_payment_projects"]);

  const direct = validateAgentQueryPlanCoverage(
    { kind: "direct", steps: [] },
    ["search_inventory"],
  );
  assert.equal(direct.ok, false);
  assert.deepEqual(direct.missingToolNames, ["search_inventory"]);

  const invalid = validateAgentQueryPlanCoverage(executionPlan("search_inventory"), ["delete_records"]);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.invalidRequiredToolNames, ["delete_records"]);
});

test("coverage accepts one relevant tool per custom managed-Skill toolset", () => {
  const requirements = deriveAgentQueryPolicyRequirements({
    latestMessage: "Show announcements",
    managedSkill: {
      id: "0a1527c3-c548-4e28-8b67-dd57db81852f",
      source: "custom",
      capabilityIds: ["communications"],
    },
  });
  const covered = validateAgentQueryPlanCoverage(executionPlan("search_announcements"), requirements);
  assert.equal(covered.ok, true);
  assert.deepEqual(covered.plannedToolsets, ["communications"]);

  const wrongCommunicationAssumption = validateAgentQueryPlanCoverage(
    executionPlan("search_group_messages"),
    requirements,
  );
  assert.equal(wrongCommunicationAssumption.ok, false);
  assert.deepEqual(wrongCommunicationAssumption.missingToolNames, ["search_announcements"]);

  const missing = validateAgentQueryPlanCoverage(executionPlan("search_inventory"), {
    requiredToolNames: [],
    requiredToolsets: ["communications"],
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingToolsets, ["communications"]);

  const invalid = validateAgentQueryPlanCoverage(executionPlan("search_announcements"), {
    requiredToolNames: [],
    requiredToolsets: ["unknown_toolset" as "communications"],
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.invalidRequiredToolsets, ["unknown_toolset"]);
});

test("Sales plus a Project Track created-date scope becomes a server-owned plan contract", () => {
  const requirements = deriveAgentQueryPolicyRequirements({
    latestMessage: "Sales Ruihan 这周添加了几单到 Project Track？",
  }, new Date("2026-09-04T02:00:00Z"));
  assert.deepEqual(requirements, {
    requiredToolNames: ["search_payment_projects"],
    requiredToolsets: [],
    argumentRequirements: {
      searchPaymentProjects: {
        salesRepresentative: "Ruihan",
        createdFrom: "2026-08-31",
        createdTo: "2026-09-06",
      },
    },
  });

  const paymentPlan = (args: Record<string, unknown>): Pick<AgentQueryPlan, "kind" | "steps"> => ({
    kind: "execute",
    steps: [{
      id: "step_1",
      order: 0,
      toolName: "search_payment_projects",
      arguments: JSON.stringify(args),
      readOnly: true,
    }],
  });
  const correct = paymentPlan({
    sales_representative: "Ruihan",
    created_from: "2026-08-31",
    created_to: "2026-09-06",
  });
  assert.equal(validateAgentQueryPlanCoverage(correct, requirements).ok, true);
  assert.deepEqual(agentQueryPlanDimensions(correct, requirements), {
    hasSalesFilter: true,
    hasCreatedRange: true,
  });

  const missing = paymentPlan({
    sales_representative: null,
    created_from: null,
    created_to: null,
  });
  const missingCoverage = validateAgentQueryPlanCoverage(missing, requirements);
  assert.equal(missingCoverage.ok, false);
  assert.deepEqual(missingCoverage.missingArgumentRequirements, ["search_payment_projects.filters"]);
  assert.deepEqual(agentQueryPlanDimensions(missing, requirements), {
    hasSalesFilter: false,
    hasCreatedRange: false,
  });

  const widenedSecondStep = {
    kind: "execute" as const,
    steps: [
      ...correct.steps,
      ...paymentPlan({
        sales_representative: null,
        created_from: null,
        created_to: null,
      }).steps.map((step) => ({ ...step, id: "step_2", order: 1 })),
    ],
  };
  assert.equal(validateAgentQueryPlanCoverage(widenedSecondStep, requirements).ok, false);
});

test("historical Weekly Schedule plans must use the server-derived Melbourne range", () => {
  const requirements = deriveAgentQueryPolicyRequirements({
    latestMessage: "上周完成情况",
  }, new Date("2026-09-04T02:00:00Z"));
  assert.deepEqual(requirements.argumentRequirements?.searchWeeklySchedule, {
    from: "2026-08-24",
    to: "2026-08-30",
  });
  const schedulePlan = (from: string, to: string): Pick<AgentQueryPlan, "kind" | "steps"> => ({
    kind: "execute",
    steps: [{
      id: "step_1",
      order: 0,
      toolName: "search_weekly_schedule",
      arguments: JSON.stringify({ from, to }),
      readOnly: true,
    }],
  });
  assert.equal(validateAgentQueryPlanCoverage(
    schedulePlan("2026-08-24", "2026-08-30"),
    requirements,
  ).ok, true);
  assert.equal(validateAgentQueryPlanCoverage(
    schedulePlan("2026-08-31", "2026-09-06"),
    requirements,
  ).ok, false);
  assert.equal(validateAgentQueryPlanCoverage({
    kind: "execute",
    steps: [
      ...schedulePlan("2026-08-24", "2026-08-30").steps,
      ...schedulePlan("2026-08-31", "2026-09-06").steps.map((step) => ({ ...step, id: "step_2", order: 1 })),
    ],
  }, requirements).ok, false);
});

test("created-date ranges support English names, last week and explicit dates", () => {
  const now = new Date("2026-09-04T02:00:00Z");
  assert.deepEqual(deriveAgentQueryPolicyRequirements({
    latestMessage: "List Project Track records created last week by Sales Rui Han.",
  }, now).argumentRequirements, {
    searchPaymentProjects: {
      salesRepresentative: "Rui Han",
      createdFrom: "2026-08-24",
      createdTo: "2026-08-30",
    },
  });
  assert.deepEqual(deriveAgentQueryPolicyRequirements({
    latestMessage: "Project Track: Sales Alex, created 2026-08-01 to 2026-08-10",
  }, now).argumentRequirements, {
    searchPaymentProjects: {
      salesRepresentative: "Alex",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-10",
    },
  });
  assert.deepEqual(deriveAgentQueryPolicyRequirements({
    latestMessage: "请统计 Sales Ruihan 在本周创建的 Project Track 项目数量，并返回项目明细。",
  }, now).argumentRequirements?.searchPaymentProjects?.salesRepresentative, "Ruihan");
});

test("privacy consent requires explicit current-turn field requests", () => {
  assert.deepEqual(deriveLatestMessagePrivacyConsent(
    "Show customer names, who was assigned, cancelled orders, phone numbers, site addresses and PM notes.",
  ), {
    customerNames: true,
    assignees: true,
    cancelledRecords: true,
    contactDetails: true,
    locations: true,
    notes: true,
  });
  assert.deepEqual(deriveLatestMessagePrivacyConsent("Show everything with full details"), {
    customerNames: false,
    assignees: false,
    cancelledRecords: false,
    contactDetails: false,
    locations: false,
    notes: false,
  });
});

test("English and Chinese targeted negations override matching privacy words", () => {
  const english = deriveLatestMessagePrivacyConsent(
    "Show addresses and assignees; do not show customer names; without phone numbers; omit PM notes; exclude cancelled orders.",
  );
  assert.deepEqual(english, {
    customerNames: false,
    assignees: true,
    cancelledRecords: false,
    contactDetails: false,
    locations: true,
    notes: false,
  });

  const chinese = deriveLatestMessagePrivacyConsent(
    "显示负责人和施工地址；不要客户姓名；不要电话；不显示备注；排除已取消订单。",
  );
  assert.deepEqual(chinese, {
    customerNames: false,
    assignees: true,
    cancelledRecords: false,
    contactDetails: false,
    locations: true,
    notes: false,
  });
});

test("tool-specific consent does not broaden legacy combined fields", () => {
  assert.deepEqual(deriveAgentToolPrivacyConsent(
    "search_delivery_orders",
    "Which driver handled it and what was the address?",
  ), { include_contact_details: false });
  assert.deepEqual(deriveAgentToolPrivacyConsent(
    "search_project_schedule",
    "Which driver handled it?",
  ), { include_contact_details: false, include_notes: false });
  assert.deepEqual(deriveAgentToolPrivacyConsent(
    "search_project_schedule",
    "Which driver handled it and what was the address?",
  ), { include_contact_details: true, include_notes: false });
  assert.deepEqual(deriveAgentToolPrivacyConsent(
    "search_delivery_orders",
    "Show the phone number, delivery address and assigned driver.",
  ), { include_contact_details: true });
  assert.deepEqual(deriveAgentToolPrivacyConsent(
    "search_weekly_schedule",
    "Show the assignee and location, but do not show phone or notes",
  ), {
    include_assignee: true,
    include_location: true,
    include_customer_contact_details: false,
    include_notes: false,
  });
  assert.equal(deriveAgentToolPrivacyConsent("unknown_tool", "show phone"), null);
});

test("argument clamping can only reduce model include flags and preserves other values", () => {
  const input = JSON.stringify({
    query: "Ruihan",
    stage: "all",
    include_assignee: true,
    include_location: true,
    include_customer_contact_details: true,
    include_pm_notes: "true",
    include_future_private_field: true,
    limit: 20,
  });
  const clamped = clampAgentToolArgumentsToPrivacyConsent(
    "search_payment_projects",
    input,
    "Show the project location. Do not show the assignee, phone or PM notes.",
  );
  assert.equal(clamped, JSON.stringify({
    query: "Ruihan",
    stage: "all",
    include_assignee: false,
    include_location: true,
    include_customer_contact_details: false,
    include_pm_notes: false,
    include_future_private_field: false,
    limit: 20,
  }));

  const modelDisabled = clampAgentToolArgumentsToPrivacyConsent(
    "search_product_activity",
    '{"query":"battery","include_customer_names":false,"limit":10}',
    "Show customer names",
  );
  assert.equal(modelDisabled, '{"query":"battery","include_customer_names":false,"limit":10}');
});

test("argument clamping inserts safe false defaults and fails closed for malformed input", () => {
  assert.equal(
    clampAgentToolArgumentsToPrivacyConsent(
      "search_inventory_usage",
      '{"sku":"KH10","limit":10}',
      "Show usage",
    ),
    '{"sku":"KH10","limit":10,"include_customer_names":false,"include_assignees":false,"include_cancelled":false}',
  );
  assert.equal(clampAgentToolArgumentsToPrivacyConsent("unknown_tool", "{}", "show phone"), null);
  assert.equal(clampAgentToolArgumentsToPrivacyConsent("search_inventory", "[]", "show stock"), null);
  assert.equal(clampAgentToolArgumentsToPrivacyConsent("search_inventory", "not-json", "show stock"), null);
  assert.equal(clampAgentToolArgumentsToPrivacyConsent(
    "search_inventory",
    '{"__proto__":{"include_secret":true}}',
    "show stock",
  ), null);
});
