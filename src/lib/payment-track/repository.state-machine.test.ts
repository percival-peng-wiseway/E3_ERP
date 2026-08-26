import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `payment-track-state-${randomUUID()}`);
process.env.PAYMENT_TRACK_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  createImportedPaymentTrackProject,
  createManualPaymentTrackProject,
  listPaymentTrackProjects,
  PaymentTrackRepositoryError,
  transitionPaymentTrackProject,
  uploadPaymentTrackProof,
} = await import(repositoryModule) as typeof import("./repository");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

function textPdf(lines: string[]) {
  const escapeText = (value: string) => value.replace(/([\\()])/g, "\\$1");
  const content = [
    "BT",
    "/F1 11 Tf",
    "72 760 Td",
    ...lines.flatMap((line, index) => [
      ...(index ? ["0 -18 Td"] : []),
      `(${escapeText(line)}) Tj`,
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  document += offsets.slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  document += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(document, "latin1"));
}

async function createInstallingProject(options: {
  stcSolarRequired: boolean;
  stcBatteryRequired: boolean;
  solarRebateRequired?: boolean;
  contractLines?: string[];
}) {
  const { contractLines, ...requirements } = options;
  const input = {
    quoteNumber: `TEST-${randomUUID()}`,
    specialist: { name: "Test Specialist", phone: "0400000000" },
    customer: {
      firstName: "Test",
      lastName: "Customer",
      phone: "0400000001",
      email: "customer@example.com",
      addressLine1: "1 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [{
      category: "Battery",
      description: "Test battery",
      model: "TEST-1",
      quantity: 1,
      capacity: "10 kWh",
    }],
    balanceDueCents: 10_000,
    expectedDepositCents: 1_000,
    ...requirements,
  };
  let project;
  if (contractLines) {
    const bytes = textPdf(contractLines);
    project = await createImportedPaymentTrackProject(input, {
      bytes,
      originalName: "agreement.pdf",
      contentType: "application/pdf",
      size: bytes.byteLength,
    });
  } else {
    project = await createManualPaymentTrackProject(input);
  }

  project = await uploadPaymentTrackProof(project.id, "deposit", "sales", {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    originalName: "deposit.jpg",
    contentType: "image/jpeg",
    size: 3,
  });
  project = await transitionPaymentTrackProject(project.id, "confirm_deposit", {
    actorRole: "admin",
    amountCents: 1_000,
  });
  project = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    deliveryDate: "2026-08-21",
    deliveryTime: "08:30",
    deliveryAssignee: "Leo",
  });
  project = await transitionPaymentTrackProject(project.id, "mark_delivered", {
    actorRole: "pm",
  });
  project = await transitionPaymentTrackProject(project.id, "acknowledge_collection", {
    actorRole: "sales",
  });
  project = await transitionPaymentTrackProject(project.id, "confirm_collection", {
    actorRole: "admin",
    amountCents: 1_000,
  });
  return project;
}

async function createInstalledProject(options: {
  stcSolarRequired: boolean;
  stcBatteryRequired: boolean;
  solarRebateRequired?: boolean;
  contractLines?: string[];
}) {
  let project = await createInstallingProject(options);
  project = await transitionPaymentTrackProject(project.id, "schedule_installation", {
    actorRole: "pm",
    installationDate: "2026-08-22",
    installationTime: "09:00",
    installationAssignee: "Daniel",
  });
  return transitionPaymentTrackProject(project.id, "mark_installed", {
    actorRole: "pm",
  });
}

function createPmNotesProject() {
  return createManualPaymentTrackProject({
    quoteNumber: `NOTES-${randomUUID()}`,
    specialist: { name: "Notes Specialist", phone: "0400000000" },
    customer: {
      firstName: "Notes",
      lastName: "Customer",
      phone: "",
      email: "",
      addressLine1: "2 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [{
      category: "Service",
      description: "Project service",
      model: "",
      quantity: 1,
      capacity: "",
    }],
    balanceDueCents: 1_000,
    expectedDepositCents: null,
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
  });
}

