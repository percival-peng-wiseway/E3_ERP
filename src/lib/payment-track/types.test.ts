import assert from "node:assert/strict";
import { test } from "node:test";

const typesModule = "./types.ts";
const {
  countActivePaymentTrackProjects,
  isFinalPaymentOverdue,
  isPaymentTrackProjectActive,
  isPaymentTrackWaitingForRebateQr,
} = await import(typesModule) as typeof import("./types");

const INSTALLED_AT = "2026-08-20T10:00:00.000Z";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const INSTALLED_AT_MS = Date.parse(INSTALLED_AT);

test("Project Track treats unfinished projects and unsettled Done projects as active", () => {
  assert.equal(isPaymentTrackProjectActive({ stage: "deposit_not_paid", outstandingCents: 0 }), true);
  assert.equal(isPaymentTrackProjectActive({ stage: "installing", outstandingCents: 120_000 }), true);
  assert.equal(isPaymentTrackProjectActive({ stage: "done", outstandingCents: 1 }), true);
  assert.equal(isPaymentTrackProjectActive({ stage: "done", outstandingCents: 0 }), false);
});

test("Project Track active count matches the workspace Active Projects metric", () => {
  assert.equal(countActivePaymentTrackProjects([
    { stage: "deposit_not_paid", outstandingCents: 500_000 },
    { stage: "material_delivery", outstandingCents: 300_000 },
    { stage: "done", outstandingCents: 50_000 },
    { stage: "done", outstandingCents: 0 },
  ]), 3);
  assert.equal(countActivePaymentTrackProjects([]), 0);
});

test("Waiting for Rebate QR only applies to an active required WIP project without a QR code", () => {
  const waitingProject = {
    stage: "working_in_progress" as const,
    solarRebateQrRequired: true,
    solarRebateQrCode: null,
    deliveredAt: null,
    installedAt: null,
  };
  const uploadedQrCode = {
    id: "qr-file",
    kind: "solar_rebate_qr_code" as const,
    originalName: "rebate-qr.png",
    contentType: "image/png" as const,
    size: 4,
    url: "/api/payment-track/files/qr-file",
    uploadedAt: "2026-08-28T01:00:00.000Z",
    uploadedByRole: "pm" as const,
  };

  assert.equal(isPaymentTrackWaitingForRebateQr(waitingProject), true);
  assert.equal(isPaymentTrackWaitingForRebateQr({
    ...waitingProject,
    solarRebateQrRequired: false,
  }), false);
  assert.equal(isPaymentTrackWaitingForRebateQr({
    ...waitingProject,
    solarRebateQrCode: uploadedQrCode,
  }), false);
  assert.equal(isPaymentTrackWaitingForRebateQr({
    ...waitingProject,
    stage: "deposit_not_paid",
  }), false);
  assert.equal(isPaymentTrackWaitingForRebateQr({
    ...waitingProject,
    deliveredAt: "2026-08-28T02:00:00.000Z",
  }), false);
  assert.equal(isPaymentTrackWaitingForRebateQr({
    ...waitingProject,
    installedAt: "2026-08-28T02:00:00.000Z",
  }), false);
});

test("final payment is not overdue before installation", () => {
  assert.equal(isFinalPaymentOverdue({ installedAt: null, outstandingCents: 1 }, INSTALLED_AT_MS + SEVEN_DAYS_MS), false);
});

test("final payment is not overdue before seven full days", () => {
  assert.equal(isFinalPaymentOverdue(
    { installedAt: INSTALLED_AT, outstandingCents: 1 },
    INSTALLED_AT_MS + SEVEN_DAYS_MS - 1,
  ), false);
});

test("final payment becomes overdue at exactly seven full days", () => {
  assert.equal(isFinalPaymentOverdue(
    { installedAt: INSTALLED_AT, outstandingCents: 1 },
    INSTALLED_AT_MS + SEVEN_DAYS_MS,
  ), true);
});

test("unsettled final payment remains overdue after seven days", () => {
  assert.equal(isFinalPaymentOverdue(
    { installedAt: INSTALLED_AT, outstandingCents: 1 },
    INSTALLED_AT_MS + SEVEN_DAYS_MS + 1,
  ), true);
});

test("settled final payment is never overdue", () => {
  assert.equal(isFinalPaymentOverdue(
    { installedAt: INSTALLED_AT, outstandingCents: 0 },
    INSTALLED_AT_MS + SEVEN_DAYS_MS + 1,
  ), false);
});
