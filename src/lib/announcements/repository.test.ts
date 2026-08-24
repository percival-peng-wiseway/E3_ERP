import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `announcements-${randomUUID()}`);
process.env.ANNOUNCEMENTS_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  ANNOUNCEMENT_MAX_RECORDS,
  AnnouncementRepositoryError,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  updateAnnouncement,
} = await import(repositoryModule) as typeof import("./repository");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

test("concurrent creates are serialized and newest announcements are listed first", async () => {
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    createAnnouncement({ title: `Notice ${index}`, content: `Message ${index}` }, "Jerry")
  )));
  assert.equal(new Set(created.map((announcement) => announcement.id)).size, created.length);

  const listed = await listAnnouncements();
  assert.equal(listed.length, 12);
  assert.equal(listed[0].id, created.at(-1)?.id);
  assert.equal(listed.at(-1)?.id, created[0].id);
});

test("updates preserve server-owned audit fields and delete removes exactly one record", async () => {
  const original = await createAnnouncement({ title: "Initial", content: "Original message" }, "Jiaqi");
  const updated = await updateAnnouncement(original.id, { title: "", content: "Revised message" });
  assert.equal(updated.title, "");
  assert.equal(updated.content, "Revised message");
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.createdBy, "Jiaqi");

  assert.equal(await deleteAnnouncement(original.id), original.id);
  assert.equal((await listAnnouncements()).some((announcement) => announcement.id === original.id), false);
  await assert.rejects(
    deleteAnnouncement(original.id),
    (error: unknown) => error instanceof AnnouncementRepositoryError && error.code === "not_found",
  );
});

test("storage remains valid JSON with strict public fields and retains only recent records", async () => {
  const additions = ANNOUNCEMENT_MAX_RECORDS + 5;
  for (let index = 0; index < additions; index += 1) {
    await createAnnouncement({ title: `Retention ${index}`, content: `Body ${index}` }, "Jerry");
  }

  const listed = await listAnnouncements();
  assert.equal(listed.length, ANNOUNCEMENT_MAX_RECORDS);
  assert.equal(listed[0].title, `Retention ${additions - 1}`);

  const persisted = JSON.parse(
    await readFile(path.join(testDataDirectory, "records.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  assert.equal(persisted.length, ANNOUNCEMENT_MAX_RECORDS);
  assert.deepEqual(Object.keys(persisted[0]).sort(), ["content", "createdAt", "createdBy", "id", "title"]);
});

