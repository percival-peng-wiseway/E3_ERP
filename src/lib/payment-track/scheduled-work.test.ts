import assert from "node:assert/strict";
import { test } from "node:test";

type ScheduledProjectInput = import("./scheduled-work").ScheduledPaymentTrackProjectInput;

const scheduledWorkModule = "./scheduled-work.ts";
const {
  countScheduledIncompletePaymentTrackProjects,
  scheduledIncompletePaymentTrackProject,
  scheduledIncompletePaymentTrackProjects,
  scheduledPaymentTrackProjectOverrideKey,
} = await import(scheduledWorkModule) as typeof import("./scheduled-work");

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

function project(overrides: Partial<ScheduledProjectInput> = {}): ScheduledProjectInput {
  return {
    id: FIRST_ID,
    stage: "working_in_progress",
    workMode: "delivery_only",
    deliveryScheduledFor: "2026-08-01",
    deliveryScheduledTime: "09:00",
    deliveryAssignee: "Leo",
    deliveredAt: null,
    installationScheduledFor: null,
    installationScheduledTime: null,
    installationAssignee: null,
    installedAt: null,
    completedAt: null,
    ...overrides,
  };
}

test("selects each supported WIP work mode from the final Project Track schedule", () => {
  assert.deepEqual(scheduledIncompletePaymentTrackProject(project()), {
    projectId: FIRST_ID,
    source: "material_delivery",
    scheduledDate: "2026-08-01",
    scheduledTime: "09:00",
    assigneeLabel: "Leo",
    overrideKey: `payment-delivery:${FIRST_ID}`,
  });

  assert.deepEqual(scheduledIncompletePaymentTrackProject(project({
    workMode: "installation_only",
    installationScheduledFor: "2026-08-02",
    installationScheduledTime: "10:30",
    installationAssignee: "Daniel",
  })), {
    projectId: FIRST_ID,
    source: "installing",
    scheduledDate: "2026-08-02",
    scheduledTime: "10:30",
    assigneeLabel: "Daniel",
    overrideKey: `payment-installation:${FIRST_ID}`,
  });

  assert.deepEqual(scheduledIncompletePaymentTrackProject(project({
    workMode: "delivery_and_installation",
    installationScheduledFor: "2026-08-01",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  })), {
    projectId: FIRST_ID,
    source: "combined",
    scheduledDate: "2026-08-01",
    scheduledTime: "09:00",
    assigneeLabel: "Leo / Daniel",
    overrideKey: `payment-combined:${FIRST_ID}`,
  });
});

test("selects scheduled incomplete legacy delivery and installation stages", () => {
  const delivery = scheduledIncompletePaymentTrackProject(project({
    stage: "material_delivery",
    workMode: null,
  }));
  const installation = scheduledIncompletePaymentTrackProject(project({
    stage: "installing",
    workMode: null,
    installationScheduledFor: "2026-09-04",
    installationScheduledTime: "13:45",
    installationAssignee: "Daniel",
  }));

  assert.equal(delivery?.source, "material_delivery");
  assert.equal(installation?.source, "installing");
  assert.equal(installation?.scheduledDate, "2026-09-04");
});

test("preferred requests, partial final schedules, and misaligned combined schedules do not qualify", () => {
  assert.equal(scheduledIncompletePaymentTrackProject(project({
    deliveryScheduledFor: null,
    deliveryScheduledTime: null,
    deliveryAssignee: null,
  })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ deliveryScheduledTime: null })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ deliveryAssignee: null })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ deliveryScheduledFor: "2026-02-30" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ deliveryScheduledTime: "25:00" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({
    workMode: "delivery_and_installation",
    installationScheduledFor: "2026-08-02",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
  })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({
    workMode: "delivery_and_installation",
    installationScheduledFor: "2026-08-01",
    installationScheduledTime: "10:00",
    installationAssignee: "Daniel",
  })), null);
});

test("completed work and unrelated Project Track stages are excluded", () => {
  assert.equal(scheduledIncompletePaymentTrackProject(project({ deliveredAt: "2026-08-01T01:00:00.000Z" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({
    workMode: "installation_only",
    installationScheduledFor: "2026-08-01",
    installationScheduledTime: "09:00",
    installationAssignee: "Leo",
    installedAt: "2026-08-01T03:00:00.000Z",
  })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({
    workMode: "delivery_and_installation",
    installationScheduledFor: "2026-08-01",
    installationScheduledTime: "09:00",
    installationAssignee: "Daniel",
    deliveredAt: "2026-08-01T02:00:00.000Z",
  })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ completedAt: "2026-08-01T04:00:00.000Z" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ stage: "done" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ stage: "deposit_not_paid" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({ stage: "waiting_coes" })), null);
  assert.equal(scheduledIncompletePaymentTrackProject(project({
    stage: "working_in_progress",
    workMode: null,
  })), null);
});

test("selection is global, stable by date/time/id, and emits only one row per project ID", () => {
  const overdue = project({ id: SECOND_ID, deliveryScheduledFor: "2020-01-01", deliveryScheduledTime: "17:00" });
  const futureLaterId = project({ id: THIRD_ID, deliveryScheduledFor: "2035-12-31", deliveryScheduledTime: "08:00" });
  const futureEarlierId = project({ id: FIRST_ID, deliveryScheduledFor: "2035-12-31", deliveryScheduledTime: "08:00" });

  const selected = scheduledIncompletePaymentTrackProjects([
    futureLaterId,
    overdue,
    futureEarlierId,
    { ...futureEarlierId },
  ]);

  assert.deepEqual(selected.map(({ projectId }) => projectId), [SECOND_ID, FIRST_ID, THIRD_ID]);
  assert.equal(selected.length, 3);
  assert.equal(countScheduledIncompletePaymentTrackProjects([futureEarlierId, futureEarlierId]), 1);
});

test("cancelled and deleted matching overrides are excluded while unrelated overrides are ignored", () => {
  const delivery = project({ id: FIRST_ID });
  const installation = project({
    id: SECOND_ID,
    stage: "installing",
    workMode: null,
    installationScheduledFor: "2026-08-02",
    installationScheduledTime: "10:00",
    installationAssignee: "Daniel",
  });
  const overrides = [
    {
      entryId: `payment-delivery:${FIRST_ID}`,
      state: "cancelled" as const,
    },
    {
      entryId: "payment-installation:99999999-9999-4999-8999-999999999999",
      state: "deleted" as const,
    },
  ];

  assert.deepEqual(
    scheduledIncompletePaymentTrackProjects([delivery, installation], overrides)
      .map(({ projectId }) => projectId),
    [SECOND_ID],
  );

  const overrideMap = new Map([
    [`payment-installation:${SECOND_ID}`, "deleted" as const],
  ]);
  assert.deepEqual(scheduledIncompletePaymentTrackProjects([installation], overrideMap), []);
});

test("override keys normalize Project Track IDs and select the source-specific prefix", () => {
  const upperId = FIRST_ID.toUpperCase();
  assert.equal(
    scheduledPaymentTrackProjectOverrideKey(upperId, "material_delivery"),
    `payment-delivery:${FIRST_ID}`,
  );
  assert.equal(
    scheduledPaymentTrackProjectOverrideKey(upperId, "installing"),
    `payment-installation:${FIRST_ID}`,
  );
  assert.equal(
    scheduledPaymentTrackProjectOverrideKey(upperId, "combined"),
    `payment-combined:${FIRST_ID}`,
  );
});
