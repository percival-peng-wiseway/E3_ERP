import { createHash } from "node:crypto";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { listPaymentTrackProjects } from "../payment-track/repository.ts";
import type { PaymentTrackProject } from "../payment-track/types";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { listReimbursements } from "../reimbursements/repository.ts";
import type { ReimbursementClaim } from "../reimbursements/types";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { amountAction, aud, planningDescription, projectCustomerAddress, projectCustomerName } from "./presentation.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { paymentTrackResponsibilities } from "./responsibilities.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { NOTIFICATION_ROLES } from "./types.ts";
import type {
  NotificationCounts,
  NotificationPriority,
  NotificationRoleFilter,
  NotificationsResponse,
  WorkspaceNotification,
} from "./types";

const DEFAULT_INVENTORY_OPERATIONS_URL = "https://inventory.e3energy.com.au/api/inventory";
const UPSTREAM_RESPONSE_LIMIT = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_SOURCE_RECORDS = 500;
const MAX_NOTIFICATIONS = 250;
const DAY_MS = 24 * 60 * 60 * 1_000;

type UnknownRecord = Record<string, unknown>;

export type OperationalOrder = {
  id: number;
  group: string;
  entityId: string;
  customer: string;
  address: string;
  createdAt: string | null;
  ownerName: string;
  status: "pending" | "scheduled" | "delivered" | "cancelled";
  plannedDate: string | null;
  deliveryTime: string | null;
  scheduleComplete: boolean;
};

type OperationalSnapshot = {
  orders: OperationalOrder[];
};

const priorityOrder: Record<NotificationPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

const operationalStatusOrder: Record<OperationalOrder["status"], number> = {
  pending: 0,
  scheduled: 1,
  delivered: 2,
  cancelled: 3,
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

export function normalizeNotificationDateTime(value: unknown): string | null {
  const candidate = cleanText(value, 60);
  if (!candidate) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(candidate)
    ? `${candidate.replace(" ", "T")}Z`
    : candidate;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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
  const {
    id,
    entityId: rawEntityId,
    badgeLabel: rawBadgeLabel,
    projectCreatedAt: rawProjectCreatedAt,
    ownerName: rawOwnerName,
    ...fields
  } = item;
  const entityId = rawEntityId ? safeEntityId(rawEntityId) : "";
  const badgeLabel = cleanText(rawBadgeLabel, 80);
  const projectCreatedAt = normalizeNotificationDateTime(rawProjectCreatedAt);
  const ownerName = rawOwnerName === undefined
    ? ""
    : cleanText(rawOwnerName, 160) || "Not assigned";
  return {
    ...fields,
    id: id || notificationId(item.module, entityId || "general", item.actionLabel),
    title: cleanText(item.title, 140),
    description: cleanText(item.description, 360),
    actionLabel: cleanText(item.actionLabel, 60),
    ...(entityId ? { entityId } : {}),
    ...(badgeLabel ? { badgeLabel } : {}),
    ...(projectCreatedAt ? { projectCreatedAt } : {}),
    ...(ownerName ? { ownerName } : {}),
  };
}

function operationalOrderCompleteness(order: OperationalOrder) {
  return Number(Boolean(order.customer))
    + Number(Boolean(order.address))
    + Number(Boolean(order.plannedDate))
    + Number(Boolean(order.deliveryTime))
    + Number(order.scheduleComplete) * 2;
}

function consistentOperationalValue(
  orders: OperationalOrder[],
  select: (order: OperationalOrder) => string,
  fallback: string,
) {
  const values = [...new Set(orders.map(select).filter(Boolean))];
  return values.length === 1 ? values[0] : fallback;
}

function earliestOperationalCreatedAt(orders: OperationalOrder[]) {
  let earliest: { timestamp: number; value: string } | null = null;
  for (const order of orders) {
    if (!order.createdAt) continue;
    const timestamp = Date.parse(order.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    if (!earliest || timestamp < earliest.timestamp) earliest = { timestamp, value: order.createdAt };
  }
  return earliest?.value;
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
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const target = Date.UTC(year, month - 1, day);
  const targetDate = new Date(target);
  if (
    targetDate.getUTCFullYear() !== year
    || targetDate.getUTCMonth() !== month - 1
    || targetDate.getUTCDate() !== day
  ) return null;
  return Math.round((target - melbourneTodayUtc(now)) / DAY_MS);
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
  if (!Array.isArray(root.orders)) throw new Error("Invalid operational response");

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
    const deliveryTime = cleanText(value.delivery_time, 5) || null;
    const customer = cleanText(value.customer, 200);
    const address = cleanText(value.address, 500);
    return [{
      id: numericId as number,
      group,
      entityId,
      customer,
      address,
      createdAt: normalizeNotificationDateTime(value.created_at),
      ownerName: cleanText(value.sales_rep, 160),
      status,
      plannedDate,
      deliveryTime,
      scheduleComplete: Boolean(
        plannedDate
        && deliveryTime
        && cleanText(value.driver, 160)
        && address
      ),
    }];
  });

  return { orders };
}

