import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { SiteVisit, SiteVisitCreateInput } from "./types";

const testDataDirectory = path.join(tmpdir(), `site-visits-${randomUUID()}`);
const recordsPath = path.join(testDataDirectory, "records.json");
process.env.SITE_VISIT_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  addSiteVisitPhotos,
  createSiteVisit,
  listSiteVisits,
  SiteVisitRepositoryError,
  transitionSiteVisit,
} = await import(repositoryModule) as typeof import("./repository");

const admin = { role: "admin", name: "Jerry" } as const;
const pm = { role: "pm", name: "Wendy" } as const;
const sales = { role: "sales", name: "Sam" } as const;
const specialist = { role: "specialist", name: "Field Specialist" } as const;

const legacyChecklist = [
  {
    id: "roof_tiles_attention",
    label: "Roof tiles need attention",
    answer: "yes" as const,
    notes: "Replace two cracked tiles",
  },
  {
    id: "switchboard_replacement",
    label: "Switchboard needs replacement",
    answer: "no" as const,
    notes: "Existing board is suitable",
  },
];

function requestInput(overrides: Partial<SiteVisitCreateInput> = {}): SiteVisitCreateInput {
  return {
    createdBy: "Ruihan",
    projectName: "Smith residence",
    address: "1 Test Street, Melbourne VIC 3000",
    contact: "+61 400 000 000",
    reason: "Confirm roof and switchboard requirements",
    requestedDate: "2026-08-28",
    requestedTime: "10:30",
    ...overrides,
  };
}

