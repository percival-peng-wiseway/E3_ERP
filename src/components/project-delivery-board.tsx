"use client";

import {
  AlertCircle,
  CalendarCheck2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LoaderCircle,
  List,
  Mail,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Truck,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import {
  FormEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErpRole } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import type { SiteVisit } from "@/lib/site-visits/types";
import {
  PAYMENT_TRACK_SCHEDULE_ASSIGNEES,
  type PaymentTrackListResponse,
  type PaymentTrackProject,
  type PaymentTrackScheduleAssignee,
} from "@/lib/payment-track/types";
import styles from "./project-delivery-board.module.css";

type OrderStatus = "pending" | "scheduled" | "delivered" | "cancelled";

type InventoryOrder = {
  id: number;
  order_group: string | null;
  sales_rep: string;
  customer: string;
  phone: string;
  sku: string;
  quantity: number;
  created_at: string;
  status: OrderStatus;
  address: string | null;
  planned_date: string | null;
  delivery_time: string | null;
  driver: string | null;
  driver_email: string | null;
  delivered_at: string | null;
  note: string | null;
};

type OperationsState = { orders: InventoryOrder[]; deliveryHistory: InventoryOrder[] };
type DeliveryGroup = { key: string; orders: InventoryOrder[]; primary: InventoryOrder };
type ScheduledPaymentProject = PaymentTrackProject & { installationScheduledFor: string | null };

type ProjectScheduleJob = {
  id: string;
  title: string;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  assignee: string | null;
  location: string | null;
  notes: string | null;
  status: "scheduled" | "completed";
  createdAt: string;
  updatedAt: string;
};

type ProjectScheduleSourceOverride = {
  entryId: string;
  state: "cancelled" | "deleted";
  updatedAt: string;
  updatedBy: string;
};

type ScheduleFilter = "all" | "material_delivery" | "installing" | "site_visit" | "custom";
type ScheduleView = "calendar" | "list";
type PaymentScheduleKind = "delivery" | "installation";
type InventoryEditorState = {
  group: DeliveryGroup;
  customer: string;
  phone: string;
  address: string;
  plannedDate: string;
  deliveryTime: string;
  driver: string;
  driverEmail: string;
  salesRep: string;
  note: string;
};
type PaymentEditorState = {
  project: ScheduledPaymentProject;
  kind: PaymentScheduleKind;
  date: string;
  time: string;
  assignee: PaymentTrackScheduleAssignee | "";
};
type CustomEditorState = {
  job: ProjectScheduleJob | null;
  title: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  assignee: string;
  location: string;
  notes: string;
};

type CalendarEntry = (
  | { id: string; source: "inventory"; date: string; time: string | null; title: string; location: string; assignee: string; detail: string; completed: boolean; group: DeliveryGroup }
  | { id: string; source: "material_delivery" | "installing"; date: string; time: string | null; title: string; location: string; assignee: string; detail: string; completed: boolean; project: ScheduledPaymentProject }
  | { id: string; source: "site_visit"; date: string; time: string; title: string; location: string; assignee: string; detail: string; completed: boolean; visit: SiteVisit }
  | { id: string; source: "custom"; date: string; time: string | null; title: string; location: string; assignee: string; detail: string; completed: boolean; job: ProjectScheduleJob }
) & { overrideKey: string | null; cancelled: boolean };

type UnscheduledEntry = {
  id: string;
  source: "material_delivery" | "installing";
  pendingStatus: "unscheduled" | "pre_scheduled";
  title: string;
  location: string;
  detail: string;
  project: ScheduledPaymentProject;
  overrideKey: string | null;
  cancelled: boolean;
};

type OverrideableEntry = Pick<CalendarEntry, "overrideKey" | "cancelled" | "source" | "title">;
type SourceOverrideAction = "cancel" | "restore" | "delete";

const MELBOURNE_TIME_ZONE = "Australia/Melbourne";
const EMPTY_OPERATIONS: OperationsState = { orders: [], deliveryHistory: [] };
const FILTERS: Array<{ id: ScheduleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "material_delivery", label: "Material Delivery" },
  { id: "installing", label: "Installment" },
  { id: "site_visit", label: "Site Visit" },
  { id: "custom", label: "Custom" },
];

function apiMessage(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return /\p{Script=Han}/u.test(value) ? fallback : value;
}

function isSourceOverride(value: unknown): value is ProjectScheduleSourceOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectScheduleSourceOverride>;
  return typeof candidate.entryId === "string"
    && (candidate.state === "cancelled" || candidate.state === "deleted")
    && typeof candidate.updatedAt === "string"
    && typeof candidate.updatedBy === "string";
}

function isoFromParts(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function melbourneToday() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return isoFromParts(Number(value.year), Number(value.month), Number(value.day));
}

function melbourneDateFromTimestamp(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return isoFromParts(Number(record.year), Number(record.month), Number(record.day));
}

function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStartFor(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay();
  return addIsoDays(value, -(day === 0 ? 6 : day - 1));
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short" }).format(new Date(`${value}T12:00:00Z`));
}

function dateNumber(value: string) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric" }).format(new Date(`${value}T12:00:00Z`));
}

function shortDate(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(date);
}

function weekRangeLabel(from: string, to: string) {
  const first = new Date(`${from}T12:00:00Z`);
  const last = new Date(`${to}T12:00:00Z`);
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  const sameMonth = sameYear && first.getUTCMonth() === last.getUTCMonth();
  const start = new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: sameMonth ? undefined : "short",
    year: sameYear ? undefined : "numeric",
  }).format(first);
  const end = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(last);
  return `${start} – ${end}`;
}

function timeLabel(value: string | null) {
  if (!value) return "Time not set";
  const [hourText, minute = "00"] = value.split(":");
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) return value;
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function customerName(project: ScheduledPaymentProject) {
  return `${project.customer.firstName} ${project.customer.lastName}`.trim() || project.reference;
}

function customerAddress(project: ScheduledPaymentProject) {
  return [project.customer.addressLine1, project.customer.suburb, project.customer.state, project.customer.postcode].filter(Boolean).join(", ");
}

function paymentItemLabel(project: ScheduledPaymentProject, itemIndex: number) {
  const item = project.items[itemIndex];
  if (!item) return "Item";
  const name = item.model.trim() || item.description.trim() || item.category.trim() || "Item";
  const capacity = item.capacity.trim();
  return capacity && !name.toLocaleLowerCase("en-AU").includes(capacity.toLocaleLowerCase("en-AU"))
    ? `${name} (${capacity})`
    : name;
}

function paymentItemsSummary(project: ScheduledPaymentProject) {
  const prepared = project.deliverySelections;
  if (prepared.length) {
    const visibleItems = prepared.slice(0, 3);
    const remainingCount = prepared.length - visibleItems.length;
    const summary = visibleItems.map((item) => `${item.quantity}× ${item.sku}`).join(", ");
    return `${project.reference} · ${summary}${remainingCount ? `, +${remainingCount} more` : ""}`;
  }
  if (!project.items.length) return `${project.reference} · No items listed`;
  const visibleItems = project.items.slice(0, 3);
  const remainingCount = project.items.length - visibleItems.length;
  const summary = visibleItems
    .map((item, index) => `${item.quantity}× ${paymentItemLabel(project, index)}`)
    .join(", ");
  return `${project.reference} · ${summary}${remainingCount ? `, +${remainingCount} more` : ""}`;
}

function hasCompletePaymentSchedule(project: ScheduledPaymentProject, kind: PaymentScheduleKind) {
  return kind === "delivery"
    ? Boolean(project.deliveryScheduledFor && project.deliveryScheduledTime && project.deliveryAssignee)
    : Boolean(project.installationScheduledFor && project.installationScheduledTime && project.installationAssignee);
}

function paymentScheduleRequest(project: ScheduledPaymentProject, kind: PaymentScheduleKind) {
  return kind === "delivery" ? project.deliveryScheduleRequest : project.installationScheduleRequest;
}

function hasCompletePaymentScheduleRequest(project: ScheduledPaymentProject, kind: PaymentScheduleKind) {
  const request = paymentScheduleRequest(project, kind);
  return Boolean(
    request?.preferredDate
    && request.preferredTime
    && request.submittedAt
    && request.submittedBy
    && (kind !== "delivery" || project.deliverySelections.length),
  );
}

function submittedAtLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function scheduleRequestOverrideKey(
  project: ScheduledPaymentProject,
  kind: PaymentScheduleKind,
  submittedAt: string,
) {
  const fixedKey = `payment-${kind === "delivery" ? "delivery" : "installation"}:${project.id.toLowerCase()}`;
  const idParts = project.id.toLowerCase().split("-");
  const submittedTimestamp = Date.parse(submittedAt);
  if (idParts.length !== 5 || !Number.isFinite(submittedTimestamp)) return fixedKey;
  // Source override IDs must retain the accepted UUID shape. Encoding the
  // submission timestamp in its final segment gives every Sales resubmission
  // a fresh override identity without changing the final Calendar card key.
  const requestToken = Math.trunc(submittedTimestamp).toString(16).padStart(12, "0").slice(-12);
  return `payment-${kind === "delivery" ? "delivery" : "installation"}:${idParts[0]}-${idParts[1]}-${idParts[2]}-${idParts[3]}-${requestToken}`;
}

function groupOrders(orders: InventoryOrder[]) {
  const grouped = new Map<string, InventoryOrder[]>();
  for (const order of orders) {
    const groupingKey = order.order_group || ["legacy", order.sales_rep, order.customer, order.phone || "", order.address || "", order.created_at, order.note || ""].join(":");
    grouped.set(groupingKey, [...(grouped.get(groupingKey) || []), order]);
  }
  return [...grouped.values()].map((rows) => {
    const sorted = [...rows].sort((left, right) => left.id - right.id);
    return { key: `orders:${sorted.map((order) => order.id).join(",")}`, orders: sorted, primary: sorted[0] } satisfies DeliveryGroup;
  });
}

function isScheduleFilterMatch(source: CalendarEntry["source"] | UnscheduledEntry["source"], filter: ScheduleFilter) {
  if (filter === "all") return true;
  if (filter === "material_delivery") return source === "material_delivery" || source === "inventory";
  return source === filter;
}

function emptyCustomEditor(date: string): CustomEditorState {
  return { job: null, title: "", scheduledDate: date, startTime: "09:00", endTime: "10:00", assignee: "", location: "", notes: "" };
}

