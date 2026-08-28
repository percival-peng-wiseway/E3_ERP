import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { registerAutomaticKnowledgeIndex } from "./automatic-index.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { automaticKnowledgeMetadata, isSupportedKnowledgeFile } from "./file-metadata.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KnowledgeRepositoryError } from "./repository.ts";
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeDocumentCreateInput, KnowledgeIndexJob } from "./types.ts";
import type { WorkspaceFileIndexSource } from "../workspace-files/types.ts";

function source(overrides: Partial<WorkspaceFileIndexSource> = {}): WorkspaceFileIndexSource {
  return {
    fileId: "10000000-0000-4000-8000-000000000001",
    name: "Troubleshooting_V1.03_中文.pdf",
    contentType: "application/pdf",
    size: 12,
    checksum: "a".repeat(64),
    version: 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
    sourcePath: "Files / Troubleshooting_V1.03_中文.pdf",
    async read() { return new Uint8Array([1]); },
    ...overrides,
  };
}

function document(input: KnowledgeDocumentCreateInput, status: KnowledgeDocument["status"] = "pending"): KnowledgeDocument {
  return {
    id: "20000000-0000-4000-8000-000000000002",
    tenantId: input.tenantId,
    fileId: input.fileId,
    fileVersion: input.fileVersion,
    title: input.title,
    fileName: input.fileName,
    sourcePath: input.sourcePath,
    contentType: input.contentType,
    documentType: input.documentType,
    category: input.category,
    language: input.language,
    sourceChecksum: input.checksum,
    version: input.version,
    indexGeneration: 1,
    status,
    accessScope: input.accessScope || "company",
    product: input.product || null,
    region: input.region || null,
    effectiveFrom: input.effectiveFrom || null,
    effectiveTo: input.effectiveTo || null,
    tags: input.tags || [],
    lastIndexedAt: status === "ready" ? "2026-08-28T00:01:00.000Z" : null,
    errorCode: null,
    errorMessage: null,
    disabledAt: null,
    disabledReason: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    createdBy: input.createdBy,
    updatedAt: "2026-08-28T00:00:00.000Z",
    updatedBy: input.createdBy,
  };
}

