"use client";

import {
  AlertCircle,
  BadgeCheck,
  Banknote,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileText,
  LayoutGrid,
  List as ListIcon,
  LoaderCircle,
  MapPin,
  PackageCheck,
  Paperclip,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  ShieldCheck,
  SkipForward,
  Trash2,
  Truck,
  UploadCloud,
  UserRound,
  WalletCards,
  Warehouse,
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
import {
  countActivePaymentTrackProjects,
  isFinalPaymentOverdue,
  isPaymentTrackWaitingForRebateQr,
  PAYMENT_TRACK_SCHEDULE_ASSIGNEES,
  PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH,
} from "@/lib/payment-track/types";
import type {
  PaymentTrackAction,
  PaymentTrackAdminSession,
  PaymentTrackDeliverySelection,
  PaymentTrackItem,
  PaymentTrackListResponse,
  PaymentTrackMutationResponse,
  PaymentTrackProject,
  PaymentTrackRole,
  PaymentTrackScheduleAssignee,
  PaymentTrackStage,
  PaymentTrackUpdatedEventDetail,
  PaymentTrackWorkMode,
} from "@/lib/payment-track/types";
import styles from "./payment-track-workspace.module.css";
import { MaterialDeliveryPicker } from "./material-delivery-picker";

type AddMode = "agreement" | "manual";
type ProofKind = "deposit";
type ProjectTrackViewMode = "board" | "list";
type ProjectTrackStageFilter = "all" | PaymentTrackStage;
type WorkflowConfirmation = {
  action: Extract<
    PaymentTrackAction,
    "acknowledge_deposit" | "mark_coes_received" | "continue_to_stc" | "confirm_stc_solar" | "confirm_stc_battery" | "confirm_solar_rebate" | "skip_stage"
  >;
  title: string;
  description: string;
  confirmLabel: string;
  successMessage: string;
  requiresReason?: boolean;
  expectedUpdatedAt?: string;
};

function announcePaymentTrackUpdate(projects: PaymentTrackProject[]) {
  window.dispatchEvent(new CustomEvent<PaymentTrackUpdatedEventDetail>("erp:payment-track-updated", {
    detail: {
      activeProjectCount: countActivePaymentTrackProjects(projects),
      source: "payment-track",
    },
  }));
}

const ROLE_LABELS: Record<PaymentTrackRole, string> = {
  sales: "Sales",
  specialist: "Sales",
  pm: "Project Manager",
  admin: "Administrator",
};

const STAGES: Array<{
  id: PaymentTrackStage;
  title: string;
  tone: "amber" | "blue" | "violet" | "cyan" | "teal" | "green";
}> = [
  {
    id: "deposit_not_paid",
    title: "Deposit Not Paid",
    tone: "amber",
  },
  {
    id: "working_in_progress",
    title: "Working in Progress",
    tone: "blue",
  },
  {
    id: "waiting_coes",
    title: "Installed / Waiting COES",
    tone: "cyan",
  },
  { id: "stc_rebate", title: "STC Rebate", tone: "teal" },
  { id: "done", title: "Done", tone: "green" },
];

const EMPTY_ADMIN_SESSION: PaymentTrackAdminSession = { admin: false, configured: false };
const MAX_AGREEMENT_SIZE = 15 * 1024 * 1024;
const MAX_PROOF_SIZE = 10 * 1024 * 1024;
const PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

type ScheduleAssignee = PaymentTrackScheduleAssignee | "";

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "—";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function formatScheduledAt(date: string | null, time: string | null) {
  if (!date) return "Not scheduled";
  return formatDate(time ? `${date}T${time}` : date, Boolean(time));
}

function hasDeliverySchedule(project: PaymentTrackProject) {
  return Boolean(
    project.deliveryScheduledFor
    && project.deliveryScheduledTime
    && project.deliveryAssignee,
  );
}

function hasInstallationSchedule(project: PaymentTrackProject) {
  return Boolean(
    project.installationScheduledFor
    && project.installationScheduledTime
    && project.installationAssignee,
  );
}

function hasWorkSchedule(project: PaymentTrackProject) {
  if (project.workMode === "delivery_only") return hasDeliverySchedule(project);
  if (project.workMode === "installation_only") return hasInstallationSchedule(project);
  return project.workMode === "delivery_and_installation"
    && hasDeliverySchedule(project)
    && hasInstallationSchedule(project)
    && project.deliveryScheduledFor === project.installationScheduledFor
    && project.deliveryScheduledTime === project.installationScheduledTime;
}

function hasActiveWorkSchedule(project: PaymentTrackProject) {
  return hasWorkSchedule(project)
    && !(project.deliveredAt && !project.installedAt && project.workMode === "delivery_only");
}

function hasDeliveryScheduleRequest(project: PaymentTrackProject) {
  return Boolean(project.deliveryScheduleRequest && project.deliverySelections.length);
}

function hasInstallationScheduleRequest(project: PaymentTrackProject) {
  return Boolean(project.installationScheduleRequest);
}

function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function customerName(project: PaymentTrackProject) {
  return [project.customer.firstName, project.customer.lastName].filter(Boolean).join(" ") || "Unnamed customer";
}

function customerAddress(project: PaymentTrackProject) {
  return [
    project.customer.addressLine1,
    project.customer.suburb,
    project.customer.state,
    project.customer.postcode,
  ].filter(Boolean).join(", ") || "No address recorded";
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const message = (value as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function unwrap<T>(value: T | { data: T }): T {
  return value && typeof value === "object" && "data" in value
    ? (value as { data: T }).data
    : value as T;
}

function stageLabel(stage: PaymentTrackStage) {
  return STAGES.find((column) => column.id === stage)?.title ?? stage;
}

function projectHasScheduledCurrentStage(project: PaymentTrackProject) {
  if (project.stage === "working_in_progress") return hasActiveWorkSchedule(project) && !project.installedAt;
  return (project.stage === "material_delivery" && !project.deliveredAt && hasDeliverySchedule(project))
    || (project.stage === "installing" && !project.installedAt && hasInstallationSchedule(project));
}

function projectHasPreScheduledCurrentStage(project: PaymentTrackProject) {
  return (project.stage === "material_delivery"
    && !project.deliveredAt
    && hasDeliveryScheduleRequest(project)
    && !hasDeliverySchedule(project))
    || (project.stage === "installing"
      && !project.installedAt
      && hasInstallationScheduleRequest(project)
      && !hasInstallationSchedule(project));
}

function projectHasUnscheduledCurrentStage(project: PaymentTrackProject) {
  if (project.stage === "working_in_progress") {
    return !isPaymentTrackWaitingForRebateQr(project)
      && !hasActiveWorkSchedule(project)
      && !project.installedAt;
  }
  return (project.stage === "material_delivery"
    && !project.deliveredAt
    && !hasDeliveryScheduleRequest(project)
    && !hasDeliverySchedule(project))
    || (project.stage === "installing"
      && !project.installedAt
      && !hasInstallationScheduleRequest(project)
      && !hasInstallationSchedule(project));
}

function displayedProjectStage(project: PaymentTrackProject) {
  if (project.stage === "working_in_progress") {
    if (project.installedAt) return "Installed";
    if (project.deliveredAt && project.workMode === "delivery_only") return "Delivered";
    if (hasActiveWorkSchedule(project)) return "Scheduled";
    if (project.deliveredAt) return "Delivered";
    if (isPaymentTrackWaitingForRebateQr(project)) return "Waiting for rebate QR code";
    return "Unscheduled";
  }
  if (projectHasScheduledCurrentStage(project)) return "Scheduled";
  if (projectHasPreScheduledCurrentStage(project)) return "Pre-scheduled";
  return projectHasUnscheduledCurrentStage(project) ? "Unscheduled" : stageLabel(project.stage);
}

function displayedProjectStageTone(project: PaymentTrackProject) {
  if (project.stage === "working_in_progress") {
    if (project.installedAt) return "green";
    if (project.deliveredAt && project.workMode === "delivery_only") return "blue";
    if (hasActiveWorkSchedule(project)) return "green";
    if (project.deliveredAt) return "blue";
    if (isPaymentTrackWaitingForRebateQr(project)) return "amber";
    return "red";
  }
  if (projectHasScheduledCurrentStage(project)) return "green";
  if (projectHasPreScheduledCurrentStage(project)) return "amber";
  if (projectHasUnscheduledCurrentStage(project)) return "red";
  return STAGES.find((stage) => stage.id === project.stage)?.tone || "blue";
}

function skipStageDetails(project: PaymentTrackProject) {
  if (project.stage === "done") return null;
  if (project.stage === "deposit_not_paid") {
    return {
      target: "material_delivery" as const,
      description: "This advances the project without creating or changing a payment record. The outstanding balance remains unchanged.",
    };
  }
  if (project.stage === "working_in_progress") {
    return {
      target: "waiting_coes" as const,
      description: "This marks delivery and installation as already completed and advances the project to the COES stage.",
    };
  }
  if (project.stage === "material_delivery") {
    return {
      target: "installing" as const,
      description: "This marks material delivery as already completed and advances the project. Collection and outstanding balances remain unchanged.",
    };
  }
  if (project.stage === "installing") {
    return {
      target: "waiting_coes" as const,
      description: "This marks installation as already completed and advances the project to the COES stage.",
    };
  }
  if (project.stage === "waiting_coes") {
    const target = pendingRebateReceipts(project).length ? "stc_rebate" as const : "done" as const;
    return {
      target,
      description: `This marks COES as already received and advances the project to ${stageLabel(target)}.`,
    };
  }
  return {
    target: "done" as const,
    description: "This marks every required STC and Solar Rebate receipt as already received and completes the project.",
  };
}

function paymentsAwaitingAdmin(project: PaymentTrackProject) {
  return project.finalPayments.filter((payment) => (
    payment.confirmedAmountCents === null && Boolean(payment.acknowledgedAt || payment.proof)
  ));
}

function pendingPaymentReviewCount(project: PaymentTrackProject) {
  return paymentsAwaitingAdmin(project).length;
}

function pendingReportedPaymentTotal(project: PaymentTrackProject) {
  return project.finalPayments.reduce((total, payment) => (
    payment.confirmedAt ? total : total + (payment.reportedAmountCents || 0)
  ), 0);
}

function pendingRebateReceipts(project: PaymentTrackProject) {
  return [
    project.stcSolarRequired && !project.stcSolarReceivedAt ? "Solar STC" : "",
    project.stcBatteryRequired && !project.stcBatteryReceivedAt ? "Battery STC" : "",
    project.solarRebateRequired && !project.solarRebateReceivedAt ? "Solar Rebate" : "",
  ].filter(Boolean);
}

function compareProjectsByOutstanding(left: PaymentTrackProject, right: PaymentTrackProject) {
  const outstandingOrder = right.outstandingCents - left.outstandingCents;
  if (outstandingOrder) return outstandingOrder;

  const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedOrder) return updatedOrder;

  const referenceOrder = left.reference.localeCompare(right.reference, "en-AU", {
    numeric: true,
    sensitivity: "base",
  });
  return referenceOrder || left.id.localeCompare(right.id);
}

function projectStatus(project: PaymentTrackProject): { label: string; owner: string; tone: string } {
  if (project.stage === "deposit_not_paid") {
    return project.deposit.proof || project.deposit.acknowledgedAt
      ? { label: "Awaiting deposit confirmation", owner: "Admin", tone: "blue" }
      : { label: "Deposit proof required", owner: "Sales", tone: "amber" };
  }
  if (project.stage === "working_in_progress") {
    if (project.installedAt) return { label: "Installed", owner: "PM", tone: "green" };
    if (project.deliveredAt && project.workMode === "delivery_only") return { label: "Delivered · installation unscheduled", owner: "PM", tone: "blue" };
    if (hasActiveWorkSchedule(project)) {
      const label = project.workMode === "delivery_only"
        ? "Delivery scheduled"
        : project.workMode === "installation_only" ? "Installation scheduled" : "Delivery & installation scheduled";
      return { label, owner: "PM", tone: "green" };
    }
    if (isPaymentTrackWaitingForRebateQr(project)) {
      return { label: "Waiting for rebate QR code", owner: "PM", tone: "amber" };
    }
    return { label: "Work unscheduled", owner: "PM", tone: "amber" };
  }
  if (project.stage === "material_delivery") {
    if (!project.deliveredAt) {
      if (hasDeliverySchedule(project)) {
        return { label: "Delivery scheduled", owner: project.deliveryAssignee || "PM", tone: "blue" };
      }
      return hasDeliveryScheduleRequest(project)
        ? { label: "Awaiting PM schedule confirmation", owner: "PM", tone: "amber" }
        : { label: "Delivery preference required", owner: "Sales", tone: "amber" };
    }
    return project.collection.acknowledgedAt || project.collection.proof
      ? { label: "Awaiting collection confirmation", owner: "Admin", tone: "blue" }
      : { label: "Payment receipt acknowledgement required", owner: "Sales", tone: "amber" };
  }
  if (project.stage === "installing") {
    if (hasInstallationSchedule(project)) {
      return { label: "Installment scheduled", owner: project.installationAssignee || "PM", tone: "violet" };
    }
    return hasInstallationScheduleRequest(project)
      ? { label: "Awaiting PM schedule confirmation", owner: "PM", tone: "amber" }
      : { label: "Installment preference required", owner: "Sales", tone: "amber" };
  }
  if (project.stage === "waiting_coes") {
    if (!project.coesReceivedAt) {
      return { label: "COES confirmation required", owner: "PM", tone: "cyan" };
    }
    return { label: "Ready for STC Rebate", owner: "Admin", tone: "cyan" };
  }
  if (project.stage === "stc_rebate") {
    const pending = pendingRebateReceipts(project).join(" + ");
    return {
      label: pending ? `${pending} confirmation required` : "Finalising rebate receipts",
      owner: "Admin",
      tone: "teal",
    };
  }
  return { label: "Project complete", owner: "Complete", tone: "green" };
}

function projectNextStep(project: PaymentTrackProject) {
  if (project.stage === "deposit_not_paid") {
    return project.deposit.proof || project.deposit.acknowledgedAt
      ? { label: "Review Deposit", roles: ["admin"] as PaymentTrackRole[] }
      : { label: "Upload Deposit Proof", roles: ["sales"] as PaymentTrackRole[] };
  }
  if (project.stage === "working_in_progress") {
    return {
      label: hasActiveWorkSchedule(project)
        ? "Complete Scheduled Work"
        : isPaymentTrackWaitingForRebateQr(project) ? "Confirm rebate QR received" : "Schedule Work",
      roles: ["pm"] as PaymentTrackRole[],
    };
  }
  if (project.stage === "material_delivery") {
    if (!project.deliveredAt) {
      if (hasDeliverySchedule(project)) {
        return { label: "Mark Delivered", roles: ["pm"] as PaymentTrackRole[] };
      }
      return hasDeliveryScheduleRequest(project)
        ? { label: "Review Delivery Request", roles: ["pm"] as PaymentTrackRole[] }
        : { label: "Submit Delivery Preference", roles: ["sales"] as PaymentTrackRole[] };
    }
    return project.collection.acknowledgedAt || project.collection.proof
      ? { label: "Review Collection", roles: ["admin"] as PaymentTrackRole[] }
      : { label: "Payment Received", roles: ["sales"] as PaymentTrackRole[] };
  }
  if (project.stage === "installing") {
    if (hasInstallationSchedule(project)) {
      return { label: "Mark Installed", roles: ["pm"] as PaymentTrackRole[] };
    }
    return hasInstallationScheduleRequest(project)
      ? { label: "Review Installment Request", roles: ["pm"] as PaymentTrackRole[] }
      : { label: "Submit Installment Preference", roles: ["sales"] as PaymentTrackRole[] };
  }
  if (project.stage === "waiting_coes") {
    return project.coesReceivedAt
      ? { label: "Open Rebate Stage", roles: ["admin"] as PaymentTrackRole[] }
      : { label: "Confirm COES", roles: ["pm"] as PaymentTrackRole[] };
  }
  if (project.stage === "stc_rebate") {
    const solarPending = project.stcSolarRequired && !project.stcSolarReceivedAt;
    const batteryPending = project.stcBatteryRequired && !project.stcBatteryReceivedAt;
    const solarRebatePending = project.solarRebateRequired && !project.solarRebateReceivedAt;
    const pendingReceiptCount = Number(solarPending) + Number(batteryPending) + Number(solarRebatePending);
    const label = pendingReceiptCount > 1
      ? "Review Rebate Receipts"
      : solarPending
        ? "Confirm Solar STC"
        : batteryPending
          ? "Confirm Battery STC"
          : solarRebatePending
            ? "Confirm Solar Rebate"
            : "Finalise Rebate Receipts";
    return {
      label,
      roles: ["admin"] as PaymentTrackRole[],
    };
  }
  return {
    label: "View Completed Project",
    roles: ["sales", "pm", "admin"] as PaymentTrackRole[],
  };
}

function parseManualItems(value: string): Array<Omit<PaymentTrackItem, "id">> {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [model = "", description = "", quantityText = "1", capacity = ""] = line
      .split("|")
      .map((part) => part.trim());
    const searchable = `${model} ${description}`.toLowerCase();
    const category = searchable.includes("battery")
      ? "Battery"
      : searchable.includes("inverter")
        ? "Solar Inverter"
        : /panel|module/.test(searchable)
          ? "Solar Panel"
          : "Item";
    const quantity = Number.parseInt(quantityText, 10);
    return {
      category,
      model: model || description,
      description: description || model,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      capacity,
    };
  });
}

