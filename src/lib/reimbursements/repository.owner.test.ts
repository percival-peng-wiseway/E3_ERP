import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = await mkdtemp(path.join(tmpdir(), "reimbursements-owner-"));
process.env.REIMBURSEMENT_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  createReimbursement,
  getReimbursementInvoice,
  listReimbursements,
} = await import(repositoryModule) as typeof import("./repository");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

const invoiceBytes = new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF\n", "ascii"));

async function createClaim(claimantName: string, ownerTokenHash: string, ownerUsername?: string) {
  return createReimbursement({
    claimantName,
    expenseDate: "2026-08-24",
    note: `${claimantName} expense`,
    amountCents: 1_000,
    currency: "AUD",
    ownerTokenHash,
    ownerUsername,
  }, {
    bytes: invoiceBytes,
    originalName: `${claimantName.toLocaleLowerCase("en-AU")}.pdf`,
    contentType: "application/pdf",
    size: invoiceBytes.byteLength,
  });
}

test("ERP username ownership takes priority over a shared legacy browser token", async () => {
  const sharedTokenHash = "shared-browser-token-hash";
  const alice = await createClaim("Alice", sharedTokenHash, "Alice");
  const bob = await createClaim("Bob", sharedTokenHash, "bob");
  const legacy = await createClaim("Legacy", sharedTokenHash);

  const aliceClaims = await listReimbursements({
    ownerUsername: "ALICE",
    ownerTokenHash: sharedTokenHash,
  });
  assert.deepEqual(aliceClaims.map(({ id }) => id), [alice.id]);
  assert.deepEqual((await listReimbursements({ ownerUsername: "bob" })).map(({ id }) => id), [bob.id]);
  assert.deepEqual(await listReimbursements({ ownerUsername: "charlie" }), []);

  // Trusted callers without an ERP session retain the legacy token lookup.
  assert.deepEqual(
    new Set((await listReimbursements({ ownerTokenHash: sharedTokenHash })).map(({ id }) => id)),
    new Set([alice.id, bob.id, legacy.id]),
  );

  for (const claim of await listReimbursements({ includeAll: true })) {
    assert.equal(Object.hasOwn(claim, "ownerUsername"), false);
    assert.equal(Object.hasOwn(claim, "ownerTokenHash"), false);
  }

  const stored = JSON.parse(
    await readFile(path.join(testDataDirectory, "records.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  assert.equal(stored.find(({ id }) => id === alice.id)?.ownerUsername, "alice");
  assert.equal(Object.hasOwn(stored.find(({ id }) => id === legacy.id) || {}, "ownerUsername"), false);

  assert.equal((await getReimbursementInvoice(alice.id))?.ownerUsername, "alice");
  assert.equal((await getReimbursementInvoice(legacy.id))?.ownerUsername, undefined);
});
