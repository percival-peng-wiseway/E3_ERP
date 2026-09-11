// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { confirmedCustomerPayments } from "./amount-due.ts";
import type { PaymentTrackProject } from "./types";

export function projectCreatedMonth(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}

export function summarizeReceivables(projects: readonly PaymentTrackProject[], period: "all" | "monthly" | "quarterly", month: string) {
  const year = month.slice(0, 4);
  const quarter = Math.floor((Number(month.slice(5)) - 1) / 3);
  const selected = projects.filter(project => {
    if (period === "all") return true;
    const created = projectCreatedMonth(project.createdAt);
    if (!created) return false;
    return period === "monthly" ? created === month : created.slice(0, 4) === year && Math.floor((Number(created.slice(5)) - 1) / 3) === quarter;
  });
  let stcCents = 0;
  let stcReceivedCents = 0;
  let missingStcProjects = 0;
  let missingReceivedStcProjects = 0;
  let missingTotalStcProjects = 0;
  for (const project of selected) {
    let missing = false;
    let missingReceived = false;
    for (const [required, received, expected, actual] of [
      [project.stcSolarRequired, project.stcSolarReceivedAt, project.stcSolarExpectedAmountCents, project.stcSolarReceivedAmountCents],
      [project.stcBatteryRequired, project.stcBatteryReceivedAt, project.stcBatteryExpectedAmountCents, project.stcBatteryReceivedAmountCents],
    ] as const) {
      if (!required) continue;
      const amount = received ? actual : expected;
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
        if (received) missingReceived = true;
        else missing = true;
      } else if (received) stcReceivedCents += amount;
      else stcCents += amount;
    }
    if (missing) missingStcProjects += 1;
    if (missingReceived) missingReceivedStcProjects += 1;
    if (missing || missingReceived) missingTotalStcProjects += 1;
  }
  return {
    contractTotalCents: selected.reduce((sum, project) => sum + project.balanceDueCents, 0),
    contractReceivedCents: selected.reduce((sum, project) => sum + confirmedCustomerPayments(project), 0),
    customerCents: selected.reduce((sum, project) => sum + Math.max(0, project.outstandingCents), 0),
    stcTotalCents: stcCents + stcReceivedCents,
    stcReceivedCents,
    stcCents,
    missingStcProjects,
    missingReceivedStcProjects,
    missingTotalStcProjects,
    projectCount: selected.length,
  };
}
