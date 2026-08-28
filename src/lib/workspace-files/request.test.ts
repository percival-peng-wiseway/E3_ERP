import assert from "node:assert/strict";
import { test } from "node:test";

const requestModule = "./request.ts";
const {
  declaredWorkspaceFilesBodyTooLarge,
  formHasExactFields,
  normalizeWorkspaceFileName,
  objectHasExactFields,
  parseWorkspaceFileContentMode,
  parseWorkspaceFileDelete,
  parseWorkspaceFileItemAction,
  parseWorkspaceFilesListQuery,
  readWorkspaceFilesBody,
  safeWorkspaceFileContentDisposition,
  workspaceFileExpectedVersion,
  workspaceFileId,
  workspaceFileParentId,
  workspaceFileSignatureMatches,
  workspaceFileUploadType,
  WorkspaceFilesRequestBodyTooLarge,
  workspaceFilesRequestIsJson,
  workspaceFilesRequestIsMultipart,
} = await import(requestModule) as typeof import("./request");

const ID = "123e4567-e89b-42d3-a456-426614174000";

test("file and folder names are normalized without accepting path or header control characters", () => {
  assert.equal(normalizeWorkspaceFileName("  Cafe\u0301 report.pdf  "), "Caf\u00e9 report.pdf");
  for (const name of ["", "   ", ".", "..", "../report.pdf", "folder\\report.pdf", "line\r\nbreak.txt", "safe\u202ename.txt"]) {
    assert.equal(normalizeWorkspaceFileName(name), null, name);
  }
  assert.equal(normalizeWorkspaceFileName("a".repeat(181)), null, "character length is enforced");
  assert.equal(normalizeWorkspaceFileName("😀".repeat(64)), null, "UTF-8 byte length is enforced");
  assert.equal(normalizeWorkspaceFileName("😀".repeat(63)), "😀".repeat(63));
});

test("IDs, root parent IDs and optimistic versions are strict", () => {
  assert.equal(workspaceFileId(ID.toLocaleUpperCase("en-AU")), ID);
  assert.equal(workspaceFileId("../item"), null);
  assert.equal(workspaceFileParentId(null), null);
  assert.equal(workspaceFileParentId(""), null);
  assert.equal(workspaceFileParentId(ID), ID);
  assert.equal(workspaceFileParentId("invalid"), undefined);
  assert.equal(workspaceFileExpectedVersion(1), 1);
  assert.equal(workspaceFileExpectedVersion(0), null);
  assert.equal(workspaceFileExpectedVersion("1"), null);
  assert.equal(workspaceFileExpectedVersion(2_147_483_648), null);
});

test("list and content queries accept only the documented exact shapes", () => {
  assert.deepEqual(parseWorkspaceFilesListQuery(new URLSearchParams()), {
    parentId: null,
    query: undefined,
    view: "active",
  });
  assert.deepEqual(parseWorkspaceFilesListQuery(new URLSearchParams({ parentId: ID })), {
    parentId: ID,
    query: undefined,
    view: "active",
  });
  assert.deepEqual(parseWorkspaceFilesListQuery(new URLSearchParams({ query: "  report  " })), {
    parentId: null,
    query: "report",
    view: "active",
  });
  assert.deepEqual(parseWorkspaceFilesListQuery(new URLSearchParams({ view: "trash" })), {
    parentId: null,
    query: undefined,
    view: "trash",
  });
  for (const query of [
    "owner=jerry",
    "parentId=invalid",
    "query=",
    "view=deleted",
    `parentId=${ID}&parentId=${ID}`,
    `parentId=${ID}&query=report`,
    "view=trash&query=report",
    `view=trash&parentId=${ID}`,
  ]) {
    assert.equal(parseWorkspaceFilesListQuery(new URLSearchParams(query)), null, query);
  }

  assert.equal(parseWorkspaceFileContentMode(new URLSearchParams()), "download");
  assert.equal(parseWorkspaceFileContentMode(new URLSearchParams({ mode: "preview" })), "preview");
  assert.equal(parseWorkspaceFileContentMode(new URLSearchParams({ mode: "download" })), "download");
  assert.equal(parseWorkspaceFileContentMode(new URLSearchParams({ mode: "inline" })), null);
  assert.equal(parseWorkspaceFileContentMode(new URLSearchParams("mode=preview&mode=download")), null);
  assert.equal(parseWorkspaceFileContentMode(new URLSearchParams({ token: "secret" })), null);
});

test("item mutations require exact action-specific fields and an optimistic version", () => {
  assert.deepEqual(parseWorkspaceFileItemAction({
    action: "rename", name: "  Report.pdf  ", expectedVersion: 2,
  }), { action: "rename", name: "Report.pdf", expectedVersion: 2 });
  assert.deepEqual(parseWorkspaceFileItemAction({
    action: "move", parentId: null, expectedVersion: 3,
  }), { action: "move", parentId: null, expectedVersion: 3 });
  assert.deepEqual(parseWorkspaceFileItemAction({
    action: "trash", expectedVersion: 4,
  }), { action: "trash", expectedVersion: 4 });
  assert.deepEqual(parseWorkspaceFileItemAction({
    action: "restore", expectedVersion: 5,
  }), { action: "restore", expectedVersion: 5 });

  for (const action of [
    { action: "rename", name: "../bad", expectedVersion: 1 },
    { action: "rename", name: "ok", expectedVersion: 0 },
    { action: "rename", name: "ok", expectedVersion: 1, owner: "jerry" },
    { action: "move", parentId: "bad", expectedVersion: 1 },
    { action: "trash", expectedVersion: 1, role: "admin" },
    { action: "purge", expectedVersion: 1 },
  ]) {
    assert.equal(parseWorkspaceFileItemAction(action), null, JSON.stringify(action));
  }
  assert.equal(parseWorkspaceFileDelete({ expectedVersion: 7 }), 7);
  assert.equal(parseWorkspaceFileDelete({ expectedVersion: 7, owner: "jerry" }), null);
  assert.equal(parseWorkspaceFileDelete({ expectedVersion: "7" }), null);
});