export function buildPaymentTrackNotifications(projects: PaymentTrackProject[], now: Date) {
  const items: WorkspaceNotification[] = [];
  for (const project of projects.slice(0, MAX_SOURCE_RECORDS)) {
    const customerName = projectCustomerName(project);
    const customerAddress = projectCustomerAddress(project);
    for (const task of paymentTrackResponsibilities(project)) {
      if (task.action === "upload_deposit_proof") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: amountAction(project.expectedDepositCents, "expected deposit", "Upload deposit proof"),
          module: "payments",
          entityId: project.id,
          actionLabel: "Upload proof",
        }));
      } else if (task.action === "confirm_deposit") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: amountAction(project.expectedDepositCents, "expected deposit", "Confirm deposit"),
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm deposit",
        }));
      } else if (task.action === "manage_delivery") {
        const scheduledFor = project.deliveryScheduledFor;
        const daysUntil = daysUntilDate(scheduledFor, now);
        const hasSchedule = daysUntil !== null
          && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cleanText(project.deliveryScheduledTime, 5))
          && Boolean(cleanText(project.deliveryAssignee, 80));
        let priority: NotificationPriority = "high";
        if (hasSchedule && daysUntil !== null) {
          if (daysUntil < -30 || daysUntil > 7) continue;
          priority = daysUntil <= 0 ? "urgent" : daysUntil <= 3 ? "high" : "normal";
        }
        items.push(notification({
          role: task.role,
          priority,
          badgeLabel: hasSchedule ? "Delivery scheduled" : "Delivery plan needed",
          projectCreatedAt: project.createdAt,
          ownerName: project.specialist.name,
          title: customerName,
          description: planningDescription(customerAddress, "Delivery planning"),
          module: "payments",
          entityId: project.id,
          actionLabel: hasSchedule ? "View delivery schedule" : "Arrange delivery",
        }));
      } else if (task.action === "record_collection") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: amountAction(project.outstandingCents, "outstanding", "Record collection"),
          module: "payments",
          entityId: project.id,
          actionLabel: "Record collection",
        }));
      } else if (task.action === "confirm_collection") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: amountAction(project.outstandingCents, "outstanding", "Confirm collection"),
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm collection",
        }));
      } else if (task.action === "manage_installation") {
        const scheduledFor = project.installationScheduledFor;
        const daysUntil = daysUntilDate(scheduledFor, now);
        const hasSchedule = daysUntil !== null
          && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cleanText(project.installationScheduledTime, 5))
          && Boolean(cleanText(project.installationAssignee, 80));
        let priority: NotificationPriority = "high";
        if (hasSchedule && daysUntil !== null) {
          if (daysUntil < -30 || daysUntil > 7) continue;
          priority = daysUntil <= 0 ? "urgent" : daysUntil <= 3 ? "high" : "normal";
        }
        items.push(notification({
          role: task.role,
          priority,
          badgeLabel: hasSchedule ? "Installation scheduled" : "Installation plan needed",
          projectCreatedAt: project.createdAt,
          ownerName: project.specialist.name,
          title: customerName,
          description: planningDescription(customerAddress, "Installation planning"),
          module: "projects",
          entityId: project.id,
          actionLabel: hasSchedule ? "View installation schedule" : "Arrange installation",
        }));
      } else if (task.action === "confirm_solar_stc") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: "Confirm Solar STC",
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm Solar STC",
        }));
      } else if (task.action === "confirm_battery_stc") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: "Confirm Battery STC",
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm Battery STC",
        }));
      } else if (task.action === "confirm_solar_rebate") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: "Confirm Solar Rebate",
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm Solar Rebate",
        }));
      } else if (task.action === "record_final_payment") {
        items.push(notification({
          role: task.role,
          priority: "high",
          title: customerName,
          description: amountAction(project.outstandingCents, "outstanding", "Record received payment"),
          module: "payments",
          entityId: project.id,
          actionLabel: "Record received payment",
        }));
      } else if (task.action === "confirm_final_payment") {
        items.push(notification({
          id: notificationId("payments", project.id, `confirm-final-payment:${task.paymentId}`),
          role: task.role,
          priority: "high",
          title: customerName,
          description: amountAction(project.outstandingCents, "outstanding", "Confirm payment"),
          module: "payments",
          entityId: project.id,
          actionLabel: "Confirm payment",
        }));
      }
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

