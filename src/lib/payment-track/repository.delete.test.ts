import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
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

test("delete removes a payment project and its stored files, then reports not found", async () => {
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

  assert.equal((await readdir(path.join(testDataDirectory, "contracts"))).length, 1);
  assert.equal((await deletePaymentTrackProject(created.id)).id, created.id);
  assert.equal((await listPaymentTrackProjects()).some((project) => project.id === created.id), false);
  assert.deepEqual(await readdir(path.join(testDataDirectory, "contracts")), []);

  await assert.rejects(
    deletePaymentTrackProject(created.id),
    (error: unknown) => (
      error instanceof PaymentTrackRepositoryError
      && error.status === 404
      && error.code === "not_found"
    ),
  );
});
