import type {
  PaymentTrackProject,
  PaymentTrackScheduleAssignee,
  PaymentTrackWorkMode,
} from "./types";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { isPaymentTrackWaitingForRebateQr } from "./types.ts";

export type WipUnscheduledPaymentTrackProjectSource =
  | "material_delivery"
  | "installing"
  | "combined";

export type WipUnscheduledPaymentTrackProjectInput = Pick<
  PaymentTrackProject,
  | "id"
  | "stage"
  | "workMode"
  | "deliveryScheduledFor"
  | "deliveryScheduledTime"
  | "deliveryAssignee"
  | "deliveredAt"
  | "installationScheduledFor"
  | "installationScheduledTime"
  | "installationAssignee"
  | "installedAt"
  | "completedAt"
  | "solarRebateQrRequired"
  | "solarRebateQrConfirmedAt"
  | "solarRebateQrCode"
>;

export interface WipUnscheduledPaymentTrackProject {
  projectId: string;
  source: WipUnscheduledPaymentTrackProjectSource;
}

function validScheduleDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validScheduleTime(value: string | null) {
  return Boolean(value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value));
}

function validScheduleAssignee(
  value: PaymentTrackScheduleAssignee | null,
): value is PaymentTrackScheduleAssignee {
  return value === "Leo" || value === "Daniel";
}

function deliveryScheduleIsComplete(project: WipUnscheduledPaymentTrackProjectInput) {
  return validScheduleDate(project.deliveryScheduledFor)
    && validScheduleTime(project.deliveryScheduledTime)
    && validScheduleAssignee(project.deliveryAssignee);
}

function installationScheduleIsComplete(project: WipUnscheduledPaymentTrackProjectInput) {
  return validScheduleDate(project.installationScheduledFor)
    && validScheduleTime(project.installationScheduledTime)
    && validScheduleAssignee(project.installationAssignee);
}

function finalWorkScheduleIsComplete(
  project: WipUnscheduledPaymentTrackProjectInput,
  workMode: PaymentTrackWorkMode | null,
) {
  if (workMode === "delivery_only") return deliveryScheduleIsComplete(project);
  if (workMode === "installation_only") return installationScheduleIsComplete(project);
  return workMode === "delivery_and_installation"
    && deliveryScheduleIsComplete(project)
    && installationScheduleIsComplete(project)
    && project.deliveryScheduledFor === project.installationScheduledFor
    && project.deliveryScheduledTime === project.installationScheduledTime;
}

/**
 * Select the current Working in Progress queue directly from Project Track.
 * Preferred dates and partial schedule fields are not a final PM schedule.
 */
export function wipUnscheduledPaymentTrackProject(
  project: WipUnscheduledPaymentTrackProjectInput,
): WipUnscheduledPaymentTrackProject | null {
  if (
    !project.id.trim()
    || project.stage !== "working_in_progress"
    || project.completedAt
    || project.installedAt
    || isPaymentTrackWaitingForRebateQr(project)
  ) return null;

  const activeSchedule = finalWorkScheduleIsComplete(project, project.workMode)
    && !(project.deliveredAt && project.workMode === "delivery_only");
  if (activeSchedule) return null;

  const source: WipUnscheduledPaymentTrackProjectSource = project.deliveredAt
    || project.workMode === "installation_only"
    ? "installing"
    : project.workMode === "delivery_only" ? "material_delivery" : "combined";

  return { projectId: project.id, source };
}

export function wipUnscheduledPaymentTrackProjects(
  projects: ReadonlyArray<WipUnscheduledPaymentTrackProjectInput>,
) {
  const unique = new Map<string, WipUnscheduledPaymentTrackProject>();

  for (const project of projects) {
    const unscheduled = wipUnscheduledPaymentTrackProject(project);
    const normalizedId = unscheduled?.projectId.toLowerCase();
    if (!unscheduled || !normalizedId || unique.has(normalizedId)) continue;
    unique.set(normalizedId, unscheduled);
  }

  return [...unique.values()].sort((left, right) => {
    const leftId = left.projectId.toLowerCase();
    const rightId = right.projectId.toLowerCase();
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.projectId < right.projectId ? -1 : Number(left.projectId > right.projectId);
  });
}

export function countWipUnscheduledPaymentTrackProjects(
  projects: ReadonlyArray<WipUnscheduledPaymentTrackProjectInput>,
) {
  return wipUnscheduledPaymentTrackProjects(projects).length;
}