export function ProjectDeliveryBoard({ authenticatedRole }: { authenticatedRole: ErpRole }) {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(melbourneToday()));
  const [operations, setOperations] = useState<OperationsState>(EMPTY_OPERATIONS);
  const [projects, setProjects] = useState<ScheduledPaymentProject[]>([]);
  const [siteVisits, setSiteVisits] = useState<SiteVisit[]>([]);
  const [customJobs, setCustomJobs] = useState<ProjectScheduleJob[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<ProjectScheduleSourceOverride[]>([]);
  const [sourceOverridesReady, setSourceOverridesReady] = useState(false);
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const [view, setView] = useState<ScheduleView>("calendar");
  const [expandedCompletedDays, setExpandedCompletedDays] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [inventoryEditor, setInventoryEditor] = useState<InventoryEditorState | null>(null);
  const [paymentEditor, setPaymentEditor] = useState<PaymentEditorState | null>(null);
  const [customEditor, setCustomEditor] = useState<CustomEditorState | null>(null);
  const loadRequestRef = useRef(0);
  const modalRef = useRef<HTMLFormElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const scheduleHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const canManageSchedule = authenticatedRole === "pm" || authenticatedRole === "admin";

  const weekEnd = addIsoDays(weekStart, 6);
  const today = melbourneToday();
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addIsoDays(weekStart, index)), [weekStart]);

  const load = useCallback(async (quiet = false) => {
    const requestId = ++loadRequestRef.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    const requests = await Promise.allSettled([
      fetch("/api/inventory/operations", { cache: "no-store" }).then(async (response) => ({ response, body: await readJsonResponse<OperationsState & { error?: string }>(response) })),
      fetch("/api/payment-track", { cache: "no-store" }).then(async (response) => ({ response, body: await readJsonResponse<PaymentTrackListResponse & { error?: string }>(response) })),
      fetch("/api/site-visits", { cache: "no-store" }).then(async (response) => ({ response, body: await readJsonResponse<{ data?: { visits?: SiteVisit[] }; error?: string }>(response) })),
      fetch(`/api/project-schedule?from=${encodeURIComponent(addIsoDays(weekStart, -90))}&to=${encodeURIComponent(addIsoDays(weekStart, 96))}`, { cache: "no-store" }).then(async (response) => ({ response, body: await readJsonResponse<{ data?: { jobs?: ProjectScheduleJob[]; overrides?: unknown[] }; error?: string }>(response) })),
    ]);
    if (requestId !== loadRequestRef.current) return;
    const warnings: string[] = [];
    let successfulSources = 0;
    const [inventoryResult, paymentResult, siteVisitResult, customResult] = requests;
    if (inventoryResult.status === "fulfilled" && inventoryResult.value.response.ok) {
      successfulSources += 1;
      setOperations({
        orders: Array.isArray(inventoryResult.value.body.orders) ? inventoryResult.value.body.orders : [],
        deliveryHistory: Array.isArray(inventoryResult.value.body.deliveryHistory) ? inventoryResult.value.body.deliveryHistory : [],
      });
    } else {
      setOperations(EMPTY_OPERATIONS);
      warnings.push("Inventory dispatches could not be refreshed.");
    }
    if (paymentResult.status === "fulfilled" && paymentResult.value.response.ok) {
      successfulSources += 1;
      setProjects(Array.isArray(paymentResult.value.body.data) ? paymentResult.value.body.data as ScheduledPaymentProject[] : []);
    } else {
      setProjects([]);
      warnings.push("Project Track could not be refreshed.");
    }
    if (siteVisitResult.status === "fulfilled" && siteVisitResult.value.response.ok) {
      successfulSources += 1;
      setSiteVisits(Array.isArray(siteVisitResult.value.body.data?.visits) ? siteVisitResult.value.body.data.visits : []);
    } else {
      setSiteVisits([]);
      warnings.push("Site visits could not be refreshed.");
    }
    const scheduleData = customResult.status === "fulfilled" ? customResult.value.body.data : undefined;
    const validScheduleData = customResult.status === "fulfilled"
      && customResult.value.response.ok
      && Array.isArray(scheduleData?.jobs)
      && Array.isArray(scheduleData.overrides)
      && scheduleData.overrides.every(isSourceOverride);
    if (validScheduleData) {
      successfulSources += 1;
      setCustomJobs(scheduleData?.jobs as ProjectScheduleJob[]);
      setSourceOverrides(scheduleData?.overrides as ProjectScheduleSourceOverride[]);
      setSourceOverridesReady(true);
    } else {
      setCustomJobs([]);
      setSourceOverridesReady(false);
      warnings.push("Weekly Schedule jobs and source-card controls could not be refreshed.");
    }
    setSourceWarnings(warnings);
    setError(successfulSources === 0 ? "Unable to load the weekly schedule." : "");
    setLoading(false);
    setRefreshing(false);
  }, [weekStart]);

  useEffect(() => {
    void load();
    const refresh = () => void load(true);
    window.addEventListener("erp:inventory-updated", refresh);
    window.addEventListener("erp:payment-track-updated", refresh);
    window.addEventListener("erp:site-visits-updated", refresh);
    return () => {
      loadRequestRef.current += 1;
      window.removeEventListener("erp:inventory-updated", refresh);
      window.removeEventListener("erp:payment-track-updated", refresh);
      window.removeEventListener("erp:site-visits-updated", refresh);
    };
  }, [load]);

  const restoreModalFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      else scheduleHeadingRef.current?.focus();
    });
  }, []);

  const closeModalAfterSuccess = useCallback(() => {
    setInventoryEditor(null);
    setPaymentEditor(null);
    setCustomEditor(null);
    restoreModalFocus();
  }, [restoreModalFocus]);

  const closeModal = useCallback(() => {
    if (busy) return;
    closeModalAfterSuccess();
  }, [busy, closeModalAfterSuccess]);

  const activeModal = inventoryEditor || paymentEditor || customEditor;
  useEffect(() => {
    if (!activeModal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        closeModal();
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [Boolean(activeModal), busy, closeModal]);

  const scheduledInventoryGroups = useMemo(
    () => groupOrders(operations.orders.filter((order) => order.status === "scheduled" && order.planned_date)),
    [operations.orders],
  );
  const completedInventoryGroups = useMemo(() => {
    const withinWeek = operations.deliveryHistory.filter((order) => {
      const date = order.planned_date || melbourneDateFromTimestamp(order.delivered_at);
      return date && date >= weekStart && date <= weekEnd;
    });
    return groupOrders(withinWeek).slice(0, 50);
  }, [operations.deliveryHistory, weekEnd, weekStart]);

  const sourceOverrideState = useMemo(
    () => new Map(sourceOverrides.map((override) => [override.entryId, override.state] as const)),
    [sourceOverrides],
  );

  const allDatedEntries = useMemo<CalendarEntry[]>(() => {
    const inventoryEntries: CalendarEntry[] = sourceOverridesReady ? [...scheduledInventoryGroups, ...completedInventoryGroups]
      .filter((group) => Boolean(group.primary.planned_date || melbourneDateFromTimestamp(group.primary.delivered_at)))
      .flatMap((group) => {
        const overrideKey = `inventory:${group.key}`;
        const overrideState = sourceOverrideState.get(overrideKey);
        if (overrideState === "deleted") return [];
        return [{
          id: `inventory:${group.key}:${group.primary.status}`,
          source: "inventory" as const,
          date: (group.primary.planned_date || melbourneDateFromTimestamp(group.primary.delivered_at)) as string,
          time: group.primary.delivery_time,
          title: group.primary.customer,
          location: group.primary.address || "Address required",
          assignee: group.primary.driver || "Driver not assigned",
          detail: `${group.orders.length} ${group.orders.length === 1 ? "item" : "items"}`,
          completed: group.primary.status === "delivered",
          group,
          overrideKey,
          cancelled: overrideState === "cancelled",
        }];
      }) : [];
    const paymentEntries: CalendarEntry[] = [];
    for (const project of sourceOverridesReady ? projects : []) {
      const deliveryDate = project.deliveryScheduledFor || melbourneDateFromTimestamp(project.deliveredAt);
      const isActiveDelivery = project.stage === "material_delivery" && !project.deliveredAt;
      const deliveryOverrideKey = `payment-delivery:${project.id.toLowerCase()}`;
      const deliveryOverrideState = sourceOverrideState.get(deliveryOverrideKey);
      if (deliveryOverrideState !== "deleted"
        && deliveryDate
        && (project.deliveredAt || (isActiveDelivery && hasCompletePaymentSchedule(project, "delivery")))) {
        paymentEntries.push({
          id: `payment-delivery:${project.id}`,
          source: "material_delivery",
          date: deliveryDate,
          time: project.deliveryScheduledTime,
          title: customerName(project),
          location: customerAddress(project) || "Address required",
          assignee: project.deliveryAssignee || "Delivery person not assigned",
          detail: paymentItemsSummary(project),
          completed: Boolean(project.deliveredAt),
          project,
          overrideKey: deliveryOverrideKey,
          cancelled: deliveryOverrideState === "cancelled",
        });
      }
      const installationDate = project.installationScheduledFor || melbourneDateFromTimestamp(project.installedAt);
      const isActiveInstallation = project.stage === "installing" && !project.installedAt;
      const installationOverrideKey = `payment-installation:${project.id.toLowerCase()}`;
      const installationOverrideState = sourceOverrideState.get(installationOverrideKey);
      if (installationOverrideState !== "deleted"
        && installationDate
        && (project.installedAt || (isActiveInstallation && hasCompletePaymentSchedule(project, "installation")))) {
        paymentEntries.push({
          id: `payment-installation:${project.id}`,
          source: "installing",
          date: installationDate,
          time: project.installationScheduledTime,
          title: customerName(project),
          location: customerAddress(project) || "Address required",
          assignee: project.installationAssignee || "Installer not assigned",
          detail: paymentItemsSummary(project),
          completed: Boolean(project.installedAt),
          project,
          overrideKey: installationOverrideKey,
          cancelled: installationOverrideState === "cancelled",
        });
      }
    }
    const customEntries: CalendarEntry[] = customJobs.map((job) => ({
      id: `custom:${job.id}`,
      source: "custom",
      date: job.scheduledDate,
      time: job.startTime,
      title: job.title,
      location: job.location || "Location not set",
      assignee: job.assignee || "Unassigned",
      detail: job.endTime ? `${timeLabel(job.startTime)} – ${timeLabel(job.endTime)}` : timeLabel(job.startTime),
      completed: job.status === "completed",
      job,
      overrideKey: null,
      cancelled: false,
    }));
    const siteVisitEntries: CalendarEntry[] = sourceOverridesReady ? siteVisits.flatMap((visit) => {
      if (!visit.scheduledDate || !visit.scheduledTime
        || !["scheduled", "in_progress", "completed"].includes(visit.status)) return [];
      const overrideKey = `site-visit:${visit.id.toLowerCase()}`;
      const overrideState = sourceOverrideState.get(overrideKey);
      if (overrideState === "deleted") return [];
      return [{
        id: `site-visit:${visit.id}:${visit.status}`,
        source: "site_visit" as const,
        date: visit.scheduledDate,
        time: visit.scheduledTime,
        title: visit.projectName,
        location: visit.address || "Address required",
        assignee: visit.assignee || "Team member not assigned",
        detail: visit.reason ? `Site visit · ${visit.reason}` : "Site visit",
        completed: visit.status === "completed",
        visit,
        overrideKey,
        cancelled: overrideState === "cancelled",
      }];
    }) : [];
    return [...inventoryEntries, ...paymentEntries, ...siteVisitEntries, ...customEntries]
      .sort((left, right) => {
        const dateOrder = left.date.localeCompare(right.date);
        if (dateOrder) return dateOrder;
        const completionOrder = Number(left.completed && !left.cancelled) - Number(right.completed && !right.cancelled);
        if (completionOrder) return completionOrder;
        return `${left.time || "99:99"}:${left.title}`.localeCompare(`${right.time || "99:99"}:${right.title}`);
      });
  }, [completedInventoryGroups, customJobs, projects, scheduledInventoryGroups, siteVisits, sourceOverrideState, sourceOverridesReady]);

  const calendarEntries = useMemo(
    () => allDatedEntries.filter((entry) => entry.date >= weekStart && entry.date <= weekEnd),
    [allDatedEntries, weekEnd, weekStart],
  );
  const overdueEntries = useMemo(
    () => allDatedEntries.filter((entry) => !entry.completed && !entry.cancelled && entry.date < weekStart),
    [allDatedEntries, weekStart],
  );
  const futureCount = useMemo(
    () => allDatedEntries.filter((entry) => !entry.completed && !entry.cancelled && entry.date > weekEnd).length,
    [allDatedEntries, weekEnd],
  );

  const unscheduledEntries = useMemo<UnscheduledEntry[]>(() => {
    const payment: UnscheduledEntry[] = [];
    for (const project of projects) {
      const deliveryRequest = project.deliveryScheduleRequest;
      if (project.stage === "material_delivery"
        && !project.deliveredAt
        && !hasCompletePaymentSchedule(project, "delivery")) {
        const requestComplete = hasCompletePaymentScheduleRequest(project, "delivery");
        const overrideKey = requestComplete && sourceOverridesReady
          ? scheduleRequestOverrideKey(project, "delivery", deliveryRequest?.submittedAt || "")
          : null;
        const overrideState = overrideKey ? sourceOverrideState.get(overrideKey) : undefined;
        if (overrideState !== "deleted") payment.push({ id: `pending-payment-delivery:${project.id}`, source: "material_delivery", pendingStatus: requestComplete ? "pre_scheduled" : "unscheduled", title: customerName(project), location: customerAddress(project) || "Address required", detail: paymentItemsSummary(project), project, overrideKey, cancelled: overrideState === "cancelled" });
      }
      const installationRequest = project.installationScheduleRequest;
      if (project.stage === "installing"
        && !project.installedAt
        && !hasCompletePaymentSchedule(project, "installation")) {
        const requestComplete = hasCompletePaymentScheduleRequest(project, "installation");
        const overrideKey = requestComplete && sourceOverridesReady
          ? scheduleRequestOverrideKey(project, "installation", installationRequest?.submittedAt || "")
          : null;
        const overrideState = overrideKey ? sourceOverrideState.get(overrideKey) : undefined;
        if (overrideState !== "deleted") payment.push({ id: `pending-payment-installation:${project.id}`, source: "installing", pendingStatus: requestComplete ? "pre_scheduled" : "unscheduled", title: customerName(project), location: customerAddress(project) || "Address required", detail: paymentItemsSummary(project), project, overrideKey, cancelled: overrideState === "cancelled" });
      }
    }
    return payment.sort((left, right) => {
      const statusOrder = Number(left.pendingStatus === "pre_scheduled") - Number(right.pendingStatus === "pre_scheduled");
      return statusOrder || `${left.source}:${left.title}`.localeCompare(`${right.source}:${right.title}`);
    });
  }, [projects, sourceOverrideState, sourceOverridesReady]);

  const visibleEntries = useMemo(() => calendarEntries.filter((entry) => isScheduleFilterMatch(entry.source, filter)), [calendarEntries, filter]);
  const visibleOverdue = useMemo(() => overdueEntries.filter((entry) => isScheduleFilterMatch(entry.source, filter)), [filter, overdueEntries]);
  const visibleUnscheduled = useMemo(() => unscheduledEntries.filter((entry) => isScheduleFilterMatch(entry.source, filter)), [filter, unscheduledEntries]);
  const filterCounts = useMemo(() => Object.fromEntries(FILTERS.map(({ id }) => [
    id,
    calendarEntries.filter((entry) => isScheduleFilterMatch(entry.source, id)).length
      + overdueEntries.filter((entry) => isScheduleFilterMatch(entry.source, id)).length
      + unscheduledEntries.filter((entry) => isScheduleFilterMatch(entry.source, id)).length,
  ])) as Record<ScheduleFilter, number>, [calendarEntries, overdueEntries, unscheduledEntries]);

  useEffect(() => {
    const completedDates = new Set(
      visibleEntries
        .filter((entry) => entry.completed && !entry.cancelled)
        .map((entry) => entry.date),
    );
    setExpandedCompletedDays((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([date, expanded]) => expanded && completedDates.has(date)),
      );
      const currentDates = Object.keys(current);
      const retainedDates = Object.keys(retained);
      return currentDates.length === retainedDates.length
        && currentDates.every((date) => retained[date] === current[date])
        ? current
        : retained;
    });
  }, [visibleEntries]);

  const openInventoryEditor = (group: DeliveryGroup, date?: string) => {
    if (!canManageSchedule) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const primary = group.primary;
    setInventoryEditor({
      group,
      customer: primary.customer,
      phone: primary.phone || "",
      address: primary.address || "",
      plannedDate: date || primary.planned_date || today,
      deliveryTime: primary.delivery_time || "09:00",
      driver: primary.driver || "",
      driverEmail: primary.driver_email || "",
      salesRep: primary.sales_rep,
      note: primary.note || "",
    });
  };

  const openPaymentEditor = (project: ScheduledPaymentProject, kind: PaymentScheduleKind, date?: string) => {
    if (!canManageSchedule) return;
    const hasLegacyFinalSchedule = kind === "delivery" && hasCompletePaymentSchedule(project, "delivery");
    if (kind === "delivery" && !project.deliverySelections.length && !hasLegacyFinalSchedule) {
      setError("Prepare this project's warehouse items in Project Track before scheduling material delivery.");
      return;
    }
    setError("");
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const request = paymentScheduleRequest(project, kind);
    setPaymentEditor({
      project,
      kind,
      date: date || (kind === "delivery" ? project.deliveryScheduledFor : project.installationScheduledFor) || request?.preferredDate || today,
      time: (kind === "delivery" ? project.deliveryScheduledTime : project.installationScheduledTime) || request?.preferredTime || "09:00",
      assignee: (kind === "delivery" ? project.deliveryAssignee : project.installationAssignee) || "",
    });
  };

  const openCustomEditor = (job?: ProjectScheduleJob, date = today) => {
    if (!canManageSchedule) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCustomEditor(job ? {
      job,
      title: job.title,
      scheduledDate: job.scheduledDate,
      startTime: job.startTime || "",
      endTime: job.endTime || "",
      assignee: job.assignee || "",
      location: job.location || "",
      notes: job.notes || "",
    } : emptyCustomEditor(date));
  };

  const refreshAll = async (message?: string) => {
    await load(true);
    if (message) setNotice(message);
  };

  async function reloadPaymentScheduleReview() {
    if (!paymentEditor || busy) return;
    const currentEditor = paymentEditor;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payment-track", { cache: "no-store" });
      const body = await readJsonResponse<PaymentTrackListResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to reload the latest Project Track data."));
      const refreshedProjects = Array.isArray(body.data) ? body.data as ScheduledPaymentProject[] : [];
      const refreshedProject = refreshedProjects.find((project) => project.id === currentEditor.project.id);
      if (!refreshedProject) throw new Error("This Project Track project is no longer available.");
      const request = paymentScheduleRequest(refreshedProject, currentEditor.kind);
      setProjects(refreshedProjects);
      setPaymentEditor({
        project: refreshedProject,
        kind: currentEditor.kind,
        date: (currentEditor.kind === "delivery" ? refreshedProject.deliveryScheduledFor : refreshedProject.installationScheduledFor) || request?.preferredDate || today,
        time: (currentEditor.kind === "delivery" ? refreshedProject.deliveryScheduledTime : refreshedProject.installationScheduledTime) || request?.preferredTime || "09:00",
        assignee: (currentEditor.kind === "delivery" ? refreshedProject.deliveryAssignee : refreshedProject.installationAssignee) || "",
      });
      setNotice("Latest Project Track data loaded. Review the schedule and try again.");
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : "Unable to reload the latest Project Track data.");
    } finally {
      setBusy(false);
    }
  }

  async function closePaymentReviewAndRefresh() {
    if (busy) return;
    closeModalAfterSuccess();
    setError("");
    await refreshAll("Weekly Schedule refreshed from the latest source data.");
  }

  async function saveInventorySchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inventoryEditor || !canManageSchedule) return;
    setBusy(true);
    setError("");
    try {
      const primary = inventoryEditor.group.primary;
      const isPending = primary.status === "pending";
      const payload = isPending ? {
        action: "schedule",
        orderIds: inventoryEditor.group.orders.map((order) => order.id),
        address: inventoryEditor.address,
        plannedDate: inventoryEditor.plannedDate,
        driver: inventoryEditor.driver,
        driverEmail: inventoryEditor.driverEmail,
      } : {
        action: "editTask",
        orderIds: inventoryEditor.group.orders.map((order) => order.id),
        customer: inventoryEditor.customer,
        phone: inventoryEditor.phone,
        address: inventoryEditor.address,
        plannedDate: inventoryEditor.plannedDate,
        deliveryTime: inventoryEditor.deliveryTime,
        driver: inventoryEditor.driver,
        driverEmail: inventoryEditor.driverEmail,
        salesRep: inventoryEditor.salesRep,
        note: inventoryEditor.note,
        items: inventoryEditor.group.orders.map((order) => ({ sku: order.sku, quantity: order.quantity })),
      };
      const response = await fetch("/api/inventory/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to save the Inventory dispatch."));
      closeModalAfterSuccess();
      await refreshAll(isPending ? "Inventory dispatch scheduled." : "Inventory dispatch updated.");
      window.dispatchEvent(new CustomEvent("erp:inventory-updated", { detail: { source: "project-management" } }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the Inventory dispatch.");
    } finally {
      setBusy(false);
    }
  }

  async function inventoryAction(group: DeliveryGroup, action: "deliver" | "cancelOrder" | "cancelDelivery") {
    if (!canManageSchedule || busy) return;
    const label = action === "deliver" ? "mark this Inventory dispatch as delivered" : action === "cancelOrder" ? "delete this Inventory order" : "cancel this Inventory dispatch";
    if (!window.confirm(`Are you sure you want to ${label} for ${group.primary.customer}?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/inventory/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, orderIds: group.orders.map((order) => order.id) }),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to update the Inventory dispatch."));
      closeModalAfterSuccess();
      await refreshAll(action === "deliver" ? "Inventory delivery completed and stock updated." : "Inventory dispatch cancelled.");
      window.dispatchEvent(new CustomEvent("erp:inventory-updated", { detail: { source: "project-management" } }));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update the Inventory dispatch.");
    } finally {
      setBusy(false);
    }
  }

  async function savePaymentSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paymentEditor || !canManageSchedule) return;
    setBusy(true);
    setError("");
    const action = paymentEditor.kind === "delivery" ? "schedule_delivery" : "schedule_installation";
    const dateField = paymentEditor.kind === "delivery" ? "deliveryDate" : "installationDate";
    const timeField = paymentEditor.kind === "delivery" ? "deliveryTime" : "installationTime";
    const assigneeField = paymentEditor.kind === "delivery" ? "deliveryAssignee" : "installationAssignee";
    try {
      const response = await fetch(`/api/payment-track/${paymentEditor.project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          actorRole: "pm",
          expectedUpdatedAt: paymentEditor.project.updatedAt,
          [dateField]: paymentEditor.date,
          [timeField]: paymentEditor.time,
          [assigneeField]: paymentEditor.assignee,
        }),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, `Unable to schedule ${paymentEditor.kind}.`));
      closeModalAfterSuccess();
      await refreshAll(paymentEditor.kind === "delivery" ? "Material delivery scheduled." : "Installment scheduled.");
      window.dispatchEvent(new CustomEvent("erp:payment-track-updated", { detail: { source: "project-management" } }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : `Unable to schedule ${paymentEditor.kind}.`);
    } finally {
      setBusy(false);
    }
  }

  async function completePaymentEntry(entry: Extract<CalendarEntry, { source: "material_delivery" | "installing" }>) {
    if (!canManageSchedule || busy) return;
    const installation = entry.source === "installing";
    if (!window.confirm(`Confirm ${installation ? "installation" : "material delivery"} completion for ${entry.title}?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/payment-track/${entry.project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: installation ? "mark_installed" : "mark_delivered", actorRole: "pm" }),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, `Unable to complete ${installation ? "installation" : "delivery"}.`));
      await refreshAll(installation ? "Installment marked complete." : "Material delivery marked complete.");
      window.dispatchEvent(new CustomEvent("erp:payment-track-updated", { detail: { source: "project-management" } }));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update the Project Track entry.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCustomJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customEditor || !canManageSchedule) return;
    if (!customEditor.startTime && customEditor.endTime) {
      setError("Add a start time before setting an end time.");
      return;
    }
    if (customEditor.startTime && customEditor.endTime && customEditor.endTime <= customEditor.startTime) {
      setError("End time must be later than start time.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = {
        title: customEditor.title.trim(),
        scheduledDate: customEditor.scheduledDate,
        startTime: customEditor.startTime || null,
        endTime: customEditor.endTime || null,
        assignee: customEditor.assignee.trim() || null,
        location: customEditor.location.trim() || null,
        notes: customEditor.notes.trim() || null,
      };
      const response = await fetch(customEditor.job ? `/api/project-schedule/${customEditor.job.id}` : "/api/project-schedule", {
        method: customEditor.job ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to save the custom job."));
      closeModalAfterSuccess();
      await refreshAll(customEditor.job ? "Custom job updated." : "Custom job added to the schedule.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the custom job.");
    } finally {
      setBusy(false);
    }
  }

  async function setCustomJobStatus(job: ProjectScheduleJob, status: ProjectScheduleJob["status"]) {
    if (!canManageSchedule || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/project-schedule/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to update the custom job."));
      closeModalAfterSuccess();
      await refreshAll(status === "completed" ? "Custom job completed." : "Custom job restored to the schedule.");
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Unable to update the custom job.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCustomJob(job: ProjectScheduleJob) {
    if (authenticatedRole !== "admin" || busy || !window.confirm(`Delete “${job.title}”? This cannot be undone.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/project-schedule/${job.id}`, { method: "DELETE" });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to delete the custom job."));
      closeModalAfterSuccess();
      await refreshAll("Custom job deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the custom job.");
    } finally {
      setBusy(false);
    }
  }

  const modalBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeModal();
  };

  const sourceLabel = (source: CalendarEntry["source"] | UnscheduledEntry["source"]) => {
    if (source === "material_delivery") return "Material Delivery";
    if (source === "installing") return "Installment";
    if (source === "inventory") return "Material Delivery";
    if (source === "site_visit") return "Site Visit";
    return "Custom";
  };

  const sourceBadgeClass = (source: CalendarEntry["source"] | UnscheduledEntry["source"]) => {
    const tone = source === "installing"
      ? styles.installingBadge
      : source === "inventory" || source === "material_delivery"
        ? styles.materialDeliveryBadge
        : source === "site_visit"
          ? styles.siteVisitBadge
          : "";
    return `${styles.sourceBadge} ${tone}`;
  };

  async function updateSourceOverride(entry: OverrideableEntry, action: SourceOverrideAction) {
    if (authenticatedRole !== "admin" || !entry.overrideKey || busy) return;
    if (action !== "restore") {
      const prompt = action === "cancel"
        ? `Cancel “${entry.title}” in Weekly Schedule?`
        : `Delete “${entry.title}” from Weekly Schedule?`;
      const effect = action === "cancel"
        ? "This only marks the Weekly Schedule card as cancelled."
        : "This only removes the card from Weekly Schedule.";
      if (!window.confirm(`${prompt}\n\n${effect} It will not delete or change Inventory, Project Track, payments, or attachments.`)) return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/project-schedule/entries/${encodeURIComponent(entry.overrideKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiMessage(body.error, "Unable to update this Weekly Schedule card."));
      const message = action === "cancel"
        ? `${sourceLabel(entry.source)} cancelled in Weekly Schedule.`
        : action === "restore"
          ? `${sourceLabel(entry.source)} restored in Weekly Schedule.`
          : `${sourceLabel(entry.source)} removed from Weekly Schedule.`;
      await refreshAll(message);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update this Weekly Schedule card.");
    } finally {
      setBusy(false);
    }
  }

  const renderSourceOverrideActions = (entry: OverrideableEntry) => authenticatedRole === "admin" && entry.overrideKey ? (
    <>
      <button
        type="button"
        className={entry.cancelled ? styles.scheduleRestoreButton : styles.scheduleCancelButton}
        onClick={() => void updateSourceOverride(entry, entry.cancelled ? "restore" : "cancel")}
        disabled={busy}
        aria-label={`${entry.cancelled ? "Restore" : "Cancel"} ${entry.title} in Weekly Schedule`}
      >
        {entry.cancelled ? <RotateCcw size={13} /> : <X size={13} />}{entry.cancelled ? "Restore" : "Cancel"}
      </button>
      <button
        type="button"
        className={styles.scheduleDeleteButton}
        onClick={() => void updateSourceOverride(entry, "delete")}
        disabled={busy}
        aria-label={`Delete ${entry.title} from Weekly Schedule`}
      >
        <Trash2 size={13} />Delete
      </button>
    </>
  ) : null;

  const renderEntryActions = (entry: CalendarEntry) => (
    <>
      {canManageSchedule && entry.source === "inventory" && !entry.completed && !entry.cancelled ? (
        <>
          <button type="button" onClick={() => openInventoryEditor(entry.group)} disabled={busy}><Pencil size={13} /> Edit</button>
          <button type="button" className={styles.primaryInline} onClick={() => void inventoryAction(entry.group, "deliver")} disabled={busy}><CheckCircle2 size={13} /> Delivered</button>
        </>
      ) : null}
      {canManageSchedule && (entry.source === "material_delivery" || entry.source === "installing") && !entry.completed && !entry.cancelled ? (
        <>
          <button type="button" onClick={() => openPaymentEditor(entry.project, entry.source === "installing" ? "installation" : "delivery")} disabled={busy}><Pencil size={13} /> Reschedule</button>
          <button type="button" className={styles.primaryInline} onClick={() => void completePaymentEntry(entry)} disabled={busy}><CheckCircle2 size={13} /> {entry.source === "installing" ? "Installed" : "Delivered"}</button>
        </>
      ) : null}
      {canManageSchedule && entry.source === "custom" ? <button type="button" onClick={() => openCustomEditor(entry.job)} disabled={busy}><Pencil size={13} /> Details</button> : null}
      {entry.source !== "custom" ? renderSourceOverrideActions(entry) : null}
    </>
  );

  const renderUnscheduledEntry = (entry: UnscheduledEntry) => {
    const kind = entry.source === "installing" ? "installation" : "delivery";
    const request = paymentScheduleRequest(entry.project, kind);
    const canReview = entry.pendingStatus === "pre_scheduled";
    return (
      <article key={entry.id} className={`${styles.unscheduledCard} ${entry.cancelled ? styles.cancelledCard : ""}`}>
        <div>
          <div className={styles.cardTopline}>
            <span className={sourceBadgeClass(entry.source)}>{sourceLabel(entry.source)}</span>
            {entry.cancelled
              ? <span className={styles.cancelledBadge}><X size={12} /> Cancelled</span>
              : canReview
                ? <span className={styles.preScheduledBadge}><Clock3 size={12} /> Pre-scheduled</span>
                : <span className={styles.unscheduledBadge}><AlertCircle size={12} /> Unscheduled</span>}
          </div>
          <h3>{entry.title}</h3>
          <p><MapPin size={13} />{entry.location}</p>
          {canReview && request ? (
            <div className={styles.requestPreview}>
              <span><CalendarDays size={13} /><strong>Preferred</strong>{shortDate(request.preferredDate)} · {timeLabel(request.preferredTime)}</span>
              <span><UserRound size={13} /><strong>Sales</strong>{request.submittedBy}</span>
              {request.notes ? <small title={request.notes}>{request.notes}</small> : null}
            </div>
          ) : (
            <div className={styles.awaitingSales}>
              <AlertCircle size={14} />
              <strong>Waiting for Sales</strong>
            </div>
          )}
          <small>{entry.detail}</small>
        </div>
        {(canManageSchedule && canReview && !entry.cancelled)
          || (authenticatedRole === "admin" && Boolean(entry.overrideKey)) ? (
          <div className={styles.unscheduledActions}>
            {canManageSchedule && canReview && !entry.cancelled ? (
              <button
                type="button"
                onClick={() => openPaymentEditor(entry.project, kind)}
                disabled={busy}
              >
                <CalendarCheck2 size={14} /> Review &amp; schedule
              </button>
            ) : null}
            {renderSourceOverrideActions(entry)}
          </div>
        ) : null}
      </article>
    );
  };

  const renderCalendarEntry = (entry: CalendarEntry) => (
    <article key={entry.id} className={`${styles.scheduleCard} ${styles[entry.source]} ${entry.completed && !entry.cancelled ? styles.completedCard : ""} ${entry.cancelled ? styles.cancelledCard : ""}`}>
      <div className={styles.cardTopline}>
        <span className={sourceBadgeClass(entry.source)}>{sourceLabel(entry.source)}</span>
        {entry.cancelled
          ? <span className={styles.cancelledBadge}><X size={12} /> Cancelled</span>
          : entry.completed
            ? <span className={styles.completedBadge}><Check size={12} /> Complete</span>
            : entry.source === "site_visit" && entry.visit.status === "in_progress"
              ? <span className={styles.inProgressBadge}><Wrench size={12} /> In progress</span>
              : <span className={styles.scheduledBadge}><CalendarCheck2 size={12} /> Scheduled</span>}
      </div>
      <h3>{entry.title}</h3>
      <p><MapPin size={13} />{entry.location}</p>
      <div className={styles.cardMeta}>
        <span><Clock3 size={13} />{entry.time ? timeLabel(entry.time) : "All day"}</span>
        <span><UserRound size={13} />{entry.assignee}</span>
      </div>
      <small>{entry.detail}</small>
      <div className={styles.cardButtons}>{renderEntryActions(entry)}</div>
    </article>
  );

  return (
    <section className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div>
          <h1 ref={scheduleHeadingRef} id="project-schedule-title" tabIndex={-1}>Weekly Schedule</h1>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.viewToggle} role="group" aria-label="Schedule view">
            <button type="button" className={view === "calendar" ? styles.activeView : ""} onClick={() => setView("calendar")} aria-pressed={view === "calendar"} title="Calendar view"><CalendarDays size={16} /><span>Calendar</span></button>
            <button type="button" className={view === "list" ? styles.activeView : ""} onClick={() => setView("list")} aria-pressed={view === "list"} title="List view"><List size={16} /><span>List</span></button>
          </div>
          <button type="button" className={styles.secondaryButton} onClick={() => void load(true)} disabled={refreshing || busy}>
            <RefreshCw size={16} className={refreshing ? styles.spinning : ""} /> Refresh
          </button>
          {canManageSchedule ? (
            <button type="button" className={styles.addButton} onClick={() => openCustomEditor()} disabled={busy}>
              <Plus size={17} /> Add Job
            </button>
          ) : null}
        </div>
      </header>

      <div className={`${styles.scheduleFrame} ${view === "calendar" ? styles.calendarScheduleFrame : ""}`}>
      {view === "calendar" ? (
        <aside className={styles.unscheduledRail} aria-labelledby="unscheduled-column-title">
          <header>
            <div><Clock3 size={16} /><strong id="unscheduled-column-title">Pending Schedule</strong></div>
            <span>{visibleUnscheduled.length}</span>
          </header>
          <div className={styles.unscheduledRailEntries}>
            {visibleUnscheduled.map(renderUnscheduledEntry)}
            {!visibleUnscheduled.length ? <div className={styles.emptyDay}>No pending Project Track jobs</div> : null}
          </div>
        </aside>
      ) : null}
      <div className={styles.scheduleMain}>

      <div className={styles.weekToolbar}>
        <div className={styles.weekNavigation} aria-label="Week navigation">
          <button type="button" onClick={() => setWeekStart((current) => addIsoDays(current, -7))} aria-label="Previous week"><ChevronLeft size={18} /></button>
          <button type="button" onClick={() => setWeekStart(weekStartFor(melbourneToday()))}>Today</button>
          <button type="button" onClick={() => setWeekStart((current) => addIsoDays(current, 7))} aria-label="Next week"><ChevronRight size={18} /></button>
        </div>
        <strong>{weekRangeLabel(weekStart, weekEnd)}</strong>
        <div className={styles.toolbarStatus}>
          {futureCount > 0 ? <button type="button" onClick={() => setWeekStart((current) => addIsoDays(current, 7))}>{futureCount} future <ChevronRight size={14} /></button> : null}
          <span className={styles.timezone}><Clock3 size={14} /> Melbourne time</span>
        </div>
      </div>

      <div className={styles.filterBar} role="group" aria-label="Filter schedule jobs">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filter === item.id ? styles.activeFilter : ""}
            onClick={() => setFilter(item.id)}
            aria-pressed={filter === item.id}
          >
            {item.label}<span>{filterCounts[item.id]}</span>
          </button>
        ))}
      </div>

      {error ? <div className={styles.errorBanner} role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => void load()}>Retry</button></div> : null}
      {sourceWarnings.length && !error ? <div className={styles.warningBanner} role="status"><AlertCircle size={17} /><span>{sourceWarnings.join(" ")} Showing the other available sources.</span><button type="button" onClick={() => void load(true)}>Retry</button></div> : null}
      {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15} /></button></div> : null}

      {visibleOverdue.length ? (
        <section className={`${styles.traySection} ${styles.overdueSection}`} aria-labelledby="overdue-title">
          <header>
            <div><AlertCircle size={18} /><h2 id="overdue-title">Overdue</h2><span>{visibleOverdue.length}</span></div>
          </header>
          <div className={styles.trayList}>{visibleOverdue.map(renderCalendarEntry)}</div>
        </section>
      ) : null}

      {view === "list" ? (
        <section className={styles.traySection} aria-labelledby="unscheduled-title">
          <header>
            <div><Clock3 size={18} /><h2 id="unscheduled-title">Pending Schedule</h2><span>{visibleUnscheduled.length}</span></div>
          </header>
          <div className={styles.trayList}>
            {visibleUnscheduled.map(renderUnscheduledEntry)}
            {!visibleUnscheduled.length ? <div className={styles.emptyTray}><CalendarCheck2 size={20} /> No pending Project Track jobs in this view</div> : null}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className={styles.loading}><LoaderCircle size={27} className={styles.spinning} /> Loading weekly schedule…</div>
      ) : view === "calendar" ? (
        <div className={styles.calendarScroller}>
          <div className={styles.calendarGrid} role="region" aria-labelledby="project-schedule-title">
            {days.map((day) => {
              const entries = visibleEntries.filter((entry) => entry.date === day);
              const activeEntries = entries.filter((entry) => !entry.completed || entry.cancelled);
              const completedEntries = entries.filter((entry) => entry.completed && !entry.cancelled);
              const completedExpanded = Boolean(expandedCompletedDays[day]);
              const completedRegionId = `completed-schedule-${day}`;
              const isToday = day === today;
              const canAddToDay = canManageSchedule && day >= today;
              return (
                <section key={day} className={`${styles.dayColumn} ${isToday ? styles.todayColumn : ""}`} aria-labelledby={`schedule-day-${day}`}>
                  <header>
                    <div><span>{dayLabel(day)}</span><strong id={`schedule-day-${day}`}>{dateNumber(day)}</strong></div>
                    {isToday ? <small>Today</small> : <span>{entries.length}</span>}
                  </header>
                  <div className={styles.dayEntries}>
                    {completedEntries.length ? (
                      <div className={styles.completedDayGroup}>
                        <button
                          type="button"
                          className={styles.completedDayToggle}
                          aria-expanded={completedExpanded}
                          aria-controls={completedRegionId}
                          aria-label={`${completedExpanded ? "Collapse" : "Expand"} ${completedEntries.length} completed ${completedEntries.length === 1 ? "job" : "jobs"} for ${dayLabel(day)} ${shortDate(day)}`}
                          onClick={() => setExpandedCompletedDays((current) => ({ ...current, [day]: !current[day] }))}
                        >
                          <span className={styles.completedDayToggleLabel}><CheckCircle2 size={15} aria-hidden="true" /> Completed</span>
                          <span className={styles.completedDayCount}>{completedEntries.length}</span>
                          <ChevronRight className={completedExpanded ? styles.completedDayChevronExpanded : styles.completedDayChevron} size={16} aria-hidden="true" />
                        </button>
                        <div id={completedRegionId} className={styles.completedDayEntries} hidden={!completedExpanded}>
                          {completedEntries.map(renderCalendarEntry)}
                        </div>
                      </div>
                    ) : null}
                    {activeEntries.map(renderCalendarEntry)}
                    {!entries.length ? <div className={styles.emptyDay}>No jobs</div> : null}
                    {canAddToDay ? <button type="button" className={styles.quickAdd} onClick={() => openCustomEditor(undefined, day)}><Plus size={14} /> Add job</button> : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={styles.scheduleListScroller} role="region" aria-label={`Weekly Schedule list for ${weekRangeLabel(weekStart, weekEnd)}`} tabIndex={0}>
          <table className={styles.scheduleList}>
            <caption className={styles.visuallyHidden}>Scheduled jobs from {weekRangeLabel(weekStart, weekEnd)}</caption>
            <thead>
              <tr><th>Date</th><th>Time</th><th>Project or customer</th><th>Type</th><th>Location</th><th>Assigned to</th><th>Status</th><th><span className={styles.visuallyHidden}>Actions</span></th></tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => (
                <tr key={entry.id} className={`${styles.listRow} ${styles[entry.source]} ${entry.completed && !entry.cancelled ? styles.completedListRow : ""} ${entry.cancelled ? styles.cancelledListRow : ""}`}>
                  <td data-label="Date"><strong>{dayLabel(entry.date)}</strong><span>{shortDate(entry.date)}</span></td>
                  <td data-label="Time">{entry.time ? timeLabel(entry.time) : "All day"}</td>
                  <td data-label="Project or customer"><strong>{entry.title}</strong><small>{entry.detail}</small></td>
                  <td data-label="Type"><span className={sourceBadgeClass(entry.source)}>{sourceLabel(entry.source)}</span></td>
                  <td data-label="Location"><span className={styles.listValue}><MapPin size={13} />{entry.location}</span></td>
                  <td data-label="Assigned to"><span className={styles.listValue}><UserRound size={13} />{entry.assignee}</span></td>
                  <td data-label="Status">{entry.cancelled
                    ? <span className={styles.cancelledBadge}><X size={12} /> Cancelled</span>
                    : entry.completed
                      ? <span className={styles.completedBadge}><Check size={12} /> Complete</span>
                      : entry.source === "site_visit" && entry.visit.status === "in_progress"
                        ? <span className={styles.inProgressBadge}><Wrench size={12} /> In progress</span>
                        : <span className={styles.scheduledBadge}><CalendarCheck2 size={12} /> Scheduled</span>}</td>
                  <td data-label="Actions"><div className={`${styles.cardButtons} ${styles.listActions}`}>{renderEntryActions(entry)}</div></td>
                </tr>
              ))}
              {!visibleEntries.length ? <tr><td className={styles.emptyList} colSpan={8}><CalendarDays size={20} />No scheduled jobs in this week for this filter</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      </div>
      </div>

      {inventoryEditor ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={modalBackdropClick}>
          <form ref={modalRef} className={styles.modal} onSubmit={saveInventorySchedule} role="dialog" aria-modal="true" aria-labelledby="inventory-editor-title">
            <header>
              <div><span>Material Delivery</span><h2 id="inventory-editor-title">{inventoryEditor.group.primary.status === "pending" ? "Schedule Delivery" : "Edit Delivery"}</h2></div>
              <button type="button" onClick={closeModal} disabled={busy} aria-label="Close"><X size={19} /></button>
            </header>
            <div className={styles.modalBody}>
              <div className={styles.formGrid}>
                <label>Customer<input value={inventoryEditor.customer} onChange={(event) => setInventoryEditor({ ...inventoryEditor, customer: event.target.value })} readOnly={inventoryEditor.group.primary.status === "pending"} required /></label>
                <label>Phone<input value={inventoryEditor.phone} onChange={(event) => setInventoryEditor({ ...inventoryEditor, phone: event.target.value })} readOnly={inventoryEditor.group.primary.status === "pending"} /></label>
                <label className={styles.spanTwo}>Delivery address<input value={inventoryEditor.address} onChange={(event) => setInventoryEditor({ ...inventoryEditor, address: event.target.value })} required /></label>
                <label>Delivery date<input type="date" value={inventoryEditor.plannedDate} onChange={(event) => setInventoryEditor({ ...inventoryEditor, plannedDate: event.target.value })} required /></label>
                <label>Arrival time<input type="time" value={inventoryEditor.deliveryTime} onChange={(event) => setInventoryEditor({ ...inventoryEditor, deliveryTime: event.target.value })} disabled={inventoryEditor.group.primary.status === "pending"} /></label>
                <label>Driver<input value={inventoryEditor.driver} onChange={(event) => setInventoryEditor({ ...inventoryEditor, driver: event.target.value })} required /></label>
                <label>Driver email<span className={styles.iconInput}><Mail size={15} /><input type="email" value={inventoryEditor.driverEmail} onChange={(event) => setInventoryEditor({ ...inventoryEditor, driverEmail: event.target.value })} required /></span></label>
                <label className={styles.spanTwo}>Delivery notes<textarea rows={3} value={inventoryEditor.note} onChange={(event) => setInventoryEditor({ ...inventoryEditor, note: event.target.value })} readOnly={inventoryEditor.group.primary.status === "pending"} /></label>
              </div>
              <div className={styles.itemSummary}>
                <strong>Delivery items</strong>
                {inventoryEditor.group.orders.map((order) => <span key={order.id}>{order.sku}<b>× {order.quantity}</b></span>)}
              </div>
            </div>
            <footer>
              <button type="button" className={styles.dangerButton} onClick={() => void inventoryAction(inventoryEditor.group, inventoryEditor.group.primary.status === "pending" ? "cancelOrder" : "cancelDelivery")} disabled={busy}>{inventoryEditor.group.primary.status === "pending" ? "Delete Order" : "Cancel Delivery"}</button>
              <span />
              <button type="button" className={styles.secondaryButton} onClick={closeModal} disabled={busy}>Cancel</button>
              <button type="submit" className={styles.addButton} disabled={busy}>{busy ? <LoaderCircle size={16} className={styles.spinning} /> : <CalendarDays size={16} />} Save Schedule</button>
            </footer>
          </form>
        </div>
      ) : null}

      {paymentEditor ? (() => {
        const request = paymentScheduleRequest(paymentEditor.project, paymentEditor.kind);
        const scheduleLabel = paymentEditor.kind === "delivery" ? "Material Delivery" : "Installment";
        const finalScheduleComplete = hasCompletePaymentSchedule(paymentEditor.project, paymentEditor.kind);
        return (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={modalBackdropClick}>
          <form ref={modalRef} className={`${styles.modal} ${styles.compactModal}`} onSubmit={savePaymentSchedule} role="dialog" aria-modal="true" aria-labelledby="payment-editor-title">
            <header>
              <div><span>Project Track · {paymentEditor.project.reference}</span><h2 id="payment-editor-title">Review &amp; Schedule {scheduleLabel}</h2></div>
              <button type="button" onClick={closeModal} disabled={busy} aria-label="Close"><X size={19} /></button>
            </header>
            <div className={styles.modalBody}>
              <div className={styles.projectSummary}>
                <span className={styles.projectIcon}>{paymentEditor.kind === "delivery" ? <Truck size={20} /> : <Wrench size={20} />}</span>
                <div><strong>{customerName(paymentEditor.project)}</strong><span><MapPin size={13} />{customerAddress(paymentEditor.project) || "Address required"}</span></div>
              </div>
              {error ? (
                <div className={styles.modalError} role="alert">
                  <AlertCircle size={18} />
                  <div className={styles.modalErrorCopy}>
                    <strong>Schedule was not saved</strong>
                    <span>{error}</span>
                  </div>
                  <div className={styles.modalErrorActions}>
                    <button type="button" onClick={() => void reloadPaymentScheduleReview()} disabled={busy}>
                      <RefreshCw size={13} className={busy ? styles.spinning : ""} /> Reload latest
                    </button>
                    <button type="button" onClick={() => void closePaymentReviewAndRefresh()} disabled={busy}>Close &amp; refresh</button>
                  </div>
                </div>
              ) : null}
              <section className={styles.scheduleRequestPanel} aria-label="Sales scheduling preference">
                <div className={styles.scheduleRequestHeader}>
                  <div><strong>Sales preference</strong></div>
                  {finalScheduleComplete
                    ? <span className={styles.scheduledBadge}><CalendarCheck2 size={12} /> Scheduled</span>
                    : request
                      ? <span className={styles.preScheduledBadge}><Clock3 size={12} /> Pre-scheduled</span>
                      : null}
                </div>
                {request ? (
                  <>
                    <dl className={styles.scheduleRequestDetails}>
                      <div><dt>Preferred date</dt><dd>{shortDate(request.preferredDate)}</dd></div>
                      <div><dt>Preferred time</dt><dd>{timeLabel(request.preferredTime)}</dd></div>
                      <div><dt>Submitted by</dt><dd>{request.submittedBy}</dd></div>
                      <div><dt>Submitted</dt><dd>{submittedAtLabel(request.submittedAt)}</dd></div>
                    </dl>
                    <div className={styles.scheduleRequestNotes}>
                      <strong>Sales notes</strong>
                      <p>{request.notes || "No notes provided."}</p>
                    </div>
                  </>
                ) : (
                  <p className={styles.legacyScheduleNotice}>No Sales preference was recorded for this existing schedule.</p>
                )}
              </section>
              {paymentEditor.kind === "delivery" ? (
                <div className={styles.scheduleItemComparison}>
                  <div className={styles.itemSummary}>
                    <strong>Chosen warehouse SKUs</strong>
                    {paymentEditor.project.deliverySelections.length
                      ? paymentEditor.project.deliverySelections.map((item) => <span key={item.sku}>{item.sku}<b>× {item.quantity}</b></span>)
                      : <span>No warehouse SKUs chosen</span>}
                  </div>
                  <div className={styles.itemSummary}>
                    <strong>Order items</strong>
                    {paymentEditor.project.items.length ? paymentEditor.project.items.map((item, index) => (
                      <span key={item.id}>{paymentItemLabel(paymentEditor.project, index)}<b>× {item.quantity}</b></span>
                    )) : <span>No items listed</span>}
                  </div>
                </div>
              ) : (
                <div className={styles.itemSummary}>
                  <strong>Order items</strong>
                  {paymentEditor.project.items.length ? paymentEditor.project.items.map((item, index) => (
                    <span key={item.id}>{paymentItemLabel(paymentEditor.project, index)}<b>× {item.quantity}</b></span>
                  )) : <span>No items listed</span>}
                </div>
              )}
              <div className={styles.scheduleConfirmationHeading}>
                <strong>PM confirmation</strong>
              </div>
              <div className={styles.paymentScheduleFields}>
                <label className={styles.singleField}>{paymentEditor.kind === "delivery" ? "Delivery date" : "Installment date"}<input type="date" value={paymentEditor.date} onChange={(event) => setPaymentEditor({ ...paymentEditor, date: event.target.value })} required /></label>
                <label className={styles.singleField}>{paymentEditor.kind === "delivery" ? "Delivery time" : "Installment time"}<input type="time" value={paymentEditor.time} onChange={(event) => setPaymentEditor({ ...paymentEditor, time: event.target.value })} required /></label>
                <label className={`${styles.singleField} ${styles.paymentAssigneeField}`}>
                  {paymentEditor.kind === "delivery" ? "Delivery person" : "Installer"}
                  <select value={paymentEditor.assignee} onChange={(event) => setPaymentEditor({ ...paymentEditor, assignee: event.target.value as PaymentTrackScheduleAssignee | "" })} required>
                    <option value="">Choose Leo or Daniel</option>
                    {PAYMENT_TRACK_SCHEDULE_ASSIGNEES.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <footer>
              <span /><span />
              <button type="button" className={styles.secondaryButton} onClick={closeModal} disabled={busy}>Cancel</button>
              <button type="submit" className={styles.addButton} disabled={busy || !paymentEditor.date || !paymentEditor.time || !paymentEditor.assignee}>{busy ? <LoaderCircle size={16} className={styles.spinning} /> : <CalendarCheck2 size={16} />} Save Schedule</button>
            </footer>
          </form>
        </div>
        );
      })() : null}

      {customEditor ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={modalBackdropClick}>
          <form ref={modalRef} className={styles.modal} onSubmit={saveCustomJob} role="dialog" aria-modal="true" aria-labelledby="custom-editor-title">
            <header>
              <div><span>Custom Schedule</span><h2 id="custom-editor-title">{customEditor.job ? "Edit Job" : "Add Job"}</h2></div>
              <button type="button" onClick={closeModal} disabled={busy} aria-label="Close"><X size={19} /></button>
            </header>
            <div className={styles.modalBody}>
              <div className={styles.formGrid}>
                <label className={styles.spanTwo}>Job title<input value={customEditor.title} onChange={(event) => setCustomEditor({ ...customEditor, title: event.target.value })} maxLength={160} required /></label>
                <label>Date<input type="date" value={customEditor.scheduledDate} onChange={(event) => setCustomEditor({ ...customEditor, scheduledDate: event.target.value })} required /></label>
                <label>Assignee<input value={customEditor.assignee} onChange={(event) => setCustomEditor({ ...customEditor, assignee: event.target.value })} maxLength={120} /></label>
                <label>Start time<input type="time" value={customEditor.startTime} onChange={(event) => setCustomEditor({ ...customEditor, startTime: event.target.value, endTime: event.target.value ? customEditor.endTime : "" })} /></label>
                <label>End time<input type="time" value={customEditor.endTime} onChange={(event) => setCustomEditor({ ...customEditor, endTime: event.target.value })} disabled={!customEditor.startTime} /></label>
                <label className={styles.spanTwo}>Location<input value={customEditor.location} onChange={(event) => setCustomEditor({ ...customEditor, location: event.target.value })} maxLength={240} /></label>
                <label className={styles.spanTwo}>Notes<textarea rows={4} value={customEditor.notes} onChange={(event) => setCustomEditor({ ...customEditor, notes: event.target.value })} maxLength={2000} /></label>
              </div>
            </div>
            <footer>
              {customEditor.job ? (
                <div className={styles.jobActions}>
                  {authenticatedRole === "admin" ? <button type="button" className={styles.dangerButton} onClick={() => void deleteCustomJob(customEditor.job as ProjectScheduleJob)} disabled={busy}><Trash2 size={15} /> Delete</button> : null}
                  <button type="button" className={styles.statusButton} onClick={() => void setCustomJobStatus(customEditor.job as ProjectScheduleJob, customEditor.job?.status === "completed" ? "scheduled" : "completed")} disabled={busy}>
                    {customEditor.job.status === "completed" ? <RotateCcw size={15} /> : <CheckCircle2 size={15} />}{customEditor.job.status === "completed" ? "Restore" : "Complete"}
                  </button>
                </div>
              ) : <span />}
              <span />
              <button type="button" className={styles.secondaryButton} onClick={closeModal} disabled={busy}>Cancel</button>
              <button type="submit" className={styles.addButton} disabled={busy}>{busy ? <LoaderCircle size={16} className={styles.spinning} /> : <CalendarCheck2 size={16} />} {customEditor.job ? "Save Changes" : "Add Job"}</button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
