import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentTrackProject } from "../payment-track/types";
const viewModule = "./project-track-view.ts";
const {
  agentDeliveryScheduleState,
  agentInstallationScheduleState,
  agentQueryExplicitlyRequestsAssignee,
  agentProjectMatchesWorkflowFilter,
  agentProjectWorkModeFilter,
  agentProjectWorkflowStatus,
  projectTrackAgentSearchTerms,
  projectTrackAgentView,
  projectTrackScheduleSearchValues,
} = await import(viewModule) as typeof import("./project-track-view");

function project(overrides: Partial<PaymentTrackProject> = {}): PaymentTrackProject {
  const receipt = {
    proof: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    reportedAmountCents: null,
    confirmedAmountCents: null,
    confirmedAt: null,
    confirmedBy: null,
  };
  return {
    id: "11111111-1111-4111-8111-111111111111",
    reference: "PAY-2026-0001",
    quoteNumber: "QTN-1",
    specialist: { name: "Sam", phone: "" },
    customer: { firstName: "Test", lastName: "Customer", phone: "", email: "", addressLine1: "", suburb: "", state: "VIC", postcode: "" },
    items: [],
    currency: "AUD",
    balanceDueCents: 10_000,
    outstandingCents: 5_000,
    overpaymentCents: 0,
    expectedDepositCents: null,
    stage: "working_in_progress",
    workMode: null,
    contract: null,
    deposit: { ...receipt },
    deliverySelections: [],
    deliveryPreparedAt: null,
    deliveryPreparedBy: null,
    deliveryScheduleRequest: null,
    deliveryScheduledFor: null,
    deliveryScheduledTime: null,
    deliveryAssignee: null,
    deliveredAt: null,
    collection: { ...receipt },
    installationScheduleRequest: null,
    installationScheduledFor: null,
    installationScheduledTime: null,
    installationAssignee: null,
    finalPayments: [],
    installedAt: null,
    solarPanelConsumption: null,
    coesReceivedAt: null,
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
    solarRebateQrRequired: false,
    solarRebateQrConfirmedAt: null,
    solarRebateQrConfirmedBy: null,
    solarRebateQrCode: null,
    stcSolarReceivedAt: null,
    stcBatteryReceivedAt: null,
    solarRebateReceivedAt: null,
    pmNotes: "",
    pmNotesUpdatedAt: null,
    pmNotesUpdatedBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    history: [],
    ...overrides,
  };
}

function privacy(overrides: Partial<Parameters<typeof projectTrackAgentView>[1]> = {}) {
  return {
    includeAssignee: false,
    includeLocation: false,
    includeCustomerContactDetails: false,
    includePmNotes: false,
    ...overrides,
  };
}

