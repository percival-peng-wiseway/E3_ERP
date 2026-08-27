import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentTrackProject } from "../payment-track/types";
import type { OperationalOrder } from "./service";

const serviceModule = "./service.ts";
const {
  buildOperationalProjectNotifications,
  buildPaymentTrackNotifications,
  notificationIsVisibleTo,
  normalizeNotificationDateTime,
} = await import(serviceModule) as typeof import("./service");

const NOW = new Date("2026-08-25T00:00:00.000Z");

function project(overrides: Partial<PaymentTrackProject> = {}): PaymentTrackProject {
  return {
    id: "PAY-TEST-1",
    reference: "PAY-TEST-1",
    quoteNumber: "PROP-1",
    specialist: { name: "Percival", phone: "0400000000" },
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
    stage: "material_delivery",
    contract: null,
    deposit: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
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
    stcSolarReceivedAt: null,
    stcBatteryReceivedAt: null,
    solarRebateReceivedAt: null,
    pmNotes: "",
    pmNotesUpdatedAt: null,
    pmNotesUpdatedBy: null,
    createdAt: "2026-08-20T01:02:03.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    completedAt: null,
    history: [],
    ...overrides,
  };
}

function order(overrides: Partial<OperationalOrder> = {}): OperationalOrder {
  return {
    id: 1,
    group: "ORDER-1",
    entityId: "ORDER-1",
    customer: "Inventory Customer",
    address: "2 Test Street, Melbourne VIC 3000",
    createdAt: "2026-08-21T03:00:00.000Z",
    ownerName: "Sales Owner",
    status: "pending",
    plannedDate: null,
    deliveryTime: null,
    scheduleComplete: false,
    ...overrides,
  };
}

function scheduleRequest(overrides: Partial<NonNullable<PaymentTrackProject["deliveryScheduleRequest"]>> = {}) {
  return {
    preferredDate: "2026-10-10",
    preferredTime: "09:00",
    notes: "Please call before arrival.",
    submittedAt: "2026-08-24T03:00:00.000Z",
    submittedBy: "Samantha Sales",
    ...overrides,
  };
}

test("delivery without a Sales request stays with Sales in Payments", () => {
  const [notification] = buildPaymentTrackNotifications([project()], NOW);
  assert.equal(notification.role, "sales");
  assert.equal(notification.module, "payments");
  assert.equal(notification.badgeLabel, "Delivery preference needed");
  assert.equal(notification.actionLabel, "Prepare delivery");
  assert.equal(notification.projectCreatedAt, "2026-08-20T01:02:03.000Z");
  assert.equal(notification.ownerName, "Percival");
});

test("a delivery pre-schedule always reaches PM review even when the preferred date is far away", () => {
  const [notification] = buildPaymentTrackNotifications([project({
    deliveryScheduleRequest: scheduleRequest(),
    deliverySelections: [{ sku: "SKU-DELIVERY", quantity: 1 }],
  })], NOW);
  assert.equal(notification.role, "pm");
  assert.equal(notification.module, "projects");
  assert.equal(notification.badgeLabel, "Delivery pre-scheduled");
  assert.equal(notification.actionLabel, "Review pre-schedule");
  assert.equal(notification.ownerName, "Samantha Sales");
  assert.match(notification.description, /2026-10-10 at 09:00/);
  assert.match(notification.description, /call before arrival/i);
});

test("a complete Project Track delivery plan requires date, time and assignee", () => {
  const [complete] = buildPaymentTrackNotifications([project({
    deliveryScheduledFor: "2026-08-26",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  })], NOW);
  assert.equal(complete.badgeLabel, "Delivery scheduled");
  assert.equal(complete.role, "pm");
  assert.equal(complete.module, "projects");
  assert.equal(complete.projectCreatedAt, "2026-08-20T01:02:03.000Z");
  assert.equal(complete.ownerName, "Percival");

  const farFuture = buildPaymentTrackNotifications([project({
    deliveryScheduleRequest: scheduleRequest(),
    deliveryScheduledFor: "2026-10-10",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  })], NOW);
  assert.deepEqual(farFuture, []);
});

test("non-delivery high-priority reminders keep their normal priority badge", () => {
  const [deposit] = buildPaymentTrackNotifications([project({
    stage: "deposit_not_paid",
  })], NOW);
  assert.equal(deposit.priority, "high");
  assert.equal(deposit.badgeLabel, undefined);
  assert.equal(deposit.projectCreatedAt, undefined);
  assert.equal(deposit.ownerName, undefined);
});

