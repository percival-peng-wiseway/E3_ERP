import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `site-visits-${randomUUID()}`);
process.env.SITE_VISIT_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  createSiteVisit,
  listSiteVisits,
  updateSiteVisit,
} = await import(repositoryModule) as typeof import("./repository");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

const legacyVisitId = randomUUID();
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

test("legacy site visits hydrate and persist new defaults without losing answers or notes", async () => {
  await mkdir(testDataDirectory, { recursive: true });
  await writeFile(path.join(testDataDirectory, "records.json"), `${JSON.stringify([{
    id: legacyVisitId,
    projectName: "Legacy solar installation",
    address: "1 Test Street, Melbourne VIC 3000",
    contact: "Test Customer",
    scheduledDate: "2026-08-25",
    scheduledTime: "09:30",
    assignee: "Site Team",
    status: "scheduled",
    checklist: legacyChecklist,
    notes: "Keep the existing visit notes",
    photos: [],
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }], null, 2)}\n`, "utf8");

  const [legacy] = await listSiteVisits();
  assert.equal(legacy.id, legacyVisitId);
  assert.equal(legacy.checklist.length, 10);
  assert.deepEqual(legacy.checklist.slice(0, 2), legacyChecklist);
  assert.ok(legacy.checklist.slice(2).every((item) => (
    item.answer === "not_checked" && item.notes === ""
  )));

  const updated = await updateSiteVisit(legacyVisitId, { status: "in_progress" });
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.checklist.length, 10);
  assert.deepEqual(updated.checklist.slice(0, 2), legacyChecklist);

  const stored = JSON.parse(
    await readFile(path.join(testDataDirectory, "records.json"), "utf8"),
  ) as Array<{ id: string; status: string; checklist: typeof legacyChecklist }>;
  const persisted = stored.find(({ id }) => id === legacyVisitId);
  assert.ok(persisted);
  assert.equal(persisted.status, "in_progress");
  assert.equal(persisted.checklist.length, 10);
  assert.deepEqual(persisted.checklist.slice(0, 2), legacyChecklist);
});

test("new site visits start with all ten default checks", async () => {
  const created = await createSiteVisit({
    projectName: "New battery installation",
    address: "2 Test Street, Melbourne VIC 3000",
    contact: "Another Customer",
    scheduledDate: "2026-08-26",
    scheduledTime: "10:00",
    assignee: "Site Team",
    notes: "",
  });

  assert.equal(created.checklist.length, 10);
  assert.ok(created.checklist.every((item) => (
    item.answer === "not_checked" && item.notes === ""
  )));
});
