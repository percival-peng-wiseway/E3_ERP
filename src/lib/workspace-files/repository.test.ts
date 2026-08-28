import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { WorkspaceFileActor } from "./types";

const testDataDirectory = path.join(tmpdir(), `workspace-files-${randomUUID()}`);
const recordsPath = path.join(testDataDirectory, "records.json");
const objectsPath = path.join(testDataDirectory, "objects");
process.env.WORKSPACE_FILES_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  createWorkspaceFolder,
  getWorkspaceFileContent,
  getWorkspaceFileIndexSource,
  listWorkspaceFileSubtreeIds,
  listWorkspaceFiles,
  moveWorkspaceItem,
  purgeWorkspaceItem,
  renameWorkspaceItem,
  restoreWorkspaceItem,
  trashWorkspaceItem,
  uploadWorkspaceFile,
  WorkspaceFilesRepositoryError,
  WORKSPACE_FILE_OWNER_LIMIT_BYTES,
} = await import(repositoryModule) as typeof import("./repository");

const jerry: WorkspaceFileActor = { username: "jerry", displayName: "Jerry", role: "admin" };
const sam: WorkspaceFileActor = { username: "sam", displayName: "Sam", role: "sales" };
const wendy: WorkspaceFileActor = { username: "wendy", displayName: "Wendy", role: "pm" };

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

async function reset() {
  await rm(testDataDirectory, { recursive: true, force: true });
  await mkdir(testDataDirectory, { recursive: true });
  await writeFile(recordsPath, "[]\n", "utf8");
}

function upload(actor: WorkspaceFileActor, originalName: string, text: string, parentId?: string | null) {
  const bytes = new TextEncoder().encode(text);
  return uploadWorkspaceFile({
    actor,
    parentId,
    upload: { bytes, originalName, contentType: "text/plain", size: bytes.byteLength },
  });
}

async function expectError(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof WorkspaceFilesRepositoryError
      && error.code === code && error.status === status,
  );
}

