import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const routeUrls = {
  list: new URL("../../app/api/files/route.ts", import.meta.url),
  folders: new URL("../../app/api/files/folders/route.ts", import.meta.url),
  upload: new URL("../../app/api/files/upload/route.ts", import.meta.url),
  items: new URL("../../app/api/files/items/[id]/route.ts", import.meta.url),
  content: new URL("../../app/api/files/items/[id]/content/route.ts", import.meta.url),
} as const;

const sources = Object.fromEntries(await Promise.all(
  Object.entries(routeUrls).map(async ([name, url]) => [name, await readFile(url, "utf8")]),
)) as Record<keyof typeof routeUrls, string>;

test("every Files route requires a real ERP session instead of trusting middleware bearer access", () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /getErpSession\(request\)/, `${name} reads the signed ERP session`);
    assert.match(source, /if \(!session\)/, `${name} rejects a missing ERP session`);
    assert.doesNotMatch(source, /isAuthorizedActorRequest|actorRole|body\.owner|body\.role/, `${name} does not trust a body actor`);
  }
});

test("every Files write route keeps same-origin mutation protection in addition to its session", () => {
  for (const name of ["folders", "upload", "items"] as const) {
    assert.match(sources[name], /isAuthorizedMutationRequest\(request\)/, `${name} has the mutation guard`);
    assert.ok(
      sources[name].indexOf("getErpSession(request)") < sources[name].indexOf("isAuthorizedMutationRequest(request)"),
      `${name} checks the real session before a bearer-aware mutation guard`,
    );
  }
  assert.match(sources.items, /session\.user\.role !== "admin"/);
  assert.match(sources.items, /parseWorkspaceFileDelete/);
  assert.match(sources.items, /MAX_DELETE_SIZE = 1024/);
});

test("upload validation is bounded, single-file and content-aware", () => {
  assert.match(sources.upload, /WORKSPACE_FILE_MAX_MULTIPART_BYTES/);
  assert.match(sources.upload, /formHasExactFields\(form, \["file"\], \["parentId"\]\)/);
  assert.match(sources.upload, /file\.size < 1 \|\| file\.size > WORKSPACE_FILE_MAX_BYTES/);
  assert.match(sources.upload, /workspaceFileUploadType/);
  assert.match(sources.upload, /workspaceFileSignatureMatches/);
  assert.doesNotMatch(sources.upload, /ownerUsername|ownerRole|accessToken/);
});

test("file content never accepts access tokens and uses safe download or restricted preview headers", () => {
  assert.doesNotMatch(sources.content, /searchParams\.get\("token"\)|accessToken/);
  assert.match(sources.content, /"attachment"/);
  assert.match(sources.content, /"application\/octet-stream"/);
  assert.match(sources.content, /"x-content-type-options": "nosniff"/);
  assert.match(sources.content, /"content-security-policy": "default-src 'none'; frame-ancestors 'self'; sandbox"/);
  assert.match(sources.content, /error\.code === "file_not_ready"/);
  assert.match(sources.content, /"retry-after", "5"/);
  assert.doesNotMatch(sources.content, /text\/html|image\/svg\+xml|javascript/);
});