test("derives the WIP unscheduled, scheduled, delivered and installed states", () => {
  const unscheduled = project({ workMode: "delivery_and_installation" });
  assert.equal(agentProjectWorkflowStatus(unscheduled), "unscheduled");

  const scheduled = project({
    workMode: "delivery_and_installation",
    deliveryScheduledFor: "2026-08-28",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-08-28",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  });
  assert.equal(agentProjectWorkflowStatus(scheduled), "scheduled");
  assert.equal(agentDeliveryScheduleState(scheduled), "scheduled");
  assert.equal(agentInstallationScheduleState(scheduled), "scheduled");

  assert.equal(agentProjectWorkflowStatus(project({ workMode: "delivery_only", deliveredAt: "2026-08-28T01:00:00.000Z" })), "delivered");
  assert.equal(agentProjectWorkflowStatus(project({ workMode: "installation_only", installedAt: "2026-08-28T02:00:00.000Z" })), "installed");
});

test("reports QR-gated WIP as waiting, then exposes confirmation facts without a file or URL", () => {
  const waiting = project({
    solarRebateQrRequired: true,
    solarRebateQrCode: null,
  });
  assert.equal(agentProjectWorkflowStatus(waiting), "waiting_for_rebate_qr_code");
  assert.equal(agentProjectMatchesWorkflowFilter(waiting, "waiting_for_rebate_qr_code"), true);
  assert.equal(agentProjectMatchesWorkflowFilter(waiting, "unscheduled"), false);

  const partialSchedule = project({
    workMode: "delivery_only",
    solarRebateQrRequired: true,
    deliveryScheduledFor: "2026-08-29",
  });
  assert.equal(agentProjectWorkflowStatus(partialSchedule), "waiting_for_rebate_qr_code");
  assert.equal(agentProjectMatchesWorkflowFilter(partialSchedule, "unscheduled"), false);

  const confirmed = project({
    solarRebateQrRequired: true,
    solarRebateQrConfirmedAt: "2026-08-28T02:00:00.000Z",
    solarRebateQrConfirmedBy: "Kevin PM",
  });
  assert.equal(agentProjectWorkflowStatus(confirmed), "unscheduled");
  const confirmedView = projectTrackAgentView(confirmed, privacy());
  assert.equal(confirmedView.solarRebateQrConfirmedAt, "2026-08-28T02:00:00.000Z");
  assert.equal(confirmedView.solarRebateQrConfirmedBy, "Kevin PM");
  assert.equal("solarRebateQrUploadedAt" in confirmedView, false);
  assert.equal("solarRebateQrCode" in confirmedView, false);

  const legacyUploaded = project({
    solarRebateQrRequired: true,
    solarRebateQrCode: {
      id: "rebate-qr-1",
      kind: "solar_rebate_qr_code",
      originalName: "customer-rebate-qr.png",
      contentType: "image/png",
      size: 512,
      url: "/api/payment-track/secret-project/files/rebate-qr-1?token=private-secret",
      uploadedAt: "2026-08-28T03:00:00.000Z",
      uploadedByRole: "pm",
    },
  });
  assert.equal(agentProjectWorkflowStatus(legacyUploaded), "unscheduled");
  const view = projectTrackAgentView(legacyUploaded, privacy({
    includeAssignee: true,
    includeLocation: true,
    includeCustomerContactDetails: true,
    includePmNotes: true,
  }));
  assert.equal(view.workflowStatus, "unscheduled");
  assert.equal(view.solarRebateQrRequired, true);
  assert.equal(view.solarRebateQrConfirmedAt, "2026-08-28T03:00:00.000Z");
  assert.equal(view.solarRebateQrConfirmedBy, "pm");
  assert.equal("solarRebateQrUploadedAt" in view, false);
  assert.equal("solarRebateQrCode" in view, false);
  assert.doesNotMatch(JSON.stringify(view), /private-secret|secret-project|customer-rebate-qr\.png/);
});

test("preserves legacy pre-scheduled state and exposes complete schedule facts", () => {
  const value = project({
    stage: "material_delivery",
    workMode: null,
    deliverySelections: [{ sku: "PANEL-475", quantity: 12 }],
    deliveryScheduleRequest: {
      preferredDate: "2026-09-01",
      preferredTime: "10:30",
      notes: "Gate access",
      submittedAt: "2026-08-28T00:00:00.000Z",
      submittedBy: "Sam",
    },
  });
  assert.equal(agentDeliveryScheduleState(value), "pre_scheduled");
  assert.equal(agentProjectWorkflowStatus(value), "pre_scheduled");
  const view = projectTrackAgentView(value, privacy());
  assert.equal(view.workflowStatus, "pre_scheduled");
  assert.deepEqual(view.schedule.delivery.chosenWarehouseItems, [{ sku: "PANEL-475", quantity: 12 }]);
  assert.equal(view.schedule.delivery.request?.preferredTime, "10:30");
  assert.equal("notes" in (view.schedule.delivery.request || {}), false);
  assert.ok(projectTrackScheduleSearchValues(value, false).includes("PANEL-475"));
  assert.equal("phone" in view.customer, false);
  assert.equal("pmNotes" in view, false);
});

test("projects expose assignee, location and customer contact details independently", () => {
  const value = project({
    customer: {
      firstName: "Private",
      lastName: "Customer",
      phone: "0400000000",
      email: "private@example.com",
      addressLine1: "1 Hidden Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    deliveryScheduledFor: "2026-08-28",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    deliveryScheduleRequest: {
      preferredDate: "2026-08-28",
      preferredTime: "09:00",
      notes: "Private note",
      submittedAt: "2026-08-27T00:00:00.000Z",
      submittedBy: "Sam",
    },
  });

  const assigneeOnly = projectTrackAgentView(value, privacy({ includeAssignee: true }));
  assert.equal(assigneeOnly.schedule.delivery.assignee, "Leo");
  assert.equal("phone" in assigneeOnly.customer, false);
  assert.equal("email" in assigneeOnly.customer, false);
  assert.equal("address" in assigneeOnly.customer, false);
  assert.equal("submittedBy" in (assigneeOnly.schedule.delivery.request || {}), false);

  const locationOnly = projectTrackAgentView(value, privacy({ includeLocation: true }));
  assert.match(locationOnly.customer.address || "", /Hidden Street/);
  assert.equal("phone" in locationOnly.customer, false);
  assert.equal("email" in locationOnly.customer, false);
  assert.equal("assignee" in locationOnly.schedule.delivery, false);

  const contactOnly = projectTrackAgentView(value, privacy({ includeCustomerContactDetails: true }));
  assert.equal(contactOnly.customer.phone, "0400000000");
  assert.equal(contactOnly.customer.email, "private@example.com");
  assert.equal("address" in contactOnly.customer, false);
  assert.equal("assignee" in contactOnly.schedule.delivery, false);

  assert.equal(projectTrackScheduleSearchValues(value, false).includes("Leo"), false);
  assert.equal(projectTrackScheduleSearchValues(value, true).includes("Leo"), true);
  assert.equal(projectTrackScheduleSearchValues(value, true).includes("Sam"), false, "request submitters are not assignees");
});

test("keeps delivered and installed completion facts searchable after automatic stage advancement", () => {
  const advanced = project({
    stage: "waiting_coes",
    workMode: "delivery_and_installation",
    deliveredAt: "2026-08-28T01:00:00.000Z",
    installedAt: "2026-08-28T02:00:00.000Z",
  });
  assert.equal(agentProjectWorkflowStatus(advanced), "waiting_coes");
  assert.equal(agentProjectMatchesWorkflowFilter(advanced, "delivered"), true);
  assert.equal(agentProjectMatchesWorkflowFilter(advanced, "installed"), true);
  assert.equal(agentProjectMatchesWorkflowFilter(advanced, "scheduled"), false);
});

test("removes Project Track intent words without losing a customer search term", () => {
  const genericQueries = [
    "Show deposit not paid projects in Project Track",
    "Show pre-scheduled projects in Project Track",
    "Who is assigned to projects in Project Track?",
    "Show items and notes in Project Track",
    "Show combined WIP projects in Project Track",
    "check Working in Progress",
    "Show all outstanding balances",
    "What is the total amount due?",
    "Please show all projects in Project Track",
    "Can you list the Project Track projects?",
    "Can you tell me all outstanding balances?",
    "Could you please show all outstanding balances?",
    "Would you tell me the total amount due?",
    "Can I see all outstanding balances?",
    "Could you let me see all outstanding balances?",
    "Would you let me know the total amount due?",
    "Please let me see all projects in Project Track",
    "Are there any unscheduled Project Track jobs?",
    "Give me a Project Track report with the current project count",
    "给我项目追踪概况",
    "检查所有 WIP 项目",
    "请问尾款总额是多少？",
    "查看进行中的项目",
    "目前项目追踪有哪些项目？",
    "请显示所有项目追踪记录和详情",
  ];
  for (const query of genericQueries) {
    assert.deepEqual(projectTrackAgentSearchTerms(query), [], query);
  }

  assert.deepEqual(projectTrackAgentSearchTerms("Which project has chosen SKU CQ7?"), ["cq7"]);
  assert.deepEqual(projectTrackAgentSearchTerms("显示 Sam 的项目"), ["sam"]);
  assert.deepEqual(projectTrackAgentSearchTerms("Show Ian in Project Track"), ["ian"]);
  assert.deepEqual(projectTrackAgentSearchTerms("Please show Ian's Project Track details"), ["ian"]);
  assert.deepEqual(projectTrackAgentSearchTerms("Can you find PAY-2026-0031 in Project Track?"), ["pay-2026-0031"]);
  assert.deepEqual(projectTrackAgentSearchTerms("请查看 Sam 的项目详情"), ["sam"]);
});

test("generic Project Track wording cannot accidentally reject every repository row", () => {
  const repositorySearchValues = [
    "pay-2026-0031 qn202605050003 ian lehmann sam cq7-l4 working_in_progress",
    "pay-2026-0042 cpec5256 amit singh kadian ruihan kh10 waiting_coes",
  ];
  const queries = [
    "check Working in Progress",
    "Show all outstanding balances",
    "What is the total amount due?",
    "Are there any WIP projects?",
    "请问目前进行中的项目有哪些？",
  ];

  for (const query of queries) {
    const terms = projectTrackAgentSearchTerms(query);
    const matched = repositorySearchValues.filter((value) => (
      terms.every((term) => value.includes(term))
    ));
    assert.deepEqual(matched, repositorySearchValues, query);
  }
});

test("recognizes exact WIP work-mode filters independently of free-text search", () => {
  assert.equal(agentProjectWorkModeFilter("Show combined WIP projects"), "delivery_and_installation");
  assert.equal(agentProjectWorkModeFilter("Show delivery-only projects"), "delivery_only");
  assert.equal(agentProjectWorkModeFilter("只安装的项目"), "installation_only");
  assert.equal(agentProjectWorkModeFilter("Show delivery projects"), null);
});

test("only widens contact scope for an explicit assignee question", () => {
  assert.equal(agentQueryExplicitlyRequestsAssignee("Who has unscheduled projects?"), false);
  assert.equal(agentQueryExplicitlyRequestsAssignee("谁的项目未排期？"), false);
  assert.equal(agentQueryExplicitlyRequestsAssignee("Who is assigned on tomorrow's schedule?"), true);
  assert.equal(agentQueryExplicitlyRequestsAssignee("Who is installing tomorrow?"), true);
  assert.equal(agentQueryExplicitlyRequestsAssignee("明天送货人是谁？"), true);
});
