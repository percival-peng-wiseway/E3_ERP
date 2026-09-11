import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import type { WorkEntry } from "./model";
const fixture = { value: [] as WorkEntry[], version: 0, conflict: false, missing: false, blobs: new Map<string, Uint8Array>(), puts: 0 };
Object.assign(globalThis, { __teamCloudTest: fixture });
const result = await build({ entryPoints: ["src/lib/team-workspace/repository.ts"], bundle: true, write: false, platform: "node", format: "esm", target: "node22", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "cloud-test", setup(builder) {
  builder.onResolve({ filter: /server\/cloudflare-storage(?:\.ts)?$/ }, () => ({ path: "storage", namespace: "test" }));
  builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
    export class CloudflareDocumentConflictError extends Error {}
    export class CloudflareStorageConfigurationError extends Error {}
    const state = globalThis.__teamCloudTest;
    export async function erpCloudflareBindings() { return state.missing ? null : { database: {}, files: {
      put: async (key, bytes) => { state.puts++; state.blobs.set(key, Uint8Array.from(bytes)); },
      get: async key => state.blobs.get(key)?.buffer || null
    } }; }
    export async function readVersionedDocument() { return { value: structuredClone(state.value), version: state.version }; }
    export async function writeVersionedDocument(db,key,value,version) {
      if (state.conflict) { state.conflict = false; state.version++; throw new CloudflareDocumentConflictError(); }
      if (version !== state.version) throw new CloudflareDocumentConflictError();
      state.value = structuredClone(value); state.version++;
    }
  ` }));
} }] });
const repository = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`) as typeof import("./repository");
const admin = { username: "admin", displayName: "Admin", role: "admin" as const };
const sam = { username: "sam", displayName: "Sam", role: "sales" as const };
const request = { kind: "task", title: "Cloud task", owner: "sam", date: "2026-09-11", content: "Requirements", goals: "Outcome", attendees: "", status: "start", update: "" };
test("production uses versioned cloud documents and private file keys, with bounded retry", async () => {
  const task = await repository.saveEntry(request, admin, ["admin", "sam"], ["admin"]);
  assert.equal(fixture.value[0].id, task.id);
  assert.equal((await repository.listEntries()).length, 1);
  fixture.conflict = true;
  const updated = await repository.saveEntry({ ...task, action: "save_employee", update: "Started" }, sam, ["admin", "sam"], ["admin"]);
  assert.equal(updated.status, "wip");
  await assert.rejects(repository.saveEntry({ ...task }, sam, ["admin", "sam"]), /changed/);
  fixture.conflict = true;
  const uploaded = await repository.saveEntry({ ...updated, update: "Attached" }, sam, ["admin", "sam"], ["admin"], { name: "test.txt", bytes: new TextEncoder().encode("attachment test") });
  assert.equal(fixture.puts, 1, "cloud contention must not re-upload the same KV key");
  assert.equal((await repository.readAttachment(task.id, uploaded.attachments![0].id)).bytes.toString(), "attachment test");
  const notice = uploaded.notifications!.find(item => item.recipient === "admin")!;
  await repository.markNotificationRead(notice.id, "admin");
  assert.equal(fixture.value[0].notifications!.find(item => item.id === notice.id)!.read, true);
  assert.equal(fixture.value[0].history.length, 3);
});
test("missing production bindings fail closed instead of using local files", async () => {
  fixture.missing = true;
  try { await assert.rejects(repository.listEntries(), /requires ERP_DB/); }
  finally { fixture.missing = false; }
});
