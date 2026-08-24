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
import type { PaymentTrackListResponse, PaymentTrackProject } from "@/lib/payment-track/types";
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

type ScheduleFilter = "all" | "material_delivery" | "installing" | "inventory" | "custom";
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
type PaymentEditorState = { project: ScheduledPaymentProject; kind: PaymentScheduleKind; date: string };
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

type CalendarEntry =
  | { id: string; source: "inventory"; date: string; time: string | null; title: string; location: string; assignee: string; detail: string; completed: boolean; group: DeliveryGroup }
  | { id: string; source: "material_delivery" | "installing"; date: string; time: null; title: string; location: string; assignee: string; detail: string; completed: boolean; project: ScheduledPaymentProject }
  | { id: string; source: "custom"; date: string; time: string | null; title: string; location: string; assignee: string; detail: string; completed: boolean; job: ProjectScheduleJob };

type UnscheduledEntry =
  | { id: string; source: "inventory"; title: string; location: string; detail: string; group: DeliveryGroup }
  | { id: string; source: "material_delivery" | "installing"; title: string; location: string; detail: string; project: ScheduledPaymentProject };

const MELBOURNE_TIME_ZONE = "Australia/Melbourne";
const EMPTY_OPERATIONS: OperationsState = { orders: [], deliveryHistory: [] };
const FILTERS: Array<{ id: ScheduleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "material_delivery", label: "Material Delivery" },
  { id: "installing", label: "Installing" },
  { id: "inventory", label: "Inventory Dispatch" },
  { id: "custom", label: "Custom" },
];

function apiMessage(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return /\p{Script=Han}/u.test(value) ? fallback : value;
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
  return filter === "all" || source === filter;
}

function emptyCustomEditor(date: string): CustomEditorState {
  return { job: null, title: "", scheduledDate: date, startTime: "09:00", endTime: "10:00", assignee: "", location: "", notes: "" };
}

