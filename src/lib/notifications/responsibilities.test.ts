import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentTrackProject } from "../payment-track/types";

const responsibilitiesModule = "./responsibilities.ts";
const { paymentTrackResponsibilities } = await import(responsibilitiesModule) as typeof import("./responsibilities");

function project(overrides: Partial<PaymentTrackProject> = {}): PaymentTrackProject {
  return {
    id: "PAY-TEST-1",
    reference: "PAY-TEST-1",
    quoteNumber: "PROP-1",
    specialist: { name: "Specialist", phone: "0400000000" },
    customer: {
      firstName: "Test",
      lastName: "Customer",
      phone: "0400000001",
      email: "customer@example.com",
      addressLine1: "1 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [],
    currency: "AUD",
    balanceDueCents: 10_000,
    outstandingCents: 8_000,
    overpaymentCents: 0,
    expectedDepositCents: 2_000,
    stage: "deposit_not_paid",
    workMode: null,
    contract: null,
    deposit: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      reportedAmountCents: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    deliverySelections: [],
    deliveryPreparedAt: null,
    deliveryPreparedBy: null,
    deliveryScheduleRequest: null,
    deliveryScheduledFor: null,
    deliveryScheduledTime: null,
    deliveryAssignee: null,
    deliveredAt: null,
    collection: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      reportedAmountCents: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    installationScheduledFor: null,
    installationScheduledTime: null,
    installationAssignee: null,
    installationScheduleRequest: null,
    finalPayments: [],
    installedAt: null,
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
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    completedAt: null,
    history: [],
    ...overrides,
  };
}

function summary(value: PaymentTrackProject) {
  return paymentTrackResponsibilities(value).map(({ action, role }) => `${role}:${action}`);
}

function scheduleRequest(overrides: Partial<NonNullable<PaymentTrackProject["deliveryScheduleRequest"]>> = {}) {
  return {
    preferredDate: "2026-09-04",
    preferredTime: "09:30",
    notes: "Customer prefers a morning appointment.",
    submittedAt: "2026-08-24T03:00:00.000Z",
    submittedBy: "Sales Owner",
    ...overrides,
  };
}

test("deposit work stays with Sales until evidence is submitted, then moves to Admin", () => {
  assert.deepEqual(summary(project()), ["sales:upload_deposit_proof"]);
  assert.deepEqual(summary(project({
    deposit: {
      ...project().deposit,
      proof: { id: "proof-1" } as PaymentTrackProject["deposit"]["proof"],
    },
  })), ["admin:confirm_deposit"]);
});

test("delivery work moves from Sales pre-scheduling to PM review and final schedule management", () => {
  assert.deepEqual(summary(project({ stage: "material_delivery" })), ["sales:pre_schedule_delivery"]);
  assert.deepEqual(summary(project({
    stage: "material_delivery",
    deliveryScheduleRequest: scheduleRequest(),
    deliverySelections: [{ sku: "SKU-DELIVERY", quantity: 1 }],
  })), ["pm:review_delivery_pre_schedule"]);
  assert.deepEqual(summary(project({
    stage: "material_delivery",
    deliveryScheduledFor: "2026-09-05",
    deliveryScheduledTime: "10:00",
    deliveryAssignee: "Leo",
  })), ["pm:manage_delivery"]);
});

test("delivery collection moves from Sales to Admin after delivery", () => {
  assert.deepEqual(summary(project({
    stage: "material_delivery",
    deliveredAt: "2026-08-24T01:00:00.000Z",
  })), ["sales:record_collection"]);
  assert.deepEqual(summary(project({
    stage: "material_delivery",
    deliveredAt: "2026-08-24T01:00:00.000Z",
    collection: {
      ...project().collection,
      acknowledgedAt: "2026-08-24T02:00:00.000Z",
    },
  })), ["admin:confirm_collection"]);
});

test("outstanding projects keep Sales collection open while Admin verifies pending receipts", () => {
  assert.deepEqual(summary(project({ stage: "waiting_coes" })), [
    "sales:record_final_payment",
  ]);

  const pendingPayment = {
    ...project().deposit,
    id: "payment-1",
    createdAt: "2026-08-24T02:00:00.000Z",
    acknowledgedAt: "2026-08-24T02:00:00.000Z",
  };
  assert.deepEqual(summary(project({
    stage: "waiting_coes",
    finalPayments: [pendingPayment],
  })), [
    "admin:confirm_final_payment",
    "sales:record_final_payment",
  ]);
});

test("Administrator receipt work remains independent from Sales final-payment responsibility", () => {
  assert.deepEqual(summary(project({
    stage: "stc_rebate",
    stcSolarRequired: true,
    stcBatteryRequired: true,
    solarRebateRequired: true,
  })), [
    "admin:confirm_solar_stc",
    "admin:confirm_battery_stc",
    "admin:confirm_solar_rebate",
    "sales:record_final_payment",
  ]);
});

test("paid projects produce no payment action", () => {
  assert.deepEqual(summary(project({ stage: "done", outstandingCents: 0 })), []);
});

test("every pending Sales payment still requires Admin confirmation after the balance reaches zero", () => {
  const base = project().deposit;
  const confirmed = {
    ...base,
    id: "payment-1",
    createdAt: "2026-08-27T01:00:00.000Z",
    acknowledgedAt: "2026-08-27T01:00:00.000Z",
    reportedAmountCents: 2_000,
    confirmedAmountCents: 8_000,
    confirmedAt: "2026-08-27T02:00:00.000Z",
    confirmedBy: "Administrator",
  };
  const pending = {
    ...base,
    id: "payment-2",
    createdAt: "2026-08-27T01:30:00.000Z",
    acknowledgedAt: "2026-08-27T01:30:00.000Z",
    reportedAmountCents: 1_000,
  };
  assert.deepEqual(paymentTrackResponsibilities(project({
    stage: "done",
    outstandingCents: 0,
    finalPayments: [confirmed, pending],
  })), [{ action: "confirm_final_payment", role: "admin", paymentId: "payment-2" }]);
  assert.deepEqual(summary(project({
    stage: "done",
    outstandingCents: 0,
    finalPayments: [confirmed, {
      ...pending,
      confirmedAmountCents: 0,
      confirmedAt: "2026-08-27T03:00:00.000Z",
      confirmedBy: "Administrator",
    }],
  })), []);
});

test("WIP keeps PM scheduling and continuous payment responsibilities independent", () => {
  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    workMode: null,
  })), [
    "pm:manage_work",
    "sales:record_final_payment",
  ]);

  const pending = {
    ...project().deposit,
    id: "payment-wip-1",
    createdAt: "2026-08-27T02:00:00.000Z",
    acknowledgedAt: "2026-08-27T02:00:00.000Z",
    reportedAmountCents: 2_000,
  };
  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    workMode: "delivery_and_installation",
    finalPayments: [pending],
  })), [
    "pm:manage_work",
    "admin:confirm_final_payment",
    "sales:record_final_payment",
  ]);
});