function job(documentId: string): KnowledgeIndexJob {
  return {
    id: "30000000-0000-4000-8000-000000000003",
    tenantId: "e3",
    documentId,
    indexGeneration: 1,
    status: "pending",
    reason: "automatic_file_upload",
    attempts: 0,
    availableAt: "2026-08-28T00:00:00.000Z",
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-08-28T00:00:00.000Z",
    requestedBy: "sam",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function canonicalDocument(
  status: KnowledgeDocument["status"],
  accessScope: KnowledgeDocument["accessScope"] = "company",
): KnowledgeDocument {
  const input: KnowledgeDocumentCreateInput = {
    tenantId: "e3",
    fileId: "40000000-0000-4000-8000-000000000004",
    fileVersion: 2,
    title: "Canonical manual",
    fileName: "canonical-manual.pdf",
    sourcePath: "Files / canonical-manual.pdf",
    contentType: "application/pdf",
    documentType: "manual",
    category: "Manual",
    language: "en",
    version: "2",
    checksum: "a".repeat(64),
    createdBy: "admin",
    accessScope,
  };
  return {
    ...document(input, status),
    id: "50000000-0000-4000-8000-000000000005",
    indexGeneration: 3,
    accessScope,
  };
}

function canonicalSource(canonical: KnowledgeDocument): WorkspaceFileIndexSource {
  return source({
    fileId: canonical.fileId,
    name: canonical.fileName,
    contentType: canonical.contentType,
    checksum: canonical.sourceChecksum,
    version: canonical.fileVersion,
    sourcePath: canonical.sourcePath,
  });
}

function canonicalChunk(canonical: KnowledgeDocument): KnowledgeChunk {
  return {
    id: "60000000-0000-4000-8000-000000000006",
    tenantId: "e3",
    documentId: canonical.id,
    indexedVersion: canonical.version,
    indexGeneration: canonical.indexGeneration,
    chunkIndex: 0,
    indexItemKey: `knowledge/${canonical.id}/g${canonical.indexGeneration}/00000`,
    indexItemId: "provider-item-1",
    text: "Canonical evidence",
    tokenCount: 2,
    headingPath: [],
    pageFrom: 1,
    pageTo: 1,
    contentChecksum: "b".repeat(64),
    active: true,
    createdAt: "2026-08-28T00:00:00.000Z",
    invalidatedAt: null,
  };
}

test("automatic knowledge eligibility is limited to PDF, DOCX, TXT and Markdown", () => {
  assert.equal(isSupportedKnowledgeFile("guide.pdf", "application/pdf"), true);
  assert.equal(isSupportedKnowledgeFile("guide.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), true);
  assert.equal(isSupportedKnowledgeFile("guide.txt", "text/plain"), true);
  assert.equal(isSupportedKnowledgeFile("guide.md", "text/plain"), true);
  assert.equal(isSupportedKnowledgeFile("data.csv", "text/csv"), false);
  assert.equal(isSupportedKnowledgeFile("photo.png", "image/png"), false);
  assert.equal(isSupportedKnowledgeFile("fake.txt", "application/pdf"), false);
  assert.equal(isSupportedKnowledgeFile("fake.pdf", "text/plain"), false);
});

test("automatic metadata is deterministic and recognizes useful filename signals", () => {
  assert.deepEqual(automaticKnowledgeMetadata(source()), {
    title: "Troubleshooting V1.03 中文",
    documentType: "troubleshooting",
    category: "Troubleshooting",
    language: "zh",
    version: "1.03",
  });
  assert.deepEqual(automaticKnowledgeMetadata(source({ name: "Installation policy.md", version: 4 })), {
    title: "Installation policy",
    documentType: "policy",
    category: "Policy",
    language: "en",
    version: "file-4",
  });
});

test("eligible uploads create a company document and durable job before returning queued", async () => {
  const createdInputs: KnowledgeDocumentCreateInput[] = [];
  const enqueuedInputs: Array<{ documentId: string; tenantId: "e3"; requestedBy: string; reason: string }> = [];
  const result = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument(input) {
        createdInputs.push(input);
        return { document: document(input), action: "created" };
      },
      async enqueueJob(input) {
        enqueuedInputs.push(input);
        return job(input.documentId);
      },
    },
  );
  assert.equal(createdInputs[0]?.accessScope, "company");
  assert.equal(createdInputs[0]?.tenantId, "e3");
  assert.deepEqual(createdInputs[0]?.tags, ["auto-indexed"]);
  assert.deepEqual(enqueuedInputs[0], {
    documentId: "20000000-0000-4000-8000-000000000002",
    tenantId: "e3",
    requestedBy: "sam",
    reason: "automatic_file_upload",
  });
  assert.deepEqual(result, {
    eligible: true,
    status: "queued",
    documentId: "20000000-0000-4000-8000-000000000002",
    jobId: "30000000-0000-4000-8000-000000000003",
    errorCode: null,
  });
});

test("an unchanged ready document does not enqueue duplicate work", async () => {
  let enqueueCalls = 0;
  const result = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument(input) { return { document: document(input, "ready"), action: "unchanged" }; },
      async enqueueJob(input) { enqueueCalls += 1; return job(input.documentId); },
    },
  );
  assert.equal(enqueueCalls, 0);
  assert.equal(result.status, "ready");
  assert.equal(result.documentId, "20000000-0000-4000-8000-000000000002");
});

test("unsupported uploads remain successful Files objects without index work", async () => {
  let calls = 0;
  const result = await registerAutomaticKnowledgeIndex(
    { file: source({ name: "photo.png", contentType: "image/png" }), requestedBy: "sam" },
    {
      async createDocument(input) { calls += 1; return { document: document(input), action: "created" }; },
      async enqueueJob(input) { calls += 1; return job(input.documentId); },
    },
  );
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    eligible: false,
    status: "not_supported",
    documentId: null,
    jobId: null,
    errorCode: null,
  });
});

