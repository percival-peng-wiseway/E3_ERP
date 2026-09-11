import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = path.join(tmpdir(), `payment-track-details-${randomUUID()}`);
process.env.PAYMENT_TRACK_DATA_DIR = directory;
const repositoryModule = "./repository.ts";
const repository = await import(repositoryModule) as typeof import("./repository");
after(() => rm(directory, { recursive: true, force: true }));

async function createProject() {
  return repository.createManualPaymentTrackProject({
    quoteNumber: `DETAILS-${randomUUID()}`,
    specialist: { name: "Test Sales", phone: "" },
    customer: { firstName: "Test", lastName: "Project", phone: "", email: "", addressLine1: "1 Test St", suburb: "Melbourne", state: "VIC", postcode: "3000" },
    items: [{ category: "Solar", model: "TEST", description: "Test panel", quantity: 1, capacity: "475 W" }],
    balanceDueCents: 100_000, expectedDepositCents: 10_000,
    stcSolarRequired: false, stcBatteryRequired: false,
  });
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof repository.PaymentTrackRepositoryError && error.code === code;
}

test("shared notes persist independently from PM notes and do not advance project workflow", async () => {
  const original = await createProject();
  let project = original;
  for (const role of ["sales", "pm", "admin", "specialist"] as const) {
    project = await repository.updatePaymentTrackProjectNotes(project.id, role, `Test ${role}`, `  ${role} update\nSecond line  `, project.projectNotesUpdatedAt || null);
    assert.equal(project.projectNotes, `${role} update\nSecond line`);
    assert.equal(project.projectNotesUpdatedBy, `Test ${role}`);
    assert.equal(project.stage, original.stage);
    assert.equal(project.outstandingCents, original.outstandingCents);
    assert.deepEqual(project.deposit, original.deposit);
    assert.equal(project.pmNotes, original.pmNotes);
  }
  const saved = (await repository.listPaymentTrackProjects()).find((item) => item.id === project.id)!;
  assert.equal(saved.projectNotes, project.projectNotes);
  assert.equal(saved.history.at(-1)?.action, "project_notes_updated");
  assert.equal(saved.history.at(-1)?.note, null);
  project = await repository.updatePaymentTrackProjectNotes(project.id, "sales", "Test", "", project.projectNotesUpdatedAt!);
  assert.equal(project.projectNotes, "");
});

