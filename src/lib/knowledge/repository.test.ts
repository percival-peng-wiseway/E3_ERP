import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { KnowledgeDocumentCreateInput, KnowledgeIndexedChunkDraft } from "./types";

const dataDirectory = path.join(tmpdir(), `knowledge-repository-${randomUUID()}`);
process.env.KNOWLEDGE_DATA_DIR = dataDirectory;

const repositoryPath = "./repository.ts";
const repository = await import(repositoryPath) as typeof import("./repository");

after(async () => { await rm(dataDirectory, { recursive: true, force: true }); });

function createInput(patch: Partial<KnowledgeDocumentCreateInput> = {}): KnowledgeDocumentCreateInput {
  const checksum = randomUUID().replaceAll("-", "").padEnd(64, "a");
  return {
    fileId: randomUUID(), tenantId: "e3", fileVersion: 1, title: "Installer SOP", fileName: "installer.md",
    sourcePath: "Root / SOP / installer.md", contentType: "text/markdown", documentType: "sop",
    category: "installation", language: "en-AU", version: "1.0", checksum,
    createdBy: "sam", accessScope: "company", product: "H3", region: "AU", tags: ["install"], ...patch,
  };
}

test("identical active file bytes cannot be indexed under a second Files record", async () => {
  const first = createInput();
  await repository.createKnowledgeDocument(first);
  await assert.rejects(
    repository.createKnowledgeDocument({ ...first, fileId: randomUUID(), fileName: "duplicate.md" }),
    (error: unknown) => error instanceof repository.KnowledgeRepositoryError
      && error.code === "duplicate_checksum" && error.status === 409,
  );
});

test("a disabled duplicate cannot be re-enabled while the same bytes are active elsewhere", async () => {
  const first = createInput();
  const original = (await repository.createKnowledgeDocument(first)).document;
  await repository.disableKnowledgeForFile(original.fileId, "manual_admin_disable", "e3", "admin");
  await repository.createKnowledgeDocument({ ...first, fileId: randomUUID(), fileName: "replacement.md" });
  await assert.rejects(
    repository.reactivateKnowledgeForFile(original.fileId, "e3", "admin"),
    (error: unknown) => error instanceof repository.KnowledgeRepositoryError
      && error.code === "duplicate_checksum" && error.status === 409,
  );
});

function indexedChunk(id: string, text: string): KnowledgeIndexedChunkDraft {
  return {
    text, tokenCount: 10, headingPath: ["Install"], pageFrom: null, pageTo: null,
    contentChecksum: id.padEnd(64, "a").slice(0, 64), indexItemKey: `key-${id}`, indexItemId: `provider-${id}`,
  };
}

test("knowledge repository checksum, generations, jobs and atomic chunk activation", async () => {
  const input = createInput();
  const created = await repository.createKnowledgeDocument(input);
  assert.equal(created.action, "created");
  const duplicate = await repository.createKnowledgeDocument(input);
  assert.equal(duplicate.action, "unchanged");
  assert.equal(duplicate.document.id, created.document.id);

  const moved = await repository.createKnowledgeDocument({ ...input, sourcePath: "Root / Current / installer.md" });
  assert.equal(moved.action, "reindex_required");
  assert.equal(moved.document.indexGeneration, 2);

  const firstJob = await repository.enqueueKnowledgeIndexJob({ documentId: moved.document.id, tenantId: "e3", requestedBy: "sam", reason: "file_updated" });
  assert.equal(firstJob.status, "pending");
  assert.equal((await repository.getKnowledgeDocument(moved.document.id))?.status, "indexing");
  assert.equal((await repository.enqueueKnowledgeIndexJob({ documentId: moved.document.id, tenantId: "e3", requestedBy: "sam", reason: "duplicate" })).id, firstJob.id);
  const claimed = await repository.claimKnowledgeIndexJob({ jobId: firstJob.id, tenantId: "e3", workerId: "worker-1" });
  assert.equal(claimed?.status, "running");

  const firstSwap = await repository.replaceKnowledgeChunksAtomically(moved.document.id, 2, [indexedChunk("1", "first generation")]);
  assert.equal(firstSwap.activeChunks.length, 1);
  assert.equal(firstSwap.retiredChunks.length, 0);
  await repository.completeKnowledgeIndexJob(firstJob.id, "worker-1");
  assert.equal((await repository.getKnowledgeDocument(moved.document.id))?.status, "ready");

  const manualJob = await repository.enqueueKnowledgeIndexJob({ documentId: moved.document.id, tenantId: "e3", requestedBy: "jerry", reason: "manual_reindex" });
  assert.equal(manualJob.indexGeneration, 3);
  assert.equal((await repository.getKnowledgeDocument(moved.document.id))?.status, "indexing");
  await repository.claimKnowledgeIndexJob({ jobId: manualJob.id, tenantId: "e3", workerId: "worker-2" });
  const secondSwap = await repository.replaceKnowledgeChunksAtomically(moved.document.id, 3, [indexedChunk("2", "second generation")]);
  assert.equal(secondSwap.retiredChunks[0].indexItemId, "provider-1");
  assert.deepEqual((await repository.listActiveKnowledgeChunksForDocument(moved.document.id)).map((chunk) => chunk.text), ["second generation"]);
  await repository.completeKnowledgeIndexJob(manualJob.id, "worker-2");
});