test("workspace files local repository", async (t) => {
  await t.test("creates folders and files with checksums, paths, usage and verified content", async () => {
    await reset();
    const folder = await createWorkspaceFolder({ actor: sam, name: "Customer Docs" });
    const file = await upload(sam, "proposal.txt", "solar proposal", folder.id);
    assert.match(file.checksum || "", /^[0-9a-f]{64}$/);
    assert.equal(file.ownerUsername, "sam");
    assert.equal(file.ownerDisplayName, "Sam");

    const root = await listWorkspaceFiles({ actor: wendy });
    assert.deepEqual(root.items.map(({ name }) => name), ["Customer Docs"]);
    assert.deepEqual(root.folders, [{
      id: folder.id,
      name: "Customer Docs",
      parentId: null,
      path: "Root / Customer Docs",
    }]);
    assert.equal(root.usage.usedBytes, new TextEncoder().encode("solar proposal").byteLength);
    assert.equal(root.usage.ownerUsedBytes, 0);

    const inside = await listWorkspaceFiles({ actor: sam, parentId: folder.id });
    assert.equal(inside.currentFolder?.id, folder.id);
    assert.deepEqual(inside.breadcrumbs, [{ id: folder.id, name: folder.name }]);
    assert.deepEqual(inside.items.map(({ name }) => name), ["proposal.txt"]);
    assert.equal(inside.usage.ownerUsedBytes, file.size);

    const content = await getWorkspaceFileContent({ actor: wendy, id: file.id });
    assert.ok(content);
    assert.equal(new TextDecoder().decode(await content.read()), "solar proposal");

    const indexSource = await getWorkspaceFileIndexSource(file.id);
    assert.ok(indexSource);
    assert.equal(indexSource.sourcePath, "Files / Customer Docs / proposal.txt");
    assert.equal(indexSource.checksum, file.checksum);
    assert.equal(new TextDecoder().decode(await indexSource.read()), "solar proposal");
  });

  await t.test("all users browse but only an owner or Administrator manages an item", async () => {
    await reset();
    const file = await upload(sam, "shared.txt", "shared");
    const seenByWendy = (await listWorkspaceFiles({ actor: wendy })).items[0];
    assert.equal(seenByWendy.id, file.id);
    assert.deepEqual(seenByWendy.capabilities, {
      rename: false, move: false, trash: false, restore: false, purge: false,
    });
    await expectError(renameWorkspaceItem({
      actor: wendy, id: file.id, name: "stolen.txt", expectedVersion: file.version,
    }), "forbidden", 403);

    const renamed = await renameWorkspaceItem({
      actor: sam, id: file.id, name: "renamed.txt", expectedVersion: file.version,
    });
    assert.equal(renamed.name, "renamed.txt");
    assert.equal(renamed.version, 2);
    await expectError(renameWorkspaceItem({
      actor: sam, id: file.id, name: "stale.txt", expectedVersion: file.version,
    }), "version_conflict", 409);

    const adminRename = await renameWorkspaceItem({
      actor: jerry, id: file.id, name: "admin.txt", expectedVersion: renamed.version,
    });
    assert.equal(adminRename.name, "admin.txt");
  });

  await t.test("mixed-owner subtrees are Administrator-managed and trash restores as one unit", async () => {
    await reset();
    const folder = await createWorkspaceFolder({ actor: sam, name: "Shared Folder" });
    await upload(wendy, "wendy.txt", "field notes", folder.id);
    const ownerView = (await listWorkspaceFiles({ actor: sam })).items[0];
    assert.equal(ownerView.capabilities.rename, false);
    assert.equal(ownerView.capabilities.trash, false);
    await expectError(trashWorkspaceItem({
      actor: sam, id: folder.id, expectedVersion: folder.version,
    }), "forbidden", 403);

    const trashed = await trashWorkspaceItem({
      actor: jerry, id: folder.id, expectedVersion: folder.version,
    });
    assert.ok(trashed.trashedAt);
    assert.equal((await listWorkspaceFiles({ actor: sam })).items.length, 0);
    assert.equal((await listWorkspaceFiles({ actor: sam, view: "trash" })).items.length, 1);
    assert.equal((await listWorkspaceFiles({ actor: wendy, view: "trash" })).items.length, 0);
    const adminTrash = await listWorkspaceFiles({ actor: jerry, view: "trash" });
    assert.equal(adminTrash.items[0].capabilities.restore, true);
    assert.equal(adminTrash.items[0].capabilities.purge, true);

    const restored = await restoreWorkspaceItem({
      actor: jerry, id: folder.id, expectedVersion: trashed.version,
    });
    assert.equal(restored.trashedAt, null);
    assert.equal((await listWorkspaceFiles({ actor: sam, parentId: folder.id })).items.length, 1);
  });

  await t.test("move prevents cycles and restore rejects a live name collision", async () => {
    await reset();
    const parent = await createWorkspaceFolder({ actor: sam, name: "Parent" });
    const child = await createWorkspaceFolder({ actor: sam, parentId: parent.id, name: "Child" });
    await expectError(moveWorkspaceItem({
      actor: sam, id: parent.id, parentId: child.id, expectedVersion: parent.version,
    }), "folder_cycle", 409);

    const trashed = await trashWorkspaceItem({ actor: sam, id: parent.id, expectedVersion: parent.version });
    await createWorkspaceFolder({ actor: wendy, name: "Parent" });
    await expectError(restoreWorkspaceItem({
      actor: sam, id: parent.id, expectedVersion: trashed.version,
    }), "name_conflict", 409);
  });

  await t.test("only an Administrator purges Trash and binary objects are removed", async () => {
    await reset();
    const file = await upload(sam, "remove.txt", "delete me");
    const stored = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{ storageKey: string }>;
    const objectPath = path.join(objectsPath, stored[0].storageKey.split("/").pop()!);
    assert.equal((await stat(objectPath)).isFile(), true);
    const trashed = await trashWorkspaceItem({ actor: sam, id: file.id, expectedVersion: file.version });
    await expectError(purgeWorkspaceItem({
      actor: sam, id: file.id, expectedVersion: trashed.version,
    }), "admin_required", 403);
    assert.deepEqual(await purgeWorkspaceItem({
      actor: jerry, id: file.id, expectedVersion: trashed.version,
    }), { id: file.id });
    await assert.rejects(stat(objectPath), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    assert.equal((await listWorkspaceFiles({ actor: jerry, view: "trash" })).items.length, 0);
  });

  await t.test("purging a nested mixed-owner folder removes every descendant binary", async () => {
    await reset();
    const folder = await createWorkspaceFolder({ actor: sam, name: "Purge tree" });
    const nested = await createWorkspaceFolder({ actor: sam, parentId: folder.id, name: "Nested" });
    await upload(sam, "root-file.txt", "root binary", folder.id);
    await upload(wendy, "nested-file.txt", "nested binary", nested.id);
    assert.equal((await listWorkspaceFileSubtreeIds(folder.id)).length, 2);
    const stored = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
      kind: "file" | "folder";
      storageKey: string | null;
    }>;
    const objectPaths = stored
      .filter((item) => item.kind === "file" && item.storageKey)
      .map((item) => path.join(objectsPath, item.storageKey!.split("/").pop()!));
    assert.equal(objectPaths.length, 2);
    for (const objectPath of objectPaths) assert.equal((await stat(objectPath)).isFile(), true);

    const trashed = await trashWorkspaceItem({ actor: jerry, id: folder.id, expectedVersion: folder.version });
    assert.equal(await getWorkspaceFileIndexSource((await listWorkspaceFileSubtreeIds(folder.id))[0]), null);
    await purgeWorkspaceItem({ actor: jerry, id: folder.id, expectedVersion: trashed.version });
    for (const objectPath of objectPaths) {
      await assert.rejects(
        stat(objectPath),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"),
      );
    }
    assert.deepEqual(JSON.parse(await readFile(recordsPath, "utf8")), []);
  });

  await t.test("content integrity failures are not served", async () => {
    await reset();
    const file = await upload(sam, "integrity.txt", "original");
    const stored = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{ storageKey: string }>;
    const objectPath = path.join(objectsPath, stored[0].storageKey.split("/").pop()!);
    await writeFile(objectPath, "tampered", "utf8");
    const content = await getWorkspaceFileContent({ actor: sam, id: file.id });
    assert.ok(content);
    await expectError(content.read(), "file_corrupt", 500);
    await rm(objectPath);
    await expectError(content.read(), "file_not_ready", 503);
  });

  await t.test("quota counts Trash and rejects another file when the owner limit is exhausted", async () => {
    await reset();
    const timestamp = new Date().toISOString();
    const records = Array.from({ length: 13 }, (_, index) => {
      const id = randomUUID();
      const sizeBytes = index === 12
        ? WORKSPACE_FILE_OWNER_LIMIT_BYTES - 12 * 20 * 1024 * 1024
        : 20 * 1024 * 1024;
      return {
        id,
        workspaceId: "company",
        parentId: null,
        kind: "file",
        name: `quota-${index}.bin`,
        nameKey: `quota-${index}.bin`,
        ownerUsername: "sam",
        contentType: "application/octet-stream",
        sizeBytes,
        checksum: "0".repeat(64),
        storageKey: `workspace-files/company/${id}`,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        updatedBy: "sam",
        trashedAt: index === 0 ? timestamp : null,
        trashedBy: index === 0 ? "sam" : null,
        trashRootId: index === 0 ? id : null,
      };
    });
    await writeFile(recordsPath, `${JSON.stringify(records)}\n`, "utf8");
    await expectError(upload(sam, "over.bin", "x"), "owner_quota_exceeded", 409);
  });

  await t.test("stored duplicates and an over-deep tree fail closed", async () => {
    await reset();
    const timestamp = new Date().toISOString();
    const duplicate = (id: string) => ({
      id,
      workspaceId: "company",
      parentId: null,
      kind: "folder",
      name: "Same",
      nameKey: "same",
      ownerUsername: "sam",
      contentType: null,
      sizeBytes: null,
      checksum: null,
      storageKey: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      updatedBy: "sam",
      trashedAt: null,
      trashedBy: null,
      trashRootId: null,
    });
    await writeFile(recordsPath, `${JSON.stringify([duplicate(randomUUID()), duplicate(randomUUID())])}\n`, "utf8");
    await expectError(listWorkspaceFiles({ actor: sam }), "invalid_storage", 500);

    const deep = [];
    let parentId: string | null = null;
    for (let index = 0; index < 21; index += 1) {
      const id = randomUUID();
      deep.push({ ...duplicate(id), parentId, name: `Level ${index}`, nameKey: `level ${index}` });
      parentId = id;
    }
    await writeFile(recordsPath, `${JSON.stringify(deep)}\n`, "utf8");
    await expectError(listWorkspaceFiles({ actor: sam }), "invalid_storage", 500);
  });
});
