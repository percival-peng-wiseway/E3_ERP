// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { isPaymentTrackWaitingForRebateQr } from "../payment-track/types.ts";
import type { PaymentTrackProject } from "../payment-track/types";
import type { NotificationRole } from "./types";

export type PaymentTrackResponsibilityAction =
  | "upload_deposit_proof"
  | "confirm_deposit"
  | "pre_schedule_delivery"
  | "review_delivery_pre_schedule"
  | "manage_delivery"
  | "record_collection"
  | "confirm_collection"
  | "pre_schedule_installation"
  | "review_installation_pre_schedule"
  | "manage_installation"
  | "confirm_rebate_qr_received"
  | "manage_work"
  | "record_final_payment"
  | "confirm_final_payment"
  | "confirm_solar_stc"
  | "confirm_battery_stc"
  | "confirm_solar_rebate";

export type PaymentTrackResponsibility = {
  action: PaymentTrackResponsibilityAction;
  role: NotificationRole;
  paymentId?: string;
};

function pendingFinalPayments(project: PaymentTrackProject) {
  return project.finalPayments.filter((payment) => (
    Boolean(payment.acknowledgedAt || payment.proof) && !payment.confirmedAt
  ));
}

function deliveryScheduleIsComplete(project: PaymentTrackProject) {
  return Boolean(
    project.deliveryScheduledFor
    && project.deliveryScheduledTime
    && project.deliveryAssignee,
  );
}

function deliveryPreScheduleIsComplete(project: PaymentTrackProject) {
  return Boolean(project.deliveryScheduleRequest && project.deliverySelections.length);
}

function installationScheduleIsComplete(project: PaymentTrackProject) {
  return Boolean(
    project.installationScheduledFor
    && project.installationScheduledTime
    && project.installationAssignee,
  );
}

function existingWipScheduleIsComplete(project: PaymentTrackProject) {
  if (project.workMode === "delivery_only") return deliveryScheduleIsComplete(project);
  if (project.workMode === "installation_only") return installationScheduleIsComplete(project);
  if (project.workMode !== "delivery_and_installation") return false;
  return deliveryScheduleIsComplete(project)
    && installationScheduleIsComplete(project)
    && project.deliveryScheduledFor === project.installationScheduledFor
    && project.deliveryScheduledTime === project.installationScheduledTime;
}

/** Returns only the next role-owned work for a Project Track project. */
export function paymentTrackResponsibilities(project: PaymentTrackProject): PaymentTrackResponsibility[] {
  if (project.stage === "deposit_not_paid") {
    if (project.deposit.confirmedAt) return [];
    return project.deposit.proof || project.deposit.acknowledgedAt
      ? [{ action: "confirm_deposit", role: "admin" }]
      : [{ action: "upload_deposit_proof", role: "sales" }];
  }

  const tasks: PaymentTrackResponsibility[] = [];
  if (project.stage === "working_in_progress" && !project.installedAt) {
    const needsQrReceiptConfirmation = isPaymentTrackWaitingForRebateQr(project)
      && !existingWipScheduleIsComplete(project);
    tasks.push({
      action: needsQrReceiptConfirmation ? "confirm_rebate_qr_received" : "manage_work",
      role: "pm",
    });
  }

  if (project.stage === "material_delivery") {
    if (!project.deliveredAt) {
      if (deliveryScheduleIsComplete(project)) return [{ action: "manage_delivery", role: "pm" }];
      return deliveryPreScheduleIsComplete(project)
        ? [{ action: "review_delivery_pre_schedule", role: "pm" }]
        : [{ action: "pre_schedule_delivery", role: "sales" }];
    }
    if (project.collection.confirmedAt) return [];
    return project.collection.acknowledgedAt || project.collection.proof
      ? [{ action: "confirm_collection", role: "admin" }]
      : [{ action: "record_collection", role: "sales" }];
  }

  if (project.stage === "installing") {
    if (project.installedAt) return [];
    if (installationScheduleIsComplete(project)) return [{ action: "manage_installation", role: "pm" }];
    return project.installationScheduleRequest
      ? [{ action: "review_installation_pre_schedule", role: "pm" }]
      : [{ action: "pre_schedule_installation", role: "sales" }];
  }

  if (project.stage === "stc_rebate") {
    if (project.stcSolarRequired && !project.stcSolarReceivedAt) {
      tasks.push({ action: "confirm_solar_stc", role: "admin" });
    }
    if (project.stcBatteryRequired && !project.stcBatteryReceivedAt) {
      tasks.push({ action: "confirm_battery_stc", role: "admin" });
    }
    if (project.solarRebateRequired && !project.solarRebateReceivedAt) {
      tasks.push({ action: "confirm_solar_rebate", role: "admin" });
    }
  }

  const pendingPayments = pendingFinalPayments(project);
  pendingPayments.forEach((payment) => tasks.push({ action: "confirm_final_payment", role: "admin", paymentId: payment.id }));
  if (project.outstandingCents > 0) {
    const pendingReported = pendingPayments.reduce((total, payment) => total + (payment.reportedAmountCents || 0), 0);
    if (pendingReported < project.outstandingCents) {
      tasks.push({ action: "record_final_payment", role: "sales" });
    }
  }

  return tasks;
}
