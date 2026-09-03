import assert from "node:assert/strict";
import test from "node:test";
import type { Order } from "../../inventory-operations/types";
import type { PaymentTrackProject } from "../../payment-track/types";
import type { ProjectScheduleJob, ProjectScheduleSourceOverride } from "../../project-schedule/types";
import type { SiteVisit } from "../../site-visits/types";

const modulePath = "./weekly-schedule.ts";
const {
  aggregateWeeklySchedule,
  normalizedWeeklyScheduleArgs,
  weeklyScheduleKindFromMessage,
  weeklyScheduleTextQuery,
} = await import(modulePath) as typeof import("./weekly-schedule");
const toolRoutingModulePath = "./tool-routing.ts";
const { isWeeklyPeriodFactIntent } = await import(toolRoutingModulePath) as typeof import("./tool-routing");

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
    quoteNumber: "CPEC-1001",
    specialist: { name: "Sam", phone: "" },
    customer: {
      firstName: "Test",
      lastName: "Customer",
      phone: "0400000000",
      email: "test@example.com",
      addressLine1: "1 Hidden Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [{ id: "item-1", category: "Battery", description: "Battery", model: "CQ7", quantity: 1, capacity: "27 kWh" }],
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
    pmNotes: "Private PM note",
    pmNotesUpdatedAt: null,
    pmNotesUpdatedBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    completedAt: null,
    history: [],
    ...overrides,
  };
}

