import { createHash } from "node:crypto";
import { HttpProvider, type Quotation } from "@/lib/erp";
import { listPaymentTrackProjects } from "@/lib/payment-track/repository";
import type { PaymentTrackProject } from "@/lib/payment-track/types";
import { listProjectScheduleJobs } from "@/lib/project-schedule/repository";
import type { ProjectScheduleJob } from "@/lib/project-schedule/types";
import { listReimbursements } from "@/lib/reimbursements/repository";
import type { ReimbursementClaim } from "@/lib/reimbursements/types";
import {
  NOTIFICATION_ROLES,
  type NotificationCounts,
  type NotificationPriority,
  type NotificationRoleFilter,
  type NotificationsResponse,
  type WorkspaceNotification,
} from "./types";

const DEFAULT_INVENTORY_OPERATIONS_URL = "https://inventory.e3energy.com.au/api/inventory";
const DEFAULT_QUOTEHELP_URL = "https://quote.e3energy.com.au";
const UPSTREAM_RESPONSE_LIMIT = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_SOURCE_RECORDS = 500;
const MAX_NOTIFICATIONS = 250;
const DAY_MS = 24 * 60 * 60 * 1_000;

type UnknownRecord = Record<string, unknown>;

type OperationalInventoryItem = {
  sku: string;
  status: string;
  available: number | null;
  pending: number | null;
};

type OperationalOrder = {
  id: number;
  group: string;
  entityId: string;
  status: "pending" | "scheduled" | "delivered" | "cancelled";
  plannedDate: string | null;
  scheduleComplete: boolean;
};

type OperationalSnapshot = {
  inventory: OperationalInventoryItem[];
  orders: OperationalOrder[];
};

type QuotationSnapshot = {
  id: string;
  number: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  createdAt: string;
  validUntil: string;
};

const priorityOrder: Record<NotificationPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maximum = 180) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function safeEntityId(value: unknown) {
  return cleanText(value, 200);
}

function notificationId(module: string, entityId: string, action: string) {
  return `${module}:${encodeURIComponent(entityId)}:${action}`.slice(0, 420);
}

