import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const component = await readFile(
  new URL("../../components/files-workspace.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../../components/files-workspace.module.css", import.meta.url),
  "utf8",
);

test("Files upload UI distinguishes storage success from Agent indexing", () => {
  assert.match(component, /type UploadKnowledgeStatus = "queued" \| "ready" \| "duplicate" \| "not_supported" \| "failed"/);
  assert.match(component, /knowledgeIndex\?: UploadKnowledgeIndex/);
  assert.match(component, /File saved · Indexing for Agent/);
  assert.match(component, /File saved · Ready for Agent/);
  assert.match(component, /File saved · Same content already available to Agent/);
  assert.match(component, /File saved · This file type is not indexed for Agent/);
  assert.match(component, /File saved · Agent indexing failed/);
  assert.match(component, /knowledgeIndex: uploadKnowledgeIndex\(body\.data\?\.knowledgeIndex\)/);
});

test("ordinary employees see queued indexing as handed off instead of an endless spinner", () => {
  assert.match(component, /currentUser\.role === "admin"\s*\? uploadTasks\.filter/);
  assert.match(component, /File saved · Sent for Agent indexing/);
  assert.match(component, /task\.knowledgeIndex\?\.status === "queued" && currentUser\.role === "admin" \? styles\.uploadIndexing/);
  assert.match(component, /task\.knowledgeIndex\?\.status === "queued" && currentUser\.role === "admin" \? <LoaderCircle/);
});

test("Files reconciles queued upload feedback with authoritative list status", () => {
  assert.match(component, /uploaded\?\.knowledge\?\.status/);
  assert.match(component, /task\.knowledgeIndex\?\.status === "failed" && \(status === "pending" \|\| status === "indexing"\)/);
  assert.match(component, /status === "ready"/);
  assert.match(component, /status === "failed"/);
  assert.match(component, /indexWorkInProgress/);
  assert.match(component, /window\.setInterval\(\(\) => void loadFiles\(true\), 5_000\)/);
  assert.match(styles, /\.uploadRow > span\.uploadIndexing/);
});

test("manual knowledge controls supplement rather than duplicate auto indexing", () => {
  assert.match(component, /item\.knowledge \? "Knowledge settings" : "Index for Agent"/);
  assert.doesNotMatch(component, /"Add to knowledge base"/);
  assert.match(component, /item\.knowledge\.status === "ready" \|\| item\.knowledge\.status === "failed"/);
  assert.match(component, /item\.knowledge\.status === "failed" \? "Retry indexing" : "Reindex"/);
  assert.match(component, /Saved only/);
  assert.match(component, /Not indexed for Agent/);
});
