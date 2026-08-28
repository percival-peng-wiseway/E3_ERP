import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `payment-track-delete-${randomUUID()}`);
process.env.PAYMENT_TRACK_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  createImportedPaymentTrackProject,
  deletePaymentTrackProject,
  listPaymentTrackProjects,
  PaymentTrackRepositoryError,
} = await import(repositoryModule) as typeof import("./repository");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

test("delete removes a payment project plus contract and legacy QR files, then reports not found", async () => {
  const contract = new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF\n", "ascii"));
  const created = await createImportedPaymentTrackProject({
    quoteNumber: `DELETE-${randomUUID()}`,
    specialist: { name: "Test Specialist", phone: "0400000000" },
    customer: {
      firstName: "Delete",
      lastName: "Test",
      phone: "0400000001",
      email: "delete@example.com",
      addressLine1: "1 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [{
      category: "Solar",
      description: "Test system",
      model: "TEST-1",
      quantity: 1,
      capacity: "10 kW",
    }],
    balanceDueCents: 10_000,
    expectedDepositCents: 1_000,
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
  }, {
    blob: new Blob([contract], { type: "application/pdf" }),
    originalName: "agreement.pdf",
    contentType: "application/pdf",
    size: contract.byteLength,
  });

  const legacyQrStoredName = `${randomUUID()}.png`;
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === created.id);
  assert.ok(storedProject);
  storedProject.solarRebateQrCode = {
    id: randomUUID(),
    kind: "solar_rebate_qr_code",
    originalName: "legacy-qr.png",
    contentType: "image/png",
    size: 4,
    storedName: legacyQrStoredName,
    accessToken: "legacy-qr-token",
    uploadedAt: "2026-08-28T01:00:00.000Z",
    uploadedByRole: "pm",
  };
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(testDataDirectory, "proofs", legacyQrStoredName),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  );

  assert.equal((await readdir(path.join(testDataDirectory, "contracts"))).length, 1);
  assert.equal((await readdir(path.join(testDataDirectory, "proofs"))).length, 1);
  assert.equal((await deletePaymentTrackProject(created.id)).id, created.id);
  assert.equal((await listPaymentTrackProjects()).some((project) => project.id === created.id), false);
  assert.deepEqual(await readdir(path.join(testDataDirectory, "contracts")), []);
  assert.deepEqual(await readdir(path.join(testDataDirectory, "proofs")), []);

  await assert.rejects(
    deletePaymentTrackProject(created.id),
    (error: unknown) => (
      error instanceof PaymentTrackRepositoryError
      && error.status === 404
      && error.code === "not_found"
    ),
  );
});