function opaqueLegacyOrderId(value: string) {
  return `legacy-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function notification(
  item: Omit<WorkspaceNotification, "id"> & { id?: string },
): WorkspaceNotification {
  const { id, entityId: rawEntityId, ...fields } = item;
  const entityId = rawEntityId ? safeEntityId(rawEntityId) : "";
  return {
    ...fields,
    id: id || notificationId(item.module, entityId || "general", item.actionLabel),
    title: cleanText(item.title, 140),
    description: cleanText(item.description, 360),
    actionLabel: cleanText(item.actionLabel, 60),
    ...(entityId ? { entityId } : {}),
  };
}

function aud(cents: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function melbourneTodayUtc(now: Date) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

function daysUntilDate(value: string | null, now: Date): number | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(target) ? Math.round((target - melbourneTodayUtc(now)) / DAY_MS) : null;
}

function daysSince(value: string, now: Date) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / DAY_MS)) : 0;
}

function melbourneDateOffset(now: Date, days: number) {
  return new Date(melbourneTodayUtc(now) + days * DAY_MS).toISOString().slice(0, 10);
}

async function limitedJson(response: Response, limit: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("Response too large");
  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Response too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function upstreamUrl(rawValue: string, path?: string) {
  const target = new URL(rawValue);
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Unsupported protocol");
  if (path) target.pathname = path;
  target.hash = "";
  return target;
}

function operationalRoot(payload: unknown) {
  if (!isRecord(payload)) throw new Error("Invalid operational response");
  return isRecord(payload.data) ? payload.data : payload;
}

async function loadOperationalSnapshot(): Promise<OperationalSnapshot> {
  const target = upstreamUrl(process.env.INVENTORY_OPERATIONS_API_URL || DEFAULT_INVENTORY_OPERATIONS_URL);
  const response = await fetch(target, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Inventory source unavailable");
  const root = operationalRoot(await limitedJson(response, UPSTREAM_RESPONSE_LIMIT));
  if (!Array.isArray(root.inventory) || !Array.isArray(root.orders)) throw new Error("Invalid operational response");

  const inventory = root.inventory.slice(0, MAX_SOURCE_RECORDS).flatMap((value): OperationalInventoryItem[] => {
    if (!isRecord(value)) return [];
    const sku = cleanText(value.sku, 160);
    const status = cleanText(value.status, 40);
    if (!sku || !status) return [];
    return [{
      sku,
      status,
      available: finiteNumber(value.available),
      pending: finiteNumber(value.pending),
    }];
  });

  const allowedStatuses = new Set<OperationalOrder["status"]>(["pending", "scheduled", "delivered", "cancelled"]);
  const orders = root.orders.slice(0, MAX_SOURCE_RECORDS).flatMap((value): OperationalOrder[] => {
    if (!isRecord(value)) return [];
    const numericId = finiteNumber(value.id);
    const status = cleanText(value.status, 30) as OperationalOrder["status"];
    if (!Number.isSafeInteger(numericId) || (numericId ?? 0) <= 0 || !allowedStatuses.has(status)) return [];
    const sourceGroup = cleanText(value.order_group, 180);
    const legacyGroup = [
      "legacy",
      cleanText(value.sales_rep, 100),
      cleanText(value.customer, 200),
      cleanText(value.phone, 80),
      cleanText(value.address, 500),
      cleanText(value.created_at, 60),
      cleanText(value.note, 500),
    ].join(":");
    const group = sourceGroup || legacyGroup;
    const entityId = sourceGroup && /^[A-Za-z0-9_-]+$/.test(sourceGroup)
      ? sourceGroup
      : opaqueLegacyOrderId(group);
    const plannedDate = cleanText(value.planned_date, 10) || null;
    return [{
      id: numericId as number,
      group,
      entityId,
      status,
      plannedDate,
      scheduleComplete: Boolean(
        plannedDate
        && cleanText(value.driver, 160)
        && cleanText(value.address, 500)
      ),
    }];
  });

  return { inventory, orders };
}

function normalizedQuotation(quotation: Quotation): QuotationSnapshot {
  return {
    id: safeEntityId(quotation.id || quotation.number),
    number: cleanText(quotation.number, 100),
    status: quotation.status,
    createdAt: cleanText(quotation.createdAt, 40),
    validUntil: cleanText(quotation.validUntil, 40),
  };
}

function quotationSessionRoot(payload: unknown) {
  if (!isRecord(payload)) throw new Error("Invalid quotation response");
  const root = isRecord(payload.data) ? payload.data : payload;
  if (isRecord(root.viewer) && root.viewer.isLocalDemo === true) throw new Error("Demo quotation source");
  if (!Array.isArray(root.quotes)) throw new Error("Invalid quotation response");
  return root;
}

async function loadQuoteHelpSnapshot(): Promise<QuotationSnapshot[]> {
  const target = upstreamUrl(process.env.QUOTEHELP_APP_URL || DEFAULT_QUOTEHELP_URL, "/api/session");
  target.search = "";
  const response = await fetch(target, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Quotation source unavailable");
  const root = quotationSessionRoot(await limitedJson(response, UPSTREAM_RESPONSE_LIMIT));
  return (root.quotes as unknown[]).slice(0, MAX_SOURCE_RECORDS).flatMap((value): QuotationSnapshot[] => {
    if (!isRecord(value)) return [];
    const id = safeEntityId(value.id);
    const status = value.status === "drafting" ? "draft" : value.status === "done" ? "accepted" : null;
    if (!id || !status) return [];
    return [{
      id,
      number: cleanText(value.projectName, 100) || id,
      status,
      createdAt: cleanText(value.createdAt, 40),
      validUntil: "",
    }];
  });
}

async function loadQuotationSnapshot(): Promise<QuotationSnapshot[]> {
  const quotationUrl = process.env.ERP_QUOTATION_API_URL?.trim();
  if (!quotationUrl) return loadQuoteHelpSnapshot();
  upstreamUrl(quotationUrl);
  const provider = new HttpProvider({
    quotationUrl,
    token: process.env.ERP_API_TOKEN,
  });
  return (await provider.listQuotations()).slice(0, MAX_SOURCE_RECORDS).map(normalizedQuotation);
}

function pendingFinalPayment(project: PaymentTrackProject) {
  return project.finalPayments.find((payment) => (
    Boolean(payment.acknowledgedAt || payment.proof) && !payment.confirmedAt
  ));
}

function finalPaymentReminder(project: PaymentTrackProject): WorkspaceNotification | null {
  if (project.outstandingCents <= 0) return null;
  const reference = cleanText(project.reference, 100) || "Payment project";
  const pendingPayment = pendingFinalPayment(project);
  if (pendingPayment) {
    return notification({
      id: notificationId("payments", project.id, `confirm-final-payment:${pendingPayment.id}`),
      role: "admin",
      priority: "high",
      title: "Payment confirmation required",
      description: `${reference} has a received payment awaiting confirmation. ${aud(project.outstandingCents)} remains outstanding.`,
      module: "payments",
      entityId: project.id,
      actionLabel: "Confirm payment",
    });
  }
  return notification({
    role: "sales",
    priority: "high",
    title: project.stage === "done" ? "Completed project still has a balance" : "Final payment follow-up required",
    description: `${reference} has ${aud(project.outstandingCents)} remaining to collect.`,
    module: "payments",
    entityId: project.id,
    actionLabel: "Record payment",
  });
}

function paymentNotifications(projects: PaymentTrackProject[], now: Date) {
  const items: WorkspaceNotification[] = [];
  for (const project of projects.slice(0, MAX_SOURCE_RECORDS)) {
    const reference = cleanText(project.reference, 100) || "Payment project";

    if (project.stage === "deposit_not_paid") {
      if (project.deposit.confirmedAt) continue;
      if (project.deposit.proof || project.deposit.acknowledgedAt) {
        items.push(notification({
          role: "admin",
          priority: "high",
          title: "Deposit confirmation required",
          description: `${reference} has deposit evidence ready for Administrator review.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm deposit",
        }));
      } else {
        items.push(notification({
          role: "specialist",
          priority: "high",
          title: "Deposit proof required",
          description: `${reference} cannot progress until deposit proof is uploaded.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Upload proof",
        }));
      }
      continue;
    }

    if (project.stage === "material_delivery") {
      if (!project.deliveredAt) {
        const daysUntil = daysUntilDate(project.deliveryScheduledFor, now);
        let title = "Schedule material delivery";
        let description = `${reference} is ready for PM delivery scheduling.`;
        let priority: NotificationPriority = "high";
        if (project.deliveryScheduledFor && daysUntil !== null) {
          title = daysUntil < 0 ? "Material delivery is overdue" : daysUntil === 0 ? "Material delivery is due today" : "Upcoming material delivery";
          description = `${reference} is scheduled for ${project.deliveryScheduledFor}.`;
          priority = daysUntil <= 0 ? "urgent" : daysUntil <= 3 ? "high" : "normal";
        }
        items.push(notification({
          role: "pm",
          priority,
          title,
          description,
          module: "payments",
          entityId: project.id,
          actionLabel: project.deliveryScheduledFor ? "Review delivery" : "Schedule delivery",
        }));
      } else if (project.collection.confirmedAt) {
        continue;
      } else if (project.collection.acknowledgedAt || project.collection.proof) {
        items.push(notification({
          role: "admin",
          priority: "high",
          title: "Delivery collection needs confirmation",
          description: `${reference} has a collection payment awaiting Administrator confirmation.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm collection",
        }));
      } else {
        items.push(notification({
          role: "sales",
          priority: "high",
          title: "Record the delivery collection",
          description: `${reference} was delivered and is waiting for Sales to record the received collection.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Record collection",
        }));
      }
      continue;
    }

    if (project.stage === "installing") {
      if (project.installedAt) continue;
      const daysUntil = daysUntilDate(project.installationScheduledFor, now);
      let title = "Schedule installation";
      let description = `${reference} is ready for PM installation scheduling.`;
      let priority: NotificationPriority = "high";
      if (project.installationScheduledFor && daysUntil !== null) {
        title = daysUntil < 0
          ? "Installation is overdue"
          : daysUntil === 0 ? "Installation is due today" : "Upcoming installation";
        description = `${reference} is scheduled for installation on ${project.installationScheduledFor}.`;
        priority = daysUntil <= 0 ? "urgent" : daysUntil <= 3 ? "high" : "normal";
      }
      items.push(notification({
        role: "pm",
        priority,
        title,
        description,
        module: "payments",
        entityId: project.id,
        actionLabel: project.installationScheduledFor ? "Review installation" : "Schedule installation",
      }));
      continue;
    }

    if (project.stage === "waiting_coes") {
      if (!project.coesReceivedAt) {
        items.push(notification({
          role: "pm",
          priority: "high",
          title: "COES confirmation required",
          description: `${reference} is installed and waiting for COES confirmation.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm COES",
        }));
      }
    }

    if (project.stage === "stc_rebate") {
      if (project.stcSolarRequired && !project.stcSolarReceivedAt) {
        items.push(notification({
          role: "specialist",
          priority: "high",
          title: "Solar STC confirmation required",
          description: `${reference} is waiting for Solar STC receipt confirmation.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm Solar STC",
        }));
      }
      if (project.stcBatteryRequired && !project.stcBatteryReceivedAt) {
        items.push(notification({
          role: "specialist",
          priority: "high",
          title: "Battery STC confirmation required",
          description: `${reference} is waiting for Battery STC receipt confirmation.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm Battery STC",
        }));
      }
      if (project.solarRebateRequired && !project.solarRebateReceivedAt) {
        items.push(notification({
          role: "specialist",
          priority: "high",
          title: "Solar Rebate confirmation required",
          description: `${reference} is waiting for Solar Rebate receipt confirmation.`,
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm Solar Rebate",
        }));
      }
    }

    if (["waiting_coes", "stc_rebate", "done"].includes(project.stage)) {
      const payment = finalPaymentReminder(project);
      if (payment) items.push(payment);
    }
  }
  return items;
}

