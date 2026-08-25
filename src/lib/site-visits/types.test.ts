import assert from "node:assert/strict";
import { test } from "node:test";

const typesModule = "./types.ts";
const {
  countOngoingSiteVisits,
  isSiteVisitOngoing,
} = await import(typesModule) as typeof import("./types");

test("Site Visiting treats every unfinished and uncancelled workflow stage as active", () => {
  assert.equal(isSiteVisitOngoing({ status: "pending_approval" }), true);
  assert.equal(isSiteVisitOngoing({ status: "approved" }), true);
  assert.equal(isSiteVisitOngoing({ status: "scheduled" }), true);
  assert.equal(isSiteVisitOngoing({ status: "in_progress" }), true);
  assert.equal(isSiteVisitOngoing({ status: "completed" }), false);
  assert.equal(isSiteVisitOngoing({ status: "cancelled" }), false);
});

test("Site Visiting active count excludes completed and cancelled visits", () => {
  assert.equal(countOngoingSiteVisits([
    { status: "pending_approval" },
    { status: "approved" },
    { status: "scheduled" },
    { status: "in_progress" },
    { status: "completed" },
    { status: "cancelled" },
  ]), 4);
  assert.equal(countOngoingSiteVisits([]), 0);
});