export function buildOperationalProjectNotifications(orders: OperationalOrder[], now: Date) {
  const groups = new Map<string, OperationalOrder[]>();
  for (const order of orders) {
    const current = groups.get(order.group);
    if (current) current.push(order);
    else groups.set(order.group, [order]);
  }

  const items: WorkspaceNotification[] = [];
  for (const groupedOrders of groups.values()) {
    const primary = [...groupedOrders].sort((left, right) => (
      operationalStatusOrder[left.status] - operationalStatusOrder[right.status]
      || operationalOrderCompleteness(right) - operationalOrderCompleteness(left)
      || left.id - right.id
    ))[0];
    const customerName = consistentOperationalValue(
      groupedOrders,
      (order) => order.customer,
      "Customer name required",
    );
    const address = consistentOperationalValue(
      groupedOrders,
      (order) => order.address,
      "Address required",
    );
    const projectCreatedAt = earliestOperationalCreatedAt(groupedOrders);
    const ownerName = consistentOperationalValue(
      groupedOrders,
      (order) => order.ownerName,
      "Not assigned",
    );
    if (primary.status === "pending") {
      items.push(notification({
        role: "pm",
        priority: "high",
        badgeLabel: "Delivery plan needed",
        projectCreatedAt,
        ownerName,
        title: customerName,
        description: planningDescription(address, "Delivery planning"),
        module: "projects",
        entityId: primary.entityId,
        actionLabel: "Arrange delivery",
      }));
      continue;
    }
    if (primary.status !== "scheduled") continue;
    const daysUntil = daysUntilDate(primary.plannedDate, now);
    const scheduleComplete = primary.scheduleComplete && daysUntil !== null;
    if (scheduleComplete && (daysUntil < -30 || daysUntil > 7)) continue;
    const priority: NotificationPriority = !scheduleComplete
      ? "high"
      : daysUntil !== null && daysUntil <= 0 ? "urgent" : daysUntil !== null && daysUntil <= 3 ? "high" : "normal";
    items.push(notification({
      role: "pm",
      priority,
      badgeLabel: scheduleComplete ? "Delivery scheduled" : "Delivery plan needed",
      projectCreatedAt,
      ownerName,
      title: customerName,
      description: planningDescription(address, "Delivery planning"),
      module: "projects",
      entityId: primary.entityId,
      actionLabel: scheduleComplete ? "View delivery schedule" : "Complete delivery schedule",
    }));
  }
  return items;
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
  const deliveryOperationsTask = role === "all" || role === "pm"
    ? loadOperationalSnapshot().then((snapshot) => buildOperationalProjectNotifications(snapshot.orders, now))
    : Promise.resolve<WorkspaceNotification[]>([]);
  const [payments, reimbursements, operations] = await Promise.allSettled([
    listPaymentTrackProjects().then((projects) => buildPaymentTrackNotifications(projects, now)),
    reimbursementTask,
    deliveryOperationsTask,
  ]);

  const generated: WorkspaceNotification[] = [];
  const warnings: string[] = [];
  if (payments.status === "fulfilled") generated.push(...payments.value);
  else warnings.push(role === "pm"
    ? "Delivery and installation reminders are temporarily unavailable."
    : "Payment reminders are temporarily unavailable.");
  if (reimbursements.status === "fulfilled") generated.push(...reimbursements.value);
  else warnings.push("Reimbursement reminders are temporarily unavailable.");
  if (operations.status === "fulfilled") generated.push(...operations.value);
  else if (role === "all" || role === "pm") warnings.push("Delivery schedule reminders are temporarily unavailable.");

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
