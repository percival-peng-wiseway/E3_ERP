import type { PaymentTrackProject } from "../payment-track/types";
import type { NotificationRole } from "./types";

export type PaymentTrackResponsibilityAction =
  | "upload_deposit_proof"
  | "confirm_deposit"
  | "manage_delivery"
  | "record_collection"
  | "confirm_collection"
  | "manage_installation"
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

function pendingFinalPayment(project: PaymentTrackProject) {
  return project.finalPayments.find((payment) => (
    Boolean(payment.acknowledgedAt || payment.proof) && !payment.confirmedAt
  ));
}

/** Returns only the next role-owned work for a Project Track project. */
export function paymentTrackResponsibilities(project: PaymentTrackProject): PaymentTrackResponsibility[] {
  if (project.stage === "deposit_not_paid") {
    if (project.deposit.confirmedAt) return [];
    return project.deposit.proof || project.deposit.acknowledgedAt
      ? [{ action: "confirm_deposit", role: "admin" }]
      : [{ action: "upload_deposit_proof", role: "sales" }];
  }

  if (project.stage === "material_delivery") {
    if (!project.deliveredAt) return [{ action: "manage_delivery", role: "pm" }];
    if (project.collection.confirmedAt) return [];
    return project.collection.acknowledgedAt || project.collection.proof
      ? [{ action: "confirm_collection", role: "admin" }]
      : [{ action: "record_collection", role: "sales" }];
  }

  if (project.stage === "installing") {
    return project.installedAt ? [] : [{ action: "manage_installation", role: "pm" }];
  }

  const tasks: PaymentTrackResponsibility[] = [];
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

  if (["waiting_coes", "stc_rebate", "done"].includes(project.stage) && project.outstandingCents > 0) {
    const pendingPayment = pendingFinalPayment(project);
    tasks.push(pendingPayment
      ? { action: "confirm_final_payment", role: "admin", paymentId: pendingPayment.id }
      : { action: "record_final_payment", role: "sales" });
  }

  return tasks;
}
