import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import path from "node:path";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const calls: unknown[][] = [];
const globals = globalThis as typeof globalThis & { __projectDetailsTestCalls: unknown[][] };
globals.__projectDetailsTestCalls = calls;

async function loadRoute(route: string): Promise<Record<string, Handler>> {
  const result = await build({
    entryPoints: [path.resolve(`src/app/api/payment-track/[id]/${route}/route.ts`)],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22",
    plugins: [{ name: "test-boundaries", setup(builder) {
      builder.onResolve({ filter: /^(next\/server|@\/lib\/auth\/session|@\/lib\/server\/proxy-security|@\/lib\/payment-track\/(repository|auth))$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: module }) => {
        if (module === "next/server") return { contents: `export class NextResponse extends Response { static json(body, init) { return Response.json(body, init); } }` };
        if (module.endsWith("auth/session")) return { contents: `export function getErpSession(request) { const role = request.headers.get('x-test-role'); return role ? { user: { role, displayName: 'Signed-in person' } } : null; }` };
        if (module.endsWith("proxy-security")) return { contents: `export function isAuthorizedMutationRequest(request) { return request.headers.get('origin') === new URL(request.url).origin; }` };
        if (module.endsWith("payment-track/auth")) return { contents: `export function isPaymentTrackAdmin() { return false; }` };
        return { contents: `
          export class PaymentTrackRepositoryError extends Error {}
          export async function updatePaymentTrackProjectNotes(...args) { globalThis.__projectDetailsTestCalls.push(args); return { projectNotes: args[3] }; }
          export async function uploadPaymentTrackAttachment(...args) { globalThis.__projectDetailsTestCalls.push(args); return { attachments: [{ originalName: args[3].originalName }] }; }
          export async function getPaymentTrackFile() { return { accessToken: 'fixture-token', originalName: 'test.html', contentType: 'application/octet-stream', read: async () => new TextEncoder().encode('<html>test</html>') }; }
        ` };
      });
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const notes = await loadRoute("notes");
const files = await loadRoute("files");
const download = await loadRoute("files/[fileId]");
const context = { params: Promise.resolve({ id: "12345678-1234-4234-8234-123456789abc", fileId: "12345678-1234-4234-8234-123456789def" }) };
const url = "https://erp.example/api/payment-track/12345678-1234-4234-8234-123456789abc";
function noteRequest(body: unknown, role = "sales", origin = "https://erp.example") {
  return new Request(`${url}/notes`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-test-role": role, origin }, body: JSON.stringify(body) });
}
function fileRequest(file: File, role = "sales", origin = "https://erp.example", duplicate = false) {
  const body = new FormData();
  body.append("file", file);
  if (duplicate) body.append("file", file);
  return new Request(`${url}/files`, { method: "POST", headers: { "x-test-role": role, origin }, body });
}

test("notes endpoint binds attribution to signed-in users and rejects spoofed fields", async () => {
  for (const role of ["sales", "pm", "specialist", "admin"]) {
    assert.equal((await notes.PATCH(noteRequest({ notes: "Team update", expectedNotesUpdatedAt: null }, role), context)).status, 200);
    assert.equal(calls.at(-1)?.[1], role);
    assert.equal(calls.at(-1)?.[2], "Signed-in person");
  }
  for (const body of [
    { notes: "x" }, { notes: "x", expectedNotesUpdatedAt: "bad-date" },
    { notes: "x", expectedNotesUpdatedAt: null, actorRole: "admin" },
  ]) assert.equal((await notes.PATCH(noteRequest(body), context)).status, 400);
  const oversized = noteRequest({ notes: "x".repeat(33_000), expectedNotesUpdatedAt: null });
  assert.equal((await notes.PATCH(oversized, context)).status, 413);
});

test("new write endpoints reject unauthenticated and cross-origin requests before persistence", async () => {
  const count = calls.length;
  const body = { notes: "update", expectedNotesUpdatedAt: null };
  const file = new File(["document"], "test.docx");
  assert.equal((await notes.PATCH(noteRequest(body, ""), context)).status, 401);
  assert.equal((await notes.PATCH(noteRequest(body, "sales", "https://other.example"), context)).status, 403);
  assert.equal((await files.POST(fileRequest(file, ""), context)).status, 401);
  assert.equal((await files.POST(fileRequest(file, "sales", "https://other.example"), context)).status, 403);
  assert.equal(calls.length, count);
});

test("attachments validate preview signatures and download other documents as opaque files", async () => {
  assert.equal((await files.POST(fileRequest(new File(["%PDF-1.4\n"], "plan.pdf", { type: "application/pdf" })), context)).status, 201);
  assert.equal((calls.at(-1)?.[3] as { contentType: string }).contentType, "application/pdf");
  assert.equal((await files.POST(fileRequest(new File(["wrong bytes"], "plan.pdf", { type: "application/pdf" })), context)).status, 415);
  assert.equal((await files.POST(fileRequest(new File(["<html>test</html>"], "test.html", { type: "text/html" })), context)).status, 201);
  assert.equal((calls.at(-1)?.[3] as { contentType: string }).contentType, "application/octet-stream");
  const request = new Request(`${url}/files/test?token=fixture-token`) as Request & { nextUrl: URL };
  request.nextUrl = new URL(request.url);
  const response = await download.GET(request, context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /^attachment;/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  request.nextUrl = new URL(`${url}/files/test?token=wrong-token`);
  assert.equal((await download.GET(request, context)).status, 403);
});

test("empty, oversized and duplicate attachments are rejected without saving", async () => {
  const count = calls.length;
  assert.equal((await files.POST(fileRequest(new File([], "empty.txt")), context)).status, 400);
  assert.equal((await files.POST(fileRequest(new File(["text"], "test.txt"), "sales", "https://erp.example", true), context)).status, 400);
  const request = fileRequest(new File(["text"], "test.txt"));
  request.headers.set("content-length", String(11 * 1024 * 1024));
  assert.equal((await files.POST(request, context)).status, 413);
  assert.equal(calls.length, count);
});