export function ProjectDeliveryBoard() {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(melbourneToday()));
  const [operations, setOperations] = useState<OperationsState>(EMPTY_OPERATIONS);
  const [projects, setProjects] = useState<ScheduledPaymentProject[]>([]);
  const [customJobs, setCustomJobs] = useState<ProjectScheduleJob[]>([]);
  const [filter, setFilter] = useState<ScheduleFilter>("all");
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

  const weekEnd = addIsoDays(weekStart, 6);
  const today = melbourneToday();
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addIsoDays(weekStart, index)), [weekStart]);

  const load = useCallback(async (quiet = false) => {
    const requestId = ++loadRequestRef.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    const requests = await Promise.allSettled([
      fetch("/api/inventory/operations", { cache: "no-store" }).then(async (response) => ({ response, body: await response.json() as OperationsState & { error?: string } })),
      fetch("/api/payment-track", { cache: "no-store" }).then(async (response) => ({ response, body: await response.json() as PaymentTrackListResponse & { error?: string } })),
      fetch(`/api/project-schedule?from=${encodeURIComponent(addIsoDays(weekStart, -90))}&to=${encodeURIComponent(addIsoDays(weekStart, 96))}`, { cache: "no-store" }).then(async (response) => ({ response, body: await response.json() as { data?: { jobs?: ProjectScheduleJob[] }; error?: string } })),
    ]);
    if (requestId !== loadRequestRef.current) return;
    const warnings: string[] = [];
    let successfulSources = 0;
    const [inventoryResult, paymentResult, customResult] = requests;
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
      warnings.push("Payment Track projects could not be refreshed.");
    }
    if (customResult.status === "fulfilled" && customResult.value.response.ok) {
      successfulSources += 1;
      setCustomJobs(Array.isArray(customResult.value.body.data?.jobs) ? customResult.value.body.data.jobs : []);
    } else {
      setCustomJobs([]);
      warnings.push("Custom schedule jobs could not be refreshed.");
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
    return () => {
      loadRequestRef.current += 1;
      window.removeEventListener("erp:inventory-updated", refresh);
      window.removeEventListener("erp:payment-track-updated", refresh);
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

  const unscheduledInventoryGroups = useMemo(
    () => groupOrders(operations.orders.filter((order) => order.status === "pending" || (order.status === "scheduled" && !order.planned_date))),
    [operations.orders],
  );
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

  const allDatedEntries = useMemo<CalendarEntry[]>(() => {
    const inventoryEntries: CalendarEntry[] = [...scheduledInventoryGroups, ...completedInventoryGroups]
      .filter((group) => Boolean(group.primary.planned_date || melbourneDateFromTimestamp(group.primary.delivered_at)))
      .map((group) => ({
        id: `inventory:${group.key}:${group.primary.status}`,
        source: "inventory",
        date: (group.primary.planned_date || melbourneDateFromTimestamp(group.primary.delivered_at)) as string,
        time: group.primary.delivery_time,
        title: group.primary.customer,
        location: group.primary.address || "Address required",
        assignee: group.primary.driver || "Driver not assigned",
        detail: `${group.orders.length} ${group.orders.length === 1 ? "item" : "items"}`,
        completed: group.primary.status === "delivered",
        group,
      }));
    const paymentEntries: CalendarEntry[] = [];
    for (const project of projects) {
      const deliveryDate = project.deliveryScheduledFor || melbourneDateFromTimestamp(project.deliveredAt);
      const isActiveDelivery = project.stage === "material_delivery" && !project.deliveredAt;
      if (deliveryDate && (isActiveDelivery || project.deliveredAt)) {
        paymentEntries.push({
          id: `payment-delivery:${project.id}`,
          source: "material_delivery",
          date: deliveryDate,
          time: null,
          title: customerName(project),
          location: customerAddress(project) || "Address required",
          assignee: "Project Manager",
          detail: `${project.reference} · ${project.items.length} ${project.items.length === 1 ? "item" : "items"}`,
          completed: Boolean(project.deliveredAt),
          project,
        });
      }
      const installationDate = project.installationScheduledFor || melbourneDateFromTimestamp(project.installedAt);
      const isActiveInstallation = project.stage === "installing" && !project.installedAt;
      if (installationDate && (isActiveInstallation || project.installedAt)) {
        paymentEntries.push({
          id: `payment-installation:${project.id}`,
          source: "installing",
          date: installationDate,
          time: null,
          title: customerName(project),
          location: customerAddress(project) || "Address required",
          assignee: "Project Manager",
          detail: `${project.reference} · Installation`,
          completed: Boolean(project.installedAt),
          project,
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
    }));
    return [...inventoryEntries, ...paymentEntries, ...customEntries]
      .sort((left, right) => `${left.date}:${left.time || "99:99"}:${left.title}`.localeCompare(`${right.date}:${right.time || "99:99"}:${right.title}`));
  }, [completedInventoryGroups, customJobs, projects, scheduledInventoryGroups]);

  const calendarEntries = useMemo(
    () => allDatedEntries.filter((entry) => entry.date >= weekStart && entry.date <= weekEnd),
    [allDatedEntries, weekEnd, weekStart],
  );
  const overdueEntries = useMemo(
    () => allDatedEntries.filter((entry) => !entry.completed && entry.date < weekStart),
    [allDatedEntries, weekStart],
  );
  const futureCount = useMemo(
    () => allDatedEntries.filter((entry) => !entry.completed && entry.date > weekEnd).length,
    [allDatedEntries, weekEnd],
  );

  const unscheduledEntries = useMemo<UnscheduledEntry[]>(() => {
    const inventory: UnscheduledEntry[] = unscheduledInventoryGroups.map((group) => ({
      id: `pending-inventory:${group.key}`,
      source: "inventory",
      title: group.primary.customer,
      location: group.primary.address || "Address required",
      detail: group.primary.status === "pending"
        ? `${group.orders.length} ${group.orders.length === 1 ? "item" : "items"} · From ${group.primary.sales_rep}`
        : `${group.orders.length} ${group.orders.length === 1 ? "item" : "items"} · Schedule date missing`,
      group,
    }));
    const payment: UnscheduledEntry[] = [];
    for (const project of projects) {
      if (project.stage === "material_delivery" && !project.deliveredAt && !project.deliveryScheduledFor) {
        payment.push({ id: `pending-payment-delivery:${project.id}`, source: "material_delivery", title: customerName(project), location: customerAddress(project) || "Address required", detail: `${project.reference} · Schedule material delivery`, project });
      }
      if (project.stage === "installing" && !project.installedAt && !project.installationScheduledFor) {
        payment.push({ id: `pending-payment-installation:${project.id}`, source: "installing", title: customerName(project), location: customerAddress(project) || "Address required", detail: `${project.reference} · Schedule installation`, project });
      }
    }
    return [...inventory, ...payment];
  }, [projects, unscheduledInventoryGroups]);

  const visibleEntries = useMemo(() => calendarEntries.filter((entry) => isScheduleFilterMatch(entry.source, filter)), [calendarEntries, filter]);
  const visibleOverdue = useMemo(() => overdueEntries.filter((entry) => isScheduleFilterMatch(entry.source, filter)), [filter, overdueEntries]);
  const visibleUnscheduled = useMemo(() => unscheduledEntries.filter((entry) => isScheduleFilterMatch(entry.source, filter)), [filter, unscheduledEntries]);
  const filterCounts = useMemo(() => Object.fromEntries(FILTERS.map(({ id }) => [
    id,
    calendarEntries.filter((entry) => isScheduleFilterMatch(entry.source, id)).length
      + overdueEntries.filter((entry) => isScheduleFilterMatch(entry.source, id)).length
      + unscheduledEntries.filter((entry) => isScheduleFilterMatch(entry.source, id)).length,
  ])) as Record<ScheduleFilter, number>, [calendarEntries, overdueEntries, unscheduledEntries]);

  const openInventoryEditor = (group: DeliveryGroup, date?: string) => {
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
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaymentEditor({ project, kind, date: date || (kind === "delivery" ? project.deliveryScheduledFor : project.installationScheduledFor) || today });
  };

  const openCustomEditor = (job?: ProjectScheduleJob, date = today) => {
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

  async function saveInventorySchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inventoryEditor) return;
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
      const body = await response.json() as { error?: string };
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
    if (busy) return;
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
      const body = await response.json() as { error?: string };
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
    if (!paymentEditor) return;
    setBusy(true);
    setError("");
    const action = paymentEditor.kind === "delivery" ? "schedule_delivery" : "schedule_installation";
    const dateField = paymentEditor.kind === "delivery" ? "deliveryDate" : "installationDate";
    try {
      const response = await fetch(`/api/payment-track/${paymentEditor.project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, actorRole: "pm", [dateField]: paymentEditor.date }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(apiMessage(body.error, `Unable to schedule ${paymentEditor.kind}.`));
      closeModalAfterSuccess();
      await refreshAll(paymentEditor.kind === "delivery" ? "Material delivery scheduled." : "Installation scheduled.");
      window.dispatchEvent(new CustomEvent("erp:payment-track-updated", { detail: { source: "project-management" } }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : `Unable to schedule ${paymentEditor.kind}.`);
    } finally {
      setBusy(false);
    }
  }

  async function completePaymentEntry(entry: Extract<CalendarEntry, { source: "material_delivery" | "installing" }>) {
    if (busy) return;
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
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(apiMessage(body.error, `Unable to complete ${installation ? "installation" : "delivery"}.`));
      await refreshAll(installation ? "Installation marked complete." : "Material delivery marked complete.");
      window.dispatchEvent(new CustomEvent("erp:payment-track-updated", { detail: { source: "project-management" } }));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update the Payment Track project.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCustomJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customEditor) return;
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
      const body = await response.json() as { error?: string };
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
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/project-schedule/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await response.json() as { error?: string };
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
    if (busy || !window.confirm(`Delete “${job.title}”? This cannot be undone.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/project-schedule/${job.id}`, { method: "DELETE" });
      const body = await response.json() as { error?: string };
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
    if (source === "installing") return "Installing";
    if (source === "inventory") return "Inventory Dispatch";
    return "Custom";
  };

  const renderCalendarEntry = (entry: CalendarEntry) => (
    <article key={entry.id} className={`${styles.scheduleCard} ${styles[entry.source]} ${entry.completed ? styles.completedCard : ""}`}>
      <div className={styles.cardTopline}>
        <span className={styles.sourceBadge}>{sourceLabel(entry.source)}</span>
        {entry.completed ? <span className={styles.completedBadge}><Check size={12} /> Complete</span> : null}
      </div>
      <h3>{entry.title}</h3>
      <p><MapPin size={13} />{entry.location}</p>
      <div className={styles.cardMeta}>
        <span><Clock3 size={13} />{entry.time ? timeLabel(entry.time) : "All day"}</span>
        <span><UserRound size={13} />{entry.assignee}</span>
      </div>
      <small>{entry.detail}</small>
      <div className={styles.cardButtons}>
        {entry.source === "inventory" && !entry.completed ? (
          <>
            <button type="button" onClick={() => openInventoryEditor(entry.group)} disabled={busy}><Pencil size={13} /> Edit</button>
            <button type="button" className={styles.primaryInline} onClick={() => void inventoryAction(entry.group, "deliver")} disabled={busy}><CheckCircle2 size={13} /> Delivered</button>
          </>
        ) : null}
        {(entry.source === "material_delivery" || entry.source === "installing") && !entry.completed ? (
          <>
            <button type="button" onClick={() => openPaymentEditor(entry.project, entry.source === "installing" ? "installation" : "delivery")} disabled={busy}><Pencil size={13} /> Reschedule</button>
            <button type="button" className={styles.primaryInline} onClick={() => void completePaymentEntry(entry)} disabled={busy}><CheckCircle2 size={13} /> {entry.source === "installing" ? "Installed" : "Delivered"}</button>
          </>
        ) : null}
        {entry.source === "custom" ? <button type="button" onClick={() => openCustomEditor(entry.job)} disabled={busy}><Pencil size={13} /> Details</button> : null}
      </div>
    </article>
  );

  return (
    <section className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div>
          <h1 ref={scheduleHeadingRef} id="project-schedule-title" tabIndex={-1}>Weekly Schedule</h1>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => void load(true)} disabled={refreshing || busy}>
            <RefreshCw size={16} className={refreshing ? styles.spinning : ""} /> Refresh
          </button>
          <button type="button" className={styles.addButton} onClick={() => openCustomEditor()} disabled={busy}>
            <Plus size={17} /> Add Job
          </button>
        </div>
      </header>

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
            <p>Scheduled before this week and still incomplete</p>
          </header>
          <div className={styles.trayList}>{visibleOverdue.map(renderCalendarEntry)}</div>
        </section>
      ) : null}

      <section className={styles.traySection} aria-labelledby="unscheduled-title">
        <header>
          <div><Clock3 size={18} /><h2 id="unscheduled-title">Unscheduled</h2><span>{visibleUnscheduled.length}</span></div>
          <p>Items that need a date from the Project Manager</p>
        </header>
        <div className={styles.trayList}>
          {visibleUnscheduled.map((entry) => (
            <article key={entry.id} className={`${styles.unscheduledCard} ${styles[entry.source]}`}>
              <div>
                <span className={styles.sourceBadge}>{sourceLabel(entry.source)}</span>
                <h3>{entry.title}</h3>
                <p><MapPin size={13} />{entry.location}</p>
                <small>{entry.detail}</small>
              </div>
              <button
                type="button"
                onClick={() => entry.source === "inventory"
                  ? openInventoryEditor(entry.group)
                  : openPaymentEditor(entry.project, entry.source === "installing" ? "installation" : "delivery")}
                disabled={busy}
              >
                <CalendarDays size={14} /> Schedule
              </button>
            </article>
          ))}
          {!visibleUnscheduled.length ? <div className={styles.emptyTray}><CalendarCheck2 size={20} /> No unscheduled jobs in this view</div> : null}
        </div>
      </section>

      {loading ? (
        <div className={styles.loading}><LoaderCircle size={27} className={styles.spinning} /> Loading weekly schedule…</div>
      ) : (
        <div className={styles.calendarScroller}>
          <div className={styles.calendarGrid} role="region" aria-labelledby="project-schedule-title">
            {days.map((day) => {
              const entries = visibleEntries.filter((entry) => entry.date === day);
              const isToday = day === today;
              return (
                <section key={day} className={`${styles.dayColumn} ${isToday ? styles.todayColumn : ""}`} aria-labelledby={`schedule-day-${day}`}>
                  <header>
                    <div><span>{dayLabel(day)}</span><strong id={`schedule-day-${day}`}>{dateNumber(day)}</strong></div>
                    {isToday ? <small>Today</small> : <span>{entries.length}</span>}
                  </header>
                  <div className={styles.dayEntries}>
                    {entries.map(renderCalendarEntry)}
                    {!entries.length ? <div className={styles.emptyDay}>No jobs</div> : null}
                    <button type="button" className={styles.quickAdd} onClick={() => openCustomEditor(undefined, day)}><Plus size={14} /> Add job</button>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {inventoryEditor ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={modalBackdropClick}>
          <form ref={modalRef} className={styles.modal} onSubmit={saveInventorySchedule} role="dialog" aria-modal="true" aria-labelledby="inventory-editor-title">
            <header>
              <div><span>Inventory Dispatch</span><h2 id="inventory-editor-title">{inventoryEditor.group.primary.status === "pending" ? "Schedule Delivery" : "Edit Delivery"}</h2></div>
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

      {paymentEditor ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={modalBackdropClick}>
          <form ref={modalRef} className={`${styles.modal} ${styles.compactModal}`} onSubmit={savePaymentSchedule} role="dialog" aria-modal="true" aria-labelledby="payment-editor-title">
            <header>
              <div><span>Payment Track · {paymentEditor.project.reference}</span><h2 id="payment-editor-title">Schedule {paymentEditor.kind === "delivery" ? "Material Delivery" : "Installation"}</h2></div>
              <button type="button" onClick={closeModal} disabled={busy} aria-label="Close"><X size={19} /></button>
            </header>
            <div className={styles.modalBody}>
              <div className={styles.projectSummary}>
                <span className={styles.projectIcon}>{paymentEditor.kind === "delivery" ? <Truck size={20} /> : <Wrench size={20} />}</span>
                <div><strong>{customerName(paymentEditor.project)}</strong><span><MapPin size={13} />{customerAddress(paymentEditor.project) || "Address required"}</span></div>
              </div>
              <label className={styles.singleField}>{paymentEditor.kind === "delivery" ? "Delivery date" : "Installation date"}<input type="date" value={paymentEditor.date} onChange={(event) => setPaymentEditor({ ...paymentEditor, date: event.target.value })} required /></label>
            </div>
            <footer>
              <span /><span />
              <button type="button" className={styles.secondaryButton} onClick={closeModal} disabled={busy}>Cancel</button>
              <button type="submit" className={styles.addButton} disabled={busy}>{busy ? <LoaderCircle size={16} className={styles.spinning} /> : <CalendarCheck2 size={16} />} Save Date</button>
            </footer>
          </form>
        </div>
      ) : null}

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
                  <button type="button" className={styles.dangerButton} onClick={() => void deleteCustomJob(customEditor.job as ProjectScheduleJob)} disabled={busy}><Trash2 size={15} /> Delete</button>
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