test("JSON objects and multipart forms reject missing, duplicate and unknown fields", () => {
  assert.equal(objectHasExactFields({ name: "Folder", parentId: null }, ["name"], ["parentId"]), true);
  assert.equal(objectHasExactFields({ parentId: null }, ["name"], ["parentId"]), false);
  assert.equal(objectHasExactFields({ name: "Folder", owner: "jerry" }, ["name"], ["parentId"]), false);

  const valid = new FormData();
  valid.set("file", "content");
  valid.set("parentId", ID);
  assert.equal(formHasExactFields(valid, ["file"], ["parentId"]), true);
  valid.append("file", "second");
  assert.equal(formHasExactFields(valid, ["file"], ["parentId"]), false);

  const extra = new FormData();
  extra.set("file", "content");
  extra.set("owner", "jerry");
  assert.equal(formHasExactFields(extra, ["file"], ["parentId"]), false);
});

test("content types require both an allowed extension and a compatible declaration", () => {
  assert.equal(workspaceFileUploadType("report.PDF", "application/pdf"), "application/pdf");
  assert.equal(workspaceFileUploadType("report.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(workspaceFileUploadType("report.csv", ""), "text/csv");
  assert.equal(workspaceFileUploadType("guide.md", "text/markdown; charset=utf-8"), "text/plain");
  assert.equal(workspaceFileUploadType("guide.md", "text/x-markdown"), "text/plain");
  assert.equal(workspaceFileUploadType("report.pdf.exe", "application/pdf"), null);
  assert.equal(workspaceFileUploadType("report.svg", "image/svg+xml"), null);
  assert.equal(workspaceFileUploadType("report.html", "text/html"), null);
  assert.equal(workspaceFileUploadType("report.pdf", "text/html"), null);
});

test("file signatures reject renamed content and generic ZIP files", () => {
  assert.equal(workspaceFileSignatureMatches("application/pdf", new TextEncoder().encode("%PDF-1.7")), true);
  assert.equal(workspaceFileSignatureMatches("application/pdf", new TextEncoder().encode("<html>")), false);
  assert.equal(workspaceFileSignatureMatches("image/png", Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])), true);
  assert.equal(workspaceFileSignatureMatches("text/plain", new TextEncoder().encode("safe text\n")), true);
  assert.equal(workspaceFileSignatureMatches("text/plain", Uint8Array.from([0x61, 0x00, 0x62])), false);

  const genericZip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("readme.txt")]);
  assert.equal(workspaceFileSignatureMatches(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    genericZip,
  ), false);
  const docxMarkers = Uint8Array.from([
    0x50, 0x4b, 0x03, 0x04,
    ...new TextEncoder().encode("[Content_Types].xml word/document.xml"),
  ]);
  assert.equal(workspaceFileSignatureMatches(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    docxMarkers,
  ), true);
});

test("body limits apply to both declared length and streamed bytes", async () => {
  assert.equal(declaredWorkspaceFilesBodyTooLarge(new Request("https://erp.test", {
    headers: { "content-length": "11" },
  }), 10), true);
  assert.equal(declaredWorkspaceFilesBodyTooLarge(new Request("https://erp.test", {
    headers: { "content-length": "10" },
  }), 10), false);
  assert.equal(declaredWorkspaceFilesBodyTooLarge(new Request("https://erp.test"), 10), false);

  const valid = new Request("https://erp.test", { method: "POST", body: "1234567890" });
  assert.equal((await readWorkspaceFilesBody(valid, 10)).byteLength, 10);
  const oversized = new Request("https://erp.test", { method: "POST", body: "12345678901" });
  await assert.rejects(readWorkspaceFilesBody(oversized, 10), WorkspaceFilesRequestBodyTooLarge);
});

test("request content-type checks and content disposition are strict", () => {
  assert.equal(workspaceFilesRequestIsJson(new Request("https://erp.test", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(workspaceFilesRequestIsJson(new Request("https://erp.test", {
    headers: { "content-type": "text/json" },
  })), false);
  assert.equal(workspaceFilesRequestIsMultipart(new Request("https://erp.test", {
    headers: { "content-type": "multipart/form-data; boundary=test" },
  })), true);
  assert.equal(workspaceFilesRequestIsMultipart(new Request("https://erp.test", {
    headers: { "content-type": "multipart/form-data" },
  })), false);

  const disposition = safeWorkspaceFileContentDisposition("attachment", "财务 report.pdf\r\nX-Evil: yes");
  assert.equal(disposition.includes("\r"), false);
  assert.equal(disposition.includes("\n"), false);
  assert.match(disposition, /^attachment; filename=/);
  assert.match(disposition, /filename\*=UTF-8''/);
});