function adminReviewCount(project: PaymentTrackProject) {
  const depositReview = (
    project.stage === "deposit_not_paid" && Boolean(project.deposit.proof || project.deposit.acknowledgedAt)
  ) ? 1 : 0;
  const legacyCollectionReview = (
    project.stage === "material_delivery"
    && Boolean(project.deliveredAt)
    && Boolean(project.collection.acknowledgedAt || project.collection.proof)
  ) ? 1 : 0;
  return depositReview + legacyCollectionReview + pendingPaymentReviewCount(project);
}

function finalPaymentTotal(project: PaymentTrackProject) {
  return project.finalPayments.reduce(
    (total, payment) => total + (payment.confirmedAmountCents ?? 0),
    0,
  );
}

type ConfirmedPaymentRecord = {
  id: string;
  label: string;
  amountCents: number;
  confirmedAt: string;
};

function confirmedPaymentRecords(project: PaymentTrackProject): ConfirmedPaymentRecord[] {
  const records: ConfirmedPaymentRecord[] = [];
  const addReceipt = (
    id: string,
    label: string,
    receipt: PaymentTrackProject["deposit"],
  ) => {
    if (receipt.confirmedAt && receipt.confirmedAmountCents !== null) {
      records.push({
        id,
        label,
        amountCents: receipt.confirmedAmountCents,
        confirmedAt: receipt.confirmedAt,
      });
    }
  };

  addReceipt(`${project.id}:deposit`, "Deposit", project.deposit);
  addReceipt(`${project.id}:collection`, "Delivery collection", project.collection);
  project.finalPayments.forEach((payment, index) => {
    addReceipt(`${payment.id}:${index}`, "Later payment", payment);
  });

  return records.sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt));
}

