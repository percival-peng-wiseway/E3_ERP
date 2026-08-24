import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `project-schedule-${randomUUID()}`);
process.env.PROJECT_SCHEDULE_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  createProjectScheduleJob,
  deleteProjectScheduleJob,
  listProjectScheduleJobs,
  ProjectScheduleRepositoryError,
  updateProjectScheduleJob,
} = await import(repositoryModule) as typeof import("./repository");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

function input(index: number) {
  return {
    title: `Installation ${index}`,
    scheduledDate: index % 2 ? "2026-09-02" : "2026-09-03",
    startTime: index % 3 ? `0${index}:00` : null,
    endTime: index % 3 ? `0${index}:30` : null,
    assignee: `PM ${index}`,
    location: `${index} Test Street`,
    notes: "",
  };
}

test("concurrent creates are serialized without losing schedule jobs", async () => {
  const created = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    createProjectScheduleJob(input(index + 1))
  )));
  assert.equal(new Set(created.map((job) => job.id)).size, 8);

  const all = await listProjectScheduleJobs("2026-09-01", "2026-09-07");
  assert.equal(all.length, 8);
  assert.ok(all.every((job) => job.status === "scheduled"));
  assert.deepEqual(
    (await listProjectScheduleJobs("2026-09-02", "2026-09-02")).map((job) => job.scheduledDate),
    ["2026-09-02", "2026-09-02", "2026-09-02", "2026-09-02"],
  );
});

test("patch edits and completes a job without accepting an invalid merged time range", async () => {
  const created = await createProjectScheduleJob({
    title: "Battery installation",
    scheduledDate: "2026-09-04",
    startTime: "09:00",
    endTime: "11:00",
    assignee: "Alex",
    location: "Melbourne",
    notes: "Call first",
  });
  const updated = await updateProjectScheduleJob(created.id, {
    title: "Battery commissioning",
    status: "completed",
  });
  assert.equal(updated.title, "Battery commissioning");
  assert.equal(updated.status, "completed");
  assert.ok(updated.updatedAt > created.updatedAt);

  await assert.rejects(
    updateProjectScheduleJob(created.id, { startTime: "12:00" }),
    (error: unknown) => (
      error instanceof ProjectScheduleRepositoryError
      && error.code === "invalid_time_range"
    ),
  );
  const afterRejectedUpdate = await listProjectScheduleJobs("2026-09-04", "2026-09-04");
  assert.equal(afterRejectedUpdate.find((job) => job.id === created.id)?.startTime, "09:00");
});

test("delete removes exactly one job and reports missing records", async () => {
  const created = await createProjectScheduleJob({
    title: "Site visit",
    scheduledDate: "2026-09-05",
    startTime: null,
    endTime: null,
    assignee: "",
    location: "",
    notes: "",
  });
  assert.equal((await deleteProjectScheduleJob(created.id)).id, created.id);
  assert.equal(
    (await listProjectScheduleJobs("2026-09-05", "2026-09-05")).some((job) => job.id === created.id),
    false,
  );
  await assert.rejects(
    deleteProjectScheduleJob(created.id),
    (error: unknown) => error instanceof ProjectScheduleRepositoryError && error.code === "not_found",
  );
});

test("listing safely normalizes and persists a legacy schedule record", async () => {
  const recordsPath = path.join(testDataDirectory, "records.json");
  await mkdir(testDataDirectory, { recursive: true });
  const existing = JSON.parse(await readFile(recordsPath, "utf8")) as unknown[];
  existing.push({
    id: "legacy-id",
    title: "  Legacy\u0000 job  ",
    scheduledDate: "2026-09-06",
    startTime: "10:00",
    endTime: "09:00",
    assignee: 42,
    location: "  Warehouse  ",
    notes: "  First line\nSecond line  ",
    status: "unknown",
    createdAt: "bad",
  });
  await writeFile(recordsPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

  const first = await listProjectScheduleJobs("2026-09-06", "2026-09-06");
  const legacy = first.find((job) => job.title === "Legacy job");
  assert.ok(legacy);
  assert.match(legacy.id, /^[0-9a-f-]{36}$/i);
  assert.equal(legacy.startTime, "10:00");
  assert.equal(legacy.endTime, null);
  assert.equal(legacy.assignee, "");
  assert.equal(legacy.location, "Warehouse");
  assert.equal(legacy.notes, "First line\nSecond line");
  assert.equal(legacy.status, "scheduled");

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const migrated = persisted.find((job) => job.id === legacy.id);
  assert.ok(migrated);
  assert.equal(migrated.title, "Legacy job");
  assert.equal(migrated.endTime, null);
  assert.equal(typeof migrated.createdAt, "string");
  assert.equal(migrated.updatedAt, migrated.createdAt);
});

test("invalid list ranges are rejected", async () => {
  await assert.rejects(
    listProjectScheduleJobs("2026-09-08", "2026-09-01"),
    (error: unknown) => (
      error instanceof ProjectScheduleRepositoryError
      && error.code === "invalid_date_range"
    ),
  );
  await assert.rejects(
    listProjectScheduleJobs("2026-01-01", "2027-12-31"),
    (error: unknown) => (
      error instanceof ProjectScheduleRepositoryError
      && error.code === "invalid_date_range"
    ),
  );
});
