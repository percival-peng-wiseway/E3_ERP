import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `payment-track-state-${randomUUID()}`);
process.env.PAYMENT_TRACK_DATA_DIR = testDataDirectory;

const repositoryModule = "./repository.ts";
const {
  confirmPaymentTrackSolarRebateQrReceived,
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
  items?: Array<{
    category: string;
    description: string;
    model: string;
    quantity: number;
    capacity: string;
  }>;
}) {
  const { contractLines, items, ...requirements } = options;
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
    items: items || [{
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
  project = await preScheduleDelivery(project);
  project = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
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
  items?: Array<{
    category: string;
    description: string;
    model: string;
    quantity: number;
    capacity: string;
  }>;
}) {
  let project = await createInstallingProject(options);
  project = await preScheduleInstallation(project);
  project = await transitionPaymentTrackProject(project.id, "schedule_installation", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
    installationDate: "2026-08-22",
    installationTime: "09:00",
    installationAssignee: "Daniel",
  });
  return transitionPaymentTrackProject(project.id, "mark_installed", {
    actorRole: "pm",
  });
}

function createPmNotesProject(items = [{
  category: "Service",
  description: "Project service",
  model: "",
  quantity: 1,
  capacity: "",
}]) {
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
    items,
    balanceDueCents: 1_000,
    expectedDepositCents: null,
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: false,
  });
}

async function createQrRequiredWipProject() {
  let project = await createManualPaymentTrackProject({
    quoteNumber: `QR-${randomUUID()}`,
    specialist: { name: "QR Specialist", phone: "0400000000" },
    customer: {
      firstName: "QR",
      lastName: "Customer",
      phone: "",
      email: "",
      addressLine1: "3 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [{
      category: "Service",
      description: "QR-gated project service",
      model: "",
      quantity: 1,
      capacity: "",
    }],
    balanceDueCents: 1_000,
    expectedDepositCents: 100,
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: true,
    solarRebateQrRequired: true,
  });
  project = await transitionPaymentTrackProject(project.id, "acknowledge_deposit", {
    actorRole: "sales",
  });
  return transitionPaymentTrackProject(project.id, "confirm_deposit", {
    actorRole: "admin",
    amountCents: 100,
  });
}

function preScheduleDelivery(project: Awaited<ReturnType<typeof createPmNotesProject>>) {
  return transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
    actorRole: "sales",
    actorName: "Sam Sales",
    expectedUpdatedAt: project.updatedAt,
    deliverySelections: [{ sku: "TEST-WAREHOUSE-SKU", quantity: 1 }],
    preferredDate: "2026-08-21",
    preferredTime: "08:00",
    notes: "Customer prefers a morning delivery.",
  });
}

