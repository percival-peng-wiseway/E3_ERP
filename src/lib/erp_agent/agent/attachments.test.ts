import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AgentAttachmentError,
  cleanAgentAttachmentIds,
  resolveAgentAttachments,
  resolveKimiImageParts,
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
} from "./attachments.ts";

test("attachment references accept only unique opaque file IDs", () => {
  const fileId = randomUUID();
  assert.deepEqual(cleanAgentAttachmentIds([{ file_id: fileId }]), [fileId]);
  assert.equal(cleanAgentAttachmentIds([{ file_id: fileId, name: "browser-value.pdf" }]), null);
  assert.equal(cleanAgentAttachmentIds([{ file_id: fileId }, { file_id: fileId }]), null);
  assert.equal(cleanAgentAttachmentIds([{ file_id: "not-an-id" }]), null);
});

test("attachment resolution derives metadata and canonical knowledge IDs from storage", async () => {
  const fileId = randomUUID();
  const documentId = randomUUID();
  const timestamp = new Date().toISOString();
  const result = await resolveAgentAttachments({
    fileIds: [fileId],
    actor: { username: "sam", displayName: "Sam", role: "sales" },
  }, {
    getFile: async () => ({
      item: {
        id: fileId,
        workspaceId: "company",
        parentId: null,
        kind: "file",
        name: "warranty.pdf",
        ownerUsername: "sam",
        ownerDisplayName: "Sam",
        contentType: "application/pdf",
        size: 1_024,
        checksum: "a".repeat(64),
        createdAt: timestamp,
        updatedAt: timestamp,
        updatedBy: "sam",
        trashedAt: null,
        trashedBy: null,
        version: 1,
        capabilities: { rename: true, move: true, trash: true, restore: false, purge: false },
      },
      read: async () => new Uint8Array(),
    }),
    getDocumentByFileId: async () => null,
    getActiveDocumentByChecksum: async () => ({
      id: documentId,
      tenantId: "e3",
      fileId: randomUUID(),
      fileVersion: 1,
      title: "Warranty",
      fileName: "warranty.pdf",
      sourcePath: "Files / warranty.pdf",
      contentType: "application/pdf",
      documentType: "policy",
      category: "Warranty",
      language: "en",
      sourceChecksum: "a".repeat(64),
      version: "1",
      indexGeneration: 1,
      status: "ready",
      accessScope: "company",
      product: null,
      region: null,
      effectiveFrom: null,
      effectiveTo: null,
      tags: [],
      lastIndexedAt: timestamp,
      errorCode: null,
      errorMessage: null,
      disabledAt: null,
      disabledReason: null,
      createdAt: timestamp,
      createdBy: "sam",
      updatedAt: timestamp,
      updatedBy: "sam",
    }),
  });

  assert.deepEqual(result, [{
    fileId,
    name: "warranty.pdf",
    contentType: "application/pdf",
    size: 1_024,
    status: "ready",
    knowledgeDocumentId: documentId,
  }]);
});

test("image attachments are Agent-ready and load only verified server bytes", async () => {
  const fileId = randomUUID();
  const timestamp = new Date().toISOString();
  const item = {
    id: fileId, workspaceId: "company" as const, parentId: null, kind: "file" as const,
    name: "panel.png", ownerUsername: "sam", ownerDisplayName: "Sam", contentType: "image/png",
    size: 3, checksum: "b".repeat(64), createdAt: timestamp, updatedAt: timestamp, updatedBy: "sam",
    trashedAt: null, trashedBy: null, version: 1,
    capabilities: { rename: true, move: true, trash: true, restore: false, purge: false },
  };
  const getFile = async () => ({ item, read: async () => new Uint8Array([1, 2, 3]) });
  const actor = { username: "sam", displayName: "Sam", role: "sales" as const };
  const attachments = await resolveAgentAttachments({ fileIds: [fileId], actor }, {
    getFile, getDocumentByFileId: async () => null, getActiveDocumentByChecksum: async () => null,
  });
  assert.equal(attachments[0]?.status, "ready");
  assert.equal(attachments[0]?.knowledgeDocumentId, null);
  assert.deepEqual(await resolveKimiImageParts({ attachments, actor }, { getFile }), [{
    type: "image_url", image_url: { url: "data:image/png;base64,AQID" },
  }]);
});

test("Kimi image payloads fail before loading bytes when the Worker-safe aggregate limit is exceeded", async () => {
  const actor = { username: "sam", displayName: "Sam", role: "sales" as const };
  const attachments = [12, 9].map((megabytes) => ({
    fileId: randomUUID(),
    name: `${megabytes}.png`,
    contentType: "image/png",
    size: megabytes * 1024 * 1024,
    status: "ready" as const,
    knowledgeDocumentId: null,
  }));
  await assert.rejects(resolveKimiImageParts({ attachments, actor }), (error: unknown) => {
    assert.ok(error instanceof AgentAttachmentError);
    assert.equal(error.status, 413);
    assert.match(error.message, /12 MB/u);
    return true;
  });
});