test("only an Administrator can skip completed real-world stages without changing payment balances", async () => {
  let project = await createPmNotesProject();
  const reason = "Stage was completed and verified before it was entered in ERP.";

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "skip_stage", {
      actorRole: "pm",
      reason,
      expectedUpdatedAt: project.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "skip_stage", {
      actorRole: "admin",
      reason: "   ",
      expectedUpdatedAt: project.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 400
      && error.code === "invalid_skip_reason",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "skip_stage", {
      actorRole: "admin",
      reason: "x".repeat(501),
      expectedUpdatedAt: project.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 400
      && error.code === "invalid_skip_reason",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "skip_stage", { actorRole: "admin", reason }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "stale_project",
  );

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "material_delivery");
  assert.equal(project.deposit.confirmedAmountCents, null);
  assert.equal(project.outstandingCents, 1_000);
  let audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", /Transition: deposit_not_paid → material_delivery/);
  assert.match(audit?.note || "", new RegExp(`Reason: ${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(audit?.note || "", /Fields populated: stage=material_delivery/);
  assert.match(audit?.note || "", new RegExp(`updatedAt=${project.updatedAt}`));

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "installing");
  assert.ok(project.deliveredAt);
  assert.equal(project.collection.confirmedAmountCents, null);
  assert.equal(project.outstandingCents, 1_000);
  audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", new RegExp(`deliveredAt=${project.deliveredAt}`));

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "waiting_coes");
  assert.ok(project.installedAt);
  audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", new RegExp(`installedAt=${project.installedAt}`));

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "done");
  assert.ok(project.coesReceivedAt);
  assert.ok(project.completedAt);
  assert.equal(project.history.filter((entry) => entry.action === "stage_skipped").length, 4);
  audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", new RegExp(`coesReceivedAt=${project.coesReceivedAt}`));
  assert.match(audit?.note || "", new RegExp(`completedAt=${project.completedAt}`));

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "skip_stage", {
      actorRole: "admin",
      reason,
      expectedUpdatedAt: project.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
});

test("skipping STC Rebate records every required receipt before completion", async () => {
  const reason = "Receipts were confirmed in the legacy finance system.";
  let project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: true,
    solarRebateRequired: true,
  });

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "stc_rebate");
  assert.ok(project.coesReceivedAt);

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "done");
  assert.ok(project.stcSolarReceivedAt);
  assert.ok(project.stcBatteryReceivedAt);
  assert.ok(project.solarRebateReceivedAt);
  assert.ok(project.completedAt);
  const audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", new RegExp(`stcSolarReceivedAt=${project.stcSolarReceivedAt}`));
  assert.match(audit?.note || "", new RegExp(`stcBatteryReceivedAt=${project.stcBatteryReceivedAt}`));
  assert.match(audit?.note || "", new RegExp(`solarRebateReceivedAt=${project.solarRebateReceivedAt}`));
  assert.match(audit?.note || "", new RegExp(`completedAt=${project.completedAt}`));
});

test("stage overrides never bypass a pending deposit or collection payment review", async () => {
  const reason = "Stage was completed outside ERP.";
  const upload = {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    originalName: "deposit.jpg",
    contentType: "image/jpeg" as const,
    size: 3,
  };

  let depositWithProof = await createPmNotesProject();
  depositWithProof = await uploadPaymentTrackProof(depositWithProof.id, "deposit", "sales", upload);
  await assert.rejects(
    transitionPaymentTrackProject(depositWithProof.id, "skip_stage", {
      actorRole: "admin",
      reason,
      expectedUpdatedAt: depositWithProof.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "payment_review_pending",
  );

  let acknowledgedDeposit = await createPmNotesProject();
  acknowledgedDeposit = await transitionPaymentTrackProject(acknowledgedDeposit.id, "acknowledge_deposit", {
    actorRole: "sales",
  });
  await assert.rejects(
    transitionPaymentTrackProject(acknowledgedDeposit.id, "skip_stage", {
      actorRole: "admin",
      reason,
      expectedUpdatedAt: acknowledgedDeposit.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "payment_review_pending",
  );

  let pendingCollection = await createPmNotesProject();
  pendingCollection = await transitionPaymentTrackProject(pendingCollection.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: pendingCollection.updatedAt,
  });
  pendingCollection = await transitionPaymentTrackProject(pendingCollection.id, "schedule_delivery", {
    actorRole: "pm",
    deliveryDate: "2026-08-21",
    deliveryTime: "08:30",
    deliveryAssignee: "Leo",
  });
  pendingCollection = await transitionPaymentTrackProject(pendingCollection.id, "mark_delivered", {
    actorRole: "pm",
  });
  pendingCollection = await transitionPaymentTrackProject(pendingCollection.id, "acknowledge_collection", {
    actorRole: "sales",
  });
  await assert.rejects(
    transitionPaymentTrackProject(pendingCollection.id, "skip_stage", {
      actorRole: "admin",
      reason,
      expectedUpdatedAt: pendingCollection.updatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "payment_review_pending",
  );
});

test("a stale Administrator stage override cannot skip the newly current stage", async () => {
  const reason = "Stage was completed outside ERP.";
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  const staleUpdatedAt = project.updatedAt;

  project = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    deliveryDate: "2026-08-21",
    deliveryTime: "08:30",
    deliveryAssignee: "Leo",
  });
  project = await transitionPaymentTrackProject(project.id, "mark_delivered", { actorRole: "pm" });
  project = await transitionPaymentTrackProject(project.id, "acknowledge_collection", { actorRole: "sales" });
  project = await transitionPaymentTrackProject(project.id, "confirm_collection", {
    actorRole: "admin",
    amountCents: 0,
  });
  assert.equal(project.stage, "installing");
  assert.notEqual(project.updatedAt, staleUpdatedAt);

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "skip_stage", {
      actorRole: "admin",
      reason,
      expectedUpdatedAt: staleUpdatedAt,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "stale_project",
  );

  const persisted = (await listPaymentTrackProjects()).find((candidate) => candidate.id === project.id);
  assert.equal(persisted?.stage, "installing");
  assert.equal(persisted?.installedAt, null);
  assert.equal(persisted?.history.filter((entry) => entry.action === "stage_skipped").length, 1);
});

test("Sales can upload deposit proof and the legacy Specialist role cannot", async () => {
  const project = await createPmNotesProject();
  const upload = {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    originalName: "deposit.jpg",
    contentType: "image/jpeg" as const,
    size: 3,
  };

  await assert.rejects(
    uploadPaymentTrackProof(project.id, "deposit", "specialist", upload),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );

  const updated = await uploadPaymentTrackProof(project.id, "deposit", "sales", upload);
  assert.equal(updated.deposit.proof?.uploadedByRole, "sales");
});

test("manual creation and PDF import reject an existing Proposal Number", async () => {
  const original = await createPmNotesProject();
  const duplicateInput = {
    quoteNumber: `  ${original.quoteNumber.toLocaleLowerCase("en-AU")}  `,
    specialist: original.specialist,
    customer: original.customer,
    items: original.items.map((item) => ({
      category: item.category,
      description: item.description,
      model: item.model,
      quantity: item.quantity,
      capacity: item.capacity,
    })),
    balanceDueCents: original.balanceDueCents,
    expectedDepositCents: original.expectedDepositCents,
    stcSolarRequired: original.stcSolarRequired,
    stcBatteryRequired: original.stcBatteryRequired,
    solarRebateRequired: original.solarRebateRequired,
  };

  await assert.rejects(
    createManualPaymentTrackProject(duplicateInput),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "duplicate_quote",
  );
  await assert.rejects(
    createImportedPaymentTrackProject(duplicateInput, {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      originalName: "duplicate.pdf",
      contentType: "application/pdf",
      size: 4,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "duplicate_quote",
  );

  const projects = await listPaymentTrackProjects();
  assert.equal(projects.filter((project) => (
    project.quoteNumber.toLocaleLowerCase("en-AU") === original.quoteNumber.toLocaleLowerCase("en-AU")
  )).length, 1);
});

test("Sales can confirm a paid deposit without uploading proof before Admin records the amount", async () => {
  let project = await createPmNotesProject();

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_deposit", {
      actorRole: "admin",
      amountCents: 1_000,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "acknowledge_deposit", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );

  project = await transitionPaymentTrackProject(project.id, "acknowledge_deposit", {
    actorRole: "sales",
    actorName: "Ruihan",
  });
  assert.equal(project.stage, "deposit_not_paid");
  assert.equal(project.deposit.proof, null);
  assert.ok(project.deposit.acknowledgedAt);
  assert.equal(project.deposit.acknowledgedBy, "Ruihan");
  assert.equal(project.history.at(-1)?.action, "deposit_acknowledged");

  project = await transitionPaymentTrackProject(project.id, "confirm_deposit", {
    actorRole: "admin",
    amountCents: 1_000,
  });
  assert.equal(project.stage, "material_delivery");
  assert.equal(project.deposit.confirmedAmountCents, 1_000);
});

test("only an Administrator can confirm any customer payment amount", async () => {
  const depositProject = await createPmNotesProject();
  const progressedProject = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });

  for (const actorRole of ["sales", "pm", "specialist"] as const) {
    await assert.rejects(
      transitionPaymentTrackProject(depositProject.id, "confirm_deposit", {
        actorRole,
        amountCents: 1_000,
      }),
      (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
    );
    await assert.rejects(
      transitionPaymentTrackProject(progressedProject.id, "confirm_collection", {
        actorRole,
        amountCents: 1_000,
      }),
      (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
    );
    await assert.rejects(
      transitionPaymentTrackProject(progressedProject.id, "confirm_final_payment", {
        actorRole,
        amountCents: 1_000,
        paymentId: randomUUID(),
      }),
      (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
    );
  }
});

test("PM installation scheduling saves date, time and assignee without advancing the project", async () => {
  const installing = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  assert.equal(installing.stage, "installing");
  assert.equal(installing.installationScheduledFor, null);
  assert.equal(installing.installationScheduledTime, null);
  assert.equal(installing.installationAssignee, null);

  const scheduled = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    actorName: "Jamie PM",
    installationDate: "2026-09-03",
    installationTime: "09:15",
    installationAssignee: "Leo",
  });
  assert.equal(scheduled.stage, "installing");
  assert.equal(scheduled.installedAt, null);
  assert.equal(scheduled.installationScheduledFor, "2026-09-03");
  assert.equal(scheduled.installationScheduledTime, "09:15");
  assert.equal(scheduled.installationAssignee, "Leo");
  assert.equal(scheduled.history.at(-1)?.action, "installation_scheduled");
  assert.equal(scheduled.history.at(-1)?.note, "2026-09-03 09:15 · Leo");

  const rescheduled = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    installationDate: "2026-09-04",
    installationTime: "13:45",
    installationAssignee: "Daniel",
  });
  assert.equal(rescheduled.stage, "installing");
  assert.equal(rescheduled.installationScheduledFor, "2026-09-04");
  assert.equal(rescheduled.installationScheduledTime, "13:45");
  assert.equal(rescheduled.installationAssignee, "Daniel");

  const installed = await transitionPaymentTrackProject(installing.id, "mark_installed", {
    actorRole: "pm",
  });
  assert.equal(installed.stage, "waiting_coes");
  assert.equal(installed.installationScheduledFor, "2026-09-04");
  assert.equal(installed.installationScheduledTime, "13:45");
  assert.equal(installed.installationAssignee, "Daniel");
});

test("PM delivery scheduling saves and replaces one date, time and assignee", async () => {
  const project = await createPmNotesProject();
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.stage = "material_delivery";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const scheduled = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    deliveryDate: "2026-09-07",
    deliveryTime: "07:30",
    deliveryAssignee: "Leo",
  });
  assert.equal(scheduled.deliveryScheduledFor, "2026-09-07");
  assert.equal(scheduled.deliveryScheduledTime, "07:30");
  assert.equal(scheduled.deliveryAssignee, "Leo");

  const rescheduled = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    deliveryDate: "2026-09-08",
    deliveryTime: "11:00",
    deliveryAssignee: "Daniel",
  });
  assert.equal(rescheduled.deliveryScheduledFor, "2026-09-08");
  assert.equal(rescheduled.deliveryScheduledTime, "11:00");
  assert.equal(rescheduled.deliveryAssignee, "Daniel");
});

test("installation scheduling enforces the PM role, date and installing stage", async () => {
  const installing = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "sales",
      installationDate: "2026-09-03",
      installationTime: "09:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      installationDate: "2026-02-30",
      installationTime: "09:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      installationDate: "2026-09-03",
      installationTime: "24:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      installationDate: "2026-09-03",
      installationTime: "09:00",
      installationAssignee: "Alex" as never,
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  const unready = await createPmNotesProject();
  await assert.rejects(
    transitionPaymentTrackProject(unready.id, "schedule_installation", {
      actorRole: "pm",
      installationDate: "2026-09-03",
      installationTime: "09:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
});

test("delivery and installation cannot complete from missing or legacy date-only schedules", async () => {
  const deliveryProject = await createPmNotesProject();
  const recordsPath = path.join(testDataDirectory, "records.json");
  let records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedDelivery = records.find((candidate) => candidate.id === deliveryProject.id);
  assert.ok(storedDelivery);
  storedDelivery.stage = "material_delivery";
  storedDelivery.deliveryScheduledFor = "2026-09-09";
  delete storedDelivery.deliveryScheduledTime;
  delete storedDelivery.deliveryAssignee;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  await assert.rejects(
    transitionPaymentTrackProject(deliveryProject.id, "mark_delivered", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  let installing = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "mark_installed", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedInstallation = records.find((candidate) => candidate.id === installing.id);
  assert.ok(storedInstallation);
  storedInstallation.installationScheduledFor = "2026-09-10";
  delete storedInstallation.installationScheduledTime;
  delete storedInstallation.installationAssignee;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "mark_installed", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  installing = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    installationDate: "2026-09-10",
    installationTime: "14:00",
    installationAssignee: "Leo",
  });
  const installed = await transitionPaymentTrackProject(installing.id, "mark_installed", {
    actorRole: "pm",
  });
  assert.equal(installed.stage, "waiting_coes");
});

test("listing persistently defaults legacy scheduling details to null", async () => {
  const project = await createPmNotesProject();
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  delete storedProject.deliveryScheduledFor;
  delete storedProject.installationScheduledFor;
  delete storedProject.deliveryScheduledTime;
  delete storedProject.deliveryAssignee;
  delete storedProject.installationScheduledTime;
  delete storedProject.installationAssignee;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const listed = await listPaymentTrackProjects();
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryScheduledFor, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationScheduledFor, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryScheduledTime, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryAssignee, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationScheduledTime, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationAssignee, null);
  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.deliveryScheduledFor, null);
  assert.equal(
    persisted.find((candidate) => candidate.id === project.id)?.installationScheduledFor,
    null,
  );
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.deliveryScheduledTime, null);
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.deliveryAssignee, null);
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.installationScheduledTime, null);
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.installationAssignee, null);
});

test("COES and final payment progress independently through the STC stage", async () => {
  let project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: false,
  });
  assert.equal(project.stage, "waiting_coes");
  assert.equal(project.outstandingCents, 8_000);

  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
  });
  const pendingPayment = project.finalPayments.at(-1);
  assert.ok(pendingPayment);

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "acknowledge_payment", { actorRole: "sales" }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "payment_review_pending"
    ),
  );

  project = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  assert.equal(project.stage, "stc_rebate");
  assert.equal(project.finalPayments.at(-1)?.confirmedAt, null);

  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: pendingPayment.id,
    amountCents: 2_500,
  });
  assert.equal(project.stage, "stc_rebate");
  assert.equal(project.outstandingCents, 5_500);

  project = await transitionPaymentTrackProject(project.id, "continue_to_stc", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "stc_rebate");

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_solar_rebate", { actorRole: "admin" }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "invalid_transition"
    ),
  );

  project = await transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "done");
  assert.equal(project.outstandingCents, 5_500);

  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
  });
  const donePayment = project.finalPayments.at(-1);
  assert.ok(donePayment);
  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: donePayment.id,
    amountCents: 5_500,
  });
  assert.equal(project.stage, "done");
  assert.equal(project.outstandingCents, 0);
});

test("COES completes a no-STC project even when money is still outstanding", async () => {
  let project = await createInstalledProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  project = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  assert.equal(project.stage, "done");
  assert.equal(project.outstandingCents, 8_000);

  project = await transitionPaymentTrackProject(project.id, "continue_to_stc", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "done");
});

test("STC-stage payment confirmation accepts zero and never advances the stage", async () => {
  let project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: true,
  });
  project = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
  });
  const payment = project.finalPayments.at(-1);
  assert.ok(payment);

  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: payment.id,
    amountCents: 0,
  });
  assert.equal(project.stage, "stc_rebate");
  assert.equal(project.outstandingCents, 8_000);
});

test("all required STC and Solar Rebate receipts are independent completion gates", async () => {
  let project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: true,
    solarRebateRequired: true,
  });
  project = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  assert.equal(project.stage, "stc_rebate");

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_solar_rebate", { actorRole: "pm" }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "role_forbidden"
    ),
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
      actorRole: "specialist",
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "role_forbidden"
    ),
  );
  project = await transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "stc_rebate");
  project = await transitionPaymentTrackProject(project.id, "confirm_stc_battery", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "stc_rebate");

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_solar_rebate", { actorRole: "sales" }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "role_forbidden"
    ),
  );

  project = await transitionPaymentTrackProject(project.id, "confirm_solar_rebate", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "done");
  assert.ok(project.solarRebateReceivedAt);
  assert.equal(
    project.history.filter((entry) => entry.action === "solar_rebate_confirmed").length,
    1,
  );
  assert.equal(project.history.filter((entry) => entry.action === "completed").length, 1);

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_solar_rebate", { actorRole: "admin" }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "invalid_transition"
    ),
  );
});

test("a Solar-Rebate-only project waits for Administrator confirmation", async () => {
  let project = await createInstalledProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: true,
  });
  project = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  assert.equal(project.stage, "stc_rebate");
  project = await transitionPaymentTrackProject(project.id, "confirm_solar_rebate", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "done");
  assert.ok(project.solarRebateReceivedAt);
});

test("listing persistently migrates a legacy COES-confirmed project to STC", async () => {
  const project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: false,
  });
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
    id: string;
    stage: string;
    coesReceivedAt: string | null;
  }>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.stage = "waiting_coes";
  storedProject.coesReceivedAt = "2026-08-21T02:00:00.000Z";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const firstList = await listPaymentTrackProjects();
  assert.equal(firstList.find((candidate) => candidate.id === project.id)?.stage, "stc_rebate");

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
    id: string;
    stage: string;
    coesReceivedAt: string | null;
  }>;
  const persistedProject = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(persistedProject?.stage, "stc_rebate");
  assert.equal(persistedProject?.coesReceivedAt, "2026-08-21T02:00:00.000Z");
});

test("legacy COES migration completes no-STC projects once without duplicate history", async () => {
  const project = await createInstalledProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
    id: string;
    stage: string;
    completedAt: string | null;
    coesReceivedAt: string | null;
    history: Array<{ action: string }>;
  }>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.stage = "waiting_coes";
  storedProject.coesReceivedAt = "2026-08-21T03:00:00.000Z";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  await listPaymentTrackProjects();
  await listPaymentTrackProjects();

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
    id: string;
    stage: string;
    completedAt: string | null;
    coesReceivedAt: string | null;
    history: Array<{ action: string }>;
  }>;
  const persistedProject = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(persistedProject?.stage, "done");
  assert.equal(persistedProject?.coesReceivedAt, "2026-08-21T03:00:00.000Z");
  assert.equal(persistedProject?.completedAt, "2026-08-21T03:00:00.000Z");
  assert.equal(
    persistedProject?.history.filter((entry) => entry.action === "completed").length,
    1,
  );
});

test("listing persistently defaults legacy Solar Rebate fields without changing workflow", async () => {
  const project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: false,
  });
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  delete storedProject.solarRebateRequired;
  delete storedProject.solarRebateReceivedAt;
  delete storedProject.solarRebateAssessmentVersion;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const firstList = await listPaymentTrackProjects();
  const secondList = await listPaymentTrackProjects();
  const firstProject = firstList.find((candidate) => candidate.id === project.id);
  const secondProject = secondList.find((candidate) => candidate.id === project.id);
  assert.equal(firstProject?.solarRebateRequired, false);
  assert.equal(firstProject?.solarRebateReceivedAt, null);
  assert.equal(secondProject?.solarRebateRequired, false);
  assert.equal(secondProject?.solarRebateReceivedAt, null);
  assert.equal("solarRebateAssessmentVersion" in (firstProject || {}), false);

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const persistedProject = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(persistedProject?.solarRebateRequired, false);
  assert.equal(persistedProject?.solarRebateReceivedAt, null);
  assert.equal(persistedProject?.solarRebateAssessmentVersion, 1);
});

test("an old imported contract backfills Solar Rebate and safely reopens an incorrect Done project", async () => {
  let project = await createInstalledProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
    contractLines: [
      "System Quote for Solar System",
      "System Price $10,000.00",
      "Less Federal Solar Rebate $2,000.00",
      "Balance Due $8,000.00",
      "Important Notice to the Customer",
    ],
  });
  project = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  assert.equal(project.stage, "done");
  assert.ok(project.completedAt);

  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.solarRebateRequired = false;
  delete storedProject.solarRebateAssessmentVersion;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const firstList = await listPaymentTrackProjects();
  const secondList = await listPaymentTrackProjects();
  const backfilled = firstList.find((candidate) => candidate.id === project.id);
  assert.equal(backfilled?.solarRebateRequired, true);
  assert.equal(backfilled?.solarRebateReceivedAt, null);
  assert.equal(backfilled?.stage, "stc_rebate");
  assert.equal(backfilled?.completedAt, null);
  assert.equal(
    backfilled?.history.filter((entry) => entry.action === "solar_rebate_requirement_backfilled").length,
    1,
  );
  assert.equal(
    secondList.find((candidate) => candidate.id === project.id)?.history
      .filter((entry) => entry.action === "solar_rebate_requirement_backfilled").length,
    1,
  );

  project = await transitionPaymentTrackProject(project.id, "confirm_solar_rebate", {
    actorRole: "admin",
  });
  assert.equal(project.stage, "done");
  assert.ok(project.solarRebateReceivedAt);
  assert.ok(project.completedAt);
  assert.equal(project.history.filter((entry) => entry.action === "completed").length, 2);

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const persistedProject = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(persistedProject?.solarRebateAssessmentVersion, 1);
  assert.equal(persistedProject?.solarRebateRequired, true);

  const alreadyRequiredRecords = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const alreadyRequiredProject = alreadyRequiredRecords.find((candidate) => candidate.id === project.id);
  assert.ok(alreadyRequiredProject);
  alreadyRequiredProject.solarRebateRequired = true;
  alreadyRequiredProject.solarRebateReceivedAt = null;
  delete alreadyRequiredProject.solarRebateAssessmentVersion;
  await writeFile(recordsPath, `${JSON.stringify(alreadyRequiredRecords, null, 2)}\n`, "utf8");

  const rechecked = await listPaymentTrackProjects();
  const recheckedProject = rechecked.find((candidate) => candidate.id === project.id);
  assert.equal(recheckedProject?.stage, "stc_rebate");
  assert.equal(recheckedProject?.completedAt, null);
  assert.equal(
    recheckedProject?.history.filter((entry) => entry.action === "solar_rebate_requirement_backfilled").length,
    2,
  );
});

test("an unevaluated contract without an authoritative price block cannot advance", async () => {
  const contractLines = [
    "System Quote for Battery Storage System",
    "Less Federal Battery Rebate $2,000.00",
    "Balance Due $8,000.00",
    "Important Notice to the Customer",
  ];
  const project = await createInstalledProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
    contractLines,
  });
  assert.equal(project.stage, "waiting_coes");

  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  const contract = storedProject.contract as { storedName: string };
  delete storedProject.solarRebateAssessmentVersion;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(testDataDirectory, "contracts", contract.storedName),
    textPdf([
      "Solar Agreement",
      "Terms and Conditions",
      "A rebate or STC may apply to this installation.",
    ]),
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "mark_coes_received", { actorRole: "pm" }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "solar_rebate_assessment_pending"
    ),
  );
  const listed = await listPaymentTrackProjects();
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.stage, "waiting_coes");

  await writeFile(
    path.join(testDataDirectory, "contracts", contract.storedName),
    textPdf(contractLines),
  );
  const retried = await listPaymentTrackProjects();
  assert.equal(retried.find((candidate) => candidate.id === project.id)?.solarRebateRequired, false);
});

test("a mutation normalizes and persists a legacy COES-confirmed stage before acting", async () => {
  const project = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: true,
  });
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
    id: string;
    stage: string;
    coesReceivedAt: string | null;
  }>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.stage = "waiting_coes";
  storedProject.coesReceivedAt = "2026-08-21T04:00:00.000Z";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const updated = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
  });
  assert.equal(updated.stage, "stc_rebate");
  assert.equal(updated.finalPayments.length, 1);

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
    id: string;
    stage: string;
  }>;
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.stage, "stc_rebate");
});

test("PM notes preserve internal newlines, clear safely and never advance workflow", async () => {
  const original = await createPmNotesProject();
  assert.equal(original.pmNotes, "");
  assert.equal(original.pmNotesUpdatedAt, null);
  assert.equal(original.pmNotesUpdatedBy, null);

  const updated = await transitionPaymentTrackProject(original.id, "update_pm_notes", {
    actorRole: "pm",
    actorName: "  Jamie PM  ",
    notes: "  First line\nSecond line  \n",
    expectedPmNotesUpdatedAt: null,
  });
  assert.equal(updated.pmNotes, "First line\nSecond line");
  assert.ok(updated.pmNotesUpdatedAt);
  assert.equal(updated.pmNotesUpdatedBy, "Jamie PM");
  assert.equal(updated.updatedAt, updated.pmNotesUpdatedAt);
  assert.equal(updated.stage, original.stage);
  const audit = updated.history.at(-1);
  assert.equal(audit?.action, "pm_notes_updated");
  assert.equal(audit?.note, null);

  await assert.rejects(
    transitionPaymentTrackProject(original.id, "update_pm_notes", {
      actorRole: "pm",
      notes: "Stale overwrite",
      expectedPmNotesUpdatedAt: null,
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "pm_notes_conflict"
    ),
  );
  await assert.rejects(
    transitionPaymentTrackProject(original.id, "update_pm_notes", {
      actorRole: "sales",
      notes: "Not allowed",
      expectedPmNotesUpdatedAt: updated.pmNotesUpdatedAt,
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "role_forbidden"
    ),
  );

  const cleared = await transitionPaymentTrackProject(original.id, "update_pm_notes", {
    actorRole: "pm",
    notes: " \n\t ",
    expectedPmNotesUpdatedAt: updated.pmNotesUpdatedAt,
  });
  assert.equal(cleared.pmNotes, "");
  assert.ok(cleared.pmNotesUpdatedAt);
  assert.notEqual(cleared.pmNotesUpdatedAt, updated.pmNotesUpdatedAt);
  assert.equal(cleared.stage, original.stage);
});

test("concurrent PM notes saves reject one stale writer", async () => {
  const project = await createPmNotesProject();
  const results = await Promise.allSettled([
    transitionPaymentTrackProject(project.id, "update_pm_notes", {
      actorRole: "pm",
      actorName: "PM One",
      notes: "First concurrent edit",
      expectedPmNotesUpdatedAt: null,
    }),
    transitionPaymentTrackProject(project.id, "update_pm_notes", {
      actorRole: "pm",
      actorName: "PM Two",
      notes: "Second concurrent edit",
      expectedPmNotesUpdatedAt: null,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => (
    result.status === "rejected"
    && result.reason instanceof PaymentTrackRepositoryError
    && result.reason.code === "pm_notes_conflict"
  )).length, 1);

  const listed = await listPaymentTrackProjects();
  const saved = listed.find((candidate) => candidate.id === project.id);
  assert.ok(saved);
  assert.ok(["First concurrent edit", "Second concurrent edit"].includes(saved.pmNotes));
  assert.ok(saved.pmNotesUpdatedAt);
});

test("listing persistently migrates legacy PM notes fields to empty values", async () => {
  const project = await createPmNotesProject();
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  delete storedProject.pmNotes;
  storedProject.pmNotesUpdatedAt = "not-a-timestamp";
  delete storedProject.pmNotesUpdatedBy;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const first = await listPaymentTrackProjects();
  const second = await listPaymentTrackProjects();
  for (const list of [first, second]) {
    const migrated = list.find((candidate) => candidate.id === project.id);
    assert.equal(migrated?.pmNotes, "");
    assert.equal(migrated?.pmNotesUpdatedAt, null);
    assert.equal(migrated?.pmNotesUpdatedBy, null);
  }

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const migrated = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(migrated?.pmNotes, "");
  assert.equal(migrated?.pmNotesUpdatedAt, null);
  assert.equal(migrated?.pmNotesUpdatedBy, null);
});

test("repository rejects missing versions and oversized PM notes", async () => {
  const project = await createPmNotesProject();
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "update_pm_notes", {
      actorRole: "pm",
      notes: "Missing version",
    }),
    (error: unknown) => (
      error instanceof PaymentTrackRepositoryError
      && error.code === "invalid_pm_notes_version"
    ),
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "update_pm_notes", {
      actorRole: "pm",
      notes: "x".repeat(5_001),
      expectedPmNotesUpdatedAt: null,
    }),
    (error: unknown) => (
      error instanceof PaymentTrackRepositoryError
      && error.code === "invalid_pm_notes"
    ),
  );
});
