import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const route = await readFile(new URL("../../app/api/files/upload/route.ts", import.meta.url), "utf8");

test("Files upload persists the file before registering supported knowledge", () => {
  assert.ok(route.indexOf("await uploadWorkspaceFile") < route.lastIndexOf("registerAutomaticKnowledgeIndex"));
  assert.match(route, /getWorkspaceFileIndexSource\(item\.id\)/);
  assert.match(route, /requestedBy: session\.user\.username/);
});

test("Files upload reports knowledge status and continues queued jobs with after", () => {
  assert.match(route, /knowledgeIndex\.status === "queued"/);
  assert.match(route, /continueKnowledgeIndex\(knowledgeIndex\.jobId\)/);
  assert.match(route, /data: \{ item, knowledgeIndex \}/);
  assert.match(route, /errorCode: "knowledge_registration_failed"/);
  assert.match(route, /status: 201/);
});
