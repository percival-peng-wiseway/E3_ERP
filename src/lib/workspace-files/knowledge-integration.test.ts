import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const routeUrls = {
  filesList: new URL("../../app/api/files/route.ts", import.meta.url),
  filesItem: new URL("../../app/api/files/items/[id]/route.ts", import.meta.url),
  filesContent: new URL("../../app/api/files/items/[id]/content/route.ts", import.meta.url),
  create: new URL("../../app/api/knowledge/documents/route.ts", import.meta.url),
  update: new URL("../../app/api/knowledge/documents/[id]/route.ts", import.meta.url),
  reindex: new URL("../../app/api/knowledge/documents/[id]/reindex/route.ts", import.meta.url),
  request: new URL("../../app/api/knowledge/request.ts", import.meta.url),
  background: new URL("../../app/api/knowledge/background.ts", import.meta.url),
  component: new URL("../../components/files-workspace.tsx", import.meta.url),
} as const;

const sources = Object.fromEntries(await Promise.all(
  Object.entries(routeUrls).map(async ([name, url]) => [name, await readFile(url, "utf8")]),
)) as Record<keyof typeof routeUrls, string>;

test("knowledge management writes require session, admin and same-origin protection", () => {
  for (const name of ["create", "update", "reindex"] as const) {
    const source = sources[name];
    assert.match(source, /getErpSession\(request\)/);
    assert.match(source, /session\.user\.role !== "admin"/);
    assert.match(source, /isAuthorizedMutationRequest\(request\)/);
    assert.match(source, /declaredWorkspaceFilesBodyTooLarge/);
    assert.match(source, /workspaceFilesRequestIsJson/);
    assert.doesNotMatch(source, /body\.(?:tenant|tenantId|role|permissions|createdBy|updatedBy)/);
  }
});

test("knowledge request parsing is exact, bounded and allow-listed", () => {
  assert.match(sources.request, /KNOWLEDGE_ROUTE_BODY_BYTES = 8 \* 1024/);
  assert.match(sources.request, /objectHasExactFields/);
  assert.match(sources.request, /KNOWLEDGE_DOCUMENT_TYPES\.includes/);
  assert.match(sources.request, /KNOWLEDGE_LANGUAGES\.includes/);
  assert.match(sources.request, /KNOWLEDGE_ACCESS_SCOPES\.includes/);
  assert.match(sources.request, /effectiveTo < effectiveFrom/);
});

test("indexing is queued into a durable Workflow in production", () => {
  assert.match(sources.background, /after\(async \(\) =>/);
  assert.match(sources.background, /knowledgeIndexWorkflow\.create/);
  assert.match(sources.background, /params: \{ jobId \}/);
  assert.match(sources.background, /processKnowledgeIndexJob\(jobId\)/);
  for (const name of ["create", "update", "reindex"] as const) {
    assert.match(sources[name], /enqueueKnowledgeIndexJob/);
    assert.match(sources[name], /continueKnowledgeIndex\(job\.id\)/);
  }
});

test("Cloudflare entrypoint exports the durable knowledge index Workflow", async () => {
  const [worker, wrangler] = await Promise.all([
    readFile(new URL("../../../worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /class KnowledgeIndexWorkflow extends WorkflowEntrypoint/);
  assert.match(worker, /timeout: "12 minutes"/);
  assert.match(worker, /workflowProviderTimeoutMs/);
  assert.match(worker, /workflowLeaseSeconds/);
  assert.match(worker, /knowledge-workflow:\$\{event\.instanceId\}/);
  assert.match(wrangler, /"main": "worker\.ts"/);
  assert.match(wrangler, /"binding": "KNOWLEDGE_INDEX_WORKFLOW"/);
  assert.match(wrangler, /"class_name": "KnowledgeIndexWorkflow"/);
  assert.match(wrangler, /"binding": "KNOWLEDGE_VECTORS"/);
  assert.match(wrangler, /"index_name": "e3-knowledge"/);
  assert.match(wrangler, /"binding": "AI"/);
  assert.doesNotMatch(wrangler, /KNOWLEDGE_SEARCH|ai-search/);
});

test("Files applies knowledge ACL before listing and downloading", () => {
  assert.match(sources.filesList, /query\.view === "knowledge" && session\.user\.role !== "admin"/);
  assert.match(sources.filesList, /listActiveKnowledgeChunkCounts/);
  assert.match(sources.filesList, /canAccessKnowledgeScope\(session\.user\.role, document\.accessScope\)/);
  assert.match(sources.filesContent, /getKnowledgeDocumentByFileId/);
  assert.match(sources.filesContent, /canAccessKnowledgeScope\(session\.user\.role, knowledgeDocument\.accessScope\)/);
  assert.match(sources.filesContent, /return workspaceFilesError\(404, "not_found"/);
  assert.match(sources.filesItem, /canAccessKnowledgeScope\(session\.user\.role, document\.accessScope\)/);
});

test("Files lifecycle withdraws and reactivates nested knowledge documents", () => {
  assert.match(sources.filesItem, /listWorkspaceFileSubtreeIds/);
  assert.match(sources.filesItem, /disableKnowledgeForFile/);
  assert.match(sources.filesItem, /reactivateKnowledgeForFile/);
  assert.match(sources.filesItem, /file_moved_to_trash/);
  assert.match(sources.filesItem, /file_restored/);
  assert.match(sources.filesItem, /file_permanently_deleted/);
  assert.match(sources.filesItem, /file_metadata_updated/);
  assert.match(sources.filesItem, /getWorkspaceFileIndexSource/);
  assert.match(sources.filesItem, /sourcePath: source\.sourcePath/);
});

test("knowledge controls are limited to administrators and supported unstructured files", () => {
  assert.match(sources.component, /currentUser\.role === "admin" && \(item\.knowledge \|\| canUseForKnowledge\(item\)\)/);
  assert.match(sources.component, /application\/pdf/);
  assert.match(sources.component, /wordprocessingml\.document/);
  assert.match(sources.component, /\\\.txt\$/);
  assert.match(sources.component, /text\/markdown/);
  assert.match(sources.component, /\\\.md\$/);
  for (const status of ["Pending", "Vectorizing", "Ready", "Failed", "Disabled"]) {
    assert.match(sources.component, new RegExp(`"${status}"`));
  }
});
