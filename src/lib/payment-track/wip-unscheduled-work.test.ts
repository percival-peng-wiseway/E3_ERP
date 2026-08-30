import assert from "node:assert/strict";
import { test } from "node:test";

type ProjectInput = import("./wip-unscheduled-work").WipUnscheduledPaymentTrackProjectInput;

const modulePath = "./wip-unscheduled-work.ts";
const {
  countWipUnscheduledPaymentTrackProjects,
  wipUnscheduledPaymentTrackProject,
  wipUnscheduledPaymentTrackProjects,
} = await import(modulePath) as typeof import("./wip-unscheduled-work");

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

function project(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    id: FIRST_ID,
    stage: "working_in_progress",
    workMode: null,
    deliveryScheduledFor: null,
    deliveryScheduledTime: null,
    deliveryAssignee: null,
    deliveredAt: null,
    installationScheduledFor: null,
    installationScheduledTime: null,
    installationAssignee: null,
    installedAt: null,
    completedAt: null,
    solarRebateQrRequired: false,
    solarRebateQrConfirmedAt: null,
    solarRebateQrCode: null,
    ...overrides,
  };
}

test("selects every WIP project without a final active work schedule", () => {
  assert.deepEqual(wipUnscheduledPaymentTrackProject(project()), {
    projectId: FIRST_ID,
    source: "combined",
  });
  assert.deepEqual(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_only",
  })), {
    projectId: FIRST_ID,
    source: "material_delivery",
  });
  assert.deepEqual(wipUnscheduledPaymentTrackProject(project({
    workMode: "installation_only",
  })), {
    projectId: FIRST_ID,
    source: "installing",
  });
});

test("partial, invalid and misaligned fields remain not scheduled", () => {
  assert.ok(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-31",
  })));
  assert.ok(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-02-30",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  })));
  assert.ok(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_and_installation",
    deliveryScheduledFor: "2026-08-31",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-09-01",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  })));
});

test("complete final schedules are excluded for all supported work modes", () => {
  assert.equal(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-31",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
  })), null);
  assert.equal(wipUnscheduledPaymentTrackProject(project({
    workMode: "installation_only",
    installationScheduledFor: "2026-08-31",
    installationScheduledTime: "10:00",
    installationAssignee: "Daniel",
  })), null);
  assert.equal(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_and_installation",
    deliveryScheduledFor: "2026-08-31",
    deliveryScheduledTime: "11:00",
    deliveryAssignee: "Leo",
    installationScheduledFor: "2026-08-31",
    installationScheduledTime: "11:00",
    installationAssignee: "Daniel",
  })), null);
});

test("a delivered WIP project awaiting installation returns to the unscheduled queue", () => {
  assert.deepEqual(wipUnscheduledPaymentTrackProject(project({
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-29",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    deliveredAt: "2026-08-29T01:00:00.000Z",
  })), {
    projectId: FIRST_ID,
    source: "installing",
  });
});

test("completed, installed and non-WIP records are excluded", () => {
  assert.equal(wipUnscheduledPaymentTrackProject(project({ stage: "material_delivery" })), null);
  assert.equal(wipUnscheduledPaymentTrackProject(project({ stage: "deposit_not_paid" })), null);
  assert.equal(wipUnscheduledPaymentTrackProject(project({ installedAt: "2026-08-30T01:00:00.000Z" })), null);
  assert.equal(wipUnscheduledPaymentTrackProject(project({ completedAt: "2026-08-30T01:00:00.000Z" })), null);
  assert.equal(wipUnscheduledPaymentTrackProject(project({ id: "" })), null);
});

test("WIP projects gated on rebate QR confirmation are not yet schedulable", () => {
  assert.equal(wipUnscheduledPaymentTrackProject(project({
    solarRebateQrRequired: true,
  })), null);
  assert.ok(wipUnscheduledPaymentTrackProject(project({
    solarRebateQrRequired: true,
    solarRebateQrConfirmedAt: "2026-08-30T02:00:00.000Z",
  })));
});

test("the global selector de-duplicates project IDs and exposes a matching count", () => {
  const selected = wipUnscheduledPaymentTrackProjects([
    project({ id: SECOND_ID }),
    project({ id: FIRST_ID }),
    project({ id: FIRST_ID.toUpperCase() }),
  ]);

  assert.deepEqual(selected.map(({ projectId }) => projectId), [FIRST_ID, SECOND_ID]);
  assert.equal(countWipUnscheduledPaymentTrackProjects(selected.map(({ projectId }) => project({ id: projectId }))), 2);
});
