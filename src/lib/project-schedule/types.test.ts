import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const typesModule = "./types.ts";
const { isProjectScheduleSourceEntryId } = await import(typesModule) as typeof import("./types");

test("accepts canonical Site Visit schedule source IDs", () => {
  const id = randomUUID();
  assert.equal(isProjectScheduleSourceEntryId(`site-visit:${id}`), true);
  assert.equal(isProjectScheduleSourceEntryId(`site-visit:${id.toUpperCase()}`), false);
  assert.equal(isProjectScheduleSourceEntryId("site-visit:not-a-uuid"), false);
});

test("accepts canonical combined WIP schedule source IDs", () => {
  assert.equal(isProjectScheduleSourceEntryId(`payment-combined:${randomUUID()}`), true);
});