function reimbursementNotifications(claims: ReimbursementClaim[]) {
  return claims.slice(0, MAX_SOURCE_RECORDS).flatMap((claim): WorkspaceNotification[] => {
    const reference = cleanText(claim.reference, 100) || "Reimbursement";
    if (claim.status === "submitted") {
      return [notification({
        role: "admin",
        priority: "high",
        title: "Reimbursement review required",
        description: `${reference} for ${aud(claim.amountCents)} is waiting for approval.`,
        module: "reimbursements",
        entityId: claim.id,
        actionLabel: "Review claim",
      })];
    }
    if (claim.status === "pending_payment") {
      return [notification({
        role: "admin",
        priority: "high",
        title: "Approved reimbursement needs payment",
        description: `${reference} has ${aud(claim.amountCents)} approved and ready to pay.`,
        module: "reimbursements",
        entityId: claim.id,
        actionLabel: "Mark as paid",
      })];
    }
    return [];
  });
}

function inventoryNotifications(items: OperationalInventoryItem[]) {
  return items.flatMap((item): WorkspaceNotification[] => {
    const normalizedStatus = item.status.toLocaleLowerCase("en-AU").replaceAll("_", " ");
    const onOrder = normalizedStatus === "订购中" || normalizedStatus === "on order";
    const overstock = normalizedStatus === "积压" || normalizedStatus === "overstock";
    const outOfStock = normalizedStatus === "缺货"
      || normalizedStatus === "out of stock"
      || (!onOrder && item.available !== null && item.available <= 0);
    const lowStock = normalizedStatus === "低库存" || normalizedStatus === "low stock";
    if (!outOfStock && !lowStock && !onOrder && !overstock) return [];
    const available = item.available === null ? "Availability needs review" : `${item.available} available`;
    const pending = item.pending && item.pending > 0 ? `; ${item.pending} already on order` : "";
    const title = outOfStock
      ? "Inventory item is out of stock"
      : lowStock
        ? "Inventory item is low on stock"
        : onOrder ? "Inventory replenishment is on order" : "Review overstocked inventory";
    return [notification({
      role: "admin",
      priority: outOfStock ? "high" : "normal",
      title,
      description: `${item.sku}: ${available}${pending}.`,
      module: "inventory",
      entityId: item.sku,
      actionLabel: "Review inventory",
    })];
  });
}