function preScheduleInstallation(project: Awaited<ReturnType<typeof createPmNotesProject>>) {
  return transitionPaymentTrackProject(project.id, "pre_schedule_installation", {
    actorRole: "sales",
    actorName: "Sam Sales",
    expectedUpdatedAt: project.updatedAt,
    preferredDate: "2026-08-22",
    preferredTime: "08:30",
    notes: "Customer prefers a morning installation.",
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
  assert.equal(project.stage, "working_in_progress");
  assert.equal(project.deposit.confirmedAmountCents, null);
  assert.equal(project.outstandingCents, 1_000);
  let audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", /Transition: deposit_not_paid → working_in_progress/);
  assert.match(audit?.note || "", new RegExp(`Reason: ${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(audit?.note || "", /Fields populated: stage=working_in_progress/);
  assert.match(audit?.note || "", new RegExp(`updatedAt=${project.updatedAt}`));

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "waiting_coes");
  assert.ok(project.deliveredAt);
  assert.ok(project.installedAt);
  assert.equal(project.collection.confirmedAmountCents, null);
  assert.equal(project.outstandingCents, 1_000);
  audit = project.history.filter((entry) => entry.action === "stage_skipped").at(-1);
  assert.match(audit?.note || "", new RegExp(`deliveredAt=${project.deliveredAt}`));
  assert.match(audit?.note || "", new RegExp(`installedAt=${project.installedAt}`));

  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "done");
  assert.ok(project.coesReceivedAt);
  assert.ok(project.completedAt);
  assert.equal(project.history.filter((entry) => entry.action === "stage_skipped").length, 3);
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
  assert.equal(project.stcSolarReceivedAmountCents, null);
  assert.equal(project.stcBatteryReceivedAmountCents, null);
  assert.equal(project.solarRebateReceivedAmountCents, null);
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
  pendingCollection = await preScheduleDelivery(pendingCollection);
  pendingCollection = await transitionPaymentTrackProject(pendingCollection.id, "schedule_delivery", {
    actorRole: "pm",
    expectedUpdatedAt: pendingCollection.updatedAt,
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
  pendingCollection = await transitionPaymentTrackProject(pendingCollection.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: pendingCollection.updatedAt,
  });
  assert.equal(pendingCollection.stage, "waiting_coes");
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

  project = await preScheduleDelivery(project);
  project = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
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
  assert.equal(project.stage, "working_in_progress");
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
  assert.equal(persisted?.stage, "working_in_progress");
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
  assert.equal(project.stage, "working_in_progress");
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
  let installing = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  assert.equal(installing.stage, "working_in_progress");
  assert.equal(installing.installationScheduleRequest, null);
  assert.equal(installing.installationScheduledFor, null);
  assert.equal(installing.installationScheduledTime, null);
  assert.equal(installing.installationAssignee, null);

  installing = await preScheduleInstallation(installing);
  const request = installing.installationScheduleRequest;
  assert.ok(request);
  assert.equal(request.preferredDate, "2026-08-22");
  assert.equal(request.preferredTime, "08:30");
  assert.equal(request.submittedBy, "Sam Sales");
  assert.equal(installing.history.at(-1)?.action, "installation_pre_scheduled");

  const scheduled = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    actorName: "Jamie PM",
    expectedUpdatedAt: installing.updatedAt,
    installationDate: "2026-09-03",
    installationTime: "09:15",
    installationAssignee: "Leo",
  });
  assert.equal(scheduled.stage, "working_in_progress");
  assert.equal(scheduled.installedAt, null);
  assert.equal(scheduled.installationScheduledFor, "2026-09-03");
  assert.equal(scheduled.installationScheduledTime, "09:15");
  assert.equal(scheduled.installationAssignee, "Leo");
  assert.deepEqual(scheduled.installationScheduleRequest, request);
  assert.equal(scheduled.history.at(-1)?.action, "installation_scheduled");
  assert.equal(scheduled.history.at(-1)?.note, "2026-09-03 09:15 · Leo");

  const rescheduled = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    expectedUpdatedAt: scheduled.updatedAt,
    installationDate: "2026-09-04",
    installationTime: "13:45",
    installationAssignee: "Daniel",
  });
  assert.equal(rescheduled.stage, "working_in_progress");
  assert.equal(rescheduled.installationScheduledFor, "2026-09-04");
  assert.equal(rescheduled.installationScheduledTime, "13:45");
  assert.equal(rescheduled.installationAssignee, "Daniel");
  assert.deepEqual(rescheduled.installationScheduleRequest, request);

  const installed = await transitionPaymentTrackProject(installing.id, "mark_installed", {
    actorRole: "pm",
  });
  assert.equal(installed.stage, "waiting_coes");
  assert.equal(installed.installationScheduledFor, "2026-09-04");
  assert.equal(installed.installationScheduledTime, "13:45");
  assert.equal(installed.installationAssignee, "Daniel");
});

test("Sales delivery pre-schedule is retained when PM chooses and later changes the final schedule", async () => {
  let project = await createPmNotesProject();
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.stage = "material_delivery";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  project = await preScheduleDelivery(project);
  const request = project.deliveryScheduleRequest;
  assert.ok(request);
  assert.equal(request.preferredDate, "2026-08-21");
  assert.equal(request.preferredTime, "08:00");
  assert.equal(request.notes, "Customer prefers a morning delivery.");
  assert.equal(request.submittedBy, "Sam Sales");
  assert.deepEqual(project.deliverySelections, [{ sku: "TEST-WAREHOUSE-SKU", quantity: 1 }]);
  assert.equal(project.history.at(-1)?.action, "delivery_pre_scheduled");

  const scheduled = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
    deliveryDate: "2026-09-07",
    deliveryTime: "07:30",
    deliveryAssignee: "Leo",
  });
  assert.equal(scheduled.deliveryScheduledFor, "2026-09-07");
  assert.equal(scheduled.deliveryScheduledTime, "07:30");
  assert.equal(scheduled.deliveryAssignee, "Leo");
  assert.deepEqual(scheduled.deliveryScheduleRequest, request);

  const rescheduled = await transitionPaymentTrackProject(project.id, "schedule_delivery", {
    actorRole: "pm",
    expectedUpdatedAt: scheduled.updatedAt,
    deliveryDate: "2026-09-08",
    deliveryTime: "11:00",
    deliveryAssignee: "Daniel",
  });
  assert.equal(rescheduled.deliveryScheduledFor, "2026-09-08");
  assert.equal(rescheduled.deliveryScheduledTime, "11:00");
  assert.equal(rescheduled.deliveryAssignee, "Daniel");
  assert.deepEqual(rescheduled.deliveryScheduleRequest, request);
});

test("legacy complete final schedules can be rescheduled without a Sales pre-schedule request", async () => {
  const recordsPath = path.join(testDataDirectory, "records.json");
  const delivery = await createPmNotesProject();
  let records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedDelivery = records.find((candidate) => candidate.id === delivery.id);
  assert.ok(storedDelivery);
  storedDelivery.stage = "material_delivery";
  delete storedDelivery.deliverySelections;
  storedDelivery.deliveryScheduleRequest = null;
  storedDelivery.deliveryScheduledFor = "2026-09-01";
  storedDelivery.deliveryScheduledTime = "08:00";
  storedDelivery.deliveryAssignee = "Leo";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const rescheduledDelivery = await transitionPaymentTrackProject(delivery.id, "schedule_delivery", {
    actorRole: "pm",
    expectedUpdatedAt: delivery.updatedAt,
    deliveryDate: "2026-09-02",
    deliveryTime: "10:30",
    deliveryAssignee: "Daniel",
  });
  assert.equal(rescheduledDelivery.deliveryScheduleRequest, null);
  assert.deepEqual(rescheduledDelivery.deliverySelections, []);
  assert.equal(rescheduledDelivery.deliveryScheduledFor, "2026-09-02");
  assert.equal(rescheduledDelivery.deliveryScheduledTime, "10:30");
  assert.equal(rescheduledDelivery.deliveryAssignee, "Daniel");

  const installing = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedInstallation = records.find((candidate) => candidate.id === installing.id);
  assert.ok(storedInstallation);
  storedInstallation.installationScheduleRequest = null;
  storedInstallation.installationScheduledFor = "2026-09-03";
  storedInstallation.installationScheduledTime = "09:00";
  storedInstallation.installationAssignee = "Leo";
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const rescheduledInstallation = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    expectedUpdatedAt: installing.updatedAt,
    installationDate: "2026-09-04",
    installationTime: "13:00",
    installationAssignee: "Daniel",
  });
  assert.equal(rescheduledInstallation.installationScheduleRequest, null);
  assert.equal(rescheduledInstallation.installationScheduledFor, "2026-09-04");
  assert.equal(rescheduledInstallation.installationScheduledTime, "13:00");
  assert.equal(rescheduledInstallation.installationAssignee, "Daniel");
});

test("only Sales can save draft delivery items and a draft alone cannot bypass PM pre-schedule review", async () => {
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason: "Deposit was confirmed in the previous system.",
    expectedUpdatedAt: project.updatedAt,
  });

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "prepare_delivery", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      deliverySelections: [{ sku: "DRAFT-SKU", quantity: 2 }],
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );

  project = await transitionPaymentTrackProject(project.id, "prepare_delivery", {
    actorRole: "sales",
    actorName: "Sam Sales",
    expectedUpdatedAt: project.updatedAt,
    deliverySelections: [{ sku: "DRAFT-SKU", quantity: 2 }],
  });
  assert.deepEqual(project.deliverySelections, [{ sku: "DRAFT-SKU", quantity: 2 }]);
  assert.equal(project.deliveryPreparedBy, "Sam Sales");
  assert.equal(project.deliveryScheduleRequest, null);
  assert.equal(project.history.at(-1)?.action, "delivery_items_prepared");
  assert.equal(project.history.at(-1)?.actorRole, "sales");

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "schedule_delivery", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      deliveryDate: "2026-09-07",
      deliveryTime: "07:30",
      deliveryAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
});

test("omitted delivery and installation preference notes are stored as empty strings", async () => {
  let delivery = await createPmNotesProject();
  delivery = await transitionPaymentTrackProject(delivery.id, "skip_stage", {
    actorRole: "admin",
    reason: "Deposit was confirmed in the previous system.",
    expectedUpdatedAt: delivery.updatedAt,
  });
  delivery = await transitionPaymentTrackProject(delivery.id, "pre_schedule_delivery", {
    actorRole: "sales",
    expectedUpdatedAt: delivery.updatedAt,
    deliverySelections: [{ sku: "NO-NOTE-DELIVERY", quantity: 1 }],
    preferredDate: "2026-09-06",
    preferredTime: "08:00",
  });
  assert.equal(delivery.deliveryScheduleRequest?.notes, "");

  let installation = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });
  installation = await transitionPaymentTrackProject(installation.id, "pre_schedule_installation", {
    actorRole: "sales",
    expectedUpdatedAt: installation.updatedAt,
    preferredDate: "2026-09-08",
    preferredTime: "09:30",
  });
  assert.equal(installation.installationScheduleRequest?.notes, "");
});

test("delivery pre-scheduling enforces Sales, current version, chosen items and PM final review", async () => {
  const reason = "Deposit was confirmed in the previous system.";
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "skip_stage", {
    actorRole: "admin",
    reason,
    expectedUpdatedAt: project.updatedAt,
  });

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "schedule_delivery", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      deliveryDate: "2026-09-07",
      deliveryTime: "07:30",
      deliveryAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      deliverySelections: [{ sku: "WAREHOUSE-1", quantity: 1 }],
      preferredDate: "2026-09-06",
      preferredTime: "08:00",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
      actorRole: "sales",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      deliverySelections: [{ sku: "WAREHOUSE-1", quantity: 1 }],
      preferredDate: "2026-09-06",
      preferredTime: "08:00",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "stale_project",
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
      actorRole: "sales",
      expectedUpdatedAt: project.updatedAt,
      deliverySelections: [],
      preferredDate: "2026-09-06",
      preferredTime: "08:00",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_delivery_items",
  );

  project = await transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
    actorRole: "sales",
    actorName: "Ruihan Sales",
    expectedUpdatedAt: project.updatedAt,
    deliverySelections: [
      { sku: "WAREHOUSE-PANEL", quantity: 14 },
      { sku: "WAREHOUSE-INVERTER", quantity: 1 },
    ],
    preferredDate: "2026-09-06",
    preferredTime: "08:00",
    notes: "  Morning preferred.  ",
  });
  assert.equal(project.items.length, 1);
  assert.deepEqual(project.deliverySelections, [
    { sku: "WAREHOUSE-PANEL", quantity: 14 },
    { sku: "WAREHOUSE-INVERTER", quantity: 1 },
  ]);
  assert.ok(project.deliveryPreparedAt);
  assert.equal(project.deliveryPreparedBy, "Ruihan Sales");
  assert.equal(project.deliveryScheduleRequest?.notes, "Morning preferred.");
  assert.equal(project.history.at(-1)?.action, "delivery_pre_scheduled");

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "mark_delivered", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "schedule_delivery", {
      actorRole: "pm",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      deliveryDate: "2026-09-07",
      deliveryTime: "07:30",
      deliveryAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "stale_project",
  );
});

test("installation pre-scheduling enforces Sales and PM cannot schedule or complete before review", async () => {
  let installing = await createInstallingProject({
    stcSolarRequired: false,
    stcBatteryRequired: false,
  });

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      expectedUpdatedAt: installing.updatedAt,
      installationDate: "2026-09-03",
      installationTime: "09:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "pre_schedule_installation", {
      actorRole: "pm",
      expectedUpdatedAt: installing.updatedAt,
      preferredDate: "2026-09-02",
      preferredTime: "08:30",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "pre_schedule_installation", {
      actorRole: "sales",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      preferredDate: "2026-09-02",
      preferredTime: "08:30",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "stale_project",
  );

  installing = await preScheduleInstallation(installing);
  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "mark_installed", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "sales",
      expectedUpdatedAt: installing.updatedAt,
      installationDate: "2026-09-03",
      installationTime: "09:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "role_forbidden",
  );

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      expectedUpdatedAt: installing.updatedAt,
      installationDate: "2026-02-30",
      installationTime: "09:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      expectedUpdatedAt: installing.updatedAt,
      installationDate: "2026-09-03",
      installationTime: "24:00",
      installationAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );

  await assert.rejects(
    transitionPaymentTrackProject(installing.id, "schedule_installation", {
      actorRole: "pm",
      expectedUpdatedAt: installing.updatedAt,
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
      expectedUpdatedAt: unready.updatedAt,
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

  installing = await preScheduleInstallation(installing);
  installing = await transitionPaymentTrackProject(installing.id, "schedule_installation", {
    actorRole: "pm",
    expectedUpdatedAt: installing.updatedAt,
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
  delete storedProject.deliveryScheduleRequest;
  delete storedProject.installationScheduleRequest;
  delete storedProject.deliveryScheduledTime;
  delete storedProject.deliveryAssignee;
  delete storedProject.installationScheduledTime;
  delete storedProject.installationAssignee;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const listed = await listPaymentTrackProjects();
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryScheduleRequest, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationScheduleRequest, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryScheduledFor, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationScheduledFor, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryScheduledTime, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.deliveryAssignee, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationScheduledTime, null);
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.installationAssignee, null);
  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.deliveryScheduleRequest, null);
  assert.equal(persisted.find((candidate) => candidate.id === project.id)?.installationScheduleRequest, null);
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

test("listing does not rewrite canonical empty warehouse selections", async () => {
  await createPmNotesProject();
  const recordsPath = path.join(testDataDirectory, "records.json");

  // Finish any one-time migration left by earlier fixtures, then ensure a
  // second read keeps the already-canonical document untouched.
  await listPaymentTrackProjects();
  const before = await stat(recordsPath);
  await listPaymentTrackProjects();
  const after = await stat(recordsPath);

  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
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
      && error.code === "reported_amount_exceeds_outstanding"
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
    transitionPaymentTrackProject(project.id, "confirm_solar_rebate", {
      actorRole: "admin",
      amountCents: 140_000,
      expectedUpdatedAt: project.updatedAt,
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "invalid_transition"
    ),
  );

  project = await transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
    actorRole: "admin",
    amountCents: 320_000,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "done");
  assert.equal(project.outstandingCents, 5_500);
  assert.equal(project.stcSolarReceivedAmountCents, 320_000);
  assert.equal(project.history.findLast((entry) => entry.action === "stc_solar_confirmed")?.note, "AUD 3200.00");

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
  const customerOutstanding = project.outstandingCents;

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

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
      actorRole: "admin",
      amountCents: 0,
      expectedUpdatedAt: project.updatedAt,
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "invalid_amount"
    ),
  );

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
      actorRole: "admin",
      amountCents: 310_025,
      expectedUpdatedAt: "2026-08-01T00:00:00.000Z",
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "stale_project"
    ),
  );
  project = await transitionPaymentTrackProject(project.id, "confirm_stc_solar", {
    actorRole: "admin",
    amountCents: 310_025,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "stc_rebate");
  assert.equal(project.stcSolarReceivedAmountCents, 310_025);
  assert.equal(project.outstandingCents, customerOutstanding);
  project = await transitionPaymentTrackProject(project.id, "confirm_stc_battery", {
    actorRole: "admin",
    amountCents: 145_050,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "stc_rebate");
  assert.equal(project.stcBatteryReceivedAmountCents, 145_050);
  assert.equal(project.outstandingCents, customerOutstanding);

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
    amountCents: 140_000,
    expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(project.stage, "done");
  assert.ok(project.solarRebateReceivedAt);
  assert.equal(project.solarRebateReceivedAmountCents, 140_000);
  assert.equal(project.outstandingCents, customerOutstanding);
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
    amountCents: 140_000,
    expectedUpdatedAt: project.updatedAt,
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
  delete storedProject.stcSolarReceivedAmountCents;
  delete storedProject.stcBatteryReceivedAmountCents;
  delete storedProject.solarRebateReceivedAmountCents;
  delete storedProject.solarRebateQrRequired;
  delete storedProject.solarRebateQrConfirmedAt;
  delete storedProject.solarRebateQrConfirmedBy;
  delete storedProject.solarRebateQrCode;
  delete storedProject.solarRebateAssessmentVersion;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const firstList = await listPaymentTrackProjects();
  const secondList = await listPaymentTrackProjects();
  const firstProject = firstList.find((candidate) => candidate.id === project.id);
  const secondProject = secondList.find((candidate) => candidate.id === project.id);
  assert.equal(firstProject?.solarRebateRequired, false);
  assert.equal(firstProject?.solarRebateReceivedAt, null);
  assert.equal(firstProject?.stcSolarReceivedAmountCents, null);
  assert.equal(firstProject?.stcBatteryReceivedAmountCents, null);
  assert.equal(firstProject?.solarRebateReceivedAmountCents, null);
  assert.equal(firstProject?.solarRebateQrRequired, false);
  assert.equal(firstProject?.solarRebateQrConfirmedAt, null);
  assert.equal(firstProject?.solarRebateQrConfirmedBy, null);
  assert.equal(firstProject?.solarRebateQrCode, null);
  assert.equal(secondProject?.solarRebateRequired, false);
  assert.equal(secondProject?.solarRebateReceivedAt, null);
  assert.equal(secondProject?.stcSolarReceivedAmountCents, null);
  assert.equal(secondProject?.stcBatteryReceivedAmountCents, null);
  assert.equal(secondProject?.solarRebateReceivedAmountCents, null);
  assert.equal(secondProject?.solarRebateQrRequired, false);
  assert.equal(secondProject?.solarRebateQrConfirmedAt, null);
  assert.equal(secondProject?.solarRebateQrConfirmedBy, null);
  assert.equal(secondProject?.solarRebateQrCode, null);
  assert.equal("solarRebateAssessmentVersion" in (firstProject || {}), false);

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const persistedProject = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(persistedProject?.solarRebateRequired, false);
  assert.equal(persistedProject?.solarRebateReceivedAt, null);
  assert.equal(persistedProject?.solarRebateQrRequired, false);
  assert.equal(persistedProject?.solarRebateQrConfirmedAt, null);
  assert.equal(persistedProject?.solarRebateQrConfirmedBy, null);
  assert.equal(persistedProject?.solarRebateQrCode, null);
  assert.equal(persistedProject?.solarRebateAssessmentVersion, 2);
});

test("legacy WIP records without QR fields default to no gate and remain schedulable", async () => {
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "acknowledge_deposit", {
    actorRole: "sales",
  });
  project = await transitionPaymentTrackProject(project.id, "confirm_deposit", {
    actorRole: "admin",
    amountCents: 100,
  });

  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.solarRebateRequired = true;
  delete storedProject.solarRebateQrRequired;
  delete storedProject.solarRebateQrConfirmedAt;
  delete storedProject.solarRebateQrConfirmedBy;
  delete storedProject.solarRebateQrCode;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const listed = (await listPaymentTrackProjects()).find((candidate) => candidate.id === project.id);
  assert.ok(listed);
  assert.equal(listed.solarRebateRequired, true);
  assert.equal(listed.solarRebateQrRequired, false);
  assert.equal(listed.solarRebateQrConfirmedAt, null);
  assert.equal(listed.solarRebateQrConfirmedBy, null);
  assert.equal(listed.solarRebateQrCode, null);

  project = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    expectedUpdatedAt: listed.updatedAt,
    workMode: "delivery_only",
    deliveryDate: "2026-08-28",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    deliverySelections: [{ sku: "LEGACY-SKU", quantity: 1 }],
  });
  assert.equal(project.workMode, "delivery_only");
  assert.equal(project.deliveryScheduledFor, "2026-08-28");
});

test("migration clears incomplete QR confirmations while legacy uploaded QR records remain schedulable", async () => {
  const project = await createQrRequiredWipProject();
  const recordsPath = path.join(testDataDirectory, "records.json");
  const records = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const storedProject = records.find((candidate) => candidate.id === project.id);
  assert.ok(storedProject);
  storedProject.solarRebateQrConfirmedAt = "2026-08-28T01:00:00.000Z";
  delete storedProject.solarRebateQrConfirmedBy;
  storedProject.solarRebateQrCode = {
    id: randomUUID(),
    kind: "solar_rebate_qr_code",
    originalName: "legacy-rebate-qr.png",
    contentType: "image/png",
    size: 4,
    storedName: `${randomUUID()}.png`,
    accessToken: "legacy-private-token",
    uploadedAt: "2026-08-27T01:00:00.000Z",
    uploadedByRole: "pm",
  };
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const migrated = (await listPaymentTrackProjects()).find((candidate) => candidate.id === project.id);
  assert.ok(migrated);
  assert.equal(migrated.solarRebateQrConfirmedAt, null);
  assert.equal(migrated.solarRebateQrConfirmedBy, null);
  assert.equal(migrated.solarRebateQrCode?.originalName, "legacy-rebate-qr.png");

  const scheduled = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    actorName: "Kevin PM",
    expectedUpdatedAt: migrated.updatedAt,
    workMode: "delivery_only",
    deliveryDate: "2026-08-28",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    deliverySelections: [{ sku: "LEGACY-QR-SKU", quantity: 1 }],
  });
  assert.equal(scheduled.deliveryScheduledFor, "2026-08-28");

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const saved = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(saved?.solarRebateQrConfirmedAt, null);
  assert.equal(saved?.solarRebateQrConfirmedBy, null);
});

test("an old imported contract preserves its stored Solar Rebate assessment without reopening", async () => {
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
  const contract = storedProject.contract as { storedName: string };
  storedProject.solarRebateRequired = false;
  delete storedProject.solarRebateAssessmentVersion;
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await unlink(path.join(testDataDirectory, "contracts", contract.storedName));

  const firstList = await listPaymentTrackProjects();
  const secondList = await listPaymentTrackProjects();
  const migrated = firstList.find((candidate) => candidate.id === project.id);
  assert.equal(migrated?.solarRebateRequired, false);
  assert.equal(migrated?.solarRebateReceivedAt, null);
  assert.equal(migrated?.stage, "done");
  assert.ok(migrated?.completedAt);
  assert.equal(
    migrated?.history.filter((entry) => entry.action === "solar_rebate_requirement_backfilled").length,
    0,
  );
  assert.equal(
    secondList.find((candidate) => candidate.id === project.id)?.history
      .filter((entry) => entry.action === "solar_rebate_requirement_backfilled").length,
    0,
  );

  const persisted = JSON.parse(await readFile(recordsPath, "utf8")) as Array<Record<string, unknown>>;
  const persistedProject = persisted.find((candidate) => candidate.id === project.id);
  assert.equal(persistedProject?.solarRebateAssessmentVersion, 2);
  assert.equal(persistedProject?.solarRebateRequired, false);
});

test("an unevaluated legacy contract does not parse its attachment from a workflow mutation", async () => {
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

  const completed = await transitionPaymentTrackProject(project.id, "mark_coes_received", {
    actorRole: "pm",
  });
  assert.equal(completed.stage, "done");
  assert.equal(completed.solarRebateRequired, false);
  const listed = await listPaymentTrackProjects();
  assert.equal(listed.find((candidate) => candidate.id === project.id)?.stage, "done");
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

test("QR-required WIP rejects new and legacy scheduling actions until PM confirms receipt", async () => {
  const project = await createQrRequiredWipProject();
  assert.equal(project.stage, "working_in_progress");
  assert.equal(project.solarRebateQrRequired, true);
  assert.equal(project.solarRebateQrCode, null);

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "schedule_work", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      workMode: "delivery_and_installation",
      deliveryDate: "2026-08-28",
      deliveryTime: "09:00",
      deliveryAssignee: "Leo",
      installationAssignee: "Daniel",
      deliverySelections: [{ sku: "QR-SKU", quantity: 1 }],
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "solar_rebate_qr_required",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "schedule_delivery", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      deliveryDate: "2026-08-28",
      deliveryTime: "09:00",
      deliveryAssignee: "Leo",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "solar_rebate_qr_required",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "schedule_installation", {
      actorRole: "pm",
      expectedUpdatedAt: project.updatedAt,
      installationDate: "2026-08-28",
      installationTime: "09:00",
      installationAssignee: "Daniel",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "solar_rebate_qr_required",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "prepare_delivery", {
      actorRole: "sales",
      expectedUpdatedAt: project.updatedAt,
      deliverySelections: [{ sku: "QR-SKU", quantity: 1 }],
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "solar_rebate_qr_required",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
      actorRole: "sales",
      expectedUpdatedAt: project.updatedAt,
      deliverySelections: [{ sku: "QR-SKU", quantity: 1 }],
      preferredDate: "2026-08-28",
      preferredTime: "09:00",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "solar_rebate_qr_required",
  );
  await assert.rejects(
    transitionPaymentTrackProject(project.id, "pre_schedule_installation", {
      actorRole: "sales",
      expectedUpdatedAt: project.updatedAt,
      preferredDate: "2026-08-28",
      preferredTime: "09:00",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "solar_rebate_qr_required",
  );
});

test("only PM can confirm QR receipt with a current version, after which WIP can be scheduled", async () => {
  let project = await createQrRequiredWipProject();

  await assert.rejects(
    confirmPaymentTrackSolarRebateQrReceived(
      project.id,
      "sales",
      project.updatedAt,
      "Sam Sales",
    ),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 403
      && error.code === "role_forbidden",
  );
  await assert.rejects(
    confirmPaymentTrackSolarRebateQrReceived(
      project.id,
      "pm",
      project.createdAt,
      "Kevin PM",
    ),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "stale_project",
  );

  project = await confirmPaymentTrackSolarRebateQrReceived(
    project.id,
    "pm",
    project.updatedAt,
    "Kevin PM",
  );
  assert.equal(project.solarRebateQrCode, null);
  assert.equal(project.solarRebateReceivedAt, null);
  assert.equal(project.stage, "working_in_progress");
  assert.ok(project.solarRebateQrConfirmedAt);
  assert.equal(project.solarRebateQrConfirmedBy, "Kevin PM");
  assert.equal(project.history.at(-1)?.action, "solar_rebate_qr_received_confirmed");
  assert.equal(project.history.at(-1)?.actorName, "Kevin PM");

  await assert.rejects(
    transitionPaymentTrackProject(project.id, "pre_schedule_delivery", {
      actorRole: "sales",
      expectedUpdatedAt: project.updatedAt,
      deliverySelections: [{ sku: "QR-SKU", quantity: 1 }],
      preferredDate: "2026-08-28",
      preferredTime: "09:00",
      notes: "Morning preferred.",
    }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError
      && error.status === 409
      && error.code === "invalid_transition",
  );

  project = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
    workMode: "delivery_and_installation",
    deliveryDate: "2026-08-28",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    installationAssignee: "Daniel",
    deliverySelections: [{ sku: "QR-SKU", quantity: 1 }],
  });
  assert.equal(project.workMode, "delivery_and_installation");
  assert.equal(project.deliveryScheduledFor, "2026-08-28");
  assert.equal(project.installationScheduledFor, "2026-08-28");
});

test("concurrent QR receipt confirmations use the project version and record exactly one history entry", async () => {
  const project = await createQrRequiredWipProject();
  const results = await Promise.allSettled([
    confirmPaymentTrackSolarRebateQrReceived(project.id, "pm", project.updatedAt, "Kevin PM"),
    confirmPaymentTrackSolarRebateQrReceived(project.id, "pm", project.updatedAt, "Hogan PM"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => (
    result.status === "rejected"
    && result.reason instanceof PaymentTrackRepositoryError
    && result.reason.code === "stale_project"
  )).length, 1);

  const saved = (await listPaymentTrackProjects()).find((candidate) => candidate.id === project.id);
  assert.ok(saved);
  assert.equal(saved.history.filter((entry) => (
    entry.action === "solar_rebate_qr_received_confirmed"
  )).length, 1);
  assert.ok(["Kevin PM", "Hogan PM"].includes(saved.solarRebateQrConfirmedBy || ""));
});

test("WIP supports combined scheduling and multiple Sales-reported payments before installation", async () => {
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "acknowledge_deposit", { actorRole: "sales" });
  project = await transitionPaymentTrackProject(project.id, "confirm_deposit", { actorRole: "admin", amountCents: 100 });
  assert.equal(project.stage, "working_in_progress");

  project = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
    workMode: "delivery_and_installation",
    deliveryDate: "2026-08-28",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    installationAssignee: "Daniel",
    deliverySelections: [{ sku: "BAT-TEST", quantity: 1 }],
  });
  assert.equal(project.workMode, "delivery_and_installation");
  assert.equal(project.deliveryScheduledFor, project.installationScheduledFor);

  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", { actorRole: "sales", amountCents: 300 });
  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", { actorRole: "sales", amountCents: 200 });
  assert.deepEqual(project.finalPayments.map((payment) => payment.reportedAmountCents), [300, 200]);
  const firstPayment = project.finalPayments[0];
  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: firstPayment.id,
    amountCents: 250,
  });
  assert.equal(project.outstandingCents, 650);
  assert.equal(project.finalPayments[1].confirmedAt, null);

  project = await transitionPaymentTrackProject(project.id, "mark_work_completed", { actorRole: "pm" });
  assert.equal(project.stage, "waiting_coes");
  assert.ok(project.deliveredAt);
  assert.ok(project.installedAt);
});

test("Sales payment review stays independent from PM scheduling and completion", async () => {
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "acknowledge_deposit", {
    actorRole: "sales",
    actorName: "Sam Sales",
  });
  project = await transitionPaymentTrackProject(project.id, "confirm_deposit", {
    actorRole: "admin",
    amountCents: 100,
  });
  assert.equal(project.stage, "working_in_progress");
  assert.equal(project.outstandingCents, 900);

  const unscheduledWorkState = {
    stage: project.stage,
    workMode: project.workMode,
    deliveryScheduledFor: project.deliveryScheduledFor,
    deliveryScheduledTime: project.deliveryScheduledTime,
    deliveryAssignee: project.deliveryAssignee,
    installationScheduledFor: project.installationScheduledFor,
    installationScheduledTime: project.installationScheduledTime,
    installationAssignee: project.installationAssignee,
    deliveredAt: project.deliveredAt,
    installedAt: project.installedAt,
  };

  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
    actorName: "Sam Sales",
    amountCents: 300,
  });
  assert.deepEqual({
    stage: project.stage,
    workMode: project.workMode,
    deliveryScheduledFor: project.deliveryScheduledFor,
    deliveryScheduledTime: project.deliveryScheduledTime,
    deliveryAssignee: project.deliveryAssignee,
    installationScheduledFor: project.installationScheduledFor,
    installationScheduledTime: project.installationScheduledTime,
    installationAssignee: project.installationAssignee,
    deliveredAt: project.deliveredAt,
    installedAt: project.installedAt,
  }, unscheduledWorkState);
  const firstPayment = project.finalPayments[0];
  assert.ok(firstPayment);
  assert.equal(firstPayment.acknowledgedBy, "Sam Sales");
  assert.equal(firstPayment.reportedAmountCents, 300);
  assert.equal(firstPayment.confirmedAmountCents, null);
  assert.equal(firstPayment.confirmedAt, null);
  assert.equal(firstPayment.confirmedBy, null);
  assert.equal(project.outstandingCents, 900);

  // A pending receipt only reserves its reported amount. Sales can record
  // another receipt while an unreported portion of the balance remains.
  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
    amountCents: 200,
  });
  const secondPayment = project.finalPayments[1];
  assert.ok(secondPayment);
  assert.notEqual(secondPayment.id, firstPayment.id);
  assert.deepEqual(project.finalPayments.map((payment) => ({
    reportedAmountCents: payment.reportedAmountCents,
    confirmedAt: payment.confirmedAt,
  })), [
    { reportedAmountCents: 300, confirmedAt: null },
    { reportedAmountCents: 200, confirmedAt: null },
  ]);
  assert.equal(project.stage, "working_in_progress");
  assert.equal(project.workMode, null);

  // The two receipts awaiting Admin do not take ownership of, or block, the
  // PM workstream.
  project = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    actorName: "Kevin PM",
    expectedUpdatedAt: project.updatedAt,
    workMode: "delivery_and_installation",
    deliveryDate: "2026-08-28",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    installationAssignee: "Daniel",
    deliverySelections: [{ sku: "BAT-TEST", quantity: 1 }],
  });
  const scheduledWorkState = {
    stage: project.stage,
    workMode: project.workMode,
    deliveryScheduledFor: project.deliveryScheduledFor,
    deliveryScheduledTime: project.deliveryScheduledTime,
    deliveryAssignee: project.deliveryAssignee,
    installationScheduledFor: project.installationScheduledFor,
    installationScheduledTime: project.installationScheduledTime,
    installationAssignee: project.installationAssignee,
    deliveredAt: project.deliveredAt,
    installedAt: project.installedAt,
  };
  assert.deepEqual(scheduledWorkState, {
    stage: "working_in_progress",
    workMode: "delivery_and_installation",
    deliveryScheduledFor: "2026-08-28",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-08-28",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
    deliveredAt: null,
    installedAt: null,
  });

  project = await transitionPaymentTrackProject(project.id, "acknowledge_payment", {
    actorRole: "sales",
    amountCents: 100,
  });
  const thirdPayment = project.finalPayments[2];
  assert.ok(thirdPayment);
  assert.deepEqual({
    stage: project.stage,
    workMode: project.workMode,
    deliveryScheduledFor: project.deliveryScheduledFor,
    deliveryScheduledTime: project.deliveryScheduledTime,
    deliveryAssignee: project.deliveryAssignee,
    installationScheduledFor: project.installationScheduledFor,
    installationScheduledTime: project.installationScheduledTime,
    installationAssignee: project.installationAssignee,
    deliveredAt: project.deliveredAt,
    installedAt: project.installedAt,
  }, scheduledWorkState);

  // Admin can confirm an individual receipt out of order; the other receipts
  // remain pending and the confirmed actual amount alone affects outstanding.
  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: secondPayment.id,
    amountCents: 175,
  });
  assert.equal(project.finalPayments[0].confirmedAt, null);
  assert.equal(project.finalPayments[1].confirmedAmountCents, 175);
  assert.ok(project.finalPayments[1].confirmedAt);
  assert.equal(project.finalPayments[2].confirmedAt, null);
  assert.equal(project.outstandingCents, 725);
  assert.deepEqual({
    stage: project.stage,
    workMode: project.workMode,
    deliveryScheduledFor: project.deliveryScheduledFor,
    deliveryScheduledTime: project.deliveryScheduledTime,
    deliveryAssignee: project.deliveryAssignee,
    installationScheduledFor: project.installationScheduledFor,
    installationScheduledTime: project.installationScheduledTime,
    installationAssignee: project.installationAssignee,
    deliveredAt: project.deliveredAt,
    installedAt: project.installedAt,
  }, scheduledWorkState);

  project = await transitionPaymentTrackProject(project.id, "mark_work_completed", {
    actorRole: "pm",
    actorName: "Kevin PM",
  });
  assert.equal(project.stage, "waiting_coes");
  assert.ok(project.deliveredAt);
  assert.ok(project.installedAt);
  assert.equal(project.finalPayments.filter((payment) => !payment.confirmedAt).length, 2);

  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: firstPayment.id,
    amountCents: 300,
  });
  assert.equal(project.stage, "waiting_coes");
  assert.equal(project.finalPayments.filter((payment) => !payment.confirmedAt).length, 1);
  project = await transitionPaymentTrackProject(project.id, "confirm_final_payment", {
    actorRole: "admin",
    paymentId: thirdPayment.id,
    amountCents: 100,
  });
  assert.equal(project.stage, "waiting_coes");
  assert.equal(project.finalPayments.filter((payment) => !payment.confirmedAt).length, 0);
  assert.equal(project.outstandingCents, 325);
});

test("Weekly delivery then installation completion advances Project Track automatically", async () => {
  let project = await createPmNotesProject();
  project = await transitionPaymentTrackProject(project.id, "acknowledge_deposit", { actorRole: "sales" });
  project = await transitionPaymentTrackProject(project.id, "confirm_deposit", { actorRole: "admin", amountCents: 100 });

  project = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
    workMode: "delivery_only",
    deliveryDate: "2026-08-28",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    deliverySelections: [{ sku: "BAT-TEST", quantity: 1 }],
  });
  project = await transitionPaymentTrackProject(project.id, "mark_work_completed", { actorRole: "pm" });
  assert.equal(project.stage, "working_in_progress");
  assert.ok(project.deliveredAt);
  assert.equal(project.installedAt, null);

  project = await transitionPaymentTrackProject(project.id, "schedule_work", {
    actorRole: "pm",
    expectedUpdatedAt: project.updatedAt,
    workMode: "installation_only",
    deliveryDate: "2026-08-29",
    deliveryTime: "10:00",
    installationAssignee: "Daniel",
  });
  project = await transitionPaymentTrackProject(project.id, "mark_work_completed", { actorRole: "pm" });
  assert.equal(project.stage, "waiting_coes");
  assert.ok(project.installedAt);
});

test("installation completion atomically records Solar Panel Inventory consumption once on every completion path", async () => {
  const panelItems = [{
    category: "Solar Panel",
    description: "LONGi Green Energy",
    model: "LR7-54HVH-475M (IEC 61215-2021)",
    quantity: 10,
    capacity: "475W",
  }, {
    category: "solar panels",
    description: "Same panel model",
    model: "LR7-54HVH-475M (IEC 61215-2021)",
    quantity: 4,
    capacity: "475W",
  }, {
    category: "太阳能板",
    description: "DIRECT-SUPPLIER-PANEL",
    model: "",
    quantity: 2,
    capacity: "440W",
  }, {
    category: "Solar Inverter",
    description: "Must not be consumed as a panel",
    model: "KH10",
    quantity: 1,
    capacity: "10kW",
  }];

  let combined = await createPmNotesProject(panelItems);
  combined = await transitionPaymentTrackProject(combined.id, "acknowledge_deposit", { actorRole: "sales" });
  combined = await transitionPaymentTrackProject(combined.id, "confirm_deposit", {
    actorRole: "admin",
    amountCents: 100,
  });
  combined = await transitionPaymentTrackProject(combined.id, "schedule_work", {
    actorRole: "pm",
    expectedUpdatedAt: combined.updatedAt,
    workMode: "delivery_and_installation",
    deliveryDate: "2026-08-30",
    deliveryTime: "09:00",
    deliveryAssignee: "Leo",
    installationAssignee: "Daniel",
    deliverySelections: [{ sku: "BAT-TEST", quantity: 1 }],
  });
  combined = await transitionPaymentTrackProject(combined.id, "mark_work_completed", {
    actorRole: "pm",
    actorName: "Kevin PM",
  });

  assert.equal(combined.solarPanelConsumption?.recordedAt, combined.installedAt);
  assert.equal(combined.solarPanelConsumption?.recordedBy, "Kevin PM");
  assert.deepEqual(combined.solarPanelConsumption?.items.map(({ sku, quantity }) => ({ sku, quantity })), [{
    sku: "LR7-54HVH-475M (IEC 61215-2021)",
    quantity: 14,
  }, {
    sku: "DIRECT-SUPPLIER-PANEL",
    quantity: 2,
  }]);
  const panelSourceIds = combined.items
    .filter((item) => item.model === "LR7-54HVH-475M (IEC 61215-2021)")
    .map((item) => item.id);
  assert.deepEqual(combined.solarPanelConsumption?.items[0].sourceItemIds, panelSourceIds);
  assert.equal(combined.history.filter((entry) => entry.action === "solar_panel_consumption_recorded").length, 1);
  assert.match(combined.history.at(-1)?.note || "", /LR7-54HVH-475M.*× 14/);
  assert.doesNotMatch(combined.history.at(-1)?.note || "", /KH10/);

  await assert.rejects(
    transitionPaymentTrackProject(combined.id, "mark_work_completed", { actorRole: "pm" }),
    (error: unknown) => error instanceof PaymentTrackRepositoryError && error.code === "invalid_transition",
  );
  const listedTwice = [await listPaymentTrackProjects(), await listPaymentTrackProjects()];
  for (const projects of listedTwice) {
    const persisted = projects.find((project) => project.id === combined.id);
    assert.deepEqual(persisted?.solarPanelConsumption, combined.solarPanelConsumption);
    assert.equal(persisted?.history.filter((entry) => entry.action === "solar_panel_consumption_recorded").length, 1);
  }

  const markedInstalled = await createInstalledProject({
    stcSolarRequired: true,
    stcBatteryRequired: false,
    items: [panelItems[0]],
  });
  assert.equal(markedInstalled.solarPanelConsumption?.items[0].quantity, 10);
  assert.equal(markedInstalled.history.filter((entry) => entry.action === "solar_panel_consumption_recorded").length, 1);

  const reason = "Installation was completed outside ERP and verified by the Administrator.";
  let skipped = await createPmNotesProject([panelItems[2]]);
  skipped = await transitionPaymentTrackProject(skipped.id, "skip_stage", {
    actorRole: "admin",
    actorName: "Administrator",
    reason,
    expectedUpdatedAt: skipped.updatedAt,
  });
  skipped = await transitionPaymentTrackProject(skipped.id, "skip_stage", {
    actorRole: "admin",
    actorName: "Administrator",
    reason,
    expectedUpdatedAt: skipped.updatedAt,
  });
  assert.equal(skipped.stage, "waiting_coes");
  assert.equal(skipped.solarPanelConsumption?.items[0].sku, "DIRECT-SUPPLIER-PANEL");
  assert.equal(skipped.solarPanelConsumption?.items[0].quantity, 2);
  assert.equal(skipped.solarPanelConsumption?.recordedBy, "Administrator");
  assert.equal(skipped.history.filter((entry) => entry.action === "solar_panel_consumption_recorded").length, 1);
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