export function PaymentTrackWorkspace({ authenticatedRole, openEntityTarget }: {
  authenticatedRole: ErpRole;
  openEntityTarget?: { entityId: string; requestId: number };
}) {
  const paymentTrackRole: PaymentTrackRole = authenticatedRole === "specialist" ? "sales" : authenticatedRole;
  const [projects, setProjects] = useState<PaymentTrackProject[]>([]);
  const [role, setRole] = useState<PaymentTrackRole>(paymentTrackRole);
  const [adminSession, setAdminSession] = useState<PaymentTrackAdminSession>(EMPTY_ADMIN_SESSION);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("agreement");
  const [agreement, setAgreement] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [actionAmount, setActionAmount] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [deliveryTime, setDeliveryTime] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [deliveryAssignee, setDeliveryAssignee] = useState<ScheduleAssignee>("");
  const [deliverySelectionDraft, setDeliverySelectionDraft] = useState<PaymentTrackDeliverySelection[]>([]);
  const [showDeliveryPicker, setShowDeliveryPicker] = useState(false);
  const [installationDate, setInstallationDate] = useState("");
  const [installationTime, setInstallationTime] = useState("");
  const [installationNotes, setInstallationNotes] = useState("");
  const [installationAssignee, setInstallationAssignee] = useState<ScheduleAssignee>("");
  const [workMode, setWorkMode] = useState<PaymentTrackWorkMode>("delivery_only");
  const [workflowConfirmation, setWorkflowConfirmation] = useState<WorkflowConfirmation | null>(null);
  const [workflowReason, setWorkflowReason] = useState("");
  const [viewMode, setViewMode] = useState<ProjectTrackViewMode>("board");
  const [listStage, setListStage] = useState<ProjectTrackStageFilter>("all");
  const [finalPaymentStatusNow, setFinalPaymentStatusNow] = useState(() => Date.now());
  const [boardPosition, setBoardPosition] = useState({ stageIndex: 0, canScrollLeft: false, canScrollRight: false });
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const deliveryPickerDialogRef = useRef<HTMLElement | null>(null);
  const deliveryPickerTriggerRef = useRef<HTMLElement | null>(null);
  const showDeliveryPickerRef = useRef(false);
  const returningFromDeliveryPickerRef = useRef(false);
  const boardScrollerRef = useRef<HTMLDivElement | null>(null);
  const stageJumpListRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const loadRequestRef = useRef(0);
  const projectsRef = useRef<PaymentTrackProject[]>([]);
  const handledOpenEntityRequestRef = useRef(0);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId],
  );
  const paymentRecords = useMemo(
    () => selected ? confirmedPaymentRecords(selected) : [],
    [selected],
  );

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const timer = window.setInterval(() => setFinalPaymentStatusNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const openDeliveryPicker = useCallback((trigger: HTMLElement) => {
    deliveryPickerTriggerRef.current = trigger;
    trigger.blur();
    returningFromDeliveryPickerRef.current = false;
    showDeliveryPickerRef.current = true;
    setShowDeliveryPicker(true);
  }, []);

  const closeDeliveryPicker = useCallback(() => {
    showDeliveryPickerRef.current = false;
    returningFromDeliveryPickerRef.current = true;
    setShowDeliveryPicker(false);
  }, []);

  const load = useCallback(async (quiet = false) => {
    const requestId = ++loadRequestRef.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch("/api/payment-track", { cache: "no-store" });
      const body = await readJsonResponse<PaymentTrackListResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to load projects."));
      if (!Array.isArray(body.data)) throw new Error("Project Track returned an invalid response.");
      if (requestId !== loadRequestRef.current) return;
      const nextProjects = body.data;
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      announcePaymentTrackUpdate(nextProjects);
      setAdminSession((current) => ({ ...current, admin: Boolean(body.meta?.admin) }));
      setError("");
    } catch (loadError) {
      if (requestId !== loadRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load projects.");
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const loadAdminSession = useCallback(async () => {
    try {
      const response = await fetch("/api/payment-track/admin", { cache: "no-store" });
      const body = await readJsonResponse<PaymentTrackAdminSession | { data: PaymentTrackAdminSession }>(response);
      if (response.ok) setAdminSession(unwrap(body));
    } catch {
      setAdminSession(EMPTY_ADMIN_SESSION);
    }
  }, []);

  useEffect(() => {
    void Promise.all([load(), loadAdminSession()]);
  }, [load, loadAdminSession]);

  const modalKey = workflowConfirmation
    ? `confirm:${workflowConfirmation.action}`
    : showAdminLogin
    ? "admin"
    : showAdd
      ? "add"
      : selected
        ? `${showDeliveryPicker ? "delivery-picker" : "detail"}:${selected.id}`
        : "none";
  useEffect(() => {
    if (modalKey === "none") return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = showDeliveryPicker
      ? deliveryPickerDialogRef.current
      : document.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']");
    const returningToPickerTrigger = !showDeliveryPicker && returningFromDeliveryPickerRef.current;
    if (returningToPickerTrigger) returningFromDeliveryPickerRef.current = false;
    const focusDialog = returningToPickerTrigger ? null : window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>("[autofocus]");
      const fallback = dialog?.querySelector<HTMLElement>("button, input, select, textarea, a[href]");
      (preferred || fallback || dialog)?.focus();
    });
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        if (workflowConfirmation) {
          setWorkflowConfirmation(null);
          return;
        }
        if (showDeliveryPicker) {
          closeDeliveryPicker();
          return;
        }
        setShowAdd(false);
        setShowAdminLogin(false);
        setSelectedId(null);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeys);
    return () => {
      if (focusDialog !== null) window.cancelAnimationFrame(focusDialog);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleDialogKeys);
      if (modalKey.startsWith("delivery-picker:")) {
        window.requestAnimationFrame(() => {
          if (deliveryPickerTriggerRef.current?.isConnected) deliveryPickerTriggerRef.current.focus();
        });
      } else if (!(modalKey.startsWith("detail:") && showDeliveryPickerRef.current)) {
        window.requestAnimationFrame(() => returnFocusRef.current?.focus());
      }
    };
  }, [closeDeliveryPicker, modalKey, showDeliveryPicker, workflowConfirmation]);

  const metrics = useMemo(() => ({
    receivable: projects.reduce((sum, project) => sum + project.balanceDueCents, 0),
    outstanding: projects.reduce((sum, project) => sum + project.outstandingCents, 0),
    adminReview: projects.reduce((sum, project) => sum + adminReviewCount(project), 0),
    active: countActivePaymentTrackProjects(projects),
  }), [projects]);

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("en-AU");
    if (!term) return projects;
    return projects.filter((project) => [
      project.reference,
      project.quoteNumber,
      customerName(project),
      project.customer.phone,
      project.customer.email,
      project.specialist.name,
      ...project.items.flatMap((item) => [item.model, item.description]),
    ].join(" ").toLocaleLowerCase("en-AU").includes(term));
  }, [projects, query]);

  const listProjects = useMemo(() => {
    return filtered
      .filter((project) => listStage === "all" || project.stage === listStage)
      .slice()
      .sort(compareProjectsByOutstanding);
  }, [filtered, listStage]);

  const updateBoardPosition = useCallback(() => {
    const scroller = boardScrollerRef.current;
    if (!scroller) return;
    const columns = [...scroller.querySelectorAll<HTMLElement>("[data-payment-stage]")];
    const stageIndex = columns.reduce((closest, column, index) => (
      Math.abs(column.offsetLeft - scroller.scrollLeft)
        < Math.abs((columns[closest]?.offsetLeft ?? 0) - scroller.scrollLeft)
        ? index
        : closest
    ), 0);
    setBoardPosition({
      stageIndex,
      canScrollLeft: scroller.scrollLeft > 2,
      canScrollRight: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    if (loading) return;
    const scroller = boardScrollerRef.current;
    if (!scroller) return;
    const frame = window.requestAnimationFrame(updateBoardPosition);
    const observer = new ResizeObserver(updateBoardPosition);
    observer.observe(scroller);
    scroller.addEventListener("scroll", updateBoardPosition, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", updateBoardPosition);
    };
  }, [filtered.length, loading, updateBoardPosition, viewMode]);

  useEffect(() => {
    const list = stageJumpListRef.current;
    const target = list?.querySelectorAll<HTMLElement>("[data-stage-jump]")[boardPosition.stageIndex];
    if (!list || !target) return;
    list.scrollTo({
      left: Math.max(0, target.offsetLeft - (list.clientWidth - target.clientWidth) / 2),
      behavior: "smooth",
    });
  }, [boardPosition.stageIndex]);

  const scrollToBoardStage = (index: number) => {
    const scroller = boardScrollerRef.current;
    const columns = scroller
      ? [...scroller.querySelectorAll<HTMLElement>("[data-payment-stage]")]
      : [];
    const target = columns[Math.max(0, Math.min(index, columns.length - 1))];
    if (!scroller || !target) return;
    scroller.scrollTo({ left: Math.max(0, target.offsetLeft - 1), behavior: "smooth" });
  };

  const updateProject = (project: PaymentTrackProject) => {
    const current = projectsRef.current;
    const exists = current.some((item) => item.id === project.id);
    const nextProjects = exists
      ? current.map((item) => item.id === project.id ? project : item)
      : [project, ...current];
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    announcePaymentTrackUpdate(nextProjects);
  };

  const openAdd = (element: HTMLElement) => {
    returnFocusRef.current = element;
    setError("");
    if (authenticatedRole !== "admin" && role !== "sales") {
      setNotice("Only Sales or an Administrator can add a project.");
      return;
    }
    setAddMode("agreement");
    setAgreement(null);
    setShowAdd(true);
  };

  const openProject = useCallback((project: PaymentTrackProject, element?: HTMLElement) => {
    returnFocusRef.current = element ?? null;
    setProofFile(null);
    setActionAmount("");
    const currentWorkMode = project.deliveredAt && !project.installedAt && project.workMode === "delivery_only"
      ? "installation_only"
      : project.workMode || (project.deliveredAt ? "installation_only" : "delivery_only");
    setWorkMode(currentWorkMode);
    const currentWorkUsesInstallation = currentWorkMode === "installation_only";
    setDeliveryDate((currentWorkUsesInstallation ? project.installationScheduledFor : project.deliveryScheduledFor) || project.deliveryScheduleRequest?.preferredDate || "");
    setDeliveryTime((currentWorkUsesInstallation ? project.installationScheduledTime : project.deliveryScheduledTime) || project.deliveryScheduleRequest?.preferredTime || "");
    setDeliveryNotes(project.deliveryScheduleRequest?.notes || "");
    setDeliveryAssignee(project.deliveryAssignee || "");
    setDeliverySelectionDraft(project.deliverySelections);
    setInstallationDate(project.installationScheduledFor || project.installationScheduleRequest?.preferredDate || "");
    setInstallationTime(project.installationScheduledTime || project.installationScheduleRequest?.preferredTime || "");
    setInstallationNotes(project.installationScheduleRequest?.notes || "");
    setInstallationAssignee(project.installationAssignee || "");
    setError("");
    showDeliveryPickerRef.current = false;
    returningFromDeliveryPickerRef.current = false;
    setShowDeliveryPicker(false);
    setRole(paymentTrackRole);
    setSelectedId(project.id);
  }, [paymentTrackRole]);

  useEffect(() => {
    if (!openEntityTarget || loading || handledOpenEntityRequestRef.current === openEntityTarget.requestId) return;
    handledOpenEntityRequestRef.current = openEntityTarget.requestId;
    const project = projects.find((candidate) => candidate.id === openEntityTarget.entityId);
    if (!project) {
      setError("The project linked to this reminder is no longer available.");
      return;
    }
    openProject(project);
  }, [loading, openEntityTarget, openProject, projects]);

  const selectRole = (nextRole: PaymentTrackRole) => {
    if (authenticatedRole !== "admin" && nextRole !== paymentTrackRole) {
      setNotice(`Your ${ROLE_LABELS[paymentTrackRole]} account cannot switch to ${ROLE_LABELS[nextRole]}.`);
      return;
    }
    if (nextRole === "admin" && !adminSession.admin) {
      setShowAdminLogin(true);
      return;
    }
    setRole(nextRole);
    setNotice(`${ROLE_LABELS[nextRole]} view enabled.`);
  };

  const submitAdminLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payment-track/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: form.get("password") }),
      });
      const body = await readJsonResponse<{ data?: PaymentTrackAdminSession; error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to enter Administrator mode."));
      setAdminSession(unwrap(body as { data: PaymentTrackAdminSession }));
      setRole("admin");
      setShowAdminLogin(false);
      setNotice("Administrator mode enabled.");
      await load(true);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Unable to enter Administrator mode.");
    } finally {
      setBusy(false);
    }
  };

  const importAgreement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agreement || agreement.type !== "application/pdf" || agreement.size > MAX_AGREEMENT_SIZE) {
      setError("Choose a Solar Proposal PDF up to 15 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { parsePaymentAgreementPdf } = await import("@/lib/payment-track/pdf-parser");
      const parsed = await parsePaymentAgreementPdf(new Uint8Array(await agreement.arrayBuffer()));
      const parsedAgreement = {
        extractionVersion: 1,
        actorRole: "sales" as const,
        quoteNumber: parsed.quoteNumber,
        specialist: parsed.specialist,
        customer: parsed.customer,
        items: parsed.items,
        balanceDue: (parsed.balanceDueCents / 100).toFixed(2),
        expectedDeposit: parsed.expectedDepositCents === null
          ? null
          : (parsed.expectedDepositCents / 100).toFixed(2),
        stcSolarRequired: parsed.stcSolarRequired,
        stcBatteryRequired: parsed.stcBatteryRequired,
        solarRebateRequired: parsed.solarRebateRequired,
      };
      const body = new FormData();
      body.set("agreement", agreement);
      body.set("actorRole", "sales");
      body.set("parsedAgreement", JSON.stringify(parsedAgreement));
      const response = await fetch("/api/payment-track/import", { method: "POST", body });
      const result = await readJsonResponse<PaymentTrackMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(result, "Unable to import this proposal."));
      updateProject(result.data);
      setShowAdd(false);
      setAgreement(null);
      setNotice(`${customerName(result.data)} was imported and added to Deposit Not Paid.`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Unable to import this proposal.");
    } finally {
      setBusy(false);
    }
  };

  const createManualProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const items = parseManualItems(String(form.get("items") || ""));
    if (!items.length) {
      setError("Add at least one project item.");
      return;
    }
    const payload = {
      actorRole: "sales" as const,
      quoteNumber: String(form.get("quoteNumber") || "").trim(),
      specialist: {
        name: String(form.get("specialistName") || "").trim(),
        phone: String(form.get("specialistPhone") || "").trim(),
      },
      customer: {
        firstName: String(form.get("firstName") || "").trim(),
        lastName: String(form.get("lastName") || "").trim(),
        phone: String(form.get("phone") || "").trim(),
        email: String(form.get("email") || "").trim(),
        addressLine1: String(form.get("addressLine1") || "").trim(),
        suburb: String(form.get("suburb") || "").trim(),
        state: String(form.get("state") || "").trim(),
        postcode: String(form.get("postcode") || "").trim(),
      },
      items,
      balanceDue: String(form.get("balanceDue") || "").trim(),
      expectedDeposit: String(form.get("expectedDeposit") || "").trim() || null,
      stcSolarRequired: form.get("stcSolarRequired") === "on",
      stcBatteryRequired: form.get("stcBatteryRequired") === "on",
      solarRebateRequired: form.get("solarRebateRequired") === "on",
    };
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payment-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await readJsonResponse<PaymentTrackMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(result, "Unable to create this project."));
      updateProject(result.data);
      setShowAdd(false);
      setNotice(`${customerName(result.data)} was added to Deposit Not Paid.`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create this project.");
    } finally {
      setBusy(false);
    }
  };

  const uploadProof = async (kind: ProofKind) => {
    if (!selected || !proofFile) return;
    if (!PROOF_TYPES.has(proofFile.type) || proofFile.size > MAX_PROOF_SIZE) {
      setError("Choose a PDF, JPG, PNG or WebP proof up to 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("proof", proofFile);
      body.set("kind", kind);
      body.set("actorRole", role);
      const response = await fetch(`/api/payment-track/${selected.id}/proof`, { method: "POST", body });
      const result = await readJsonResponse<PaymentTrackMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(result, "Unable to upload payment proof."));
      updateProject(result.data);
      setProofFile(null);
      setSelectedId(null);
      setNotice("Deposit proof uploaded for Admin confirmation.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to upload payment proof.");
    } finally {
      setBusy(false);
    }
  };

  const confirmSolarRebateQrCodeReceived = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/payment-track/${selected.id}/rebate-qr-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorRole: "pm", expectedUpdatedAt: selected.updatedAt }),
      });
      const result = await readJsonResponse<PaymentTrackMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(result, "Unable to confirm receipt of the Solar Rebate QR code."));
      updateProject(result.data);
      setNotice("Solar Rebate QR code received. Work is now Unscheduled.");
    } catch (confirmationError) {
      setError(confirmationError instanceof Error
        ? confirmationError.message
        : "Unable to confirm receipt of the Solar Rebate QR code.");
    } finally {
      setBusy(false);
    }
  };

  const performAction = async (
    action: PaymentTrackAction,
    extra: Record<string, unknown> = {},
    successMessage = "Project updated.",
  ) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/payment-track/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, actorRole: action === "skip_stage" ? "admin" : role, ...extra }),
      });
      const result = await readJsonResponse<PaymentTrackMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(result, "Unable to update this project."));
      updateProject(result.data);
      setActionAmount("");
      setDeliveryDate(result.data.deliveryScheduledFor || result.data.deliveryScheduleRequest?.preferredDate || deliveryDate);
      setDeliveryTime(result.data.deliveryScheduledTime || result.data.deliveryScheduleRequest?.preferredTime || deliveryTime);
      setDeliveryNotes(result.data.deliveryScheduleRequest?.notes || deliveryNotes);
      setDeliveryAssignee(result.data.deliveryAssignee || deliveryAssignee);
      setDeliverySelectionDraft(result.data.deliverySelections);
      setInstallationDate(result.data.installationScheduledFor || result.data.installationScheduleRequest?.preferredDate || installationDate);
      setInstallationTime(result.data.installationScheduledTime || result.data.installationScheduleRequest?.preferredTime || installationTime);
      setInstallationNotes(result.data.installationScheduleRequest?.notes || installationNotes);
      setInstallationAssignee(result.data.installationAssignee || installationAssignee);
      setWorkflowConfirmation(null);
      setWorkflowReason("");
      if (action === "acknowledge_payment" || action === "confirm_final_payment") {
        setSelectedId(result.data.id);
      } else {
        setSelectedId(null);
      }
      setNotice(successMessage);
    } catch (actionError) {
      setWorkflowConfirmation(null);
      setWorkflowReason("");
      setError(actionError instanceof Error ? actionError.message : "Unable to update this project.");
    } finally {
      setBusy(false);
    }
  };

  const deleteProject = async () => {
    if (!selected || busy || authenticatedRole !== "admin") return;
    const project = selected;
    if (!window.confirm(`Delete “${customerName(project)}”? Files and schedule entries will also be removed.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/payment-track/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to delete the project."));
      const nextProjects = projectsRef.current.filter((item) => item.id !== project.id);
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      setSelectedId(null);
      setNotice(`${customerName(project)} deleted.`);
      announcePaymentTrackUpdate(nextProjects);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the project.");
    } finally {
      setBusy(false);
    }
  };

  const confirmAmount = (
    action: "confirm_deposit" | "confirm_collection" | "confirm_final_payment",
    label: string,
    paymentId?: string,
  ) => {
    if (actionAmount === "" || !Number.isFinite(Number(actionAmount)) || Number(actionAmount) < 0) {
      setError("Enter the actual amount received. It can be 0, but not negative.");
      return;
    }
    void performAction(
      action,
      { amount: actionAmount, ...(paymentId ? { paymentId } : {}) },
      `${label} confirmed.`,
    );
  };

  const recordReceivedPayment = (project: PaymentTrackProject) => {
    const amount = Number(actionAmount);
    const available = Math.max(0, project.outstandingCents - pendingReportedPaymentTotal(project));
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > available) {
      setError(`Enter a received amount between $0.01 and ${formatMoney(available)}.`);
      return;
    }
    void performAction(
      "acknowledge_payment",
      { amount: actionAmount },
      "Payment recorded. Awaiting Administrator confirmation.",
    );
  };

  const closeProjectDetail = () => {
    showDeliveryPickerRef.current = false;
    returningFromDeliveryPickerRef.current = false;
    setShowDeliveryPicker(false);
    setSelectedId(null);
  };

  const reloadSelectedProject = () => {
    setError("");
    closeProjectDetail();
    void load(true);
  };

  const closeWorkflowConfirmation = () => {
    setWorkflowConfirmation(null);
    setWorkflowReason("");
  };

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || busy) return;
    if (workflowConfirmation) {
      closeWorkflowConfirmation();
      return;
    }
    if (showDeliveryPicker) {
      closeDeliveryPicker();
      return;
    }
    setShowAdd(false);
    setShowAdminLogin(false);
    closeProjectDetail();
  };

  const requestWorkflowConfirmation = (confirmation: WorkflowConfirmation) => {
    setError("");
    setWorkflowReason("");
    setWorkflowConfirmation(confirmation);
  };

  const confirmWorkflowAction = () => {
    if (!workflowConfirmation) return;
    const reason = workflowReason.trim();
    if (workflowConfirmation.requiresReason
      && (!reason || reason.length > PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH)) {
      setError(`Enter a reason of up to ${PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH} characters for this Administrator stage override.`);
      return;
    }
    if (workflowConfirmation.requiresReason && !workflowConfirmation.expectedUpdatedAt) {
      setError("Reload this project before using the Administrator stage override.");
      return;
    }
    void performAction(
      workflowConfirmation.action,
      workflowConfirmation.requiresReason
        ? { reason, expectedUpdatedAt: workflowConfirmation.expectedUpdatedAt || "" }
        : {},
      workflowConfirmation.successMessage,
    );
  };

  const renderPaymentRecorder = (project: PaymentTrackProject) => {
    if (project.stage === "deposit_not_paid" || project.outstandingCents <= 0) return null;
    const available = Math.max(0, project.outstandingCents - pendingReportedPaymentTotal(project));
    if (available <= 0) return null;
    if (role !== "sales") {
      return authenticatedRole === "admin" ? (
        <button className={styles.addPaymentRecordButton} type="button" disabled={busy} onClick={() => selectRole("sales")}>
          <Plus size={15} /> Add payment record
        </button>
      ) : null;
    }
    const enteredAmount = Number(actionAmount);
    const validAmount = actionAmount !== ""
      && Number.isFinite(enteredAmount)
      && enteredAmount > 0
      && Math.round(enteredAmount * 100) <= available;
    return (
      <form className={styles.paymentRecorder} onSubmit={(event) => {
        event.preventDefault();
        if (validAmount) recordReceivedPayment(project);
      }}>
        <div className={styles.paymentRecorderHeading}>
          <span><Banknote size={17} /></span>
          <strong>Record received payment</strong>
        </div>
        <label className={styles.paymentRecorderAmount}>
          Amount received · up to {formatMoney(available)}
          <span className={styles.moneyField}>
            <b aria-hidden="true">$</b>
            <input
              aria-label="Payment amount received in AUD"
              value={actionAmount}
              onChange={(event) => setActionAmount(event.target.value)}
              type="number"
              inputMode="decimal"
              min="0.01"
              max={(available / 100).toFixed(2)}
              step="0.01"
              aria-invalid={actionAmount !== "" && !validAmount}
            />
          </span>
        </label>
        <button className={styles.primaryButton} type="submit" disabled={busy || !validAmount}>
          {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <Plus size={16} />} Record payment
        </button>
      </form>
    );
  };

  const renderPaymentCollection = (project: PaymentTrackProject) => {
    if (project.stage === "deposit_not_paid") return null;
    const pendingPayments = paymentsAwaitingAdmin(project);
    const pendingPayment = pendingPayments[0] || null;
    const recorder = renderPaymentRecorder(project);
    if (!pendingPayments.length && !recorder) return null;

    return (
      <section className={styles.paymentCollection} aria-label="Payment collection">
        <header className={styles.paymentCollectionHeader}>
          <div><span><Banknote size={17} /></span><strong>Payment collection</strong></div>
          {pendingPayments.length ? (
            <em><Clock3 size={13} /> Awaiting Admin confirmation{pendingPayments.length > 1 ? ` · ${pendingPayments.length}` : ""}</em>
          ) : null}
        </header>

        {pendingPayments.length ? (
          <div className={styles.pendingPaymentQueue} aria-label="Payments awaiting Administrator confirmation">
            {pendingPayments.map((payment, index) => (
              <article key={payment.id}>
                <div>
                  <strong>{formatMoney(payment.reportedAmountCents || 0)}</strong>
                  <small>Payment {index + 1}</small>
                </div>
                <span><Clock3 size={13} /> Awaiting Admin confirmation</span>
              </article>
            ))}
          </div>
        ) : null}

        {role === "admin" && pendingPayment ? (
          <div className={styles.paymentCollectionAdminAction}>
            <AmountAction
              amount={actionAmount}
              busy={busy}
              label={`Sales recorded ${formatMoney(pendingPayment.reportedAmountCents || 0)} · actual amount received`}
              buttonLabel="Confirm Actual Amount"
              onAmount={setActionAmount}
              onSubmit={() => confirmAmount("confirm_final_payment", "Payment", pendingPayment.id)}
            />
          </div>
        ) : null}

        {recorder}
      </section>
    );
  };

  const renderActionPanel = (project: PaymentTrackProject) => {
    const status = projectStatus(project);
    if (project.stage === "done") {
      return (
        <div className={`${styles.actionPanel} ${styles.completedPanel}`}>
          <CheckCircle2 size={20} />
          <strong>Project complete</strong>
        </div>
      );
    }

    if (project.stage === "deposit_not_paid" && !project.deposit.proof && !project.deposit.acknowledgedAt) {
      if (role !== "sales") {
        return (
          <ReadOnlyNextStep
            owner="Sales"
            label="Upload the customer’s deposit payment proof."
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Sales"
            onContinue={() => selectRole("sales")}
          />
        );
      }
      return (
        <ProofAction
          busy={busy}
          file={proofFile}
          label="Deposit payment proof"
          buttonLabel="Upload & Submit"
          onFile={setProofFile}
          onSubmit={() => void uploadProof("deposit")}
          onConfirmPaid={() => requestWorkflowConfirmation({
            action: "acknowledge_deposit",
            title: "Confirm deposit paid without proof?",
            description: "This skips the file upload and sends the deposit to Administrator review. Only continue after confirming the customer has paid.",
            confirmLabel: "Yes, Confirm Paid",
            successMessage: "Deposit marked as paid. Administrator can now record the actual amount received.",
          })}
        />
      );
    }

    if (project.stage === "deposit_not_paid") {
      if (role !== "admin") {
        return (
          <ReadOnlyNextStep
            owner="Administrator"
            label="Confirm the deposit and record the actual amount received."
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Administrator"
            onContinue={() => selectRole("admin")}
          />
        );
      }
      return (
        <AmountAction
          amount={actionAmount}
          busy={busy}
          label="Actual deposit received"
          buttonLabel="Deposit Confirmed"
          onAmount={setActionAmount}
          onSubmit={() => confirmAmount("confirm_deposit", "Deposit")}
        />
      );
    }

    if (project.stage === "working_in_progress") {
      // Do not retroactively block a fully scheduled legacy project. Partial
      // schedule data still requires PM receipt confirmation first.
      const waitingForRebateQr = isPaymentTrackWaitingForRebateQr(project)
        && !hasActiveWorkSchedule(project);
      if (role !== "pm") {
        return (
          <ReadOnlyNextStep
            owner="Project Manager"
            label={waitingForRebateQr
              ? "Waiting for the Project Manager to confirm the Solar Rebate QR code was received."
              : hasActiveWorkSchedule(project) ? "Complete or update the scheduled work." : "Choose the work type, items, time and team."}
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Project Manager"
            onContinue={() => selectRole("pm")}
          />
        );
      }
      if (waitingForRebateQr) {
        return (
          <RebateQrConfirmationAction
            busy={busy}
            onConfirm={() => void confirmSolarRebateQrCodeReceived()}
          />
        );
      }
      const includesDelivery = workMode === "delivery_only" || workMode === "delivery_and_installation";
      const includesInstallation = workMode === "installation_only" || workMode === "delivery_and_installation";
      const scheduleReady = Boolean(
        deliveryDate
        && deliveryTime
        && (!includesDelivery || (deliveryAssignee && deliverySelectionDraft.length))
        && (!includesInstallation || installationAssignee),
      );
      const savedScheduleMatches = hasWorkSchedule(project)
        && project.workMode === workMode
        && (project.deliveryScheduledFor || project.installationScheduledFor) === deliveryDate
        && (project.deliveryScheduledTime || project.installationScheduledTime) === deliveryTime
        && (!includesDelivery || project.deliveryAssignee === deliveryAssignee)
        && (!includesInstallation || project.installationAssignee === installationAssignee);
      return (
        <div className={`${styles.actionPanel} ${styles.scheduleActionPanel}`}>
          <div className={styles.scheduleActionHeader}>
            <div className={styles.actionHeading}><span><Wrench size={17} /></span><strong>Working in Progress</strong></div>
            <span className={hasActiveWorkSchedule(project) ? styles.scheduleSyncBadge : styles.unscheduledBadge}>
              <CalendarDays size={14} /> {hasActiveWorkSchedule(project) ? "Scheduled" : project.deliveredAt ? "Delivered" : "Unscheduled"}
            </span>
          </div>
          <div className={styles.scheduleFields}>
            <label className={styles.actionField}>
              Work type
              <select value={workMode} disabled={busy} onChange={(event) => setWorkMode(event.target.value as PaymentTrackWorkMode)}>
                {!project.deliveredAt ? <option value="delivery_only">Delivery only</option> : null}
                <option value="installation_only">Install only</option>
                {!project.deliveredAt ? <option value="delivery_and_installation">Delivery &amp; Install</option> : null}
              </select>
            </label>
            <label className={styles.actionField}>Date<input type="date" value={deliveryDate} disabled={busy} onChange={(event) => setDeliveryDate(event.target.value)} /></label>
            <label className={styles.actionField}>Time<input type="time" value={deliveryTime} disabled={busy} onChange={(event) => setDeliveryTime(event.target.value)} /></label>
            {includesDelivery ? (
              <label className={styles.actionField}>Delivery person<select value={deliveryAssignee} disabled={busy} onChange={(event) => setDeliveryAssignee(event.target.value as ScheduleAssignee)}><option value="">Select a person</option>{PAYMENT_TRACK_SCHEDULE_ASSIGNEES.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}</select></label>
            ) : null}
            {includesInstallation ? (
              <label className={styles.actionField}>Installer<select value={installationAssignee} disabled={busy} onChange={(event) => setInstallationAssignee(event.target.value as ScheduleAssignee)}><option value="">Select a person</option>{PAYMENT_TRACK_SCHEDULE_ASSIGNEES.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}</select></label>
            ) : null}
          </div>
          {includesDelivery ? (
            <div className={`${styles.deliveryPreparationRow} ${deliverySelectionDraft.length ? styles.deliveryPrepared : ""}`}>
              <span><Warehouse size={17} /></span>
              <strong>{deliverySelectionDraft.length ? `${deliverySelectionDraft.length} warehouse items chosen` : "Choose warehouse items"}</strong>
              <button className={styles.secondaryButton} type="button" disabled={busy} onClick={(event) => openDeliveryPicker(event.currentTarget)}><Warehouse size={14} /> {deliverySelectionDraft.length ? "Edit items" : "Choose items"}</button>
            </div>
          ) : null}
          <div className={`${styles.actionButtons} ${styles.scheduleActionButtons}`}>
            <button className={styles.secondaryButton} type="button" disabled={busy || !scheduleReady} onClick={() => void performAction("schedule_work", {
              workMode,
              deliveryDate,
              deliveryTime,
              ...(includesDelivery ? { deliveryAssignee, selections: deliverySelectionDraft } : {}),
              ...(includesInstallation ? { installationAssignee } : {}),
              expectedUpdatedAt: project.updatedAt,
            }, "Work scheduled and added to Weekly Schedule.")}>
              <CalendarDays size={15} /> {hasActiveWorkSchedule(project) ? "Update Schedule" : "Schedule Work"}
            </button>
            <button className={styles.primaryButton} type="button" disabled={busy || !savedScheduleMatches} onClick={() => void performAction("mark_work_completed", {}, workMode === "delivery_only" ? "Delivery marked complete." : "Installation marked complete.")}>
              <CheckCircle2 size={15} /> {workMode === "delivery_only" ? "Mark Delivered" : workMode === "installation_only" ? "Mark Installed" : "Mark Delivered & Installed"}
            </button>
          </div>
        </div>
      );
    }

    if (project.stage === "material_delivery" && !project.deliveredAt) {
      const deliveryScheduled = hasDeliverySchedule(project);
      const deliveryRequest = hasDeliveryScheduleRequest(project) ? project.deliveryScheduleRequest : null;
      const deliveryPrepared = deliverySelectionDraft.length > 0;

      if (role === "sales" && !deliveryScheduled) {
        return (
          <div className={`${styles.actionPanel} ${styles.scheduleActionPanel}`}>
            <div className={styles.scheduleActionHeader}>
              <div className={styles.actionHeading}>
                <span><Truck size={17} /></span>
                <strong>Material delivery preference</strong>
              </div>
              <span className={styles.salesRequestBadge}>Sales request</span>
            </div>
            <div className={`${styles.deliveryPreparationRow} ${deliveryPrepared ? styles.deliveryPrepared : ""}`}>
              <span><Warehouse size={17} /></span>
              <strong>{deliveryPrepared ? "Warehouse items chosen" : "Warehouse item selection required"}</strong>
              <button className={styles.secondaryButton} type="button" disabled={busy} onClick={(event) => openDeliveryPicker(event.currentTarget)}>
                <Warehouse size={14} /> {deliveryPrepared ? "Edit items" : "Choose items"}
              </button>
            </div>
            <div className={styles.preferenceSubmitRow}>
              <div className={styles.preferenceFields}>
                <label className={styles.actionField}>
                  Preferred delivery date
                  <input type="date" value={deliveryDate} disabled={busy} onChange={(event) => setDeliveryDate(event.target.value)} />
                </label>
                <label className={styles.actionField}>
                  Preferred delivery time
                  <input type="time" value={deliveryTime} disabled={busy} onChange={(event) => setDeliveryTime(event.target.value)} />
                </label>
                <label className={`${styles.actionField} ${styles.preferenceNotesField}`}>
                  Notes
                  <textarea
                    value={deliveryNotes}
                    disabled={busy}
                    maxLength={2000}
                    rows={1}
                    onChange={(event) => setDeliveryNotes(event.target.value)}
                  />
                </label>
              </div>
              <div className={`${styles.actionButtons} ${styles.scheduleActionButtons}`}>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={busy || !deliveryPrepared || !deliveryDate || !deliveryTime}
                  onClick={() => void performAction(
                    "pre_schedule_delivery",
                    {
                      selections: deliverySelectionDraft,
                      preferredDate: deliveryDate,
                      preferredTime: deliveryTime,
                      notes: deliveryNotes,
                      expectedUpdatedAt: project.updatedAt,
                    },
                    deliveryRequest
                      ? "Delivery request updated for Project Manager review."
                      : "Delivery request sent to Weekly Schedule for Project Manager review.",
                  )}
                >
                  {busy ? <LoaderCircle className={styles.spinning} size={15} /> : <CalendarDays size={15} />}
                  {deliveryRequest ? "Update request" : "Send to Weekly Schedule"}
                </button>
              </div>
            </div>
          </div>
        );
      }

      if (role !== "pm") {
        return (
          <ReadOnlyNextStep
            owner={deliveryRequest ? "Project Manager" : "Sales"}
            label={deliveryRequest
              ? "Review the Sales delivery preference and confirm the final schedule."
              : "Choose delivery items and submit a preferred delivery date and time."}
            allowContinue={authenticatedRole === "admin"}
            buttonLabel={deliveryRequest ? "Continue as Project Manager" : "Continue as Sales"}
            onContinue={() => selectRole(deliveryRequest ? "pm" : "sales")}
          />
        );
      }

      if (!deliveryRequest && !deliveryScheduled) {
        return (
          <ReadOnlyNextStep
            owner="Sales"
            label="Sales must choose the warehouse items and send a preferred delivery date and time before PM scheduling."
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Sales"
            onContinue={() => selectRole("sales")}
          />
        );
      }

      return (
        <div className={`${styles.actionPanel} ${styles.scheduleActionPanel}`}>
          <div className={styles.scheduleActionHeader}>
            <div className={styles.actionHeading}>
              <span><Truck size={17} /></span>
              <strong>{deliveryScheduled ? "Material delivery scheduled" : "Review material delivery request"}</strong>
            </div>
            <span className={deliveryScheduled ? styles.scheduleSyncBadge : styles.preScheduledBadge}>
              <CalendarDays size={14} /> {deliveryScheduled ? "Scheduled" : "Pre-scheduled"}
            </span>
          </div>
          <div className={styles.scheduleRequestSummary}>
            <span><Clock3 size={17} /></span>
            <div>
              <strong>Sales preference</strong>
              <small>{deliveryRequest
                ? `${formatScheduledAt(deliveryRequest.preferredDate, deliveryRequest.preferredTime)} · Submitted by ${deliveryRequest.submittedBy}`
                : "Legacy schedule — no Sales preference was recorded."}</small>
              {deliveryRequest?.notes ? <p>{deliveryRequest.notes}</p> : null}
            </div>
          </div>
          <div className={styles.scheduleFields}>
            <label className={styles.actionField}>
              Confirmed delivery date
              <input
                type="date"
                value={deliveryDate}
                disabled={busy}
                onChange={(event) => setDeliveryDate(event.target.value)}
              />
            </label>
            <label className={styles.actionField}>
              Confirmed delivery time
              <input
                type="time"
                value={deliveryTime}
                disabled={busy}
                onChange={(event) => setDeliveryTime(event.target.value)}
              />
            </label>
            <label className={styles.actionField}>
              Delivery person
              <select
                value={deliveryAssignee}
                disabled={busy}
                onChange={(event) => setDeliveryAssignee(event.target.value as ScheduleAssignee)}
              >
                <option value="">Select a person</option>
                {PAYMENT_TRACK_SCHEDULE_ASSIGNEES.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
              </select>
            </label>
          </div>
          <div className={`${styles.actionButtons} ${styles.scheduleActionButtons}`}>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={busy || (!deliveryScheduled && !project.deliverySelections.length) || !deliveryDate || !deliveryTime || !deliveryAssignee}
              onClick={() => void performAction(
                "schedule_delivery",
                { deliveryDate, deliveryTime, deliveryAssignee, expectedUpdatedAt: project.updatedAt },
                "Delivery schedule saved and Weekly Schedule task updated.",
              )}
            >
              {busy ? <LoaderCircle className={styles.spinning} size={15} /> : <CalendarDays size={15} />}
              {deliveryScheduled ? "Update Schedule" : "Confirm Schedule"}
            </button>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={
                busy
                || !hasDeliverySchedule(project)
                || deliveryDate !== project.deliveryScheduledFor
                || deliveryTime !== project.deliveryScheduledTime
                || deliveryAssignee !== project.deliveryAssignee
              }
              onClick={() => void performAction("mark_delivered", {}, "Materials marked as delivered. Sales can now acknowledge payment receipt.")}
            >
              <PackageCheck size={15} /> Mark Delivered
            </button>
          </div>
        </div>
      );
    }

    if (
      project.stage === "material_delivery"
      && !project.collection.acknowledgedAt
      && !project.collection.proof
    ) {
      if (role !== "sales") {
        return (
          <ReadOnlyNextStep
            owner="Sales"
            label="Acknowledge that the customer’s payment has been received."
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Sales"
            onContinue={() => selectRole("sales")}
          />
        );
      }
      return (
        <SimpleAction
          icon={<Banknote size={18} />}
          title="Customer payment received"
          button="Payment Received"
          busy={busy}
          onClick={() => void performAction(
            "acknowledge_collection",
            {},
            "Payment marked as received. Administrator can now record the actual amount.",
          )}
        />
      );
    }

    if (project.stage === "material_delivery") {
      if (role !== "admin") {
        return (
          <ReadOnlyNextStep
            owner="Administrator"
            label="Confirm collection and record the actual amount received."
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Administrator"
            onContinue={() => selectRole("admin")}
          />
        );
      }
      return (
        <AmountAction
          amount={actionAmount}
          busy={busy}
          label="Actual collection received"
          buttonLabel="Collection Confirmed"
          onAmount={setActionAmount}
          onSubmit={() => confirmAmount("confirm_collection", "Collection")}
        />
      );
    }

    if (project.stage === "installing") {
      const installationScheduled = hasInstallationSchedule(project);
      const installationRequest = project.installationScheduleRequest;

      if (role === "sales" && !installationScheduled) {
        return (
          <div className={`${styles.actionPanel} ${styles.scheduleActionPanel}`}>
            <div className={styles.scheduleActionHeader}>
              <div className={styles.actionHeading}>
                <span><Wrench size={17} /></span>
                <strong>Installment preference</strong>
              </div>
              <span className={styles.salesRequestBadge}>Sales request</span>
            </div>
            <div className={styles.preferenceSubmitRow}>
              <div className={styles.preferenceFields}>
                <label className={styles.actionField}>
                  Preferred installment date
                  <input type="date" value={installationDate} disabled={busy} onChange={(event) => setInstallationDate(event.target.value)} />
                </label>
                <label className={styles.actionField}>
                  Preferred installment time
                  <input type="time" value={installationTime} disabled={busy} onChange={(event) => setInstallationTime(event.target.value)} />
                </label>
                <label className={`${styles.actionField} ${styles.preferenceNotesField}`}>
                  Notes
                  <textarea
                    value={installationNotes}
                    disabled={busy}
                    maxLength={2000}
                    rows={1}
                    onChange={(event) => setInstallationNotes(event.target.value)}
                  />
                </label>
              </div>
              <div className={`${styles.actionButtons} ${styles.scheduleActionButtons}`}>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={busy || !installationDate || !installationTime}
                  onClick={() => void performAction(
                    "pre_schedule_installation",
                    {
                      preferredDate: installationDate,
                      preferredTime: installationTime,
                      notes: installationNotes,
                      expectedUpdatedAt: project.updatedAt,
                    },
                    installationRequest
                      ? "Installment request updated for Project Manager review."
                      : "Installment request sent to Weekly Schedule for Project Manager review.",
                  )}
                >
                  {busy ? <LoaderCircle className={styles.spinning} size={15} /> : <CalendarDays size={15} />}
                  {installationRequest ? "Update request" : "Send to Weekly Schedule"}
                </button>
              </div>
            </div>
          </div>
        );
      }

      if (role !== "pm") {
        return (
          <ReadOnlyNextStep
            owner={installationRequest ? "Project Manager" : "Sales"}
            label={installationRequest
              ? "Review the Sales installment preference and confirm the final schedule."
              : "Submit the customer’s preferred installment date and time."}
            allowContinue={authenticatedRole === "admin"}
            buttonLabel={installationRequest ? "Continue as Project Manager" : "Continue as Sales"}
            onContinue={() => selectRole(installationRequest ? "pm" : "sales")}
          />
        );
      }

      if (!installationRequest && !installationScheduled) {
        return (
          <ReadOnlyNextStep
            owner="Sales"
            label="Sales must send a preferred installment date and time before PM scheduling."
            allowContinue={authenticatedRole === "admin"}
            buttonLabel="Continue as Sales"
            onContinue={() => selectRole("sales")}
          />
        );
      }

      return (
        <div className={`${styles.actionPanel} ${styles.scheduleActionPanel}`}>
          <div className={styles.scheduleActionHeader}>
            <div className={styles.actionHeading}>
              <span><Wrench size={17} /></span>
              <strong>{installationScheduled ? "Installment scheduled" : "Review installment request"}</strong>
            </div>
            <span className={installationScheduled ? styles.scheduleSyncBadge : styles.preScheduledBadge}>
              <CalendarDays size={14} /> {installationScheduled ? "Scheduled" : "Pre-scheduled"}
            </span>
          </div>
          <div className={styles.scheduleRequestSummary}>
            <span><Clock3 size={17} /></span>
            <div>
              <strong>Sales preference</strong>
              <small>{installationRequest
                ? `${formatScheduledAt(installationRequest.preferredDate, installationRequest.preferredTime)} · Submitted by ${installationRequest.submittedBy}`
                : "Legacy schedule — no Sales preference was recorded."}</small>
              {installationRequest?.notes ? <p>{installationRequest.notes}</p> : null}
            </div>
          </div>
          <div className={styles.scheduleFields}>
            <label className={styles.actionField}>
              Confirmed installment date
              <input
                type="date"
                value={installationDate}
                disabled={busy}
                onChange={(event) => setInstallationDate(event.target.value)}
              />
            </label>
            <label className={styles.actionField}>
              Confirmed installment time
              <input
                type="time"
                value={installationTime}
                disabled={busy}
                onChange={(event) => setInstallationTime(event.target.value)}
              />
            </label>
            <label className={styles.actionField}>
              Installer
              <select
                value={installationAssignee}
                disabled={busy}
                onChange={(event) => setInstallationAssignee(event.target.value as ScheduleAssignee)}
              >
                <option value="">Select an installer</option>
                {PAYMENT_TRACK_SCHEDULE_ASSIGNEES.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
              </select>
            </label>
          </div>
          <div className={`${styles.actionButtons} ${styles.scheduleActionButtons}`}>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={busy || !installationDate || !installationTime || !installationAssignee}
              onClick={() => void performAction(
                "schedule_installation",
                { installationDate, installationTime, installationAssignee, expectedUpdatedAt: project.updatedAt },
                "Installment schedule saved and Weekly Schedule task updated.",
              )}
            >
              {busy ? <LoaderCircle className={styles.spinning} size={15} /> : <CalendarDays size={15} />}
              {installationScheduled ? "Update Schedule" : "Confirm Schedule"}
            </button>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={
                busy
                || !hasInstallationSchedule(project)
                || installationDate !== project.installationScheduledFor
                || installationTime !== project.installationScheduledTime
                || installationAssignee !== project.installationAssignee
              }
              onClick={() => void performAction("mark_installed", {}, "Installment marked complete. Project moved to Waiting COES.")}
            >
              <Wrench size={15} /> Mark Installed
            </button>
          </div>
        </div>
      );
    }

    if (project.stage === "waiting_coes") {
      return (
        <div className={styles.parallelWorkflow}>
          <div className={styles.parallelWorkflowIntro}>
            <div>
              <strong>COES workflow</strong>
            </div>
          </div>
          <div className={styles.parallelWorkflowGrid}>
            <ParallelActionCard
              icon={<FileCheck2 size={18} />}
              owner="Project Manager"
              title="Certificate of Electrical Safety"
            >
              {project.coesReceivedAt ? (
                <div className={styles.parallelComplete}><CheckCircle2 size={15} /> COES received</div>
              ) : role === "pm" ? (
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={busy}
                  onClick={() => requestWorkflowConfirmation({
                    action: "mark_coes_received",
                    title: "Confirm COES received?",
                    description: "This records the COES as received and moves the project to STC Rebate. Any outstanding final payment remains open and can still be recorded there.",
                    confirmLabel: "Yes, Confirm COES",
                    successMessage: "COES received. Project moved to the next stage.",
                  })}
                >
                  <FileCheck2 size={16} /> COES Received
                </button>
              ) : authenticatedRole === "admin" ? (
                <button className={styles.secondaryButton} type="button" onClick={() => selectRole("pm")}>
                  Continue as Project Manager <ChevronRight size={15} />
                </button>
              ) : (
                <span className={styles.roleWaitHint}>Waiting for Project Manager confirmation.</span>
              )}
            </ParallelActionCard>
          </div>
        </div>
      );
    }

    if (project.stage === "stc_rebate") {
      const canConfirmStc = role === "admin";
      return (
        <div className={styles.parallelWorkflow}>
          <div className={styles.parallelWorkflowIntro}>
            <div>
              <strong>Rebate receipts</strong>
            </div>
          </div>
          <div className={`${styles.parallelWorkflowGrid} ${styles.singleParallelTask}`}>
            <ParallelActionCard
              icon={<BadgeCheck size={18} />}
              owner="Administrator"
              title="Rebate receipts"
              wide
            >
              <div className={styles.stcActions}>
                <StcAction
                  label="Solar STC"
                  required={project.stcSolarRequired}
                  received={Boolean(project.stcSolarReceivedAt)}
                  busy={busy}
                  canConfirm={canConfirmStc}
                  canSwitchRole={authenticatedRole === "admin"}
                  onClick={() => requestWorkflowConfirmation({
                    action: "confirm_stc_solar",
                    title: "Confirm Solar STC received?",
                    description: "Only confirm after the Solar STC payment has been received. If this is the final required rebate receipt, the project will move to Done.",
                    confirmLabel: "Confirm Solar STC",
                    successMessage: "Solar STC payment confirmed.",
                  })}
                  onSwitchRole={() => selectRole("admin")}
                />
                <StcAction
                  label="Battery STC"
                  required={project.stcBatteryRequired}
                  received={Boolean(project.stcBatteryReceivedAt)}
                  busy={busy}
                  canConfirm={canConfirmStc}
                  canSwitchRole={authenticatedRole === "admin"}
                  onClick={() => requestWorkflowConfirmation({
                    action: "confirm_stc_battery",
                    title: "Confirm Battery STC received?",
                    description: "Only confirm after the Battery STC payment has been received. If this is the final required rebate receipt, the project will move to Done.",
                    confirmLabel: "Confirm Battery STC",
                    successMessage: "Battery STC payment confirmed.",
                  })}
                  onSwitchRole={() => selectRole("admin")}
                />
                <StcAction
                  label="Solar Rebate"
                  required={project.solarRebateRequired}
                  received={Boolean(project.solarRebateReceivedAt)}
                  busy={busy}
                  canConfirm={canConfirmStc}
                  canSwitchRole={authenticatedRole === "admin"}
                  onClick={() => requestWorkflowConfirmation({
                    action: "confirm_solar_rebate",
                    title: "Confirm Solar Rebate received?",
                    description: "Only confirm after the Solar Rebate payment has been received. If this is the final required rebate receipt, the project will move to Done.",
                    confirmLabel: "Confirm Solar Rebate",
                    successMessage: "Solar Rebate payment confirmed.",
                  })}
                  onSwitchRole={() => selectRole("admin")}
                />
              </div>
            </ParallelActionCard>
          </div>
        </div>
      );
    }

    return <ReadOnlyNextStep owner={status.owner} label={status.label} />;
  };

  return (
    <section className={styles.workspace} aria-labelledby="payment-track-title">
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>ACCOUNTS RECEIVABLE</span>
          <h1 id="payment-track-title">Project Track</h1>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.primaryButton} type="button" onClick={(event) => openAdd(event.currentTarget)}>
            <Plus size={16} /> Add Project
          </button>
        </div>
      </header>

      <div className={styles.metrics} aria-label="Project Track summary">
        <article>
          <span className={styles.metricIcon}><CircleDollarSign size={19} /></span>
          <div><small>Original Receivable</small><strong>{formatMoney(metrics.receivable)}</strong></div>
        </article>
        <article>
          <span className={`${styles.metricIcon} ${styles.blue}`}><WalletCards size={19} /></span>
          <div><small>Amount Outstanding</small><strong>{formatMoney(metrics.outstanding)}</strong></div>
        </article>
        <article>
          <span className={`${styles.metricIcon} ${styles.amber}`}><ShieldCheck size={19} /></span>
          <div><small>Awaiting Admin</small><strong>{metrics.adminReview}</strong></div>
        </article>
        <article>
          <span className={`${styles.metricIcon} ${styles.violet}`}><Clock3 size={19} /></span>
          <div><small>Active Projects</small><strong>{metrics.active}</strong></div>
        </article>
      </div>

      {notice && !selected ? (
        <div className={styles.notice} role="status">
          <CheckCircle2 size={16} /><span>{notice}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={14} /></button>
        </div>
      ) : null}
      {error && (!selected || showAdminLogin || workflowConfirmation) ? (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} /><span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}><X size={14} /></button>
        </div>
      ) : null}

      <div className={styles.boardToolbar}>
        <label className={styles.searchField}>
          <Search size={16} />
          <input
            aria-label="Search Project Track projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search customer, proposal, sales representative or item…"
          />
        </label>
        <div className={styles.toolbarMeta}>
          <div className={styles.viewToggle} role="group" aria-label="Project Track view">
            <button
              type="button"
              className={viewMode === "board" ? styles.activeView : ""}
              aria-pressed={viewMode === "board"}
              onClick={() => setViewMode("board")}
            >
              <LayoutGrid size={15} /> Board
            </button>
            <button
              type="button"
              className={viewMode === "list" ? styles.activeView : ""}
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              <ListIcon size={16} /> List
            </button>
          </div>
          <span aria-live="polite" aria-atomic="true">
            {viewMode === "list" ? listProjects.length : filtered.length}{" "}
            {(viewMode === "list" ? listProjects.length : filtered.length) === 1 ? "project" : "projects"}
          </span>
          <button type="button" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw className={refreshing ? styles.spinning : ""} size={15} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.loadingState}><LoaderCircle className={styles.spinning} size={20} /> Loading projects…</div>
      ) : viewMode === "list" ? (
        <section className={styles.listView} aria-label="Project Track list view">
          <nav className={styles.listStageTabs} aria-label="Filter projects by stage">
            <button
              type="button"
              className={listStage === "all" ? styles.activeListStage : ""}
              aria-pressed={listStage === "all"}
              onClick={() => setListStage("all")}
            >
              <span>All</span><b>{filtered.length}</b>
            </button>
            {STAGES.map((stage) => {
              const count = filtered.filter((project) => project.stage === stage.id).length;
              return (
                <button
                  key={stage.id}
                  type="button"
                  className={`${styles[stage.tone]} ${listStage === stage.id ? styles.activeListStage : ""}`}
                  aria-pressed={listStage === stage.id}
                  onClick={() => setListStage(stage.id)}
                >
                  <span>{stage.title}</span><b>{count}</b>
                </button>
              );
            })}
          </nav>

          <div className={styles.listHeader} aria-hidden="true">
            <span>Project</span><span>Stage</span><span>Amount due</span><span>Next owner</span><span>Next action</span><span />
          </div>
          <div className={styles.projectList}>
            {listProjects.map((project) => {
              const status = projectStatus(project);
              const nextStep = projectNextStep(project);
              const canContinue = nextStep.roles.includes(role);
              const pendingPaymentCount = pendingPaymentReviewCount(project);
              const isSettledDone = project.stage === "done"
                && project.outstandingCents === 0
                && pendingPaymentCount === 0;
              const finalPaymentOverdue = isFinalPaymentOverdue(project, finalPaymentStatusNow);
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`${styles.projectListRow} ${isSettledDone ? styles.settledListRow : ""} ${finalPaymentOverdue ? styles.overdueFinalPaymentListRow : ""}`}
                  onClick={(event) => openProject(project, event.currentTarget)}
                  aria-label={`Open ${customerName(project)}, ${displayedProjectStage(project)}, ${formatMoney(project.outstandingCents)} due${pendingPaymentCount ? `, ${pendingPaymentCount} payment${pendingPaymentCount === 1 ? "" : "s"} awaiting Admin` : ""}${finalPaymentOverdue ? ", final payment overdue" : ""}, next owner ${status.owner}, next action ${nextStep.label}`}
                >
                  <span className={styles.listProjectIdentity}>
                    <strong>{customerName(project)}</strong>
                    <small>Proposal {project.quoteNumber}</small>
                    <small><MapPin size={12} /> {customerAddress(project)}</small>
                  </span>
                  <span className={`${styles.listStageBadge} ${styles[displayedProjectStageTone(project)]}`}>
                    {displayedProjectStage(project)}
                  </span>
                  <span className={styles.listAmount}>
                    <strong>{formatMoney(project.outstandingCents)}</strong>
                    {project.overpaymentCents > 0 ? <small>{formatMoney(project.overpaymentCents)} overpaid</small> : null}
                    {pendingPaymentCount ? (
                      <span className={styles.listPaymentReview}><Banknote size={12} /> Payment · Awaiting Admin{pendingPaymentCount > 1 ? ` · ${pendingPaymentCount}` : ""}</span>
                    ) : null}
                  </span>
                  <span className={styles.listOwner}>
                    <strong>{status.owner}</strong>
                    <small>Sales: {project.specialist.name || "—"}</small>
                  </span>
                  <span className={styles.listNextAction}>
                    <strong className={canContinue ? styles.listActionReady : ""}>{nextStep.label}</strong>
                    <small>{status.label}</small>
                  </span>
                  <ChevronRight className={styles.listOpenIcon} size={17} />
                </button>
              );
            })}
            {!listProjects.length ? (
              <div className={styles.emptyList}>
                <FileText size={20} />
                <strong>No projects in this view</strong>
                <span>
                  {query
                    ? "No projects match this search and stage."
                    : listStage === "all"
                      ? "No projects have been added yet."
                      : `No projects are currently in ${stageLabel(listStage)}.`}
                </span>
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <>
          {boardPosition.canScrollLeft || boardPosition.canScrollRight ? (
            <nav className={styles.boardNavigation} aria-label="Move between Project Track stages">
              <button
                type="button"
                disabled={!boardPosition.canScrollLeft}
                onClick={() => scrollToBoardStage(boardPosition.stageIndex - 1)}
                aria-label="Previous stage"
              >
                <ChevronLeft size={17} />
              </button>
              <div ref={stageJumpListRef} className={styles.stageJumpList}>
                {STAGES.map((stage, index) => (
                  <button
                    key={stage.id}
                    data-stage-jump={stage.id}
                    type="button"
                    className={boardPosition.stageIndex === index ? styles.activeStageJump : ""}
                    aria-current={boardPosition.stageIndex === index ? "true" : undefined}
                    onClick={() => scrollToBoardStage(index)}
                  >
                    {stage.title}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={!boardPosition.canScrollRight}
                onClick={() => scrollToBoardStage(boardPosition.stageIndex + 1)}
                aria-label="Next stage"
              >
                <ChevronRight size={17} />
              </button>
            </nav>
          ) : null}
          <div
            ref={boardScrollerRef}
            className={styles.boardScroller}
            tabIndex={0}
            aria-label="Payment workflow board"
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget
                || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
              event.preventDefault();
              scrollToBoardStage(boardPosition.stageIndex + (event.key === "ArrowRight" ? 1 : -1));
            }}
          >
            <div className={styles.board}>
              {STAGES.map((column) => {
              const columnProjects = filtered
                .filter((project) => project.stage === column.id)
                .sort(compareProjectsByOutstanding);
              return (
                <section data-payment-stage={column.id} className={`${styles.column} ${styles[column.tone]}`} key={column.id} aria-labelledby={`column-${column.id}`}>
                  <header>
                    <span className={styles.columnDot} aria-hidden="true" />
                    <div>
                      <h2 id={`column-${column.id}`}>{column.title}</h2>
                    </div>
                    <b>{columnProjects.length}</b>
                  </header>
                  <div className={styles.cardList}>
                    {columnProjects.map((project) => {
                      const status = projectStatus(project);
                      const hasCurrentScheduleStatus = projectHasScheduledCurrentStage(project)
                        || projectHasPreScheduledCurrentStage(project)
                        || projectHasUnscheduledCurrentStage(project);
                      const scheduleWorkflowStatus = hasCurrentScheduleStatus
                        ? { label: displayedProjectStage(project), tone: displayedProjectStageTone(project) }
                        : null;
                      const nextStep = projectNextStep(project);
                      const canContinue = nextStep.roles.includes(role);
                      const pendingPaymentCount = pendingPaymentReviewCount(project);
                      const isSettledDone = project.stage === "done"
                        && project.outstandingCents === 0
                        && pendingPaymentCount === 0;
                      const finalPaymentOverdue = isFinalPaymentOverdue(project, finalPaymentStatusNow);
                      return (
                        <button
                          className={`${styles.projectCard} ${isSettledDone ? styles.settledDoneCard : ""} ${finalPaymentOverdue ? styles.overdueFinalPaymentCard : ""}`}
                          key={project.id}
                          type="button"
                          onClick={(event) => openProject(project, event.currentTarget)}
                          aria-label={`Open ${customerName(project)}, proposal ${project.quoteNumber}${pendingPaymentCount ? `, ${pendingPaymentCount} payment${pendingPaymentCount === 1 ? "" : "s"} awaiting Admin` : ""}${finalPaymentOverdue ? ", final payment overdue" : ""}`}
                        >
                          {isSettledDone ? (
                            <>
                              <h3>{customerName(project)}</h3>
                              <p className={styles.cardAddress}><MapPin size={13} /> {customerAddress(project)}</p>
                              <div className={styles.settledCardStatus}>
                                <span className={`${styles.substatus} ${styles.green}`}>Project complete</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className={styles.cardTopline}>
                                <span>Proposal {project.quoteNumber}</span>
                              </div>
                              <h3>{customerName(project)}</h3>
                              <p className={styles.cardAddress}><MapPin size={13} /> {customerAddress(project)}</p>
                              <div className={styles.amountDue}>
                                <span>Amount Due</span>
                                <strong>{formatMoney(project.outstandingCents)}</strong>
                                {project.overpaymentCents > 0 ? <small>{formatMoney(project.overpaymentCents)} overpaid</small> : null}
                              </div>
                              <div className={styles.cardMeta}>
                                <span><UserRound size={13} /> {project.specialist.name}</span>
                                <span><Boxes size={13} /> {project.items.length} {project.items.length === 1 ? "item" : "items"}</span>
                              </div>
                              {pendingPaymentCount ? (
                                <div className={styles.cardPaymentReview}>
                                  <Banknote size={13} />
                                  <span>Payment · Awaiting Admin</span>
                                  {pendingPaymentCount > 1 ? <b>{pendingPaymentCount}</b> : null}
                                </div>
                              ) : null}
                              {project.stage === "material_delivery" && (project.deliveryScheduledFor || project.deliveryScheduleRequest) ? (
                                <div className={styles.cardSchedule}>
                                  <span><CalendarDays size={13} /> {formatScheduledAt(
                                    project.deliveryScheduledFor || project.deliveryScheduleRequest?.preferredDate || null,
                                    project.deliveryScheduledTime || project.deliveryScheduleRequest?.preferredTime || null,
                                  )}</span>
                                  <strong><UserRound size={13} /> {project.deliveryAssignee || "PM review"}</strong>
                                </div>
                              ) : null}
                              {project.stage === "installing" && (project.installationScheduledFor || project.installationScheduleRequest) ? (
                                <div className={styles.cardSchedule}>
                                  <span><CalendarDays size={13} /> {formatScheduledAt(
                                    project.installationScheduledFor || project.installationScheduleRequest?.preferredDate || null,
                                    project.installationScheduledTime || project.installationScheduleRequest?.preferredTime || null,
                                  )}</span>
                                  <strong><UserRound size={13} /> {project.installationAssignee || "PM review"}</strong>
                                </div>
                              ) : null}
                              <div className={styles.cardFooter}>
                                <span className={`${styles.substatus} ${styles[scheduleWorkflowStatus?.tone || status.tone]}`}>
                                  {scheduleWorkflowStatus?.label || status.label}
                                </span>
                                <small>{status.owner}</small>
                              </div>
                              <span className={`${styles.cardNextStep} ${canContinue ? styles.cardNextReady : ""}`}>
                                <span>{nextStep.label}</span>
                                <strong>{canContinue ? "Continue" : "Open next step"} <ChevronRight size={14} /></strong>
                              </span>
                            </>
                          )}
                        </button>
                      );
                    })}
                    {!columnProjects.length ? (
                      <div className={styles.emptyColumn}>
                        <span><FileText size={17} /></span>
                        <p>{query ? "No matching projects" : "No projects in this stage"}</p>
                      </div>
                    ) : null}
                  </div>
                </section>
              );
              })}
            </div>
          </div>
        </>
      )}

      {workflowConfirmation && selected ? (
        <div className={styles.backdrop} onMouseDown={closeFromBackdrop}>
          <div
            className={`${styles.modal} ${styles.confirmModal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-confirmation-title"
            aria-describedby="workflow-confirmation-description"
          >
            <header>
              <div><span>Confirm workflow update</span><h2 id="workflow-confirmation-title">{workflowConfirmation.title}</h2></div>
              <button type="button" aria-label="Close" disabled={busy} onClick={closeWorkflowConfirmation}><X size={19} /></button>
            </header>
            <div className={styles.confirmationBody}>
              <span className={styles.confirmationIcon}><BadgeCheck size={24} /></span>
              <div className={styles.confirmationContent}>
                <p id="workflow-confirmation-description">{workflowConfirmation.description}</p>
                {workflowConfirmation.requiresReason ? (
                  <label className={styles.overrideReasonField}>
                    Override reason
                    <textarea
                      autoFocus
                      required
                      maxLength={PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH}
                      rows={3}
                      value={workflowReason}
                      onChange={(event) => setWorkflowReason(event.target.value)}
                      placeholder="Explain why this stage was completed outside ERP"
                    />
                    <small>{workflowReason.trim().length} / {PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH}</small>
                  </label>
                ) : null}
              </div>
            </div>
            <footer className={styles.confirmationFooter}>
              <button
                autoFocus={!workflowConfirmation.requiresReason}
                className={styles.secondaryButton}
                type="button"
                disabled={busy}
                onClick={closeWorkflowConfirmation}
              >
                Cancel
              </button>
              <button
                className={styles.primaryButton}
                type="button"
                disabled={busy || Boolean(workflowConfirmation.requiresReason && !workflowReason.trim())}
                onClick={confirmWorkflowAction}
              >
                {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <CheckCircle2 size={16} />}
                {workflowConfirmation.confirmLabel}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {showAdd ? (
        <div className={styles.backdrop} onMouseDown={closeFromBackdrop}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="add-project-title">
            <header>
              <div><span>Sales workspace</span><h2 id="add-project-title">Add project</h2></div>
              <button type="button" aria-label="Close" disabled={busy} onClick={() => setShowAdd(false)}><X size={19} /></button>
            </header>
            <div className={styles.modalTabs} role="tablist" aria-label="Project entry method">
              <button
                className={addMode === "agreement" ? styles.activeTab : ""}
                type="button"
                role="tab"
                aria-selected={addMode === "agreement"}
                onClick={() => setAddMode("agreement")}
              >
                <UploadCloud size={16} /> Upload Proposal
              </button>
              <button
                className={addMode === "manual" ? styles.activeTab : ""}
                type="button"
                role="tab"
                aria-selected={addMode === "manual"}
                onClick={() => setAddMode("manual")}
              >
                <Plus size={16} /> Manual Entry
              </button>
            </div>

            {addMode === "agreement" ? (
              <form className={styles.importForm} onSubmit={importAgreement}>
                <div className={styles.importIntro}>
                  <span><FileCheck2 size={22} /></span>
                  <strong>Import a Solar Proposal</strong>
                </div>
                <label className={styles.uploadField}>
                  <input
                    autoFocus
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(event) => setAgreement(event.target.files?.[0] ?? null)}
                  />
                  <span><UploadCloud size={21} /></span>
                  <strong>{agreement?.name || "Choose Solar Proposal PDF"}</strong>
                  <small>{agreement ? fileSize(agreement.size) : "PDF · maximum 15 MB"}</small>
                </label>
                <footer className={styles.modalFooter}>
                  <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setShowAdd(false)}>Cancel</button>
                  <button className={styles.primaryButton} type="submit" disabled={busy || !agreement}>
                    {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <UploadCloud size={16} />}
                    Import Proposal
                  </button>
                </footer>
              </form>
            ) : (
              <form className={styles.manualForm} onSubmit={createManualProject}>
                <div className={styles.formSection}>
                  <h3>Project ownership</h3>
                  <div className={styles.formGrid}>
                    <label>Proposal number<input autoFocus required name="quoteNumber" placeholder="e.g. CPEC5270" /></label>
                    <label>Sales name<input required name="specialistName" placeholder="Project owner" /></label>
                    <label className={styles.fullField}>Sales phone<input name="specialistPhone" inputMode="tel" placeholder="Mobile number" /></label>
                  </div>
                </div>
                <div className={styles.formSection}>
                  <h3>Customer details</h3>
                  <div className={styles.formGrid}>
                    <label>First name<input required name="firstName" /></label>
                    <label>Last name<input required name="lastName" /></label>
                    <label>Phone<input required name="phone" inputMode="tel" /></label>
                    <label>Email<input required name="email" type="email" /></label>
                    <label className={styles.fullField}>Installation address<input required name="addressLine1" /></label>
                    <label>Suburb<input required name="suburb" /></label>
                    <div className={styles.compactFields}>
                      <label>State<input required name="state" defaultValue="VIC" /></label>
                      <label>Postcode<input required name="postcode" inputMode="numeric" /></label>
                    </div>
                  </div>
                </div>
                <div className={styles.formSection}>
                  <h3>Receivable and items</h3>
                  <div className={styles.formGrid}>
                    <label>
                      Balance Due (AUD)
                      <span className={styles.moneyField}><b>$</b><input required name="balanceDue" type="number" min="0" step="0.01" /></span>
                    </label>
                    <label>
                      Expected deposit (optional)
                      <span className={styles.moneyField}><b>$</b><input name="expectedDeposit" type="number" min="0" step="0.01" /></span>
                    </label>
                    <label className={styles.fullField}>
                      Project items
                      <textarea required name="items" rows={4} placeholder={"One item per line: Model | Description | Qty | Capacity\nLR7-54HVH-475M | Solar panel | 14 | 475W"} />
                    </label>
                    <fieldset className={styles.fullField}>
                      <legend>Applicable rebate receipts</legend>
                      <label className={styles.checkbox}><input type="checkbox" name="stcSolarRequired" defaultChecked /> Solar STC</label>
                      <label className={styles.checkbox}><input type="checkbox" name="stcBatteryRequired" /> Battery STC</label>
                      <label className={styles.checkbox}><input type="checkbox" name="solarRebateRequired" /> Solar Rebate required</label>
                    </fieldset>
                  </div>
                </div>
                <footer className={styles.modalFooter}>
                  <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setShowAdd(false)}>Cancel</button>
                  <button className={styles.primaryButton} type="submit" disabled={busy}>
                    {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <Plus size={16} />}
                    Create Project
                  </button>
                </footer>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {showAdminLogin ? (
        <div className={styles.backdrop} onMouseDown={closeFromBackdrop}>
          <div className={`${styles.modal} ${styles.compactModal}`} role="dialog" aria-modal="true" aria-labelledby="admin-login-title">
            <header>
              <div><span>Protected actions</span><h2 id="admin-login-title">Administrator access</h2></div>
              <button type="button" aria-label="Close" disabled={busy} onClick={() => setShowAdminLogin(false)}><X size={19} /></button>
            </header>
            <form className={styles.loginForm} onSubmit={submitAdminLogin}>
              <div className={styles.loginIcon}><ShieldCheck size={23} /></div>
              <label>Administrator password<input autoFocus required type="password" name="password" autoComplete="current-password" /></label>
              {adminSession.demoPassword ? <div className={styles.demoHint}>Local demo password: <strong>{adminSession.demoPassword}</strong></div> : null}
              <footer className={styles.modalFooter}>
                <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setShowAdminLogin(false)}>Cancel</button>
                <button className={styles.primaryButton} type="submit" disabled={busy}>
                  {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <ShieldCheck size={16} />}
                  Enter Admin Mode
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}

      {selected && !showAdminLogin && !workflowConfirmation ? (
        <div className={`${styles.backdrop} ${showDeliveryPicker ? styles.detailPickerBackdrop : ""}`} onMouseDown={closeFromBackdrop}>
          <div
            className={`${styles.detailPickerShell} ${showDeliveryPicker ? styles.detailPickerShellOpen : ""}`}
            role={showDeliveryPicker ? undefined : "dialog"}
            aria-modal={showDeliveryPicker ? undefined : "true"}
            aria-labelledby={showDeliveryPicker ? undefined : "project-detail-title"}
          >
          <div
            className={`${styles.modal} ${styles.detailModal} ${showDeliveryPicker ? styles.detailReferencePane : ""}`}
            aria-hidden={showDeliveryPicker ? "true" : undefined}
          >
            <header className={styles.detailHeader}>
              <div className={styles.detailHeaderMain}>
                <div className={styles.detailHeaderTitle}>
                  <span>Proposal {selected.quoteNumber}</span>
                  <h2 id="project-detail-title">{customerName(selected)}</h2>
                </div>
                <div className={styles.detailHeaderMeta}>
                  <span className={`${styles.stageBadge} ${styles[displayedProjectStageTone(selected)]}`}>
                    {displayedProjectStage(selected)}
                  </span>
                  <span className={styles.detailStatus}>{projectStatus(selected).label}</span>
                </div>
              </div>
              <div className={styles.detailHeaderActions}>
                <span className={styles.roleBadge}>Viewing as {ROLE_LABELS[role]}</span>
                <button type="button" aria-label="Close" disabled={busy} onClick={closeProjectDetail}><X size={19} /></button>
              </div>
            </header>
            <div className={styles.detailBody}>
              {error ? (
                <div className={`${styles.error} ${styles.modalError}`} role="alert">
                  <AlertCircle size={16} />
                  <span>{error}</span>
                  <div className={styles.modalErrorActions}>
                    <button type="button" disabled={busy} onClick={reloadSelectedProject}>
                      <RefreshCw size={14} /> Reload project
                    </button>
                    <button type="button" disabled={busy} aria-label="Dismiss error" onClick={() => setError("")}><X size={14} /></button>
                  </div>
                </div>
              ) : null}
              {notice ? (
                <div className={styles.notice} role="status">
                  <CheckCircle2 size={16} /><span>{notice}</span>
                  <button type="button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={14} /></button>
                </div>
              ) : null}
              <section className={styles.detailAmounts} aria-label="Receivable summary">
                <div><span>Original Balance Due</span><strong>{formatMoney(selected.balanceDueCents)}</strong></div>
                <div><span>Expected Deposit</span><strong>{selected.expectedDepositCents === null ? "—" : formatMoney(selected.expectedDepositCents)}</strong></div>
                <div><span>Deposit Received</span><strong>{selected.deposit.confirmedAmountCents === null ? "—" : formatMoney(selected.deposit.confirmedAmountCents)}</strong></div>
                <div><span>Collection Received</span><strong>{selected.collection.confirmedAmountCents === null ? "—" : formatMoney(selected.collection.confirmedAmountCents)}</strong></div>
                <div><span>Later Payments Received</span><strong>{formatMoney(finalPaymentTotal(selected))}</strong></div>
                <div className={styles.outstandingAmount}>
                  <span>Amount Outstanding</span>
                  <strong>{formatMoney(selected.outstandingCents)}</strong>
                  {selected.overpaymentCents > 0 ? <small>{formatMoney(selected.overpaymentCents)} overpaid</small> : null}
                </div>
              </section>

              {renderActionPanel(selected)}

              {renderPaymentCollection(selected)}

              {authenticatedRole === "admin" && skipStageDetails(selected) ? (() => {
                const skip = skipStageDetails(selected);
                if (!skip) return null;
                return (
                  <div className={`${styles.actionPanel} ${styles.adminSkipPanel}`}>
                    <div className={styles.actionHeading}>
                      <span><SkipForward size={18} /></span>
                      <strong>Administrator stage override</strong>
                    </div>
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      disabled={busy}
                      onClick={() => requestWorkflowConfirmation({
                        action: "skip_stage",
                        title: `Skip ${stageLabel(selected.stage)}?`,
                        description: `${skip.description} This Administrator override cannot be automatically undone.`,
                        confirmLabel: `Skip to ${stageLabel(skip.target)}`,
                        successMessage: `Current stage skipped. Project moved to ${stageLabel(skip.target)}.`,
                        requiresReason: true,
                        expectedUpdatedAt: selected.updatedAt,
                      })}
                    >
                      <SkipForward size={16} /> Skip to {stageLabel(skip.target)}
                    </button>
                  </div>
                );
              })() : null}

              <div className={styles.detailColumns}>
                <section className={styles.detailSection}>
                  <h3><UserRound size={16} /> Customer</h3>
                  <dl>
                    <div><dt>Name</dt><dd>{customerName(selected)}</dd></div>
                    <div><dt>Phone</dt><dd>{selected.customer.phone || "—"}</dd></div>
                    <div><dt>Email</dt><dd>{selected.customer.email || "—"}</dd></div>
                    <div><dt>Installation</dt><dd>{customerAddress(selected)}</dd></div>
                  </dl>
                </section>
                <section className={styles.detailSection}>
                  <h3><ShieldCheck size={16} /> Ownership</h3>
                  <dl>
                    <div><dt>Sales</dt><dd>{selected.specialist.name || "—"}</dd></div>
                    <div><dt>Sales phone</dt><dd>{selected.specialist.phone || "—"}</dd></div>
                    <div>
                      <dt>Material delivery</dt>
                      <dd>
                        {formatScheduledAt(
                          selected.deliveryScheduledFor || selected.deliveryScheduleRequest?.preferredDate || null,
                          selected.deliveryScheduledTime || selected.deliveryScheduleRequest?.preferredTime || null,
                        )}
                        {selected.deliveryAssignee
                          ? ` · ${selected.deliveryAssignee}`
                          : selected.deliveryScheduleRequest ? " · Pre-scheduled" : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Installment</dt>
                      <dd>
                        {formatScheduledAt(
                          selected.installationScheduledFor || selected.installationScheduleRequest?.preferredDate || null,
                          selected.installationScheduledTime || selected.installationScheduleRequest?.preferredTime || null,
                        )}
                        {selected.installationAssignee
                          ? ` · ${selected.installationAssignee}`
                          : selected.installationScheduleRequest ? " · Pre-scheduled" : ""}
                      </dd>
                    </div>
                    <div><dt>Created</dt><dd>{formatDate(selected.createdAt, true)}</dd></div>
                  </dl>
                </section>
              </div>

              <div className={styles.deliveryComparisonGrid}>
                <section className={styles.detailSection}>
                  <h3><Boxes size={16} /> Order Items <span>{selected.items.length}</span></h3>
                  <div className={styles.itemTableScroll}>
                    <table className={styles.itemTable}>
                      <thead><tr><th>Category</th><th>Model</th><th>Description</th><th>Capacity</th><th>Qty</th></tr></thead>
                      <tbody>
                        {selected.items.map((item) => (
                          <tr key={item.id}>
                            <td><span>{item.category || "Item"}</span></td>
                            <td><strong>{item.model || "—"}</strong></td>
                            <td>{item.description || "—"}</td>
                            <td>{item.capacity || "—"}</td>
                            <td>{item.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className={`${styles.detailSection} ${styles.chosenItemsSection}`}>
                  <h3>
                    <PackageCheck size={16} /> Chosen Items <span>{deliverySelectionDraft.length}</span>
                    {((role === "pm"
                      && selected.stage === "working_in_progress"
                      && !selected.deliveredAt
                      && !isPaymentTrackWaitingForRebateQr(selected))
                      || (role === "sales" && selected.stage === "material_delivery" && !selected.deliveredAt && !hasDeliverySchedule(selected))) ? (
                      <button type="button" onClick={(event) => openDeliveryPicker(event.currentTarget)}>{deliverySelectionDraft.length ? "Edit" : "Choose items"}</button>
                    ) : null}
                  </h3>
                  {deliverySelectionDraft.length ? (
                    <ul className={styles.chosenItemsList} aria-label="Chosen warehouse items">
                      {deliverySelectionDraft.map((item) => (
                        <li key={item.sku} title={`${item.sku} × ${item.quantity}`}>
                          <strong>{item.sku}</strong>
                          <span>× {item.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className={styles.chosenItemsEmpty}>
                      <Warehouse size={20} />
                      <strong>No warehouse items chosen</strong>
                    </div>
                  )}
                </section>
              </div>

              <section className={styles.detailSection}>
                <h3><Paperclip size={16} /> Files</h3>
                <div className={styles.fileGrid}>
                  {[
                    selected.contract,
                    selected.deposit.proof,
                    selected.solarRebateQrCode,
                    selected.collection.proof,
                    ...selected.finalPayments.map((payment) => payment.proof),
                  ].filter(Boolean).map((file) => file ? (
                    <a key={file.id} className={styles.fileCard} href={file.url} target="_blank" rel="noreferrer">
                      <span><FileText size={18} /></span>
                      <div><strong>{file.originalName}</strong><small>{file.kind.replaceAll("_", " ")} · {fileSize(file.size)}</small></div>
                      <ExternalLink size={14} />
                    </a>
                  ) : null)}
                  {!selected.contract
                    && !selected.deposit.proof
                    && !selected.solarRebateQrCode
                    && !selected.collection.proof
                    && !selected.finalPayments.some((payment) => payment.proof)
                    ? <p className={styles.noFiles}>No files attached yet.</p>
                    : null}
                </div>
              </section>

              {selected.stage !== "deposit_not_paid" || paymentRecords.length || selected.finalPayments.length ? (
                <section className={styles.detailSection}>
                  <h3><Banknote size={16} /> Payment Records <span>{paymentRecords.length + selected.finalPayments.filter((payment) => !payment.confirmedAt).length}</span></h3>
                  <div className={styles.paymentLedger}>
                    {paymentRecords.map((payment, index) => (
                      <article key={payment.id}>
                        <div>
                          <strong>Payment #{index + 1}</strong>
                          <small>{payment.label}</small>
                        </div>
                        <div className={styles.confirmedPayment}>
                          <strong>{formatMoney(payment.amountCents)}</strong>
                          <small>Admin confirmed {formatDate(payment.confirmedAt, true)}</small>
                        </div>
                      </article>
                    ))}
                    {selected.finalPayments.filter((payment) => !payment.confirmedAt).map((payment, index) => (
                      <article key={payment.id} className={styles.pendingPaymentRecord}>
                        <div>
                          <strong>Pending payment #{index + 1}</strong>
                          <small>Sales reported {formatMoney(payment.reportedAmountCents || 0)}</small>
                        </div>
                        <div className={styles.pendingPaymentStatus}>
                          <strong>Awaiting Admin confirmation</strong>
                          <small>{formatDate(payment.acknowledgedAt || payment.createdAt, true)}</small>
                        </div>
                      </article>
                    ))}
                    {!paymentRecords.length && !selected.finalPayments.some((payment) => !payment.confirmedAt) ? (
                      <div className={styles.emptyPaymentRecords}>No payments recorded</div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {authenticatedRole === "admin" ? (
                <div className={styles.dangerZone}>
                  <button className={styles.dangerButton} type="button" disabled={busy} onClick={() => void deleteProject()}>
                    <Trash2 size={16} /> Delete project
                  </button>
                </div>
              ) : null}

            </div>
          </div>
          {showDeliveryPicker ? (
            <aside
              ref={deliveryPickerDialogRef}
              className={styles.deliveryPickerDrawer}
              role="dialog"
              aria-modal="true"
              aria-labelledby="material-delivery-picker-title"
              tabIndex={-1}
            >
              <MaterialDeliveryPicker
                project={selected}
                selections={deliverySelectionDraft}
                onBack={closeDeliveryPicker}
                onSaved={(selections) => {
                  setDeliverySelectionDraft(selections);
                  closeDeliveryPicker();
                  setNotice("Chosen warehouse items are ready. Save the WIP schedule to confirm them.");
                }}
              />
            </aside>
          ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ParallelActionCard({
  icon,
  owner,
  title,
  children,
  wide = false,
}: {
  icon: React.ReactNode;
  owner: string;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <article className={`${styles.parallelActionCard} ${wide ? styles.parallelActionWide : ""}`}>
      <div className={styles.parallelActionHeading}>
        <span>{icon}</span>
        <div><small>{owner}</small><strong>{title}</strong></div>
      </div>
      {children}
    </article>
  );
}

function ReadOnlyNextStep({
  owner,
  label,
  allowContinue = false,
  buttonLabel,
  onContinue,
}: {
  owner: string;
  label: string;
  allowContinue?: boolean;
  buttonLabel?: string;
  onContinue?: () => void;
}) {
  return (
    <div className={styles.readOnlyStep} aria-label={`Next owner: ${owner}. ${label}`}>
      <span><Clock3 size={18} /></span>
      <div><strong>Next owner: {owner}</strong></div>
      {allowContinue && buttonLabel && onContinue ? (
        <button className={styles.secondaryButton} type="button" onClick={onContinue}>
          {buttonLabel} <ChevronRight size={15} />
        </button>
      ) : null}
    </div>
  );
}

function ProofAction({
  busy,
  file,
  label,
  buttonLabel,
  onFile,
  onSubmit,
  onConfirmPaid,
}: {
  busy: boolean;
  file: File | null;
  label: string;
  buttonLabel: string;
  onFile: (file: File | null) => void;
  onSubmit: () => void;
  onConfirmPaid: () => void;
}) {
  return (
    <div className={`${styles.actionPanel} ${styles.proofChoicePanel}`}>
      <div className={styles.proofChoiceHeader}>
        <span><UploadCloud size={18} /></span>
        <strong>{label}</strong>
      </div>
      <div className={styles.proofChoiceGrid}>
        <section className={styles.proofChoiceCard} aria-label="Upload payment proof">
          <div className={styles.proofChoiceCardHeader}>
            <span className={styles.proofChoiceIcon}><Paperclip size={18} /></span>
            <strong>Upload proof</strong>
          </div>
          <div className={styles.proofUploadControls}>
            <label
              className={`${styles.fileIconButton} ${file ? styles.fileSelected : ""}`}
              aria-label={file ? `Change payment proof: ${file.name}` : "Choose payment proof"}
              title={file ? `Change file: ${file.name}` : "Choose payment proof"}
            >
              <input
                type="file"
                disabled={busy}
                accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
                onChange={(event) => onFile(event.target.files?.[0] ?? null)}
              />
              {file ? <FileCheck2 size={18} /> : <Paperclip size={18} />}
            </label>
            <div className={styles.fileSelectionMeta} title={file?.name}>
              <span>{file?.name || "No file selected"}</span>
              <small>{file ? fileSize(file.size) : "PDF, JPG, PNG or WebP · up to 10 MB"}</small>
            </div>
            <button className={styles.primaryButton} type="button" disabled={busy || !file} onClick={onSubmit}>
              {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <UploadCloud size={16} />}
              {buttonLabel}
            </button>
          </div>
        </section>
        <span className={styles.proofChoiceDivider} aria-hidden="true">OR</span>
        <section className={`${styles.proofChoiceCard} ${styles.confirmPaidChoice}`} aria-label="Confirm paid without proof">
          <div className={styles.proofChoiceCardHeader}>
            <span className={styles.proofChoiceIcon}><CheckCircle2 size={18} /></span>
            <strong>Confirm paid</strong>
          </div>
          <button className={styles.confirmPaidButton} type="button" disabled={busy} onClick={onConfirmPaid}>
            <CheckCircle2 size={16} /> Confirm Paid — No Upload
          </button>
        </section>
      </div>
    </div>
  );
}

function RebateQrConfirmationAction({
  busy,
  onConfirm,
}: {
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className={`${styles.actionPanel} ${styles.rebateQrConfirmationPanel}`} aria-busy={busy}>
      <div className={styles.actionHeading}>
        <span><QrCode size={18} /></span>
        <strong>Waiting for rebate QR code</strong>
      </div>
      <button
        className={styles.primaryButton}
        type="button"
        disabled={busy}
        onClick={onConfirm}
      >
        {busy ? <LoaderCircle className={styles.spinning} size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
        {busy ? "Confirming…" : "Confirm QR code received"}
      </button>
    </div>
  );
}

function AmountAction({
  amount,
  busy,
  label,
  buttonLabel,
  onAmount,
  onSubmit,
}: {
  amount: string;
  busy: boolean;
  label: string;
  buttonLabel: string;
  onAmount: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className={styles.actionPanel}>
      <div className={styles.actionHeading}>
        <span><Banknote size={18} /></span>
        <strong>Administrator payment confirmation</strong>
      </div>
      <label className={styles.actionField}>
        {label} (AUD)
        <span className={styles.moneyField}><b>$</b><input value={amount} onChange={(event) => onAmount(event.target.value)} type="number" min="0" step="0.01" /></span>
      </label>
      <button className={styles.primaryButton} type="button" disabled={busy || amount === ""} onClick={onSubmit}>
        {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <ShieldCheck size={16} />}
        {buttonLabel}
      </button>
    </div>
  );
}

function SimpleAction({
  icon,
  title,
  button,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  button: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className={styles.actionPanel}>
      <div className={styles.actionHeading}>
        <span>{icon}</span>
        <strong>{title}</strong>
      </div>
      <button className={styles.primaryButton} type="button" disabled={busy} onClick={onClick}>
        {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <CheckCircle2 size={16} />}
        {button}
      </button>
    </div>
  );
}

function StcAction({
  label,
  required,
  received,
  busy,
  canConfirm,
  canSwitchRole,
  onClick,
  onSwitchRole,
}: {
  label: string;
  required: boolean;
  received: boolean;
  busy: boolean;
  canConfirm: boolean;
  canSwitchRole: boolean;
  onClick: () => void;
  onSwitchRole: () => void;
}) {
  if (!required) return <div className={styles.stcRow}><span>{label}</span><small>Not applicable</small></div>;
  if (received) return <div className={`${styles.stcRow} ${styles.received}`}><span>{label}</span><small><CheckCircle2 size={14} /> Received</small></div>;
  if (!canConfirm && !canSwitchRole) {
    return <div className={styles.stcRow}><span>{label}</span><small>Waiting for Administrator</small></div>;
  }
  return (
    <div className={styles.stcRow}>
      <span>{label}</span>
      <button
        type="button"
        aria-label={canConfirm ? `Confirm ${label} received` : `Continue as Administrator to confirm ${label}`}
        disabled={busy}
        onClick={canConfirm ? onClick : onSwitchRole}
      >
        {canConfirm ? <BadgeCheck size={14} /> : <UserRound size={14} />}
        {canConfirm ? "Confirm Received" : "Continue as Administrator"}
      </button>
    </div>
  );
}