function projectNotifications(orders: OperationalOrder[], now: Date) {
  const groups = new Map<string, OperationalOrder[]>();
  for (const order of orders) {
    const current = groups.get(order.group);
    if (current) current.push(order);
    else groups.set(order.group, [order]);
  }

  const items: WorkspaceNotification[] = [];
  for (const [group, groupedOrders] of groups) {
    const primary = groupedOrders[0];
    const orderLabel = `Order #${String(primary.id).padStart(4, "0")}`;
    if (primary.status === "pending") {
      items.push(notification({
        role: "pm",
        priority: "high",
        title: "New order needs PM review",
        description: `${orderLabel} has ${groupedOrders.length} item line${groupedOrders.length === 1 ? "" : "s"} ready for delivery planning.`,
        module: "projects",
        entityId: primary.entityId,
        actionLabel: "Review order",
      }));
      continue;
    }
    if (primary.status !== "scheduled") continue;
    const daysUntil = daysUntilDate(primary.plannedDate, now);
    const priority: NotificationPriority = !primary.scheduleComplete
      ? "high"
      : daysUntil !== null && daysUntil <= 0 ? "urgent" : daysUntil !== null && daysUntil <= 3 ? "high" : "normal";
    const title = !primary.scheduleComplete
      ? "Complete the delivery schedule"
      : daysUntil !== null && daysUntil < 0
        ? "Project delivery is overdue"
        : daysUntil === 0 ? "Project delivery is due today" : "Upcoming project delivery";
    const description = primary.scheduleComplete && primary.plannedDate
      ? `${orderLabel} is scheduled for ${primary.plannedDate}.`
      : `${orderLabel} is Scheduled but its date, address or driver details need review.`;
    items.push(notification({
      role: "pm",
      priority,
      title,
      description,
      module: "projects",
      entityId: primary.entityId,
      actionLabel: "Review delivery",
    }));
  }
  return items;
}