test("local job claims recover an expired Worker lease", async () => {
  const start = new Date("2035-01-01T00:00:00.000Z");
  const afterExpiry = new Date("2035-01-01T00:00:31.000Z");
  const first = (await repository.createKnowledgeDocument(createInput())).document;
  const firstJob = await repository.enqueueKnowledgeIndexJob({ documentId: first.id, tenantId: "e3", requestedBy: "sam", reason: "lease_test" });
  const initiallyClaimed = await repository.claimKnowledgeIndexJob({
    jobId: firstJob.id, tenantId: "e3", workerId: "dead-worker", leaseSeconds: 30, now: start,
  });
  assert.equal(initiallyClaimed?.attempts, 1);
  assert.equal(await repository.claimKnowledgeIndexJob({
    jobId: firstJob.id, tenantId: "e3", workerId: "other-worker", leaseSeconds: 30,
    now: new Date("2035-01-01T00:00:10.000Z"),
  }), null);
  const reclaimedById = await repository.claimKnowledgeIndexJob({
    jobId: firstJob.id, tenantId: "e3", workerId: "replacement-worker", leaseSeconds: 30, now: afterExpiry,
  });
  assert.equal(reclaimedById?.attempts, 2);
  assert.equal(reclaimedById?.leaseOwner, "replacement-worker");
  await repository.completeKnowledgeIndexJob(firstJob.id, "replacement-worker");

  const second = (await repository.createKnowledgeDocument(createInput())).document;
  const secondJob = await repository.enqueueKnowledgeIndexJob({ documentId: second.id, tenantId: "e3", requestedBy: "sam", reason: "lease_test_next" });
  await repository.claimKnowledgeIndexJob({ jobId: secondJob.id, tenantId: "e3", workerId: "dead-next", leaseSeconds: 30, now: start });
  const reclaimedNext = await repository.claimNextKnowledgeIndexJob({
    tenantId: "e3", workerId: "replacement-next", leaseSeconds: 30, now: afterExpiry,
  });
  assert.equal(reclaimedNext?.id, secondJob.id);
  assert.equal(reclaimedNext?.attempts, 2);
  assert.equal(reclaimedNext?.leaseOwner, "replacement-next");
});

test("chunk activation and job completion share one lease-checked commit", async () => {
  const document = (await repository.createKnowledgeDocument(createInput())).document;
  const job = await repository.enqueueKnowledgeIndexJob({
    documentId: document.id,
    tenantId: "e3",
    requestedBy: "sam",
    reason: "atomic_finalize",
  });
  await repository.claimKnowledgeIndexJob({
    jobId: job.id,
    tenantId: "e3",
    workerId: "active-worker",
  });
  await assert.rejects(
    repository.replaceKnowledgeChunksAtomically(document.id, job.indexGeneration, [indexedChunk("3", "atomic generation")], {
      jobId: job.id,
      workerId: "wrong-worker",
    }),
    (error: unknown) => error instanceof repository.KnowledgeRepositoryError && error.code === "invalid_lease",
  );
  assert.deepEqual(await repository.listActiveKnowledgeChunksForDocument(document.id), []);
  assert.equal((await repository.getKnowledgeIndexJob(job.id))?.status, "running");

  await repository.replaceKnowledgeChunksAtomically(document.id, job.indexGeneration, [indexedChunk("3", "atomic generation")], {
    jobId: job.id,
    workerId: "active-worker",
  });
  assert.equal((await repository.getKnowledgeIndexJob(job.id))?.status, "completed");
  assert.equal((await repository.getKnowledgeDocument(document.id))?.status, "ready");
  assert.deepEqual((await repository.listActiveKnowledgeChunksForDocument(document.id)).map((chunk) => chunk.text), ["atomic generation"]);
});

test("metadata concurrency and manual disable fail closed", async () => {
  const created = (await repository.createKnowledgeDocument(createInput())).document;
  const updated = await repository.updateKnowledgeDocumentMetadata(created.id, { category: "commissioning", updatedBy: "jerry" }, created.updatedAt);
  assert.equal(updated.category, "commissioning");
  assert.equal(updated.status, "pending");
  await assert.rejects(
    repository.updateKnowledgeDocumentMetadata(created.id, { category: "stale", updatedBy: "jerry" }, created.updatedAt),
    (error: unknown) => error instanceof repository.KnowledgeRepositoryError && error.code === "version_conflict" && error.status === 409,
  );
  const disabled = await repository.disableKnowledgeForFile(created.fileId, "manual_admin_disable", "e3", "jerry");
  assert.equal(disabled?.status, "disabled");
  const trashAttempt = await repository.disableKnowledgeForFile(created.fileId, "file_moved_to_trash", "e3", "system");
  assert.equal(trashAttempt?.disabledReason, "manual_admin_disable");
  const reactivated = await repository.reactivateKnowledgeForFile(created.fileId, "e3", "jerry");
  assert.equal(reactivated.status, "pending");
  assert.equal(reactivated.indexGeneration, disabled!.indexGeneration + 1);
});
