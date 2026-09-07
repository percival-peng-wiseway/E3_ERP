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
