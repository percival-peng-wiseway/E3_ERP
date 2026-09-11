import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function fixture(repository: string) {
  const bundled = await build({
    entryPoints: [`src/lib/${repository}/repository.ts`], bundle: true, write: false,
    platform: "node", format: "esm", target: "node22",
    plugins: [{ name: "cloud-storage", setup(builder) {
      builder.onResolve({ filter: /server\/cloudflare-storage(?:\.ts)?$/ }, () => ({ path: "storage", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export class CloudflareDocumentConflictError extends Error {}
        export class CloudflareStorageConfigurationError extends Error {}
        export async function erpCloudflareBindings() { return { database: {} }; }
        export async function readVersionedDocument() { return globalThis.__cloudQueueFixture.read(); }
        export async function writeVersionedDocument(db, key, value, expected) {
          const state = globalThis.__cloudQueueFixture;
          if (expected !== state.version) { state.conflicts++; throw new CloudflareDocumentConflictError(); }
          state.value = structuredClone(value); state.version++;
        }
      ` }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
}

const state = {
  value: [] as unknown[], version: 0, conflicts: 0,
  read: async (): Promise<{ value: unknown[]; version: number }> => ({ value: structuredClone(state.value), version: state.version }),
};
Object.assign(globalThis, { __cloudQueueFixture: state });
const projects = await fixture("payment-track") as typeof import("./repository");
const claims = await fixture("reimbursements") as typeof import("../reimbursements/repository");
const normalRead = state.read;

async function verifyIndependentRead(start: () => Promise<unknown>, read: () => Promise<unknown>) {
  let release!: () => void;
  let entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  state.read = async () => {
    if (first) { first = false; entered(); await pending; }
    return normalRead();
  };
  const blocked = start().catch(() => undefined);
  await began;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("another request blocked this read")), 500);
    })]);
  } finally {
    clearTimeout(timer); release(); await blocked; state.read = normalRead;
  }
}

test("cloud project reads do not wait for another request's unresolved I/O", async () => {
  await verifyIndependentRead(() => projects.listPaymentTrackProjects(), () => projects.listPaymentTrackProjects());
});

test("cloud reimbursement reads do not wait for another request's mutation", async () => {
  await verifyIndependentRead(() => claims.deleteReimbursement("missing"), () => claims.listReimbursements());
});

test("concurrent cloud project creation retries version conflicts without losing either write", async () => {
  const create = (quoteNumber: string) => projects.createManualPaymentTrackProject({
    quoteNumber, specialist: { name: "Test", phone: "" },
    customer: { firstName: "Test", lastName: "Customer", phone: "", email: "", addressLine1: "1 Test St", suburb: "Melbourne", state: "VIC", postcode: "3000" },
    items: [{ category: "Solar", model: "TEST", description: "Panel", quantity: 1, capacity: "475 W" }],
    balanceDueCents: 100000, expectedDepositCents: 10000, stcSolarRequired: false, stcBatteryRequired: false,
  });
  await Promise.all([create("CONCURRENT-A"), create("CONCURRENT-B")]);
  assert.ok(state.conflicts > 0);
  assert.deepEqual((await projects.listPaymentTrackProjects()).map((p) => p.quoteNumber).sort(), ["CONCURRENT-A", "CONCURRENT-B"]);
});
