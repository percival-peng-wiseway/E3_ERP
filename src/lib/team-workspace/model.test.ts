import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Node source tests use explicit extensions.
import { applyEntry, monday, canEdit, WEEKLY_MEMBERS, weeklyDateRanges, taskReminders } from "./model.ts";
const admin = { username: "admin", displayName: "Admin", role: "admin" as const };
const member = { username: "sam", displayName: "Member", role: "sales" as const };
const other = { username: "other", displayName: "Other", role: "installer" as const };
const input = { kind: "task", title: "Prepare meeting", owner: "sam", date: "2026-09-11", content: "Prepare agenda", goals: "Agree priorities", attendees: "", status: "start", progress: 0, update: "" };
const members = ["admin", "sam", "other"];
test("admin assigns a task; assignee can update progress but not requirements", () => {
  const task = applyEntry(input, admin, members);
  const updated = applyEntry({ ...task, action: "start_work", update: "Started agenda" }, member, members, task);
  assert.equal(updated.status, "wip"); assert.equal(updated.history.length, 2);
  assert.throws(() => applyEntry({ ...task, owner: "other" }, member, members, task), /administrators/);
  assert.throws(() => applyEntry({ ...task, content: "Changed scope" }, member, members, task), /administrators/);
  assert.throws(() => applyEntry(task, other, members, task), /cannot edit/);
  assert.throws(() => applyEntry(input, member, members), /administrators/);
});
test("week plan belongs to authenticated member; week starts Monday", () => {
  const plan = applyEntry({ ...input, kind: "weekly", date: "2026-09-13", owner: "admin" }, member, members);
  assert.equal(plan.owner, "sam"); assert.equal(plan.date, "2026-09-07");
  assert.equal(monday("2026-09-14"), "2026-09-14");
  assert.equal(canEdit(plan, admin), false);
  assert.throws(() => applyEntry(plan, admin, members, plan), /cannot edit/);
});
test("meeting record creation is disabled", () => {
  assert.throws(() => applyEntry({ ...input, kind: "meeting" }, admin, members), /no longer enabled/);
});
test("reject stale edits, invalid dates, progress and assignees", () => {
  const task = applyEntry(input, admin, members);
  assert.throws(() => applyEntry({ ...task, version: 0 }, admin, members, task), /changed/);
  for (const patch of [{ date: "2026-02-30" }, { status: "done" }, { title: "" }, { owner: "missing" }]) assert.throws(() => applyEntry({ ...input, ...patch }, admin, members));
});
test("local persistence, concurrent stale updates, and one weekly plan per owner", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "e3-team-test-"));
  process.env.TEAM_WORKSPACE_DATA_DIR = dir;
  // @ts-expect-error Node source tests use explicit extensions.
  const { listEntries, saveEntry, markNotificationRead, readAttachment } = await import("./repository.ts");
  try {
    const task = await saveEntry(input, admin, members);
    const results = await Promise.allSettled([saveEntry({ ...task, progress: 30 }, member, members), saveEntry({ ...task, progress: 60 }, member, members)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await listEntries())[0].version, 2);
    const assigned = await saveEntry({ ...input, title: "Notification test" }, admin, members);
    assert.deepEqual(assigned.notifications?.map(item => item.recipient).sort(), ["admin", "sam"]);
    assert.ok(assigned.notifications?.every(item => item.priority === "high"));
    const updated = await saveEntry({ ...assigned, action: "start_work", update: "Started work" }, member, members);
    assert.equal(updated.notifications?.length, 2);
    const submitted = await saveEntry({ ...updated, action: "submit_review" }, member, members);
    const feedback = await saveEntry({ ...submitted, action: "request_changes", update: "Please check measurements" }, admin, members);
    assert.equal(feedback.notifications?.length, 2);
    const fileTask = await saveEntry({ ...feedback, update: "Uploaded evidence" }, member, members, { name: "progress.txt", bytes: new TextEncoder().encode("test file") });
    assert.equal(fileTask.attachments?.length, 1);
    assert.equal(fileTask.notifications?.length, 2);
    assert.equal((await readAttachment(fileTask.id, fileTask.attachments![0].id)).bytes.toString(), "test file");
    await assert.rejects(saveEntry({ ...fileTask }, other, members, { name: "no.txt", bytes: new Uint8Array([1]) }), /cannot edit/);
    const notification = fileTask.notifications!.find(item => item.recipient === "sam")!;
    await assert.rejects(markNotificationRead(notification.id, "other"), /not found/);
    await markNotificationRead(notification.id, "sam");
    const stored = (await listEntries()).find(item => item.id === fileTask.id)!;
    assert.equal(stored.notifications!.find(item => item.id === notification.id)!.read, true);
    const reassigned = await saveEntry({ ...stored, owner: "admin", action: "start_work" }, admin, members);
    const review = await saveEntry({ ...reassigned, action: "submit_review" }, admin, members);
    const accepted = await saveEntry({ ...review, action: "accept" }, admin, members);
    assert.equal(accepted.owner, "admin"); assert.equal(accepted.status, "done");
    assert.equal(taskReminders([accepted], "admin").length, 1);
    assert.deepEqual(accepted.notifications?.map(item => item.recipient), ["admin"], "self-assigned requests have one reminder");
    assert.equal(taskReminders([accepted], "sam").length, 0, "former assignees no longer receive reminders");
    const delegated = await saveEntry(input, admin, members);
    const unrelatedAdmin = { ...admin, username: "other" };
    const edited = await saveEntry({ ...delegated, content: "Updated requirements" }, unrelatedAdmin, members);
    assert.deepEqual(edited.notifications?.map(item => item.recipient).sort(), ["admin", "sam"], "an administrator editing the task does not become a notification recipient");
    assert.equal(taskReminders([edited], "other").length, 0);
    await saveEntry({ ...input, kind: "weekly" }, member, members);
    await assert.rejects(saveEntry({ ...input, kind: "weekly" }, member, members), /already have a plan/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("weekly cards are limited to the requested roster, including JiaQi as an admin", () => {
  assert.deepEqual(WEEKLY_MEMBERS.map(member => member.displayName), ["RuiHan", "Sam", "Wendy", "Hogan", "Kevin", "JiaQi"]);
  assert.throws(() => applyEntry({ ...input, kind: "weekly" }, other, members), /six selected/);
  assert.throws(() => applyEntry({ ...input, kind: "weekly" }, admin, members), /six selected/);
  const jiaqi = { username: "jiaqi", displayName: "JiaQi", role: "admin" as const };
  const plan = applyEntry({ ...input, kind: "weekly" }, jiaqi, [...members, "jiaqi"]);
  assert.equal(plan.owner, "jiaqi");
  assert.equal(canEdit(plan, member), false);
  const updated = applyEntry({ ...plan, content: "Finished installations", goals: "Plan next week's site visits" }, jiaqi, members, plan);
  assert.equal(updated.content, "Finished installations");
  assert.equal(updated.goals, "Plan next week's site visits");
});

test("weekly date ranges keep Monday–Sunday boundaries across years and daylight saving", () => {
  assert.deepEqual(weeklyDateRanges("2027-01-04"), { start: "2027-01-04", end: "2027-01-10", previousStart: "2026-12-28", previousEnd: "2027-01-03" });
  assert.deepEqual(weeklyDateRanges("2026-12-31"), { start: "2026-12-28", end: "2027-01-03", previousStart: "2026-12-21", previousEnd: "2026-12-27" });
  assert.deepEqual(weeklyDateRanges("2026-10-04"), { start: "2026-09-28", end: "2026-10-04", previousStart: "2026-09-21", previousEnd: "2026-09-27" });
});

test("completion requires admin acceptance and supports return/rework/resubmission", () => {
  const task = applyEntry(input, admin, members);
  assert.throws(() => applyEntry({ ...task, action: "accept" }, admin, members, task), /not permitted/);
  assert.throws(() => applyEntry({ ...task, status: "done" }, member, members, task), /action buttons/);
  const working = applyEntry({ ...task, action: "start_work" }, member, members, task);
  const review = applyEntry({ ...working, action: "submit_review" }, member, members, working);
  assert.equal(review.status, "review");
  assert.throws(() => applyEntry({ ...review, action: "accept" }, member, members, review), /not permitted/);
  assert.throws(() => applyEntry({ ...review, action: "request_changes", update: "" }, admin, members, review), /Explain/);
  const returned = applyEntry({ ...review, action: "request_changes", update: "Correct the measurements" }, admin, members, review);
  const resumed = applyEntry({ ...returned, action: "start_work" }, member, members, returned);
  const resubmitted = applyEntry({ ...resumed, action: "submit_review" }, member, members, resumed);
  const accepted = applyEntry({ ...resubmitted, action: "accept" }, admin, members, resubmitted);
  assert.equal(accepted.status, "done");
  assert.equal(accepted.history.at(-1)?.by, "admin");
  assert.throws(() => applyEntry({ ...accepted, action: "start_work" }, member, members, accepted), /not permitted/);
});
test("legacy repeated notifications are grouped into one reminder per task and recipient", () => {
  const task = applyEntry(input, admin, members);
  task.notifications = [1,2,3].map(n => ({ id: String(n), recipient: "admin", priority: "high", message: `Update ${n}`, at: `2026-09-11T00:00:0${n}Z`, read: false }));
  assert.equal(taskReminders([task], "admin").length, 1);
  assert.equal(taskReminders([task], "admin")[0].message, "Update 3");
  assert.equal(taskReminders([task], "sam").length, 0);
});

test("separate employee and admin feedback boxes preserve each other and enforce authorship", () => {
  const task = applyEntry(input, admin, members);
  assert.equal(task.assignedBy, "admin");
  assert.throws(() => applyEntry({ ...task, action: "save_employee", update: "Impersonating employee" }, admin, members, task), /assigned employee/);
  const saved = applyEntry({ ...task, action: "save_employee", update: "Work underway" }, member, members, task);
  assert.equal(saved.status, "wip"); assert.equal(saved.employeeFeedback, "Work underway");
  const review = applyEntry({ ...saved, action: "employee_review", update: "Completed work" }, member, members, saved);
  assert.equal(review.status, "review");
  assert.throws(() => applyEntry({ ...review, action: "admin_feedback", update: "fake review" }, member, members, review), /administrators/);
  const feedback = applyEntry({ ...review, action: "admin_feedback", update: "Add a photo" }, admin, members, review);
  assert.equal(feedback.adminFeedback, "Add a photo"); assert.equal(feedback.employeeFeedback, "Completed work");
  const again = applyEntry({ ...feedback, action: "employee_review", update: "Photo added" }, member, members, feedback);
  assert.equal(again.adminFeedback, "Add a photo");
  const accepted = applyEntry({ ...again, action: "accept", update: "Approved" }, admin, members, again);
  assert.equal(accepted.status, "done"); assert.equal(accepted.employeeFeedback, "Photo added"); assert.equal(accepted.adminFeedback, "Approved");
  assert.throws(() => applyEntry({ ...accepted, action: "save_employee", update: "changed" }, member, members, accepted), /already been accepted/);
});
test("image previews use raster signatures and never trust SVG or HTML content", async () => {
  // @ts-expect-error Node source tests use explicit extensions.
  const { imagePreviewType } = await import("./image-type.ts");
  assert.equal(imagePreviewType(new Uint8Array([137,80,78,71,13,10,26,10])), "image/png");
  assert.equal(imagePreviewType(new Uint8Array([255,216,255,0])), "image/jpeg");
  assert.equal(imagePreviewType(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(imagePreviewType(new TextEncoder().encode("RIFF0000WEBP")), "image/webp");
  assert.equal(imagePreviewType(new TextEncoder().encode("<svg onload='alert(1)'>")), undefined);
  assert.equal(imagePreviewType(new TextEncoder().encode("<html>")), undefined);
});

test("legacy notifications are hidden from unrelated admins and former assignees", () => {
  const task = applyEntry(input, admin, members);
  task.assignedBy = undefined; // Legacy entries recover the assigner from creation history.
  task.notifications = ["admin", "sam", "other"].map(recipient => ({ id: recipient, recipient, priority: "high", message: "Updated", at: task.updatedAt, read: false }));
  assert.equal(taskReminders([task], "admin").length, 1);
  assert.equal(taskReminders([task], "sam").length, 1);
  assert.equal(taskReminders([task], "other").length, 0);
  assert.equal(taskReminders([{ ...task, owner: "other" }], "sam").length, 0);
});