test("Solar Rebate WIP assigns QR receipt confirmation to PM before normal work management", () => {
  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    solarRebateQrRequired: true,
    solarRebateQrCode: null,
  })), [
    "pm:confirm_rebate_qr_received",
    "sales:record_final_payment",
  ]);

  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    solarRebateQrRequired: true,
    solarRebateQrConfirmedAt: "2026-08-27T03:00:00.000Z",
    solarRebateQrConfirmedBy: "Kevin PM",
  })), [
    "pm:manage_work",
    "sales:record_final_payment",
  ]);

  // Do not regress historical inconsistent records that were already fully
  // scheduled before the confirmation fields existed.
  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    workMode: "delivery_only",
    solarRebateQrRequired: true,
    deliveryScheduledFor: "2026-08-29",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  })), [
    "pm:manage_work",
    "sales:record_final_payment",
  ]);

  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    workMode: "delivery_only",
    solarRebateQrRequired: true,
    deliveryScheduledFor: "2026-08-29",
  })), [
    "pm:confirm_rebate_qr_received",
    "sales:record_final_payment",
  ], "a partial historical schedule must not bypass QR receipt confirmation");

  const completeCombinedSchedule = {
    stage: "working_in_progress" as const,
    workMode: "delivery_and_installation" as const,
    solarRebateQrRequired: true,
    deliveryScheduledFor: "2026-08-29",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo" as const,
    installationScheduledFor: "2026-08-29",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel" as const,
  };
  assert.deepEqual(summary(project(completeCombinedSchedule)), [
    "pm:manage_work",
    "sales:record_final_payment",
  ]);
  assert.deepEqual(summary(project({
    ...completeCombinedSchedule,
    installationScheduledTime: "10:00",
  })), [
    "pm:confirm_rebate_qr_received",
    "sales:record_final_payment",
  ], "a mismatched combined schedule must not bypass QR receipt confirmation");

  // A historical uploaded file remains an effective receipt confirmation.
  assert.deepEqual(summary(project({
    stage: "working_in_progress",
    solarRebateQrRequired: true,
    solarRebateQrCode: {
      id: "rebate-qr-1",
      kind: "solar_rebate_qr_code",
      originalName: "solar-rebate-qr.png",
      contentType: "image/png",
      size: 512,
      url: "/api/payment-track/project-1/files/rebate-qr-1?token=private",
      uploadedAt: "2026-08-27T03:00:00.000Z",
      uploadedByRole: "pm",
    },
  })), [
    "pm:manage_work",
    "sales:record_final_payment",
  ]);
});

test("installation work moves from Sales pre-scheduling to PM review and final schedule management", () => {
  assert.deepEqual(summary(project({ stage: "installing" })), ["sales:pre_schedule_installation"]);
  assert.deepEqual(summary(project({
    stage: "installing",
    installationScheduleRequest: scheduleRequest(),
  })), ["pm:review_installation_pre_schedule"]);
  assert.deepEqual(summary(project({
    stage: "installing",
    installationScheduledFor: "2026-09-06",
    installationScheduledTime: "08:00",
    installationAssignee: "Daniel",
  })), ["pm:manage_installation"]);
});

test("PM responsibility is limited to reviewed or scheduled incomplete delivery and installation work", () => {
  assert.equal(summary(project({ stage: "material_delivery" })).some((entry) => entry.startsWith("pm:")), false);
  assert.equal(summary(project({ stage: "installing" })).some((entry) => entry.startsWith("pm:")), false);
  assert.deepEqual(summary(project({
    stage: "material_delivery",
    deliveryScheduleRequest: scheduleRequest(),
    deliverySelections: [{ sku: "SKU-DELIVERY", quantity: 1 }],
  })), ["pm:review_delivery_pre_schedule"]);
  assert.deepEqual(summary(project({
    stage: "installing",
    installationScheduleRequest: scheduleRequest(),
  })), ["pm:review_installation_pre_schedule"]);
  assert.equal(summary(project({ stage: "material_delivery", deliveredAt: "2026-08-24T01:00:00.000Z" }))
    .some((entry) => entry.startsWith("pm:")), false);
  assert.deepEqual(summary(project({ stage: "installing", installedAt: "2026-08-24T01:00:00.000Z" })), []);
  assert.equal(summary(project({ stage: "waiting_coes" })).some((entry) => entry.startsWith("pm:")), false);
});
