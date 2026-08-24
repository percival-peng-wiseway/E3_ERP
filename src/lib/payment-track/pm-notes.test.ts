import assert from "node:assert/strict";
import { test } from "node:test";

const pmNotesModule = "./pm-notes.ts";
const { parsePaymentTrackPmNotesBody } = await import(pmNotesModule) as typeof import("./pm-notes");

test("PM notes body parser preserves internal newlines and permits clearing", () => {
  assert.deepEqual(parsePaymentTrackPmNotesBody({
    action: "update_pm_notes",
    actorRole: "pm",
    actorName: "Jamie",
    notes: "  First line\nSecond line  \n",
    expectedPmNotesUpdatedAt: null,
  }), {
    notes: "First line\nSecond line",
    expectedPmNotesUpdatedAt: null,
  });
  assert.deepEqual(parsePaymentTrackPmNotesBody({
    action: "update_pm_notes",
    actorRole: "pm",
    notes: " \n\t ",
    expectedPmNotesUpdatedAt: "2026-08-24T01:02:03.004Z",
  }), {
    notes: "",
    expectedPmNotesUpdatedAt: "2026-08-24T01:02:03.004Z",
  });
});

test("PM notes body parser rejects extra, missing and malformed fields", () => {
  const valid = {
    action: "update_pm_notes",
    actorRole: "pm",
    notes: "Note",
    expectedPmNotesUpdatedAt: null,
  };
  assert.equal(parsePaymentTrackPmNotesBody({ ...valid, amount: "0" }), null);
  assert.equal(parsePaymentTrackPmNotesBody({ ...valid, notes: 1 }), null);
  assert.equal(parsePaymentTrackPmNotesBody({ ...valid, actorName: null }), null);
  assert.equal(parsePaymentTrackPmNotesBody({
    action: "update_pm_notes",
    actorRole: "pm",
    notes: "Note",
  }), null);
  assert.equal(parsePaymentTrackPmNotesBody({
    ...valid,
    expectedPmNotesUpdatedAt: "24 August 2026",
  }), null);
  assert.equal(parsePaymentTrackPmNotesBody({ ...valid, notes: "x".repeat(5_001) }), null);
  assert.equal(parsePaymentTrackPmNotesBody({ ...valid, notes: "Unsafe\u0000note" }), null);
});