test("deposit and collection confirmations are primarily assigned to Jiaqi", () => {
  const [deposit] = buildPaymentTrackNotifications([project({
    stage: "deposit_not_paid",
    deposit: {
      ...project().deposit,
      acknowledgedAt: "2026-08-25T01:00:00.000Z",
      acknowledgedBy: "Sales",
    },
  })], NOW);
  assert.equal(deposit.actionLabel, "Confirm deposit");
  assert.equal(deposit.ownerName, "Jiaqi");
  assert.equal(deposit.assigneeUsername, "jiaqi");
  assert.equal(notificationIsVisibleTo(deposit, "admin", "jiaqi"), true);
  assert.equal(notificationIsVisibleTo(deposit, "admin", "jerry"), false);

  const [collection] = buildPaymentTrackNotifications([project({
    deliveredAt: "2026-08-25T01:00:00.000Z",
    collection: {
      ...project().collection,
      acknowledgedAt: "2026-08-25T02:00:00.000Z",
      acknowledgedBy: "Sales",
    },
  })], NOW);
  assert.equal(collection.actionLabel, "Confirm collection");
  assert.equal(collection.ownerName, "Jiaqi");
  assert.equal(collection.assigneeUsername, "jiaqi");
  assert.equal(notificationIsVisibleTo(collection, "admin", "jiaqi"), true);
  assert.equal(notificationIsVisibleTo(collection, "admin", "steve"), false);
});

test("installment notifications move from Sales preference to PM review and scheduled reminder", () => {
  const [needsPreference] = buildPaymentTrackNotifications([project({
    stage: "installing",
  })], NOW);
  assert.equal(needsPreference.role, "sales");
  assert.equal(needsPreference.module, "payments");
  assert.equal(needsPreference.badgeLabel, "Installment preference needed");
  assert.equal(needsPreference.projectCreatedAt, "2026-08-20T01:02:03.000Z");
  assert.equal(needsPreference.ownerName, "Percival");

  const [review] = buildPaymentTrackNotifications([project({
    stage: "installing",
    installationScheduleRequest: scheduleRequest(),
  })], NOW);
  assert.equal(review.role, "pm");
  assert.equal(review.module, "projects");
  assert.equal(review.badgeLabel, "Installment pre-scheduled");
  assert.equal(review.actionLabel, "Review pre-schedule");

  const [scheduled] = buildPaymentTrackNotifications([project({
    stage: "installing",
    installationScheduledFor: "2026-08-26",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  })], NOW);
  assert.equal(scheduled.badgeLabel, "Installment scheduled");
  assert.equal(scheduled.role, "pm");
  assert.equal(scheduled.module, "projects");
});

test("Inventory delivery reminders use the earliest creation time and a consistent owner", () => {
  const notifications = buildOperationalProjectNotifications([
    order({ id: 1, createdAt: "2026-08-22T03:00:00.000Z" }),
    order({ id: 2, createdAt: "2026-08-20T03:00:00.000Z" }),
  ], NOW);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].badgeLabel, "Delivery plan needed");
  assert.equal(notifications[0].projectCreatedAt, "2026-08-20T03:00:00.000Z");
  assert.equal(notifications[0].ownerName, "Sales Owner");
});

test("Inventory database timestamps without an offset are consistently treated as UTC", () => {
  assert.equal(
    normalizeNotificationDateTime("2026-08-21 03:00:00"),
    "2026-08-21T03:00:00.000Z",
  );
  assert.equal(
    normalizeNotificationDateTime("2026-08-21T03:00:00+10:00"),
    "2026-08-20T17:00:00.000Z",
  );
});

test("Inventory delivery reminders fall back safely for inconsistent owners", () => {
  const [notification] = buildOperationalProjectNotifications([
    order({ id: 1, ownerName: "First Owner" }),
    order({ id: 2, ownerName: "Second Owner" }),
  ], NOW);
  assert.equal(notification.ownerName, "Not assigned");
});

test("complete Inventory delivery schedules keep urgency sorting with an explicit status badge", () => {
  const [notification] = buildOperationalProjectNotifications([order({
    status: "scheduled",
    plannedDate: "2026-08-26",
    deliveryTime: "09:00",
    scheduleComplete: true,
  })], NOW);
  assert.equal(notification.badgeLabel, "Delivery scheduled");
  assert.equal(notification.priority, "high");
  assert.equal(notification.projectCreatedAt, "2026-08-21T03:00:00.000Z");
  assert.equal(notification.ownerName, "Sales Owner");
});