async function resetRecords(records: unknown[] = []) {
  await mkdir(testDataDirectory, { recursive: true });
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

async function expectRepositoryError(
  promise: Promise<unknown>,
  code: string,
  status: number,
) {
  await assert.rejects(
    promise,
    (error: unknown) => (
      error instanceof SiteVisitRepositoryError
      && error.code === code
      && error.status === status
    ),
  );
}

async function approve(visit: SiteVisit) {
  return transitionSiteVisit(visit.id, {
    action: "approve",
    expectedUpdatedAt: visit.updatedAt,
  }, admin);
}

async function schedule(visit: SiteVisit, actor = pm) {
  return transitionSiteVisit(visit.id, {
    action: "schedule",
    expectedUpdatedAt: visit.updatedAt,
    scheduledDate: "2026-09-02",
    scheduledTime: "14:15",
    assignee: "Site Team",
  }, actor);
}

async function createApprovedVisit() {
  return approve(await createSiteVisit(requestInput()));
}

async function createScheduledVisit() {
  return schedule(await createApprovedVisit());
}

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

test("site visit repository enforces the request-to-completion workflow", async (t) => {
  await t.test("new requests are pending approval with requested and actual times separated", async () => {
    await resetRecords();
    const created = await createSiteVisit(requestInput());

    assert.equal(created.status, "pending_approval");
    assert.equal(created.createdBy, "Ruihan");
    assert.equal(created.requestedDate, "2026-08-28");
    assert.equal(created.requestedTime, "10:30");
    assert.equal(created.scheduledDate, null);
    assert.equal(created.scheduledTime, null);
    assert.equal(created.assignee, "");
    assert.equal(created.approvedAt, null);
    assert.equal(created.approvedBy, null);
    assert.equal(created.scheduledAt, null);
    assert.equal(created.scheduledBy, null);
    assert.equal(created.cancelledFrom, null);
    assert.equal(created.checklist.length, 10);
    assert.ok(created.checklist.every((item) => (
      item.answer === "not_checked" && item.notes === ""
    )));
  });

  await t.test("repository rejects an unapproved business creator", async () => {
    await resetRecords();
    await expectRepositoryError(
      createSiteVisit({ ...requestInput(), createdBy: "Jerry" } as unknown as SiteVisitCreateInput),
      "invalid_visit",
      400,
    );
    assert.deepEqual(await listSiteVisits(), []);
  });

  await t.test("stored creator values are strict while legacy omissions remain compatible", async () => {
    await resetRecords();
    await createSiteVisit(requestInput());
    const stored = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
    stored[0].createdBy = "Jerry";
    await writeFile(recordsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await expectRepositoryError(listSiteVisits(), "invalid_storage", 500);
  });

  await t.test("PM and admin can approve, schedule and reschedule", async () => {
    await resetRecords();
    const pending = await createSiteVisit(requestInput());

    await expectRepositoryError(transitionSiteVisit(pending.id, {
      action: "approve",
      expectedUpdatedAt: pending.updatedAt,
    }, sales), "role_forbidden", 403);

    const approved = await transitionSiteVisit(pending.id, {
      action: "approve",
      expectedUpdatedAt: pending.updatedAt,
    }, pm);
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, pm.name);
    assert.ok(approved.approvedAt);
    assert.equal(approved.scheduledDate, null);
    assert.equal(approved.scheduledTime, null);
    await expectRepositoryError(transitionSiteVisit(approved.id, {
      action: "update_request",
      expectedUpdatedAt: approved.updatedAt,
      ...requestInput({ reason: "Changed after approval" }),
    }, sales), "invalid_transition", 409);

    const scheduled = await schedule(approved, pm);
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.createdBy, "Ruihan");
    assert.equal(scheduled.scheduledBy, pm.name);
    assert.equal(scheduled.scheduledDate, "2026-09-02");
    assert.equal(scheduled.scheduledTime, "14:15");
    assert.equal(scheduled.requestedDate, pending.requestedDate);
    assert.equal(scheduled.requestedTime, pending.requestedTime);
    assert.equal(scheduled.reason, pending.reason);

    const rescheduled = await transitionSiteVisit(scheduled.id, {
      action: "schedule",
      expectedUpdatedAt: scheduled.updatedAt,
      scheduledDate: "2026-09-04",
      scheduledTime: "08:45",
      assignee: "Battery Team",
    }, admin);
    assert.equal(rescheduled.status, "scheduled");
    assert.equal(rescheduled.scheduledBy, admin.name);
    assert.equal(rescheduled.scheduledDate, "2026-09-04");
    assert.equal(rescheduled.scheduledTime, "08:45");
    assert.equal(rescheduled.assignee, "Battery Team");
    assert.equal(rescheduled.requestedDate, pending.requestedDate);
    assert.equal(rescheduled.requestedTime, pending.requestedTime);
  });

  await t.test("illegal jumps and early site work are rejected", async () => {
    await resetRecords();
    const pending = await createSiteVisit(requestInput());
    const pendingSave = {
      action: "save_visit" as const,
      expectedUpdatedAt: pending.updatedAt,
      projectName: pending.projectName,
      address: pending.address,
      contact: pending.contact,
      checklist: pending.checklist,
      notes: "Too early",
    };

    await expectRepositoryError(transitionSiteVisit(pending.id, {
      action: "schedule",
      expectedUpdatedAt: pending.updatedAt,
      scheduledDate: "2026-09-02",
      scheduledTime: "14:15",
      assignee: "Site Team",
    }, pm), "invalid_transition", 409);
    await expectRepositoryError(transitionSiteVisit(pending.id, {
      action: "start",
      expectedUpdatedAt: pending.updatedAt,
    }, specialist), "invalid_transition", 409);
    await expectRepositoryError(transitionSiteVisit(pending.id, {
      action: "complete",
      expectedUpdatedAt: pending.updatedAt,
    }, specialist), "invalid_transition", 409);
    await expectRepositoryError(
      transitionSiteVisit(pending.id, pendingSave, specialist),
      "invalid_transition",
      409,
    );
    await expectRepositoryError(addSiteVisitPhotos(pending.id, [{
      bytes: Uint8Array.of(0xff),
      originalName: "pending.jpg",
      contentType: "image/jpeg",
      size: 1,
    }]), "invalid_transition", 409);

    const approved = await approve(pending);
    await expectRepositoryError(transitionSiteVisit(approved.id, {
      action: "start",
      expectedUpdatedAt: approved.updatedAt,
    }, specialist), "invalid_transition", 409);
    await expectRepositoryError(transitionSiteVisit(approved.id, {
      ...pendingSave,
      expectedUpdatedAt: approved.updatedAt,
    }, specialist), "invalid_transition", 409);
    await expectRepositoryError(addSiteVisitPhotos(approved.id, [{
      bytes: Uint8Array.of(0x89),
      originalName: "approved.png",
      contentType: "image/png",
      size: 1,
    }]), "invalid_transition", 409);

    const scheduled = await schedule(approved);
    await expectRepositoryError(transitionSiteVisit(scheduled.id, {
      action: "complete",
      expectedUpdatedAt: scheduled.updatedAt,
    }, specialist), "invalid_transition", 409);
  });

  await t.test("sales cannot schedule, cancel or reopen a visit", async () => {
    await resetRecords();
    const approved = await createApprovedVisit();
    await expectRepositoryError(transitionSiteVisit(approved.id, {
      action: "schedule",
      expectedUpdatedAt: approved.updatedAt,
      scheduledDate: "2026-09-02",
      scheduledTime: "14:15",
      assignee: "Site Team",
    }, sales), "role_forbidden", 403);

    const scheduled = await schedule(approved);
    await expectRepositoryError(transitionSiteVisit(scheduled.id, {
      action: "cancel",
      expectedUpdatedAt: scheduled.updatedAt,
    }, sales), "role_forbidden", 403);

    const started = await transitionSiteVisit(scheduled.id, {
      action: "start",
      expectedUpdatedAt: scheduled.updatedAt,
    }, specialist);
    const completed = await transitionSiteVisit(started.id, {
      action: "complete",
      expectedUpdatedAt: started.updatedAt,
    }, specialist);
    await expectRepositoryError(transitionSiteVisit(completed.id, {
      action: "reopen",
      expectedUpdatedAt: completed.updatedAt,
    }, sales), "role_forbidden", 403);
  });

  await t.test("scheduled visits can start, save findings and complete", async () => {
    await resetRecords();
    const scheduled = await createScheduledVisit();
    const started = await transitionSiteVisit(scheduled.id, {
      action: "start",
      expectedUpdatedAt: scheduled.updatedAt,
    }, specialist);
    assert.equal(started.status, "in_progress");

    const checklist = started.checklist.map((item, index) => index === 0
      ? { ...item, answer: "yes" as const, notes: "Replace two tiles" }
      : item);
    const saved = await transitionSiteVisit(started.id, {
      action: "save_visit",
      expectedUpdatedAt: started.updatedAt,
      projectName: started.projectName,
      address: started.address,
      contact: started.contact,
      checklist,
      notes: "Photos and measurements captured",
    }, specialist);
    assert.equal(saved.status, "in_progress");
    assert.equal(saved.checklist[0].answer, "yes");
    assert.equal(saved.checklist[0].notes, "Replace two tiles");
    assert.equal(saved.notes, "Photos and measurements captured");

    const completed = await transitionSiteVisit(saved.id, {
      action: "complete",
      expectedUpdatedAt: saved.updatedAt,
    }, specialist);
    assert.equal(completed.status, "completed");
    await expectRepositoryError(transitionSiteVisit(completed.id, {
      action: "save_visit",
      expectedUpdatedAt: completed.updatedAt,
      projectName: completed.projectName,
      address: completed.address,
      contact: completed.contact,
      checklist: completed.checklist,
      notes: completed.notes,
    }, specialist), "invalid_transition", 409);
  });

  await t.test("cancel and restore return to the exact prior stage", async () => {
    await resetRecords();
    const approved = await createApprovedVisit();
    const cancelled = await transitionSiteVisit(approved.id, {
      action: "cancel",
      expectedUpdatedAt: approved.updatedAt,
    }, pm);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelledFrom, "approved");

    await expectRepositoryError(transitionSiteVisit(cancelled.id, {
      action: "restore",
      expectedUpdatedAt: cancelled.updatedAt,
    }, sales), "role_forbidden", 403);

    const restored = await transitionSiteVisit(cancelled.id, {
      action: "restore",
      expectedUpdatedAt: cancelled.updatedAt,
    }, pm);
    assert.equal(restored.status, "approved");
    assert.equal(restored.cancelledFrom, null);

    const scheduled = await schedule(restored);
    const started = await transitionSiteVisit(scheduled.id, {
      action: "start",
      expectedUpdatedAt: scheduled.updatedAt,
    }, specialist);
    const completed = await transitionSiteVisit(started.id, {
      action: "complete",
      expectedUpdatedAt: started.updatedAt,
    }, specialist);
    await expectRepositoryError(transitionSiteVisit(completed.id, {
      action: "cancel",
      expectedUpdatedAt: completed.updatedAt,
    }, pm), "invalid_transition", 409);
  });

  await t.test("stale expectedUpdatedAt is rejected without overwriting the winner", async () => {
    await resetRecords();
    const pending = await createSiteVisit(requestInput());
    const staleUpdatedAt = pending.updatedAt;
    const approved = await approve(pending);

    await expectRepositoryError(transitionSiteVisit(pending.id, {
      action: "update_request",
      expectedUpdatedAt: staleUpdatedAt,
      ...requestInput({ projectName: "Stale customer name" }),
    }, sales), "stale_visit", 409);

    const [persisted] = await listSiteVisits();
    assert.equal(persisted.status, "approved");
    assert.equal(persisted.projectName, approved.projectName);
    assert.equal(persisted.updatedAt, approved.updatedAt);
  });

  await t.test("legacy scheduled records hydrate and persist without losing checks or photo metadata", async () => {
    const legacyVisitId = randomUUID();
    const photoId = randomUUID();
    const storedName = `${randomUUID()}.jpg`;
    const accessToken = "A".repeat(32);
    const legacyPhoto = {
      id: photoId,
      originalName: "legacy-roof.jpg",
      contentType: "image/jpeg",
      size: 3,
      createdAt: "2026-08-24T00:00:01.000Z",
      storedName,
      accessToken,
    };
    await resetRecords([{
      id: legacyVisitId,
      projectName: "Legacy solar installation",
      address: "2 Old Street, Melbourne VIC 3000",
      contact: "",
      scheduledDate: "2026-08-25",
      scheduledTime: "09:30",
      assignee: "Site Team",
      status: "scheduled",
      checklist: legacyChecklist,
      notes: "Keep the existing visit notes",
      photos: [legacyPhoto],
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:02.000Z",
    }]);

    const [legacy] = await listSiteVisits();
    assert.equal(legacy.id, legacyVisitId);
    assert.equal(legacy.createdBy, null);
    assert.equal(legacy.status, "scheduled");
    assert.equal(legacy.contact, "");
    assert.equal(legacy.reason, "");
    assert.equal(legacy.requestedDate, "2026-08-25");
    assert.equal(legacy.requestedTime, "09:30");
    assert.equal(legacy.approvedAt, null);
    assert.equal(legacy.approvedBy, null);
    assert.equal(legacy.scheduledAt, null);
    assert.equal(legacy.scheduledBy, null);
    assert.equal(legacy.checklist.length, 10);
    assert.deepEqual(legacy.checklist.slice(0, 2), legacyChecklist);
    assert.equal(legacy.photos.length, 1);
    assert.equal(legacy.photos[0].id, photoId);
    assert.equal(legacy.photos[0].url.includes(accessToken), true);

    const savedLegacy = await transitionSiteVisit(legacy.id, {
      action: "save_visit",
      expectedUpdatedAt: legacy.updatedAt,
      projectName: legacy.projectName,
      address: legacy.address,
      contact: "",
      checklist: legacy.checklist,
      notes: legacy.notes,
    }, specialist);
    assert.equal(savedLegacy.status, "scheduled");
    assert.equal(savedLegacy.contact, "");
    assert.deepEqual(savedLegacy.checklist.slice(0, 2), legacyChecklist);
    assert.equal(savedLegacy.photos[0].url.includes(accessToken), true);

    const started = await transitionSiteVisit(savedLegacy.id, {
      action: "start",
      expectedUpdatedAt: savedLegacy.updatedAt,
    }, specialist);
    assert.equal(started.status, "in_progress");
    assert.deepEqual(started.checklist.slice(0, 2), legacyChecklist);
    assert.equal(started.photos[0].url.includes(accessToken), true);

    const stored = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
    const persisted = stored.find(({ id }) => id === legacyVisitId);
    assert.ok(persisted);
    assert.equal(persisted.createdBy, null);
    assert.equal(persisted.reason, "");
    assert.equal(persisted.requestedDate, "2026-08-25");
    assert.equal(persisted.requestedTime, "09:30");
    assert.equal(persisted.approvedAt, null);
    assert.equal(persisted.scheduledAt, null);
    assert.equal((persisted.checklist as unknown[]).length, 10);
    assert.deepEqual((persisted.checklist as unknown[]).slice(0, 2), legacyChecklist);
    assert.deepEqual((persisted.photos as unknown[])[0], legacyPhoto);
  });
});
