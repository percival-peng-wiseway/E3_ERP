import assert from "node:assert/strict";
import test from "node:test";
import type { Order } from "../inventory-operations/types";
import type { PaymentTrackProject } from "../payment-track/types";
import type { ProjectScheduleJob, ProjectScheduleSourceOverride } from "../project-schedule/types";
import type { SiteVisit } from "../site-visits/types";

const modulePath = "./weekly-schedule.ts";
const {
  aggregateWeeklySchedule,
  normalizedWeeklyScheduleArgs,
  weeklyScheduleKindFromMessage,
  weeklyScheduleTextQuery,
} = await import(modulePath) as typeof import("./weekly-schedule");

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

test("excludes QR-gated WIP until upload, then emits exactly one unscheduled entry", () => {
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

  const uploaded = project({
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
  const uploadedResult = aggregateWeeklySchedule(
    { projects: [uploaded] },
    args({ source: "project_track" }),
  );
  assert.equal(uploadedResult.count, 1);
  assert.equal(uploadedResult.pendingCount, 1);
  assert.equal(uploadedResult.statusCounts.unscheduled, 1);
  assert.deepEqual(uploadedResult.entries.map(({ reference, status, kind }) => ({ reference, status, kind })), [
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
