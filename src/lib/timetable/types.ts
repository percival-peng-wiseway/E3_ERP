import type { PaymentTrackProject } from "../payment-track/types";

export type InstallationDetails = Pick<PaymentTrackProject,
  "customerUpdatedAt" | "id" | "reference" | "quoteNumber" | "customer" | "specialist" | "items" | "deliverySelections" | "projectNotes" | "pmNotes"
  | "deliveryScheduledFor" | "deliveryScheduledTime" | "deliveryAssignee"
  | "installationScheduledFor" | "installationScheduledTime" | "installationAssignee">;

/** Deliberately allowlisted: no receipts, prices, files or account metadata. */
export function installationDetails(project: PaymentTrackProject): InstallationDetails {
  const { customerUpdatedAt, id, reference, quoteNumber, customer, specialist, items, deliverySelections, projectNotes, pmNotes,
    deliveryScheduledFor, deliveryScheduledTime, deliveryAssignee,
    installationScheduledFor, installationScheduledTime, installationAssignee } = project;
  return { customerUpdatedAt, id, reference, quoteNumber, customer, specialist, items, deliverySelections, projectNotes, pmNotes,
    deliveryScheduledFor, deliveryScheduledTime, deliveryAssignee,
    installationScheduledFor, installationScheduledTime, installationAssignee };
}

export type TimetableEvent = {
  id: string;
  kind: "delivery" | "installation" | "combined";
  date: string;
  time: string | null;
  assignee: string;
  completed: boolean;
  cancelled: boolean;
  details: InstallationDetails;
};

export const WORK_LABELS = { delivery: "Material Delivery", installation: "Installation", combined: "Delivery & Installation" };
export function customerLabel(details: InstallationDetails) {
  return [details.customer.firstName, details.customer.lastName].filter(Boolean).join(" ") || details.reference;
}
export function addressLabel(details: InstallationDetails) {
  const c = details.customer;
  return [c.addressLine1, c.suburb, c.state, c.postcode].filter(Boolean).join(", ");
}
export function melbourneDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (key: string) => parts.find((p) => p.type === key)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function weekStart(date: string) {
  return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}
