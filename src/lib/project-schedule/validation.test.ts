import assert from "node:assert/strict";
import { test } from "node:test";

const validationModule = "./validation.ts";
const {
  parseProjectScheduleCreate,
  parseProjectSchedulePatch,
  projectScheduleDate,
} = await import(validationModule) as typeof import("./validation");

test("schedule create normalizes optional fields and preserves note newlines", () => {
  assert.deepEqual(parseProjectScheduleCreate({
    title: "  Smith installation  ",
    scheduledDate: "2026-09-03",
    notes: "  Confirm access\nBring ladder  ",
  }), {
    title: "Smith installation",
    scheduledDate: "2026-09-03",
    startTime: null,
    endTime: null,
    assignee: "",
    location: "",
    notes: "Confirm access\nBring ladder",
  });
});

test("schedule validation rejects extra fields, bad dates, times and unsafe text", () => {
  assert.equal(projectScheduleDate("2026-02-29"), false);
  assert.equal(projectScheduleDate("2028-02-29"), true);
  assert.equal(parseProjectScheduleCreate({
    title: "Test",
    scheduledDate: "2026-09-03",
    startTime: "10:00",
    endTime: "09:59",
  }), null);
  assert.equal(parseProjectScheduleCreate({
    title: "Test",
    scheduledDate: "2026-09-03",
    endTime: "09:59",
  }), null);
  assert.equal(parseProjectScheduleCreate({
    title: "Test",
    scheduledDate: "2026-09-03",
    unexpected: true,
  }), null);
  assert.equal(parseProjectScheduleCreate({
    title: "Unsafe\u0000title",
    scheduledDate: "2026-09-03",
  }), null);
  assert.equal(parseProjectScheduleCreate({
    title: "x".repeat(161),
    scheduledDate: "2026-09-03",
  }), null);
});

test("schedule patch is strict and permits explicit completion", () => {
  assert.deepEqual(parseProjectSchedulePatch({
    status: "completed",
    startTime: "08:30",
    endTime: "10:00",
  }), {
    status: "completed",
    startTime: "08:30",
    endTime: "10:00",
  });
  assert.deepEqual(parseProjectSchedulePatch({ startTime: "" }), { startTime: null });
  assert.equal(parseProjectSchedulePatch({}), null);
  assert.equal(parseProjectSchedulePatch({ status: "done" }), null);
  assert.equal(parseProjectSchedulePatch({ status: "completed", id: "not-editable" }), null);
  assert.equal(parseProjectSchedulePatch({ notes: "x".repeat(5_001) }), null);
});
