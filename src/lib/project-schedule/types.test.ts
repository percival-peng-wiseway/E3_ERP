import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const typesModule = "./types.ts";
const {
  isProjectScheduleSourceEntryId,
  isProjectScheduleSourceOverride,
} = await import(typesModule) as typeof import("./types");

test("accepts canonical Site Visit schedule source IDs", () => {
  const id = randomUUID();
  assert.equal(isProjectScheduleSourceEntryId(`site-visit:${id}`), true);
  assert.equal(isProjectScheduleSourceEntryId(`site-visit:${id.toUpperCase()}`), false);
  assert.equal(isProjectScheduleSourceEntryId("site-visit:not-a-uuid"), false);
});

test("accepts canonical combined WIP schedule source IDs", () => {
  assert.equal(isProjectScheduleSourceEntryId(`payment-combined:${randomUUID()}`), true);
});

test("validates source override records before UI counts consume them", () => {
  const value = {
    entryId: `payment-delivery:${randomUUID()}`,
    state: "cancelled",
    updatedAt: "2026-08-30T00:00:00.000Z",
    updatedBy: "Admin",
  };
  assert.equal(isProjectScheduleSourceOverride(value), true);
  assert.equal(isProjectScheduleSourceOverride({ ...value, state: "scheduled" }), false);
  assert.equal(isProjectScheduleSourceOverride({ ...value, updatedBy: null }), false);
  assert.equal(isProjectScheduleSourceOverride([]), false);
});
