import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./weekly-business-summary.ts";
const {
  formatWeeklyBusinessSummary,
  melbourneBusinessWeek,
  melbourneDate,
  summarizeConfirmedPayments,
} = await import(modulePath) as typeof import("./weekly-business-summary");

test("Melbourne business week remains Monday-to-Sunday across UTC and DST boundaries", () => {
  assert.equal(melbourneDate("2026-09-06T14:30:00.000Z"), "2026-09-07");
  assert.deepEqual(melbourneBusinessWeek(new Date("2026-09-06T14:30:00.000Z")), {
    from: "2026-09-07",
    to: "2026-09-13",
  });
  assert.deepEqual(melbourneBusinessWeek(new Date("2026-10-03T16:30:00.000Z")), {
    from: "2026-09-28",
    to: "2026-10-04",
  });
});

test("weekly payments use confirmedAt only and keep outstanding as a current snapshot", () => {
  const result = summarizeConfirmedPayments([
    {
      outstandingCents: 12_500,
      deposit: { confirmedAt: "2026-09-01T01:00:00.000Z", confirmedAmountCents: 20_000 },
      collection: { confirmedAt: "2026-08-30T01:00:00.000Z", confirmedAmountCents: 5_000 },
      finalPayments: [
        { confirmedAt: "2026-09-05T23:30:00.000Z", confirmedAmountCents: 30_000 },
        { confirmedAt: "2026-09-04T01:00:00.000Z", confirmedAmountCents: null },
      ],
    },
    {
      outstandingCents: 0,
      deposit: { confirmedAt: null, confirmedAmountCents: null },
      collection: { confirmedAt: "2026-09-07T14:30:00.000Z", confirmedAmountCents: 99_999 },
      finalPayments: [],
    },
  ], "2026-08-31", "2026-09-06");
  assert.deepEqual(result, {
    confirmedCount: 3,
    confirmedAmountCents: 50_000,
    confirmedWithoutAmount: 1,
    outstandingProjectCount: 1,
    outstandingAmountCents: 12_500,
  });
});

test("weekly summary keeps combined work separate and never treats unavailable sources as zero", () => {
  const counts = { total: 2, completed: 1, scheduled: 1, pending: 0, cancelled: 0 };
  const answer = formatWeeklyBusinessSummary({
    from: "2026-08-31",
    to: "2026-09-06",
    work: {
      delivery: { ...counts, total: 3 },
      installation: { ...counts, total: 4 },
      combined: { ...counts, total: 2 },
      siteVisits: { ...counts, total: 5 },
    },
    inventory: null,
    payments: null,
    scheduleWarningCount: 1,
  }, "english");
  assert.match(answer, /\| Delivery & installation \| 2 \|/u);
  assert.match(answer, /Inventory data is currently unavailable/u);
  assert.match(answer, /Payment data is currently unavailable/u);
  assert.match(answer, /1 schedule source\(s\) were unavailable/u);
  assert.doesNotMatch(answer, /customer|phone|email|address|notes?/iu);
});
