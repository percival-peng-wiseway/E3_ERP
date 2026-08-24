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
    contract: null,
    deposit: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    deliveryScheduledFor: null,
    deliveryScheduledTime: null,
    deliveryAssignee: null,
    deliveredAt: null,
    collection: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    installationScheduledFor: null,
    installationScheduledTime: null,
    installationAssignee: null,
    finalPayments: [],
    installedAt: null,
    coesReceivedAt: null,
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
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

test("deposit work stays with Specialist until evidence is submitted, then moves to Admin", () => {
  assert.deepEqual(summary(project()), ["specialist:upload_deposit_proof"]);
  assert.deepEqual(summary(project({
    deposit: {
      ...project().deposit,
      proof: { id: "proof-1" } as PaymentTrackProject["deposit"]["proof"],
    },
  })), ["admin:confirm_deposit"]);
});

test("delivery collection moves from PM to Sales and only then to Admin", () => {
  assert.deepEqual(summary(project({ stage: "material_delivery" })), ["pm:manage_delivery"]);
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

test("an outstanding installed project notifies Sales, but does not add a PM COES reminder", () => {
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
  ]);
});

test("Specialist receipt work remains independent from final-payment responsibility", () => {
  assert.deepEqual(summary(project({
    stage: "stc_rebate",
    stcSolarRequired: true,
    stcBatteryRequired: true,
    solarRebateRequired: true,
  })), [
    "specialist:confirm_solar_stc",
    "specialist:confirm_battery_stc",
    "specialist:confirm_solar_rebate",
    "sales:record_final_payment",
  ]);
});

test("paid projects produce no payment action", () => {
  assert.deepEqual(summary(project({ stage: "done", outstandingCents: 0 })), []);
});

test("PM responsibility is limited to incomplete delivery and installation scheduling", () => {
  assert.deepEqual(summary(project({ stage: "material_delivery" })), ["pm:manage_delivery"]);
  assert.deepEqual(summary(project({ stage: "installing" })), ["pm:manage_installation"]);
  assert.equal(summary(project({ stage: "material_delivery", deliveredAt: "2026-08-24T01:00:00.000Z" }))
    .some((entry) => entry.startsWith("pm:")), false);
  assert.deepEqual(summary(project({ stage: "installing", installedAt: "2026-08-24T01:00:00.000Z" })), []);
  assert.equal(summary(project({ stage: "waiting_coes" })).some((entry) => entry.startsWith("pm:")), false);
});
