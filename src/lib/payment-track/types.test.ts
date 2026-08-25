import assert from "node:assert/strict";
import { test } from "node:test";

const typesModule = "./types.ts";
const {
  countActivePaymentTrackProjects,
  isPaymentTrackProjectActive,
} = await import(typesModule) as typeof import("./types");

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