function customScheduleNotifications(jobs: ProjectScheduleJob[], now: Date) {
  return jobs.slice(0, MAX_SOURCE_RECORDS).flatMap((job): WorkspaceNotification[] => {
    if (job.status !== "scheduled") return [];
    const daysUntil = daysUntilDate(job.scheduledDate, now);
    if (daysUntil === null || daysUntil < -30 || daysUntil > 7) return [];
    const title = daysUntil < 0
      ? "Custom schedule job is overdue"
      : daysUntil === 0 ? "Custom schedule job is due today" : "Upcoming custom schedule job";
    const priority: NotificationPriority = daysUntil <= 0
      ? "urgent"
      : daysUntil <= 3 ? "high" : "normal";
    return [notification({
      role: "pm",
      priority,
      title,
      description: `${cleanText(job.title, 160) || "Custom schedule job"} is scheduled for ${job.scheduledDate}.`,
      module: "projects",
      entityId: job.id,
      actionLabel: "Review schedule",
    })];
  });
}

function quotationNotifications(quotations: QuotationSnapshot[], now: Date) {
  return quotations.flatMap((quotation): WorkspaceNotification[] => {
    const label = quotation.number || quotation.id;
    if (quotation.status === "draft") {
      const age = daysSince(quotation.createdAt, now);
      return [notification({
        role: "sales",
        priority: age >= 7 ? "high" : "normal",
        title: "Draft quotation needs follow-up",
        description: `${label} has been in Draft for ${age} day${age === 1 ? "" : "s"}.`,
        module: "quotations",
        entityId: quotation.id,
        actionLabel: "Open quotation",
      })];
    }
    if (quotation.status !== "sent") return [];
    const daysUntil = daysUntilDate(quotation.validUntil, now);
    const priority: NotificationPriority = daysUntil !== null && daysUntil < 0
      ? "urgent"
      : daysUntil !== null && daysUntil <= 3 ? "high" : "normal";
    const description = daysUntil === null
      ? `${label} has been sent and is waiting for customer follow-up.`
      : daysUntil < 0
        ? `${label} passed its validity date on ${quotation.validUntil.slice(0, 10)}.`
        : `${label} is valid until ${quotation.validUntil.slice(0, 10)}.`;
    return [notification({
      role: "sales",
      priority,
      title: daysUntil !== null && daysUntil < 0 ? "Sent quotation is overdue" : "Sent quotation needs follow-up",
      description,
      module: "quotations",
      entityId: quotation.id,
      actionLabel: "Open quotation",
    })];
  });
}

