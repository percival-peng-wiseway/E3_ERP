import type {
  PaymentTrackProject,
  PaymentTrackScheduleAssignee,
} from "./types";
import type {
  ProjectScheduleSourceOverride,
  ProjectScheduleSourceOverrideState,
} from "../project-schedule/types";

export type ScheduledPaymentTrackProjectSource =
  | "material_delivery"
  | "installing"
  | "combined";

export type ScheduledPaymentTrackProjectInput = Pick<
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
>;

export interface ScheduledIncompletePaymentTrackProject {
  projectId: string;
  source: ScheduledPaymentTrackProjectSource;
  scheduledDate: string;
  scheduledTime: string;
  assigneeLabel: string;
  overrideKey: string;
}

export type ScheduledPaymentTrackOverrideInput =
  | ReadonlyMap<string, ProjectScheduleSourceOverrideState>
  | ReadonlyArray<Pick<ProjectScheduleSourceOverride, "entryId" | "state">>;

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

function deliveryScheduleIsComplete(project: ScheduledPaymentTrackProjectInput) {
  return validScheduleDate(project.deliveryScheduledFor)
    && validScheduleTime(project.deliveryScheduledTime)
    && validScheduleAssignee(project.deliveryAssignee);
}

function installationScheduleIsComplete(project: ScheduledPaymentTrackProjectInput) {
  return validScheduleDate(project.installationScheduledFor)
    && validScheduleTime(project.installationScheduledTime)
    && validScheduleAssignee(project.installationAssignee);
}

export function scheduledPaymentTrackProjectOverrideKey(
  projectId: string,
  source: ScheduledPaymentTrackProjectSource,
) {
  const prefix = source === "material_delivery"
    ? "payment-delivery"
    : source === "installing" ? "payment-installation" : "payment-combined";
  return `${prefix}:${projectId.toLowerCase()}`;
}

/**
 * Projects finalised in Project Track are the source of truth for this list.
 * Sales' preferred scheduling requests deliberately do not qualify.
 */
export function scheduledIncompletePaymentTrackProject(
  project: ScheduledPaymentTrackProjectInput,
): ScheduledIncompletePaymentTrackProject | null {
  if (!project.id.trim() || project.stage === "done" || project.completedAt) return null;

  let source: ScheduledPaymentTrackProjectSource;
  let scheduledDate: string;
  let scheduledTime: string;
  let assigneeLabel: string;

  if (
    ((project.stage === "working_in_progress" && project.workMode === "delivery_only")
      || project.stage === "material_delivery")
    && !project.deliveredAt
    && deliveryScheduleIsComplete(project)
  ) {
    source = "material_delivery";
    scheduledDate = project.deliveryScheduledFor as string;
    scheduledTime = project.deliveryScheduledTime as string;
    assigneeLabel = project.deliveryAssignee as PaymentTrackScheduleAssignee;
  } else if (
    ((project.stage === "working_in_progress" && project.workMode === "installation_only")
      || project.stage === "installing")
    && !project.installedAt
    && installationScheduleIsComplete(project)
  ) {
    source = "installing";
    scheduledDate = project.installationScheduledFor as string;
    scheduledTime = project.installationScheduledTime as string;
    assigneeLabel = project.installationAssignee as PaymentTrackScheduleAssignee;
  } else if (
    project.stage === "working_in_progress"
    && project.workMode === "delivery_and_installation"
    && !project.deliveredAt
    && !project.installedAt
    && deliveryScheduleIsComplete(project)
    && installationScheduleIsComplete(project)
    && project.deliveryScheduledFor === project.installationScheduledFor
    && project.deliveryScheduledTime === project.installationScheduledTime
  ) {
    source = "combined";
    scheduledDate = project.deliveryScheduledFor as string;
    scheduledTime = project.deliveryScheduledTime as string;
    assigneeLabel = project.deliveryAssignee === project.installationAssignee
      ? project.deliveryAssignee as PaymentTrackScheduleAssignee
      : `${project.deliveryAssignee} / ${project.installationAssignee}`;
  } else {
    return null;
  }

  return {
    projectId: project.id,
    source,
    scheduledDate,
    scheduledTime,
    assigneeLabel,
    overrideKey: scheduledPaymentTrackProjectOverrideKey(project.id, source),
  };
}

function isOverrideMap(
  input: ScheduledPaymentTrackOverrideInput,
): input is ReadonlyMap<string, ProjectScheduleSourceOverrideState> {
  return typeof (input as ReadonlyMap<string, ProjectScheduleSourceOverrideState>).get === "function";
}

function overrideState(
  overrides: ScheduledPaymentTrackOverrideInput | undefined,
  entryId: string,
) {
  if (!overrides) return undefined;
  if (isOverrideMap(overrides)) return overrides.get(entryId);
  return overrides.find((override) => override.entryId === entryId)?.state;
}

export function scheduledIncompletePaymentTrackProjects(
  projects: ReadonlyArray<ScheduledPaymentTrackProjectInput>,
  overrides?: ScheduledPaymentTrackOverrideInput,
) {
  const unique = new Map<string, ScheduledIncompletePaymentTrackProject>();

  for (const project of projects) {
    const scheduled = scheduledIncompletePaymentTrackProject(project);
    if (!scheduled || unique.has(scheduled.projectId.toLowerCase())) continue;
    const state = overrideState(overrides, scheduled.overrideKey);
    if (state === "cancelled" || state === "deleted") continue;
    unique.set(scheduled.projectId.toLowerCase(), scheduled);
  }

  return [...unique.values()].sort((left, right) => {
    if (left.scheduledDate !== right.scheduledDate) {
      return left.scheduledDate < right.scheduledDate ? -1 : 1;
    }
    if (left.scheduledTime !== right.scheduledTime) {
      return left.scheduledTime < right.scheduledTime ? -1 : 1;
    }
    const leftId = left.projectId.toLowerCase();
    const rightId = right.projectId.toLowerCase();
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.projectId < right.projectId ? -1 : Number(left.projectId > right.projectId);
  });
}

export function countScheduledIncompletePaymentTrackProjects(
  projects: ReadonlyArray<ScheduledPaymentTrackProjectInput>,
  overrides?: ScheduledPaymentTrackOverrideInput,
) {
  return scheduledIncompletePaymentTrackProjects(projects, overrides).length;
}
