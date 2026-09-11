import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error -- focused Node tests use explicit extensions.
import { projectCreatedMonth, summarizeReceivables } from "./receivables-summary.ts";
import type { PaymentTrackProject } from "./types";

function project(patch: Partial<PaymentTrackProject> = {}): PaymentTrackProject {
  return { balanceDueCents: 500000, deposit: { confirmedAmountCents: 90000 }, collection: { confirmedAmountCents: null }, finalPayments: [], createdAt: "2026-09-01T00:00:00Z", outstandingCents: 410000,
    stcSolarRequired: true, stcBatteryRequired: true, stcSolarReceivedAt: null, stcBatteryReceivedAt: null,
    stcSolarExpectedAmountCents: 120000, stcBatteryExpectedAmountCents: 230000, ...patch } as PaymentTrackProject;
}

test("monthly receivables use Melbourne creation dates, not installation dates", () => {
  assert.equal(projectCreatedMonth("2026-08-31T14:01:00Z"), "2026-09");
  const result = summarizeReceivables([project({ installedAt: "2026-10-02T00:00:00Z" }), project({ createdAt: "2026-08-31T13:59:00Z" })], "monthly", "2026-09");
  assert.equal(result.projectCount, 1);
  assert.equal(result.customerCents, 410000);
  assert.equal(result.stcCents, 350000);
});

test("quarterly selection includes three calendar months in the selected year", () => {
  const result = summarizeReceivables([project({ createdAt: "2026-07-01T00:00:00Z" }), project(), project({ createdAt: "2026-10-01T00:00:00Z" }), project({ createdAt: "2025-09-01T00:00:00Z" })], "quarterly", "2026-08");
  assert.equal(result.projectCount, 2);
  assert.equal(result.customerCents, 820000);
});

test("received or inapplicable STC is excluded; unknown amounts remain visible", () => {
  const result = summarizeReceivables([
    project({ stcSolarReceivedAt: "2026-09-05T00:00:00Z", stcBatteryExpectedAmountCents: null }),
    project({ stcSolarRequired: false, stcBatteryExpectedAmountCents: 0 }),
    project({ outstandingCents: 0, stcSolarReceivedAt: "2026-09-05T00:00:00Z", stcBatteryReceivedAt: "2026-09-05T00:00:00Z" }),
  ], "all", "2026-09");
  assert.equal(result.stcCents, 0);
  assert.equal(result.missingStcProjects, 1);
  assert.equal(result.customerCents, 820000);
  assert.equal(summarizeReceivables([], "monthly", "2026-09").projectCount, 0);
});


test("totals include confirmed customer receipts and actual STC, without rebate double counting", () => {
  const result = summarizeReceivables([project({
    deposit: { confirmedAmountCents: 100000 } as PaymentTrackProject["deposit"],
    collection: { confirmedAmountCents: 150000 } as PaymentTrackProject["collection"],
    finalPayments: [{ confirmedAmountCents: 300000 }, { confirmedAmountCents: null, reportedAmountCents: 90000 }] as PaymentTrackProject["finalPayments"],
    outstandingCents: 0, overpaymentCents: 50000,
    stcSolarReceivedAt: "2026-09-05T00:00:00Z", stcSolarReceivedAmountCents: 110000,
    solarRebateReceivedAmountCents: 140000,
  })], "all", "2026-09");
  assert.equal(result.contractTotalCents, 500000);
  assert.equal(result.contractReceivedCents, 550000);
  assert.equal(result.stcReceivedCents, 110000);
  assert.equal(result.stcTotalCents, 340000);
  assert.equal(result.missingTotalStcProjects, 0);
});

test("unknown received STC is flagged instead of replaced with an estimate", () => {
  const result = summarizeReceivables([project({ stcSolarReceivedAt: "2026-09-05T00:00:00Z", stcBatteryExpectedAmountCents: null })], "all", "2026-09");
  assert.equal(result.stcReceivedCents, 0);
  assert.equal(result.missingReceivedStcProjects, 1);
  assert.equal(result.missingTotalStcProjects, 1);
});

test("new totals follow the period filter and empty periods return zero", () => {
  const result = summarizeReceivables([project(), project({ createdAt: "2026-08-01T00:00:00Z" })], "monthly", "2026-09");
  assert.equal(result.contractTotalCents, 500000);
  assert.equal(result.contractReceivedCents, 90000);
  assert.equal(result.stcTotalCents, 350000);
  const empty = summarizeReceivables([], "all", "2026-09");
  assert.equal(empty.contractTotalCents, 0);
  assert.equal(empty.contractReceivedCents, 0);
  assert.equal(empty.stcTotalCents, 0);
  assert.equal(empty.stcReceivedCents, 0);
});