test("concurrent notes editors cannot overwrite each other and failed saves leave the winner intact", async () => {
  const project = await createProject();
  const results = await Promise.allSettled([
    repository.updatePaymentTrackProjectNotes(project.id, "sales", "One", "First edit", null),
    repository.updatePaymentTrackProjectNotes(project.id, "pm", "Two", "Second edit", null),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(hasCode("notes_conflict")(rejected.reason));
  const saved = (await repository.listPaymentTrackProjects()).find((item) => item.id === project.id)!;
  assert.equal(saved.projectNotes, "First edit");
  await assert.rejects(repository.updatePaymentTrackProjectNotes(project.id, "sales", "One", "x".repeat(5_001), saved.projectNotesUpdatedAt!), hasCode("invalid_notes"));
  await assert.rejects(repository.updatePaymentTrackProjectNotes(project.id, "sales", "One", "bad\u0000note", saved.projectNotesUpdatedAt!), hasCode("invalid_notes"));
});

test("attachments round-trip without replacing payment files, are project scoped and are deleted with the project", async () => {
  const project = await createProject();
  const other = await createProject();
  const bytes = new TextEncoder().encode("project document");
  const upload = { bytes, size: bytes.length, originalName: "handover.docx", contentType: "application/octet-stream" as const };
  await Promise.all([
    repository.uploadPaymentTrackAttachment(project.id, "sales", "Sales", upload),
    repository.uploadPaymentTrackAttachment(project.id, "pm", "PM", { ...upload, originalName: "equipment.xlsx" }),
  ]);
  const updated = (await repository.listPaymentTrackProjects()).find((item) => item.id === project.id)!;
  assert.equal(updated.attachments?.length, 2);
  assert.equal(updated.stage, project.stage);
  assert.deepEqual(updated.deposit, project.deposit);
  assert.equal(updated.contract, project.contract);
  for (const attachment of updated.attachments!) {
    assert.equal(attachment.kind, "attachment");
    assert.equal("storedName" in attachment, false);
    assert.equal("accessToken" in attachment, false);
    const file = await repository.getPaymentTrackFile(project.id, attachment.id);
    assert.ok(file);
    assert.deepEqual(await file.read(), bytes);
    assert.equal(await repository.getPaymentTrackFile(other.id, attachment.id), null);
  }
  await repository.deletePaymentTrackProject(project.id);
  assert.deepEqual(await readdir(path.join(directory, "proofs")), []);
  assert.equal(await repository.getPaymentTrackFile(project.id, updated.attachments![0].id), null);
});

test("legacy records expose empty notes and attachments; attachment limits reject writes before storage", async () => {
  const project = await createProject();
  assert.deepEqual(project.attachments, []);
  assert.equal(project.projectNotes, "");
  assert.equal(project.projectNotesUpdatedAt, null);
  const bytes = new Uint8Array([1]);
  const upload = { bytes, size: 1, originalName: "file.txt", contentType: "application/octet-stream" as const };
  await assert.rejects(repository.uploadPaymentTrackAttachment(project.id, "sales", "Test", { ...upload, size: 10 * 1024 * 1024 + 1 }), hasCode("invalid_file_size"));
  await assert.rejects(repository.uploadPaymentTrackAttachment(randomUUID(), "sales", "Test", upload), hasCode("not_found"));
  const recordsPath = path.join(directory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8"));
  records.find((item: { id: string }) => item.id === project.id).attachments = Array.from({ length: 50 }, () => ({}));
  await writeFile(recordsPath, JSON.stringify(records));
  await assert.rejects(repository.uploadPaymentTrackAttachment(project.id, "sales", "Test", upload), hasCode("attachment_limit"));
});

test("customer edits persist Coupling and leading-zero NMI without changing workflow or finance", async () => {
  const original = await createProject();
  let project = original;
  for (const role of ["sales", "pm", "admin", "specialist"] as const) {
    project = await repository.updatePaymentTrackCustomer(project.id, role, `Test ${role}`, {
      ...project.customer, firstName: "Edited", phone: "0400000000", addressLine1: "2 Test St", coupling: " AC ", nmi: " 00123456789 ",
    }, project.customerUpdatedAt || null);
    assert.equal(project.customer.coupling, "AC");
    assert.equal(project.customer.nmi, "00123456789");
    assert.equal(project.customer.addressLine1, "2 Test St");
    assert.equal(project.stage, original.stage);
    assert.equal(project.outstandingCents, original.outstandingCents);
    assert.deepEqual(project.deposit, original.deposit);
    assert.deepEqual(project.items, original.items);
    assert.equal(project.history.at(-1)?.action, "customer_updated");
    assert.equal(project.history.at(-1)?.note, null);
    assert.equal(project.history.at(-1)?.actorRole, role);
  }
  const saved = (await repository.listPaymentTrackProjects()).find((p) => p.id === project.id)!;
  assert.equal(saved.customer.nmi, "00123456789");
  const cleared = await repository.updatePaymentTrackCustomer(project.id, "sales", "Test", { ...saved.customer, coupling: "", nmi: "" }, saved.customerUpdatedAt!);
  assert.equal(cleared.customer.nmi, "");
  assert.equal(cleared.customer.coupling, "");
});

test("customer version prevents lost updates and remains independent of shared notes", async () => {
  const project = await createProject();
  await repository.updatePaymentTrackProjectNotes(project.id, "sales", "Test", "Keep these notes", null);
  const results = await Promise.allSettled([
    repository.updatePaymentTrackCustomer(project.id, "sales", "One", { ...project.customer, coupling: "AC", nmi: "00123456789" }, null),
    repository.updatePaymentTrackCustomer(project.id, "pm", "Two", { ...project.customer, coupling: "DC", nmi: "00000000000" }, null),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(hasCode("customer_conflict")(rejected.reason));
  const saved = (await repository.listPaymentTrackProjects()).find((p) => p.id === project.id)!;
  assert.equal(saved.customer.coupling, "AC");
  assert.equal(saved.projectNotes, "Keep these notes");
});

test("invalid customer data and installer edits cannot change stored customer fields", async () => {
  const project = await createProject();
  for (const input of [
    { ...project.customer, firstName: "", lastName: "" },
    { ...project.customer, nmi: 123456789 },
    { ...project.customer, nmi: "1".repeat(33) },
    { ...project.customer, coupling: "x".repeat(81) },
    { ...project.customer, email: "not-email" },
    { ...project.customer, phone: "bad\u0000value" },
    { ...project.customer, actorRole: "admin" },
  ]) await assert.rejects(repository.updatePaymentTrackCustomer(project.id, "sales", "Test", input, null), hasCode("invalid_customer"));
  await assert.rejects(repository.updatePaymentTrackCustomer(project.id, "installer" as never, "Test", project.customer, null), hasCode("role_forbidden"));
  await assert.rejects(repository.updatePaymentTrackCustomer(project.id, "sales", "Test", project.customer, undefined as never), hasCode("invalid_customer_version"));
  assert.deepEqual((await repository.listPaymentTrackProjects()).find((p) => p.id === project.id)!.customer, project.customer);
});


async function seedPayments(project: Awaited<ReturnType<typeof createProject>>, balanceDueCents = 410_000) {
  const recordsPath = path.join(directory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8"));
  const stored = records.find((item: { id: string }) => item.id === project.id);
  stored.balanceDueCents = balanceDueCents;
  stored.deposit.confirmedAmountCents = 100_000;
  stored.collection.confirmedAmountCents = 30_000;
  stored.finalPayments = [
    { ...stored.collection, id: randomUUID(), createdAt: project.createdAt, confirmedAmountCents: 20_000 },
    { ...stored.collection, id: randomUUID(), createdAt: project.createdAt, confirmedAmountCents: null, reportedAmountCents: 90_000 },
  ];
  await writeFile(recordsPath, JSON.stringify(records));
  return (await repository.listPaymentTrackProjects()).find((item) => item.id === project.id)!;
}

test("admin adjusts Amount Due using confirmed customer payments and preserves receipt and workflow data", async () => {
  const original = await seedPayments(await createProject());
  assert.equal(original.outstandingCents, 260_000);
  const changed = await repository.updatePaymentTrackAmountDue(original.id, "admin", "Signed Admin", 410_025, original.updatedAt, "  Contract correction  ");
  assert.equal(changed.outstandingCents, 410_025);
  assert.equal(changed.balanceDueCents, 560_025);
  for (const key of ["deposit", "collection", "finalPayments", "stage", "customer", "items", "expectedDepositCents"] as const) {
    assert.deepEqual(changed[key], original[key]);
  }
  const entry = changed.history.at(-1)!;
  assert.equal(entry.action, "amount_due_adjusted");
  assert.equal(entry.actorRole, "admin");
  assert.equal(entry.actorName, "Signed Admin");
  assert.equal(entry.note, "Contract correction");
  assert.equal(entry.at, changed.updatedAt);
  assert.ok(changed.updatedAt > original.updatedAt);
  assert.deepEqual(entry.amountAdjustment, { previousAmountDueCents: 260_000, amountDueCents: 410_025, previousBalanceDueCents: 410_000, balanceDueCents: 560_025, confirmedPaymentsCents: 150_000 });
  assert.deepEqual((await repository.listPaymentTrackProjects()).find((p) => p.id === original.id), changed);
  const zero = await repository.updatePaymentTrackAmountDue(changed.id, "admin", "Admin", 0, changed.updatedAt);
  assert.equal(zero.outstandingCents, 0);
  assert.equal(zero.balanceDueCents, 150_000);
  assert.equal(zero.stage, original.stage);
});

test("Amount Due no-op preserves existing overpayment and does not add history", async () => {
  const original = await seedPayments(await createProject(), 100_000);
  assert.equal(original.outstandingCents, 0);
  const unchanged = await repository.updatePaymentTrackAmountDue(original.id, "admin", "Admin", 0, original.updatedAt);
  assert.deepEqual(unchanged, original);
});

test("Amount Due rejects unauthorized, invalid and stale writes without changing stored amounts", async () => {
  const project = await seedPayments(await createProject());
  for (const role of ["sales", "pm", "specialist", "installer", "accountant"]) {
    await assert.rejects(repository.updatePaymentTrackAmountDue(project.id, role as never, "Test", 1, project.updatedAt), hasCode("role_forbidden"));
  }
  for (const value of [-1, 1.5, NaN, Infinity, 100_000_000_001, 100_000_000_000]) {
    await assert.rejects(repository.updatePaymentTrackAmountDue(project.id, "admin", "Test", value, project.updatedAt), hasCode("invalid_amount"));
  }
  for (const reason of ["x".repeat(501), "bad\u0000reason"]) {
    await assert.rejects(repository.updatePaymentTrackAmountDue(project.id, "admin", "Test", 1, project.updatedAt, reason), hasCode("invalid_reason"));
  }
  await assert.rejects(repository.updatePaymentTrackAmountDue(randomUUID(), "admin", "Test", 1, project.updatedAt), hasCode("not_found"));
  assert.deepEqual((await repository.listPaymentTrackProjects()).find((p) => p.id === project.id), project);
  const results = await Promise.allSettled([
    repository.updatePaymentTrackAmountDue(project.id, "admin", "One", 410_000, project.updatedAt),
    repository.updatePaymentTrackAmountDue(project.id, "admin", "Two", 510_000, project.updatedAt),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(hasCode("amount_due_conflict")((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason));
  const winner = (await repository.listPaymentTrackProjects()).find((p) => p.id === project.id)!;
  assert.equal(winner.outstandingCents, 410_000);
  await repository.updatePaymentTrackProjectNotes(winner.id, "pm", "PM", "Changed after editing began", null);
  await assert.rejects(repository.updatePaymentTrackAmountDue(winner.id, "admin", "Admin", 123, winner.updatedAt), hasCode("amount_due_conflict"));
});
