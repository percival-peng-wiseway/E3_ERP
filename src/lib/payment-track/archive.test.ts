import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error -- focused Node tests require the explicit extension.
import { isPaymentTrackProjectArchived } from "./types.ts";

test("only completed projects with a settled balance belong in Archive", () => {
  assert.equal(isPaymentTrackProjectArchived({ stage: "done", outstandingCents: 0 }), true);
  assert.equal(isPaymentTrackProjectArchived({ stage: "done", outstandingCents: 56623 }), false);
  assert.equal(isPaymentTrackProjectArchived({ stage: "done", outstandingCents: 1 }), false);
  for (const stage of ["deposit_not_paid", "working_in_progress", "waiting_coes", "stc_rebate"] as const) {
    assert.equal(isPaymentTrackProjectArchived({ stage, outstandingCents: 0 }), false);
  }
});

test("settling, reopening the balance, and reopening work update Archive membership", () => {
  const project = { stage: "done" as const, outstandingCents: 100 };
  assert.equal(isPaymentTrackProjectArchived(project), false);
  project.outstandingCents = 0;
  assert.equal(isPaymentTrackProjectArchived(project), true);
  project.outstandingCents = 410000;
  assert.equal(isPaymentTrackProjectArchived(project), false);
  assert.equal(isPaymentTrackProjectArchived({ ...project, stage: "stc_rebate", outstandingCents: 0 }), false);
});