function siteVisit(overrides: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    createdBy: "Kevin",
    projectName: "Site Alpha",
    address: "5 Private Avenue",
    contact: "Customer phone details",
    reason: "Roof inspection",
    requestedDate: "2026-08-27",
    requestedTime: "10:00",
    scheduledDate: "2026-08-28",
    scheduledTime: "10:00",
    assignee: "Hogan",
    status: "scheduled",
    approvedAt: null,
    approvedBy: null,
    scheduledAt: null,
    scheduledBy: null,
    cancelledFrom: null,
    checklist: [],
    notes: "Visit note",
    photos: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

function args(overrides: Partial<NonNullable<ReturnType<typeof normalizedWeeklyScheduleArgs>>> = {}) {
  return {
    query: "",
    source: "all" as const,
    kind: "all" as const,
    status: "all" as const,
    from: "2026-08-24",
    to: "2026-08-30",
    limit: 20,
    includeAssignee: false,
    includeLocation: false,
    includeCustomerContactDetails: false,
    includeNotes: false,
    ...overrides,
  };
}

test("strictly normalizes bounded weekly schedule arguments", () => {
  assert.deepEqual(normalizedWeeklyScheduleArgs({
    query: "  battery  ",
    source: "project_track",
    kind: "material_delivery",
    status: "pre_scheduled",
    from: "2026-08-01",
    to: "2026-08-31",
    limit: 10,
    include_assignee: false,
    include_location: true,
    include_customer_contact_details: false,
    include_notes: true,
  }), {
    query: "battery",
    source: "project_track",
    kind: "material_delivery",
    status: "pre_scheduled",
    from: "2026-08-01",
    to: "2026-08-31",
    limit: 10,
    includeAssignee: false,
    includeLocation: true,
    includeCustomerContactDetails: false,
    includeNotes: true,
  });
  assert.equal(normalizedWeeklyScheduleArgs({
    query: "",
    source: "all",
    kind: "all",
    status: "all",
    from: "2026-01-01",
    to: "2027-01-03",
    limit: 10,
    include_assignee: false,
    include_location: false,
    include_customer_contact_details: false,
    include_notes: false,
  }), null);
  assert.equal(normalizedWeeklyScheduleArgs({
    query: "",
    source: "all",
    kind: "all",
    status: "all",
    from: "2026-08-01",
    to: "2026-08-31",
    limit: 10,
    include_assignee: false,
    include_location: false,
    include_customer_contact_details: false,
    include_notes: false,
    unexpected: true,
  }), null);
  assert.equal(normalizedWeeklyScheduleArgs({
    query: "",
    source: "all",
    kind: "all",
    status: "all",
    from: "2026-08-01",
    to: "2026-08-31",
    limit: 10,
    include_contact_details: true,
    include_notes: false,
  }), null, "the former bundled PII flag must not be accepted");
});

test("extracts customer and item terms from natural Weekly Schedule questions", () => {
  assert.equal(weeklyScheduleTextQuery("Show Amit Singh's weekly schedule"), "amit singh");
  assert.equal(weeklyScheduleTextQuery("Show battery deliveries this week"), "battery");
  assert.equal(weeklyScheduleTextQuery("显示 Amit 的送货安排"), "amit");
  assert.equal(weeklyScheduleTextQuery("本周完成情况"), "");
  assert.equal(weeklyScheduleTextQuery("总结上周完成工作概况"), "");
  assert.equal(weeklyScheduleTextQuery("上周一共有几单都做了什么"), "");
  assert.equal(weeklyScheduleTextQuery("上周一共有几条"), "");
  assert.equal(weeklyScheduleTextQuery("What did we complete last week?"), "");
  assert.equal(weeklyScheduleTextQuery("What did we finish last week?"), "");
  assert.equal(weeklyScheduleTextQuery("What did the team finish last week?"), "");
  assert.equal(weeklyScheduleTextQuery("What did we do last week?"), "");
  assert.equal(weeklyScheduleTextQuery("How many work items did the team finish last week?"), "");
  assert.equal(weeklyScheduleTextQuery("Last week status"), "");
  assert.equal(weeklyScheduleTextQuery("Summary for last week"), "");
  assert.equal(weeklyScheduleTextQuery("本周业务总结"), "");
  assert.equal(weeklyScheduleTextQuery("上周完成了哪些"), "");
  assert.equal(weeklyScheduleTextQuery("上周完成了什么"), "");
  assert.equal(weeklyScheduleTextQuery("上周都完成了哪些任务"), "");
  assert.equal(weeklyScheduleTextQuery("上周做了哪些工作"), "");
  assert.equal(weeklyScheduleTextQuery("王有才上周完成情况"), "王有才");
  assert.equal(weeklyScheduleTextQuery("单伟上周完成情况"), "单伟");
  assert.equal(weeklyScheduleTextQuery("成都上周完成情况"), "成都");
  assert.equal(weeklyScheduleTextQuery("都市能源上周完成情况"), "都市能源");
  assert.equal(weeklyScheduleTextQuery("都明上周完成情况"), "都明");
  assert.equal(weeklyScheduleTextQuery("Lien Se Do上周完成了吗"), "lien se do");
  assert.equal(weeklyScheduleTextQuery("Which customers had deliveries last week?"), "");
  assert.equal(weeklyScheduleTextQuery("Which customer deliveries were completed last week?"), "");
  assert.equal(weeklyScheduleTextQuery("Who had installations last week?"), "");
  assert.equal(weeklyScheduleTextQuery("显示上周库存送货"), "");
  assert.equal(weeklyScheduleTextQuery("Show installations this week"), "");
  assert.equal(weeklyScheduleTextQuery("Who is assigned on tomorrow's schedule?"), "");
  assert.equal(weeklyScheduleTextQuery("Show CPEC5256 on the Weekly Schedule"), "cpec5256");
  assert.equal(weeklyScheduleTextQuery("Show deliver and install work this week"), "");
  assert.equal(weeklyScheduleKindFromMessage("Show installations this week"), "installment");
  assert.equal(weeklyScheduleKindFromMessage("Show deliver and install work this week"), "deliver_and_install");
  assert.equal(weeklyScheduleKindFromMessage("Show battery deliveries this week"), "material_delivery");
  assert.equal(weeklyScheduleKindFromMessage("显示本周送货和安装"), "deliver_and_install");
  assert.equal(weeklyScheduleKindFromMessage("Show delivered this week"), "material_delivery");
  assert.equal(weeklyScheduleKindFromMessage("Show installed this week"), "installment");
});

test("source-specific schedule kinds take priority over incidental work words", () => {
  assert.equal(weeklyScheduleKindFromMessage("Show site visit installation notes"), "site_visit");
  assert.equal(weeklyScheduleKindFromMessage("Show custom installation jobs"), "custom");
});

test("derives WIP and legacy pending, scheduled and completed Project Track entries", () => {
  const wipUnscheduled = project({ workMode: null });
  const combinedScheduled = project({
    id: "22222222-2222-4222-8222-222222222222",
    quoteNumber: "CPEC-2002",
    customer: { ...project().customer, firstName: "Combined" },
    workMode: "delivery_and_installation",
    deliverySelections: [{ sku: "BAT-CQ7", quantity: 1 }],
    deliveryScheduledFor: "2026-08-27",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-08-27",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  });
  const completedDelivery = project({
    id: "33333333-3333-4333-8333-333333333333",
    quoteNumber: "CPEC-3003",
    customer: { ...project().customer, firstName: "Delivered" },
    stage: "waiting_coes",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-26",
    deliveryScheduledTime: "10:00",
    deliveryAssignee: "Leo",
    deliveredAt: "2026-08-26T03:00:00.000Z",
  });
  const legacyPreScheduled = project({
    id: "44444444-4444-4444-8444-444444444444",
    quoteNumber: "CPEC-4004",
    customer: { ...project().customer, firstName: "Legacy" },
    stage: "material_delivery",
    workMode: null,
    deliverySelections: [{ sku: "PANEL-475", quantity: 14 }],
    deliveryScheduleRequest: {
      preferredDate: "2026-09-15",
      preferredTime: "11:30",
      notes: "Use rear gate",
      submittedAt: "2026-08-28T00:00:00.000Z",
      submittedBy: "Sam",
    },
  });
  const result = aggregateWeeklySchedule({
    projects: [wipUnscheduled, combinedScheduled, completedDelivery, legacyPreScheduled],
  }, args({ source: "project_track" }));

  assert.deepEqual(result.entries.map(({ reference, status, kind }) => ({ reference, status, kind })), [
    { reference: "CPEC-4004", status: "pre_scheduled", kind: "material_delivery" },
    { reference: "CPEC-1001", status: "unscheduled", kind: "deliver_and_install" },
    { reference: "CPEC-3003", status: "completed", kind: "material_delivery" },
    { reference: "CPEC-2002", status: "scheduled", kind: "deliver_and_install" },
  ]);
  assert.equal(result.entries[0].preferredDate, "2026-09-15");
  assert.equal(result.entries[0].scheduledDate, null, "pre-scheduled work remains in the persistent pending column");
});

test("excludes QR-gated WIP until receipt confirmation, then emits exactly one unscheduled entry", () => {
  const waiting = project({
    solarRebateQrRequired: true,
    solarRebateQrCode: null,
  });
  const waitingResult = aggregateWeeklySchedule(
    { projects: [waiting] },
    args({ source: "project_track" }),
  );
  assert.equal(waitingResult.count, 0);
  assert.equal(waitingResult.pendingCount, 0);
  assert.equal(waitingResult.statusCounts.unscheduled, 0);
  assert.deepEqual(waitingResult.entries, []);

  const partialScheduleResult = aggregateWeeklySchedule(
    { projects: [project({
      workMode: "delivery_only",
      solarRebateQrRequired: true,
      deliveryScheduledFor: "2026-08-29",
    })] },
    args({ source: "project_track" }),
  );
  assert.equal(partialScheduleResult.count, 0);
  assert.equal(partialScheduleResult.pendingCount, 0);
  assert.deepEqual(partialScheduleResult.entries, []);

  const confirmed = project({
    solarRebateQrRequired: true,
    solarRebateQrConfirmedAt: "2026-08-28T02:00:00.000Z",
    solarRebateQrConfirmedBy: "Kevin PM",
  });
  const confirmedResult = aggregateWeeklySchedule(
    { projects: [confirmed] },
    args({ source: "project_track" }),
  );
  assert.equal(confirmedResult.count, 1);
  assert.equal(confirmedResult.pendingCount, 1);
  assert.equal(confirmedResult.statusCounts.unscheduled, 1);
  assert.deepEqual(confirmedResult.entries.map(({ reference, status, kind }) => ({ reference, status, kind })), [
    { reference: "CPEC-1001", status: "unscheduled", kind: "deliver_and_install" },
  ]);

  // Historical file-based confirmation remains compatible.
  const legacyUploaded = project({
    solarRebateQrRequired: true,
    solarRebateQrCode: {
      id: "rebate-qr-1",
      kind: "solar_rebate_qr_code",
      originalName: "solar-rebate-qr.png",
      contentType: "image/png",
      size: 512,
      url: "/api/payment-track/project-1/files/rebate-qr-1?token=private",
      uploadedAt: "2026-08-28T03:00:00.000Z",
      uploadedByRole: "pm",
    },
  });
  const legacyResult = aggregateWeeklySchedule(
    { projects: [legacyUploaded] },
    args({ source: "project_track" }),
  );
  assert.equal(legacyResult.count, 1);
  assert.equal(legacyResult.pendingCount, 1);
  assert.equal(legacyResult.statusCounts.unscheduled, 1);
  assert.deepEqual(legacyResult.entries.map(({ reference, status, kind }) => ({ reference, status, kind })), [
    { reference: "CPEC-1001", status: "unscheduled", kind: "deliver_and_install" },
  ]);
});

test("kind filtering keeps installations, combined work and battery deliveries exact", () => {
  const delivery = project({
    id: "77777777-7777-4777-8777-777777777777",
    quoteNumber: "CPEC-DELIVERY",
    customer: { ...project().customer, firstName: "Amit" },
    workMode: "delivery_only",
    deliverySelections: [{ sku: "CQ7-L4", quantity: 1 }],
    deliveryScheduledFor: "2026-08-28",
    deliveryScheduledTime: "08:00",
    deliveryAssignee: "Leo",
  });
  const installation = project({
    id: "88888888-8888-4888-8888-888888888888",
    quoteNumber: "CPEC-INSTALL",
    customer: { ...project().customer, firstName: "Installation" },
    workMode: "installation_only",
    installationScheduledFor: "2026-08-28",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  });
  const combined = project({
    id: "99999999-9999-4999-8999-999999999999",
    quoteNumber: "CPEC-COMBINED",
    customer: { ...project().customer, firstName: "Combined" },
    workMode: "delivery_and_installation",
    deliveryScheduledFor: "2026-08-28",
    deliveryScheduledTime: "10:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-08-28",
    installationScheduledTime: "10:00",
    installationAssignee: "Daniel",
  });
  const sources = { projects: [delivery, installation, combined] };

  assert.deepEqual(
    aggregateWeeklySchedule(sources, args({ kind: "installment" })).entries.map((entry) => entry.reference),
    ["CPEC-INSTALL"],
  );
  assert.deepEqual(
    aggregateWeeklySchedule(sources, args({ kind: "deliver_and_install" })).entries.map((entry) => entry.reference),
    ["CPEC-COMBINED"],
  );
  assert.deepEqual(
    aggregateWeeklySchedule(sources, args({ kind: "material_delivery", query: "battery" })).entries.map((entry) => entry.reference),
    ["CPEC-DELIVERY"],
  );
  assert.deepEqual(
    aggregateWeeklySchedule(sources, args({ kind: "material_delivery", query: "amit battery" })).entries.map((entry) => entry.reference),
    ["CPEC-DELIVERY"],
    "customer and item terms may match different fields",
  );
});

test("pending and overdue filters match the Weekly Schedule side rails", () => {
  const pending = project({ workMode: "delivery_only" });
  const overdue = project({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    quoteNumber: "CPEC-OVERDUE",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-20",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  });
  const sources = { projects: [pending, overdue] };
  assert.deepEqual(
    aggregateWeeklySchedule(sources, args({ status: "pending" })).entries.map((entry) => entry.reference),
    ["CPEC-1001"],
  );
  const overdueResult = aggregateWeeklySchedule(sources, args({ status: "overdue" }));
  assert.deepEqual(overdueResult.entries.map((entry) => entry.reference), ["CPEC-OVERDUE"]);
  assert.equal(overdueResult.overdueCount, 1);
  const allResult = aggregateWeeklySchedule(sources, args());
  assert.equal(allResult.pendingCount, 1);
  assert.equal(allResult.overdueCount, 1);
  assert.equal(allResult.count, 2);
});

test("aggregates all Weekly Schedule sources, respects overrides and gates contacts and notes", () => {
  const order = (overrides: Partial<Order> = {}): Order => ({
    id: 17,
    order_group: "group-1",
    sales_rep: "Sam",
    customer: "Inventory Customer",
    phone: "0411111111",
    sku: "INV-1",
    quantity: 2,
    created_at: "2026-08-20T00:00:00.000Z",
    status: "scheduled",
    address: "17 Secret Road",
    planned_date: "2026-08-28",
    driver: "Leo",
    delivered_at: null,
    note: "Warehouse note",
    driver_email: null,
    delivery_time: "08:30",
    ...overrides,
  });
  const visit: SiteVisit = {
    id: "55555555-5555-4555-8555-555555555555",
    createdBy: "Kevin",
    projectName: "Site Alpha",
    address: "5 Private Avenue",
    contact: "Customer phone details",
    reason: "Roof inspection",
    requestedDate: "2026-08-27",
    requestedTime: "10:00",
    scheduledDate: "2026-08-28",
    scheduledTime: "10:00",
    assignee: "Hogan",
    status: "scheduled",
    approvedAt: null,
    approvedBy: null,
    scheduledAt: null,
    scheduledBy: null,
    cancelledFrom: null,
    checklist: [],
    notes: "Visit note",
    photos: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  const custom: ProjectScheduleJob = {
    id: "custom-1",
    title: "Custom Alpha",
    scheduledDate: "2026-08-29",
    startTime: "09:00",
    endTime: "10:00",
    assignee: "Daniel",
    location: "9 Private Lane",
    notes: "Custom note",
    status: "completed",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  const overrides: ProjectScheduleSourceOverride[] = [
    { entryId: "inventory:orders:17", state: "deleted", updatedAt: "2026-08-22T00:00:00.000Z", updatedBy: "PM" },
    { entryId: `site-visit:${visit.id}`, state: "cancelled", updatedAt: "2026-08-22T00:00:00.000Z", updatedBy: "PM" },
  ];
  const hidden = aggregateWeeklySchedule({
    inventoryOrders: [order()],
    siteVisits: [visit],
    customJobs: [custom],
    sourceOverrides: overrides,
  }, args());
  assert.equal(hidden.entries.some((entry) => entry.source === "inventory"), false);
  assert.equal(hidden.entries.find((entry) => entry.source === "site_visit")?.status, "cancelled");
  assert.equal(hidden.entries.find((entry) => entry.source === "site_visit")?.createdBy, "Kevin");
  assert.equal(hidden.entries.every((entry) => !("location" in entry)
    && !("assignee" in entry)
    && !("contact" in entry)
    && !("notes" in entry)), true);

  const privateSearchIsGated = aggregateWeeklySchedule({ siteVisits: [visit] }, args({ query: "Private Avenue" }));
  assert.equal(privateSearchIsGated.count, 0);
  const locationOnly = aggregateWeeklySchedule({ siteVisits: [visit], customJobs: [custom] }, args({
    query: "Private Avenue",
    includeLocation: true,
    includeNotes: true,
  }));
  assert.equal(locationOnly.count, 1);
  assert.equal(locationOnly.entries[0].location, "5 Private Avenue");
  assert.equal("assignee" in locationOnly.entries[0], false);
  assert.equal("contact" in locationOnly.entries[0], false);
  assert.match(locationOnly.entries[0].notes || "", /Roof inspection/);
  assert.match(locationOnly.securityNotice || "", /untrusted/i);

  const assigneeOnly = aggregateWeeklySchedule({ siteVisits: [visit] }, args({
    query: "Hogan",
    includeAssignee: true,
  }));
  assert.equal(assigneeOnly.count, 1);
  assert.equal(assigneeOnly.entries[0].assignee, "Hogan");
  assert.equal("location" in assigneeOnly.entries[0], false);
  assert.equal("contact" in assigneeOnly.entries[0], false);

  const customerContactOnly = aggregateWeeklySchedule({ siteVisits: [visit] }, args({
    query: "Customer phone details",
    includeCustomerContactDetails: true,
  }));
  assert.equal(customerContactOnly.count, 1);
  assert.deepEqual(customerContactOnly.entries[0].contact, { name: "Customer phone details" });
  assert.equal("location" in customerContactOnly.entries[0], false);
  assert.equal("assignee" in customerContactOnly.entries[0], false);
});

test("every entity-free weekly period intent also produces an empty text query", () => {
  for (const message of [
    "Show completed work this week",
    "What did the team finish last week?",
    "What did we do last week?",
    "How many work items did the team finish last week?",
    "Last week status",
    "Summary for last week",
    "This week activity overview",
    "上周情况",
    "本周业务总结",
    "上周一共有几单",
    "上周有多少条",
    "上周完成了哪些",
    "上周都完成了哪些任务",
    "上周的完成了哪些",
    "上周的都完成了哪些任务",
    "上周做了哪些工作",
    "上周完成了哪些客户",
    "上周完成了哪些客户的安装",
    "上周做了哪些客户",
    "上周完成的客户有哪些",
    "上周有哪些客户完成了安装",
  ]) {
    assert.equal(isWeeklyPeriodFactIntent(message), true, message);
    assert.equal(weeklyScheduleTextQuery(message), "", message);
  }
});

test("Site Visiting keeps approval-stage requests in the pending schedule", () => {
  const pendingApproval = siteVisit({
    id: "55555555-5555-4555-8555-555555555551",
    status: "pending_approval",
    scheduledDate: null,
    scheduledTime: null,
    assignee: "",
  });
  const approved = siteVisit({
    id: "55555555-5555-4555-8555-555555555552",
    status: "approved",
    scheduledDate: null,
    scheduledTime: null,
    assignee: "",
  });
  const cancelled = siteVisit({
    id: "55555555-5555-4555-8555-555555555553",
    status: "cancelled",
    cancelledFrom: "approved",
    scheduledDate: null,
    scheduledTime: null,
    assignee: "",
  });
  const sources = { siteVisits: [pendingApproval, approved, cancelled] };
  const filter = args({ source: "site_visit", kind: "site_visit" });
  const all = aggregateWeeklySchedule(sources, filter);

  assert.equal(all.count, 3);
  assert.equal(all.entries.find(({ id }) => id.endsWith(pendingApproval.id))?.status, "unscheduled");
  assert.equal(all.entries.find(({ id }) => id.endsWith(approved.id))?.status, "pre_scheduled");
  assert.equal(all.entries.find(({ id }) => id.endsWith(cancelled.id))?.status, "cancelled");
  assert.equal(all.entries.find(({ id }) => id.endsWith(pendingApproval.id))?.scheduledDate, null);
  assert.equal(all.entries.find(({ id }) => id.endsWith(pendingApproval.id))?.preferredDate, "2026-08-27");

  const pendingOnly = aggregateWeeklySchedule(sources, { ...filter, status: "pending" });
  assert.equal(pendingOnly.count, 2);
  assert.equal(pendingOnly.pendingCount, 2);
  assert.deepEqual(new Set(pendingOnly.entries.map(({ status }) => status)), new Set(["unscheduled", "pre_scheduled"]));

  const laterWeek = aggregateWeeklySchedule(sources, {
    ...filter,
    from: "2026-09-07",
    to: "2026-09-13",
  });
  assert.equal(laterWeek.count, 2, "persistent approval-stage requests remain visible");
  assert.equal(laterWeek.entries.some(({ status }) => status === "cancelled"), false,
    "an undated cancelled visit is scoped to its requested week");
  assert.equal(aggregateWeeklySchedule(sources, {
    ...filter,
    status: "cancelled",
    from: "2026-09-07",
    to: "2026-09-13",
  }).count, 0);
});

test("projects expose assignee, location and customer contact details independently", () => {
  const scheduled = project({
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-28",
    deliveryScheduledTime: "08:00",
    deliveryAssignee: "Leo",
  });
  const assigneeOnly = aggregateWeeklySchedule({ projects: [scheduled] }, args({
    source: "project_track",
    includeAssignee: true,
  })).entries[0];
  assert.equal(assigneeOnly.assignee, "Leo");
  assert.equal("location" in assigneeOnly, false);
  assert.equal("contact" in assigneeOnly, false);

  const locationOnly = aggregateWeeklySchedule({ projects: [scheduled] }, args({
    source: "project_track",
    includeLocation: true,
  })).entries[0];
  assert.match(locationOnly.location || "", /Hidden Street/);
  assert.equal("assignee" in locationOnly, false);
  assert.equal("contact" in locationOnly, false);

  const contactOnly = aggregateWeeklySchedule({ projects: [scheduled] }, args({
    source: "project_track",
    includeCustomerContactDetails: true,
  })).entries[0];
  assert.deepEqual(contactOnly.contact, {
    phone: "0400000000",
    email: "test@example.com",
  });
  assert.equal("assignee" in contactOnly, false);
  assert.equal("location" in contactOnly, false);
});

test("date range filters dated work but retains the undated Project Track queue", () => {
  const scheduledOutsideRange = project({
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-09-10",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  });
  const pending = project({ id: "66666666-6666-4666-8666-666666666666", quoteNumber: "CPEC-PENDING" });
  const result = aggregateWeeklySchedule({ projects: [scheduledOutsideRange, pending] }, args({ source: "project_track" }));
  assert.deepEqual(result.entries.map((entry) => entry.reference), ["CPEC-PENDING"]);
});

test("strict historical ranges exclude the current undated queue and older overdue work", () => {
  const undated = project({
    id: "70000000-0000-4000-8000-000000000001",
    quoteNumber: "CPEC-CURRENT-QUEUE",
    workMode: "delivery_only",
  });
  const oldOverdue = project({
    id: "70000000-0000-4000-8000-000000000002",
    quoteNumber: "CPEC-OLD-OVERDUE",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-20",
    deliveryScheduledTime: "09:00",
  });
  const inRange = project({
    id: "70000000-0000-4000-8000-000000000003",
    quoteNumber: "CPEC-IN-RANGE",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-26",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  });
  const result = aggregateWeeklySchedule(
    { projects: [undated, oldOverdue, inRange] },
    args({ source: "project_track", strictDateRange: true }),
  );
  assert.deepEqual(result.entries.map((entry) => entry.reference), ["CPEC-IN-RANGE"]);
  assert.equal(result.count, 1);
  assert.equal(result.pendingCount, 0);
  assert.equal(result.overdueCount, 0);
});

test("preserves the complete count across tool and display pagination", () => {
  const jobs: ProjectScheduleJob[] = Array.from({ length: 25 }, (_, index) => ({
    id: `page-${String(index + 1).padStart(2, "0")}`,
    title: `Paged job ${String(index + 1).padStart(2, "0")}`,
    scheduledDate: "2026-08-26",
    startTime: "09:00",
    endTime: "10:00",
    assignee: "",
    location: "",
    notes: "",
    status: "scheduled",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  }));
  const result = aggregateWeeklySchedule(
    { customJobs: jobs },
    args({ source: "custom", kind: "custom", limit: 20 }),
  );
  assert.equal(result.count, 25);
  assert.equal(result.returned, 20);
  assert.equal(result.entries.length, 20);
  assert.equal(result.truncated, true);
  assert.equal(result.count - Math.min(result.entries.length, 10), 15,
    "the answer must report all 15 records hidden beyond its ten displayed rows");
});

test("completed combined work is represented by one combined entry", () => {
  const combined = project({
    workMode: "delivery_and_installation",
    deliveryScheduledFor: "2026-08-27",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-08-27",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
    deliveredAt: "2026-08-27T01:00:00.000Z",
    installedAt: "2026-08-27T03:00:00.000Z",
    stage: "waiting_coes",
  });
  const result = aggregateWeeklySchedule(
    { projects: [combined] },
    args({ source: "project_track", status: "completed" }),
  );
  assert.equal(result.count, 1);
  assert.equal(result.statusCounts.completed, 1);
  assert.equal(result.entries[0]?.kind, "deliver_and_install");
});

test("scopes completed Project Track work by recorded completion time while preserving its planned schedule", () => {
  const completedInRequestedWeek = [
    project({
      id: "10000000-0000-4000-8000-000000000001",
      quoteNumber: "CPEC-ACTUAL-DELIVERY",
      customer: { ...project().customer, firstName: "Delivery" },
      stage: "waiting_coes",
      workMode: "delivery_only",
      deliveryScheduledFor: "2026-08-28",
      deliveryScheduledTime: "09:00",
      deliveryAssignee: "Leo",
      deliveredAt: "2026-08-31T00:15:00.000Z",
    }),
    project({
      id: "10000000-0000-4000-8000-000000000002",
      quoteNumber: "CPEC-ACTUAL-INSTALL",
      customer: { ...project().customer, firstName: "Installation" },
      stage: "waiting_coes",
      workMode: "installation_only",
      installationScheduledFor: "2026-08-29",
      installationScheduledTime: "10:00",
      installationAssignee: "Daniel",
      installedAt: "2026-09-01T01:30:00.000Z",
    }),
    project({
      id: "10000000-0000-4000-8000-000000000003",
      quoteNumber: "CPEC-ACTUAL-COMBINED",
      customer: { ...project().customer, firstName: "Combined" },
      stage: "waiting_coes",
      workMode: "delivery_and_installation",
      deliveryScheduledFor: "2026-08-30",
      deliveryScheduledTime: "11:00",
      deliveryAssignee: "Leo",
      installationScheduledFor: "2026-08-30",
      installationScheduledTime: "11:00",
      installationAssignee: "Daniel",
      deliveredAt: "2026-09-02T00:00:00.000Z",
      installedAt: "2026-09-02T02:45:00.000Z",
    }),
  ];
  const sources = { projects: completedInRequestedWeek };
  const currentWeek = aggregateWeeklySchedule(sources, args({
    source: "project_track",
    status: "completed",
    from: "2026-08-31",
    to: "2026-09-06",
  }));

  assert.deepEqual(currentWeek.entries.map((entry) => ({
    reference: entry.reference,
    scheduledDate: entry.scheduledDate,
    completionDate: entry.completionDate,
    completionTime: entry.completionTime,
    dateBasis: entry.dateBasis,
  })), [
    {
      reference: "CPEC-ACTUAL-DELIVERY",
      scheduledDate: "2026-08-28",
      completionDate: "2026-08-31",
      completionTime: "10:15",
      dateBasis: "recorded_completion",
    },
    {
      reference: "CPEC-ACTUAL-INSTALL",
      scheduledDate: "2026-08-29",
      completionDate: "2026-09-01",
      completionTime: "11:30",
      dateBasis: "recorded_completion",
    },
    {
      reference: "CPEC-ACTUAL-COMBINED",
      scheduledDate: "2026-08-30",
      completionDate: "2026-09-02",
      completionTime: "12:45",
      dateBasis: "recorded_completion",
    },
  ]);
  assert.equal(aggregateWeeklySchedule(sources, args({
    source: "project_track",
    status: "completed",
  })).count, 0, "planned dates in the previous week must not pull later completions backwards");

  const completedBeforeRequestedWeek = project({
    id: "10000000-0000-4000-8000-000000000004",
    quoteNumber: "CPEC-EARLY-COMPLETION",
    stage: "waiting_coes",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-09-01",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    deliveredAt: "2026-08-30T01:00:00.000Z",
  });
  assert.equal(aggregateWeeklySchedule({ projects: [completedBeforeRequestedWeek] }, args({
    source: "project_track",
    status: "completed",
    from: "2026-08-31",
    to: "2026-09-06",
  })).count, 0, "a planned date in range must not include work actually completed in another week");
});

test("uses Inventory delivered_at in Melbourne time, including suffix-free UTC timestamps", () => {
  const delivered: Order = {
    id: 901,
    order_group: "actual-week-group",
    sales_rep: "Sam",
    customer: "Boundary Customer",
    phone: "",
    sku: "CQ7",
    quantity: 1,
    created_at: "2026-08-20T00:00:00.000Z",
    status: "delivered",
    address: "",
    planned_date: "2026-08-30",
    driver: "Leo",
    // D1/SQLite UTC format: this is 2026-08-31 00:30 in Melbourne.
    delivered_at: "2026-08-30 14:30:00",
    note: "",
    driver_email: null,
    delivery_time: "09:00",
  };
  const sources = { inventoryDeliveryHistory: [delivered] };
  const currentWeek = aggregateWeeklySchedule(sources, args({
    source: "inventory",
    status: "completed",
    from: "2026-08-31",
    to: "2026-09-06",
  }));

  assert.equal(currentWeek.count, 1);
  assert.equal(currentWeek.entries[0]?.scheduledDate, "2026-08-30");
  assert.equal(currentWeek.entries[0]?.completionDate, "2026-08-31");
  assert.equal(currentWeek.entries[0]?.completionTime, "00:30");
  assert.equal(currentWeek.entries[0]?.dateBasis, "recorded_completion");
  assert.equal(aggregateWeeklySchedule(sources, args({
    source: "inventory",
    status: "completed",
  })).count, 0);
});

test("orders completed work on the same day by actual completion time", () => {
  const laterActual = project({
    id: "10000000-0000-4000-8000-000000000011",
    quoteNumber: "CPEC-LATER-ACTUAL",
    stage: "waiting_coes",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-20",
    deliveryScheduledTime: "08:00",
    deliveryAssignee: "Leo",
    deliveredAt: "2026-09-01T03:00:00.000Z",
  });
  const earlierActual = project({
    id: "10000000-0000-4000-8000-000000000012",
    quoteNumber: "CPEC-EARLIER-ACTUAL",
    stage: "waiting_coes",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-20",
    deliveryScheduledTime: "17:00",
    deliveryAssignee: "Leo",
    deliveredAt: "2026-09-01T00:00:00.000Z",
  });
  const result = aggregateWeeklySchedule({ projects: [laterActual, earlierActual] }, args({
    source: "project_track",
    status: "completed",
    from: "2026-08-31",
    to: "2026-09-06",
  }));

  assert.deepEqual(result.entries.map((entry) => entry.reference), [
    "CPEC-EARLIER-ACTUAL",
    "CPEC-LATER-ACTUAL",
  ]);
});

test("uses Site Visit status update as an explicit completion proxy and labels Custom fallback dates", () => {
  const completedVisit = siteVisit({
    status: "completed",
    scheduledDate: "2026-08-28",
    updatedAt: "2026-08-31T00:45:00.000Z",
  });
  const completedCustom: ProjectScheduleJob = {
    id: "custom-completed",
    title: "Legacy custom completion",
    scheduledDate: "2026-09-02",
    startTime: "09:00",
    endTime: "10:00",
    assignee: "Daniel",
    location: "",
    notes: "",
    status: "completed",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-09-04T02:00:00.000Z",
  };
  const result = aggregateWeeklySchedule({
    siteVisits: [completedVisit],
    customJobs: [completedCustom],
  }, args({
    status: "completed",
    from: "2026-08-31",
    to: "2026-09-06",
  }));

  const visitEntry = result.entries.find((entry) => entry.source === "site_visit");
  assert.equal(visitEntry?.scheduledDate, "2026-08-28");
  assert.equal(visitEntry?.completionDate, "2026-08-31");
  assert.equal(visitEntry?.completionTime, "10:45");
  assert.equal(visitEntry?.dateBasis, "status_updated_at");
  const customEntry = result.entries.find((entry) => entry.source === "custom");
  assert.equal(customEntry?.completionDate, "2026-09-02");
  assert.equal(customEntry?.completionTime, null);
  assert.equal(customEntry?.dateBasis, "scheduled_fallback");
});

test("applies Project Track request overrides before status filtering and limiting", () => {
  const submittedAt = "2026-08-28T00:00:00.000Z";
  const pending = project({
    stage: "material_delivery",
    deliverySelections: [{ sku: "PANEL-475", quantity: 10 }],
    deliveryScheduleRequest: {
      preferredDate: "2026-09-02",
      preferredTime: "09:30",
      notes: "",
      submittedAt,
      submittedBy: "Sam",
    },
  });
  const requestToken = Math.trunc(Date.parse(submittedAt)).toString(16).padStart(12, "0").slice(-12);
  const entryId = `payment-delivery:11111111-1111-4111-8111-${requestToken}`;
  const cancelled: ProjectScheduleSourceOverride = {
    entryId,
    state: "cancelled",
    updatedAt: "2026-08-28T01:00:00.000Z",
    updatedBy: "PM",
  };
  const result = aggregateWeeklySchedule({ projects: [pending], sourceOverrides: [cancelled] }, args({
    source: "project_track",
    status: "cancelled",
    limit: 1,
  }));
  assert.equal(result.count, 1);
  assert.equal(result.returned, 1);
  assert.equal(result.statusCounts.cancelled, 1);
  assert.equal(result.sourceCounts.project_track, 1);
  assert.equal(result.entries[0].id, entryId);

  const deleted = aggregateWeeklySchedule({
    projects: [pending],
    sourceOverrides: [{ ...cancelled, state: "deleted" }],
  }, args({ source: "project_track" }));
  assert.equal(deleted.count, 0);
});