function sortedUniqueNotifications(items: WorkspaceNotification[]) {
  const unique = new Map<string, WorkspaceNotification>();
  for (const item of items) {
    const current = unique.get(item.id);
    if (!current || priorityOrder[item.priority] < priorityOrder[current.priority]) unique.set(item.id, item);
  }
  return [...unique.values()]
    .sort((left, right) => (
      priorityOrder[left.priority] - priorityOrder[right.priority]
      || left.role.localeCompare(right.role)
      || left.title.localeCompare(right.title, "en-AU")
      || left.id.localeCompare(right.id)
    ));
}

function notificationCounts(items: WorkspaceNotification[]): NotificationCounts {
  const counts: NotificationCounts = { all: items.length, sales: 0, specialist: 0, pm: 0, admin: 0 };
  for (const item of items) counts[item.role] += 1;
  return counts;
}

export async function buildWorkspaceNotifications(
  role: NotificationRoleFilter = "all",
  options: { includeReimbursements?: boolean } = {},
): Promise<NotificationsResponse> {
  const now = new Date();
  const reimbursementTask = options.includeReimbursements
    ? listReimbursements({ includeAll: true }).then(reimbursementNotifications)
    : Promise.resolve<WorkspaceNotification[]>([]);
  const [payments, reimbursements, operations, quotations, customSchedule] = await Promise.allSettled([
    listPaymentTrackProjects().then((projects) => paymentNotifications(projects, now)),
    reimbursementTask,
    loadOperationalSnapshot().then((snapshot) => [
      ...inventoryNotifications(snapshot.inventory),
      ...projectNotifications(snapshot.orders, now),
    ]),
    loadQuotationSnapshot().then((items) => quotationNotifications(items, now)),
    listProjectScheduleJobs(
      melbourneDateOffset(now, -30),
      melbourneDateOffset(now, 7),
    ).then((jobs) => customScheduleNotifications(jobs, now)),
  ]);

  const generated: WorkspaceNotification[] = [];
  const warnings: string[] = [];
  if (payments.status === "fulfilled") generated.push(...payments.value);
  else warnings.push("Payment reminders are temporarily unavailable.");
  if (reimbursements.status === "fulfilled") generated.push(...reimbursements.value);
  else warnings.push("Reimbursement reminders are temporarily unavailable.");
  if (operations.status === "fulfilled") generated.push(...operations.value);
  else warnings.push("Inventory and Project Management reminders are temporarily unavailable.");
  if (quotations.status === "fulfilled") generated.push(...quotations.value);
  else warnings.push("Quotation reminders are temporarily unavailable.");
  if (customSchedule.status === "fulfilled") generated.push(...customSchedule.value);
  else warnings.push("Custom Project Schedule reminders are temporarily unavailable.");

  const allNotifications = sortedUniqueNotifications(generated);
  const counts = notificationCounts(allNotifications);
  return {
    data: {
      generatedAt: now.toISOString(),
      notifications: (role === "all"
        ? allNotifications
        : allNotifications.filter((item) => item.role === role)).slice(0, MAX_NOTIFICATIONS),
      counts,
    },
    meta: {
      source: "workspace-live-data",
      warnings,
    },
  };
}

export function isNotificationRoleFilter(value: string): value is NotificationRoleFilter {
  return value === "all" || NOTIFICATION_ROLES.includes(value as (typeof NOTIFICATION_ROLES)[number]);
}