test("registration failures are observable and never escape into the Files upload", async () => {
  const createFailure = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument() { throw new KnowledgeRepositoryError("offline", 503, "storage_unavailable"); },
      async enqueueJob(input) { return job(input.documentId); },
    },
  );
  assert.deepEqual(createFailure, {
    eligible: true,
    status: "failed",
    documentId: null,
    jobId: null,
    errorCode: "storage_unavailable",
  });

  const enqueueFailure = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument(input) { return { document: document(input), action: "created" }; },
      async enqueueJob() { throw new Error("secret provider detail"); },
    },
  );
  assert.equal(enqueueFailure.status, "failed");
  assert.equal(enqueueFailure.documentId, "20000000-0000-4000-8000-000000000002");
  assert.equal(enqueueFailure.errorCode, "knowledge_registration_failed");
});

test("duplicate content is a no-op only when company canonical evidence is active and ready", async () => {
  const canonical = canonicalDocument("ready");
  let enqueueCalls = 0;
  const result = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument() {
        throw new KnowledgeRepositoryError("already indexed", 409, "duplicate_checksum");
      },
      async enqueueJob(input) { enqueueCalls += 1; return job(input.documentId); },
      async findActiveDocumentByChecksum() { return canonical; },
      async getFileSource() { return canonicalSource(canonical); },
      async listActiveChunks() { return [canonicalChunk(canonical)]; },
    },
  );
  assert.equal(enqueueCalls, 0);
  assert.deepEqual(result, {
    eligible: true,
    status: "duplicate",
    documentId: canonical.id,
    jobId: null,
    errorCode: null,
  });
});

test("a failed company canonical document is retried idempotently instead of reported ready", async () => {
  const canonical = canonicalDocument("failed");
  const jobs: Array<{ documentId: string; reason: string }> = [];
  const result = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument() { throw new KnowledgeRepositoryError("duplicate", 409, "duplicate_checksum"); },
      async findActiveDocumentByChecksum() { return canonical; },
      async getFileSource() { return canonicalSource(canonical); },
      async listActiveChunks() { throw new Error("failed documents must not be treated as ready"); },
      async enqueueJob(input) {
        jobs.push({ documentId: input.documentId, reason: input.reason });
        return { ...job(input.documentId), indexGeneration: canonical.indexGeneration };
      },
    },
  );
  assert.deepEqual(jobs, [{ documentId: canonical.id, reason: "automatic_duplicate_recovery" }]);
  assert.equal(result.status, "queued");
  assert.equal(result.documentId, canonical.id);
  assert.equal(result.jobId, "30000000-0000-4000-8000-000000000003");
});

test("a pending canonical document with no active job is enqueued and returned as queued", async () => {
  const canonical = canonicalDocument("pending");
  let enqueueCalls = 0;
  const result = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument() { throw new KnowledgeRepositoryError("duplicate", 409, "duplicate_checksum"); },
      async findActiveDocumentByChecksum() { return canonical; },
      async getFileSource() { return canonicalSource(canonical); },
      async listActiveChunks() { return []; },
      async enqueueJob(input) {
        enqueueCalls += 1;
        return { ...job(input.documentId), indexGeneration: canonical.indexGeneration };
      },
    },
  );
  assert.equal(enqueueCalls, 1);
  assert.deepEqual(result, {
    eligible: true,
    status: "queued",
    documentId: canonical.id,
    jobId: "30000000-0000-4000-8000-000000000003",
    errorCode: null,
  });
});

test("a ready narrow-scope canonical document fails closed without widening its ACL", async () => {
  const canonical = canonicalDocument("ready", "admin");
  let downstreamCalls = 0;
  const result = await registerAutomaticKnowledgeIndex(
    { file: source(), requestedBy: "sam" },
    {
      async createDocument() { throw new KnowledgeRepositoryError("duplicate", 409, "duplicate_checksum"); },
      async findActiveDocumentByChecksum() { return canonical; },
      async getFileSource() { downstreamCalls += 1; return canonicalSource(canonical); },
      async listActiveChunks() { downstreamCalls += 1; return [canonicalChunk(canonical)]; },
      async enqueueJob(input) { downstreamCalls += 1; return job(input.documentId); },
    },
  );
  assert.equal(downstreamCalls, 0);
  assert.deepEqual(result, {
    eligible: true,
    status: "failed",
    documentId: canonical.id,
    jobId: null,
    errorCode: "scope_conflict",
  });
});
