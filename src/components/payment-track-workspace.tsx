"use client";

import {
  AlertCircle,
  BadgeCheck,
  Banknote,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileText,
  LoaderCircle,
  LogOut,
  MapPin,
  PackageCheck,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Truck,
  UploadCloud,
  UserRound,
  WalletCards,
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
import type {
  PaymentTrackAction,
  PaymentTrackAdminSession,
  PaymentTrackItem,
  PaymentTrackListResponse,
  PaymentTrackMutationResponse,
  PaymentTrackProject,
  PaymentTrackRole,
  PaymentTrackStage,
} from "@/lib/payment-track/types";
import styles from "./payment-track-workspace.module.css";

type AddMode = "agreement" | "manual";
type ProofKind = "deposit";
type WorkflowConfirmation = {
  action: Extract<
    PaymentTrackAction,
    "mark_coes_received" | "continue_to_stc" | "confirm_stc_solar" | "confirm_stc_battery" | "confirm_solar_rebate"
  >;
  title: string;
  description: string;
  confirmLabel: string;
  successMessage: string;
};
type PmNotesConflict = {
  notes: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

const ROLE_LABELS: Record<PaymentTrackRole, string> = {
  sales: "Sales",
  specialist: "Specialist",
  pm: "Project Manager",
  admin: "Administrator",
};

const STAGES: Array<{
  id: PaymentTrackStage;
  title: string;
  description: string;
  tone: "amber" | "blue" | "violet" | "cyan" | "teal" | "green";
}> = [
  {
    id: "deposit_not_paid",
    title: "Deposit Not Paid",
    description: "Deposit proof and Admin confirmation",
    tone: "amber",
  },
  {
    id: "material_delivery",
    title: "Material Delivery",
    description: "Delivery and payment confirmation",
    tone: "blue",
  },
  { id: "installing", title: "Installing", description: "PM installation confirmation", tone: "violet" },
  {
    id: "waiting_coes",
    title: "Installed / Waiting COES",
    description: "Installed projects awaiting COES",
    tone: "cyan",
  },
  { id: "stc_rebate", title: "STC Rebate", description: "Confirm applicable rebate receipts", tone: "teal" },
  { id: "done", title: "Done", description: "Completed work and final settlements", tone: "green" },
];

const EMPTY_ADMIN_SESSION: PaymentTrackAdminSession = { admin: false, configured: false };
const MAX_AGREEMENT_SIZE = 15 * 1024 * 1024;
const MAX_PROOF_SIZE = 10 * 1024 * 1024;
const DISCARD_PM_NOTES_MESSAGE = "Discard your unsaved PM notes?";
const PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

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

function pendingLaterPayment(project: PaymentTrackProject) {
  const payment = project.finalPayments.at(-1);
  return project.outstandingCents > 0
    && payment?.confirmedAmountCents === null
    && Boolean(payment.acknowledgedAt || payment.proof)
    ? payment
    : null;
}

function pendingRebateReceipts(project: PaymentTrackProject) {
  return [
    project.stcSolarRequired && !project.stcSolarReceivedAt ? "Solar STC" : "",
    project.stcBatteryRequired && !project.stcBatteryReceivedAt ? "Battery STC" : "",
    project.solarRebateRequired && !project.solarRebateReceivedAt ? "Solar Rebate" : "",
  ].filter(Boolean);
}

function compareDoneProjects(left: PaymentTrackProject, right: PaymentTrackProject) {
  const settlementOrder = Number(right.outstandingCents > 0) - Number(left.outstandingCents > 0);
  if (settlementOrder) return settlementOrder;

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
    return project.deposit.proof
      ? { label: "Awaiting deposit confirmation", owner: "Admin", tone: "blue" }
      : { label: "Deposit proof required", owner: "Specialist", tone: "amber" };
  }
  if (project.stage === "material_delivery") {
    if (!project.deliveredAt) {
      return project.deliveryScheduledFor
        ? { label: `Delivery ${formatDate(project.deliveryScheduledFor)}`, owner: "PM", tone: "blue" }
        : { label: "Delivery scheduling required", owner: "PM", tone: "amber" };
    }
    return project.collection.acknowledgedAt || project.collection.proof
      ? { label: "Awaiting collection confirmation", owner: "Admin", tone: "blue" }
      : { label: "Payment receipt acknowledgement required", owner: "Sales", tone: "amber" };
  }
  if (project.stage === "installing") {
    return { label: "Installation confirmation required", owner: "PM", tone: "violet" };
  }
  if (project.stage === "waiting_coes") {
    const pendingPayment = pendingLaterPayment(project);
    if (!project.coesReceivedAt && pendingPayment) {
      return { label: "COES + payment review pending", owner: "PM / Admin", tone: "cyan" };
    }
    if (!project.coesReceivedAt && project.outstandingCents > 0) {
      return { label: "COES + final payment open", owner: "PM / Sales", tone: "cyan" };
    }
    if (!project.coesReceivedAt) {
      return { label: "COES confirmation required", owner: "PM", tone: "cyan" };
    }
    if (pendingPayment) {
      return { label: "Payment review pending", owner: "Admin", tone: "blue" };
    }
    return project.outstandingCents > 0
      ? { label: "Final payment open", owner: "Sales", tone: "amber" }
      : { label: "Ready for STC Rebate", owner: "Admin", tone: "cyan" };
  }
  if (project.stage === "stc_rebate") {
    const pending = pendingRebateReceipts(project).join(" + ");
    const pendingPayment = pendingLaterPayment(project);
    if (pendingPayment) {
      return {
        label: `${pending ? `${pending} + ` : ""}payment review pending`,
        owner: pending ? "Specialist / Admin" : "Admin",
        tone: "teal",
      };
    }
    if (project.outstandingCents > 0) {
      return {
        label: `${pending ? `${pending} + ` : ""}final payment open`,
        owner: pending ? "Specialist / Sales" : "Sales",
        tone: "teal",
      };
    }
    return {
      label: pending ? `${pending} confirmation required` : "Finalising rebate receipts",
      owner: "Specialist / Admin",
      tone: "teal",
    };
  }
  if (project.outstandingCents <= 0) {
    return { label: "Paid in full", owner: "Complete", tone: "green" };
  }
  return pendingLaterPayment(project)
    ? { label: "Awaiting final payment confirmation", owner: "Admin", tone: "blue" }
    : { label: "Final payment acknowledgement required", owner: "Sales", tone: "amber" };
}

function projectNextStep(project: PaymentTrackProject, activeRole: PaymentTrackRole) {
  if (project.stage === "deposit_not_paid") {
    return project.deposit.proof
      ? { label: "Review Deposit", roles: ["admin"] as PaymentTrackRole[] }
      : { label: "Upload Deposit Proof", roles: ["specialist"] as PaymentTrackRole[] };
  }
  if (project.stage === "material_delivery") {
    if (!project.deliveredAt) {
      return project.deliveryScheduledFor
        ? { label: "Mark Delivered", roles: ["pm"] as PaymentTrackRole[] }
        : { label: "Schedule Delivery", roles: ["pm"] as PaymentTrackRole[] };
    }
    return project.collection.acknowledgedAt || project.collection.proof
      ? { label: "Review Collection", roles: ["admin"] as PaymentTrackRole[] }
      : { label: "Payment Received", roles: ["sales"] as PaymentTrackRole[] };
  }
  if (project.stage === "installing") {
    return { label: "Mark Installed", roles: ["pm"] as PaymentTrackRole[] };
  }
  if (project.stage === "waiting_coes") {
    const pendingPayment = pendingLaterPayment(project);
    const canAcknowledgePayment = project.outstandingCents > 0 && !pendingPayment;
    if (activeRole === "admin" && pendingPayment) {
      return { label: "Review Final Payment", roles: ["admin"] as PaymentTrackRole[] };
    }
    if (activeRole === "sales" && canAcknowledgePayment) {
      return { label: "Record Final Payment", roles: ["sales"] as PaymentTrackRole[] };
    }
    if (activeRole === "pm" && !project.coesReceivedAt) {
      return { label: "Confirm COES", roles: ["pm"] as PaymentTrackRole[] };
    }
    const roles: PaymentTrackRole[] = [];
    if (!project.coesReceivedAt) roles.push("pm");
    if (pendingPayment) roles.push("admin");
    else if (canAcknowledgePayment) roles.push("sales");
    return {
      label: !project.coesReceivedAt ? "Open COES & Payment Tasks" : "Open Payment Task",
      roles: roles.length ? roles : ["admin"],
    };
  }
  if (project.stage === "stc_rebate") {
    const solarPending = project.stcSolarRequired && !project.stcSolarReceivedAt;
    const batteryPending = project.stcBatteryRequired && !project.stcBatteryReceivedAt;
    const solarRebatePending = project.solarRebateRequired && !project.solarRebateReceivedAt;
    const rebateReceiptPending = solarPending || batteryPending || solarRebatePending;
    const pendingPayment = pendingLaterPayment(project);
    const canAcknowledgePayment = project.outstandingCents > 0 && !pendingPayment;
    if (activeRole === "admin" && pendingPayment) {
      return { label: "Review Final Payment", roles: ["admin"] as PaymentTrackRole[] };
    }
    if (activeRole === "sales" && canAcknowledgePayment) {
      return { label: "Record Final Payment", roles: ["sales"] as PaymentTrackRole[] };
    }
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
    if ((activeRole === "specialist" || activeRole === "admin") && rebateReceiptPending) {
      return { label, roles: [activeRole] as PaymentTrackRole[] };
    }
    const roles: PaymentTrackRole[] = [];
    if (rebateReceiptPending) roles.push("specialist", "admin");
    if (pendingPayment && !roles.includes("admin")) roles.push("admin");
    else if (canAcknowledgePayment) roles.push("sales");
    return {
      label: project.outstandingCents > 0 ? "Open Rebate & Payment Tasks" : label,
      roles: roles.length ? roles : ["specialist", "admin"],
    };
  }
  if (project.outstandingCents > 0) {
    return pendingLaterPayment(project)
      ? { label: "Review Final Payment", roles: ["admin"] as PaymentTrackRole[] }
      : { label: "Payment Received", roles: ["sales"] as PaymentTrackRole[] };
  }
  return {
    label: "View Paid Project",
    roles: ["sales", "specialist", "pm", "admin"] as PaymentTrackRole[],
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

function isAwaitingAdmin(project: PaymentTrackProject) {
  return (
    project.stage === "deposit_not_paid" && Boolean(project.deposit.proof)
  ) || (
    project.stage === "material_delivery"
    && Boolean(project.deliveredAt)
    && Boolean(project.collection.acknowledgedAt || project.collection.proof)
  ) || (
    (project.stage === "waiting_coes" || project.stage === "stc_rebate" || project.stage === "done")
    && Boolean(pendingLaterPayment(project))
  );
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

export function PaymentTrackWorkspace({ authenticatedRole }: { authenticatedRole: ErpRole }) {
  const [projects, setProjects] = useState<PaymentTrackProject[]>([]);
  const [role, setRole] = useState<PaymentTrackRole>(authenticatedRole);
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
  const [pmNotesDraft, setPmNotesDraft] = useState("");
  const [pmNotesBaseUpdatedAt, setPmNotesBaseUpdatedAt] = useState<string | null>(null);
  const [pmNotesError, setPmNotesError] = useState("");
  const [pmNotesSaved, setPmNotesSaved] = useState(false);
  const [pmNotesSaving, setPmNotesSaving] = useState(false);
  const [pmNotesConflict, setPmNotesConflict] = useState<PmNotesConflict | null>(null);
  const [workflowConfirmation, setWorkflowConfirmation] = useState<WorkflowConfirmation | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const pmNotesDirtyRef = useRef(false);
  const loadRequestRef = useRef(0);

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
    pmNotesDirtyRef.current = Boolean(selected && pmNotesDraft !== selected.pmNotes);
  }, [pmNotesDraft, selected]);

  const load = useCallback(async (quiet = false) => {
    const requestId = ++loadRequestRef.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch("/api/payment-track", { cache: "no-store" });
      const body = await response.json() as PaymentTrackListResponse & { error?: string };
      if (!response.ok) throw new Error(apiError(body, "Unable to load payment projects."));
      if (requestId !== loadRequestRef.current) return;
      setProjects(Array.isArray(body.data) ? body.data : []);
      setAdminSession((current) => ({ ...current, admin: Boolean(body.meta?.admin) }));
      setError("");
    } catch (loadError) {
      if (requestId !== loadRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load payment projects.");
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
      const body = await response.json() as PaymentTrackAdminSession | { data: PaymentTrackAdminSession };
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
        ? `detail:${selected.id}`
        : "none";
  useEffect(() => {
    if (modalKey === "none") return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']");
    const focusDialog = window.requestAnimationFrame(() => {
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
        setShowAdd(false);
        setShowAdminLogin(false);
        if (pmNotesDirtyRef.current && !window.confirm(DISCARD_PM_NOTES_MESSAGE)) return;
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
      window.cancelAnimationFrame(focusDialog);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleDialogKeys);
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [modalKey, workflowConfirmation]);

  const metrics = useMemo(() => ({
    receivable: projects.reduce((sum, project) => sum + project.balanceDueCents, 0),
    outstanding: projects.reduce((sum, project) => sum + project.outstandingCents, 0),
    adminReview: projects.filter(isAwaitingAdmin).length,
    active: projects.filter((project) => project.stage !== "done" || project.outstandingCents > 0).length,
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
      project.pmNotes,
      ...project.items.flatMap((item) => [item.model, item.description]),
    ].join(" ").toLocaleLowerCase("en-AU").includes(term));
  }, [projects, query]);

  const updateProject = (project: PaymentTrackProject) => {
    setProjects((current) => {
      const exists = current.some((item) => item.id === project.id);
      return exists
        ? current.map((item) => item.id === project.id ? project : item)
        : [project, ...current];
    });
    window.dispatchEvent(new CustomEvent("erp:payment-track-updated"));
  };

  const openAdd = (element: HTMLElement) => {
    returnFocusRef.current = element;
    setError("");
    if (role !== "sales") {
      setNotice("Switch to the Sales role to add a payment project.");
      return;
    }
    setAddMode("agreement");
    setAgreement(null);
    setShowAdd(true);
  };

  const openProject = (project: PaymentTrackProject, element: HTMLElement) => {
    returnFocusRef.current = element;
    setProofFile(null);
    setActionAmount("");
    setDeliveryDate(project.deliveryScheduledFor || "");
    setPmNotesDraft(project.pmNotes || "");
    setPmNotesBaseUpdatedAt(project.pmNotesUpdatedAt || null);
    setPmNotesError("");
    setPmNotesSaved(false);
    setPmNotesConflict(null);
    pmNotesDirtyRef.current = false;
    setError("");
    setSelectedId(project.id);
  };

  const selectRole = (nextRole: PaymentTrackRole) => {
    if (authenticatedRole !== "admin" && nextRole !== authenticatedRole) {
      setNotice(`Your ${ROLE_LABELS[authenticatedRole]} account cannot switch to ${ROLE_LABELS[nextRole]}.`);
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
      const body = await response.json() as { data?: PaymentTrackAdminSession; error?: string };
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

  const logoutAdmin = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payment-track/admin", { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to end Administrator mode.");
      setAdminSession((current) => ({ ...current, admin: false }));
      setRole("sales");
      setSelectedId(null);
      setNotice("Administrator mode ended.");
      await load(true);
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "Unable to end Administrator mode.");
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
      const body = new FormData();
      body.set("agreement", agreement);
      body.set("actorRole", "sales");
      const response = await fetch("/api/payment-track/import", { method: "POST", body });
      const result = await response.json() as PaymentTrackMutationResponse & { error?: string };
      if (!response.ok) throw new Error(apiError(result, "Unable to import this proposal."));
      updateProject(result.data);
      setShowAdd(false);
      setAgreement(null);
      setNotice(`${result.data.reference} was imported and added to Deposit Not Paid.`);
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
      const result = await response.json() as PaymentTrackMutationResponse & { error?: string };
      if (!response.ok) throw new Error(apiError(result, "Unable to create this payment project."));
      updateProject(result.data);
      setShowAdd(false);
      setNotice(`${result.data.reference} was added to Deposit Not Paid.`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create this payment project.");
    } finally {
      setBusy(false);
    }
  };

  const uploadProof = async (kind: ProofKind) => {
    if (!selected || !proofFile) return;
    if (pmNotesDirtyRef.current && !window.confirm(DISCARD_PM_NOTES_MESSAGE)) return;
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
      const result = await response.json() as PaymentTrackMutationResponse & { error?: string };
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

  const performAction = async (
    action: PaymentTrackAction,
    extra: Record<string, string> = {},
    successMessage = "Project updated.",
  ) => {
    if (!selected) return;
    if (pmNotesDirtyRef.current && !window.confirm(DISCARD_PM_NOTES_MESSAGE)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/payment-track/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, actorRole: role, ...extra }),
      });
      const result = await response.json() as PaymentTrackMutationResponse & { error?: string };
      if (!response.ok) throw new Error(apiError(result, "Unable to update this project."));
      updateProject(result.data);
      setActionAmount("");
      setDeliveryDate(result.data.deliveryScheduledFor || deliveryDate);
      setWorkflowConfirmation(null);
      setSelectedId(null);
      setNotice(successMessage);
    } catch (actionError) {
      setWorkflowConfirmation(null);
      setError(actionError instanceof Error ? actionError.message : "Unable to update this project.");
    } finally {
      setBusy(false);
    }
  };

  const savePmNotes = async () => {
    if (!selected || role !== "pm" || pmNotesDraft.length > 5_000) return;
    setBusy(true);
    setPmNotesSaving(true);
    setPmNotesError("");
    setPmNotesSaved(false);
    try {
      const response = await fetch(`/api/payment-track/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_pm_notes",
          actorRole: "pm",
          notes: pmNotesDraft,
          expectedPmNotesUpdatedAt: pmNotesBaseUpdatedAt,
        }),
      });
      const result = await response.json() as PaymentTrackMutationResponse & { error?: string };
      if (!response.ok) {
        const message = apiError(result, response.status === 409
          ? "These PM notes were updated elsewhere. Review the latest version before trying again."
          : "Unable to save PM notes.");
        if (response.status === 409) {
          let latestLoaded = false;
          try {
            const latestResponse = await fetch("/api/payment-track", { cache: "no-store" });
            const latestBody = await latestResponse.json() as PaymentTrackListResponse & { error?: string };
            if (latestResponse.ok) {
              const latest = latestBody.data.find((project) => project.id === selected.id);
              if (latest) {
                updateProject(latest);
                setPmNotesBaseUpdatedAt(latest.pmNotesUpdatedAt);
                setPmNotesConflict({
                  notes: latest.pmNotes,
                  updatedAt: latest.pmNotesUpdatedAt,
                  updatedBy: latest.pmNotesUpdatedBy,
                });
                pmNotesDirtyRef.current = pmNotesDraft !== latest.pmNotes;
                latestLoaded = true;
              }
            }
          } catch {
            // Keep the local draft even when the latest saved version cannot be reloaded.
          }
          setPmNotesError(latestLoaded
            ? `${message} Your unsaved text is still here; compare it with the latest saved version below, then save again.`
            : `${message} Your unsaved text is still here, but the latest saved version could not be loaded.`);
          return;
        }
        throw new Error(message);
      }
      updateProject(result.data);
      setPmNotesDraft(result.data.pmNotes);
      setPmNotesBaseUpdatedAt(result.data.pmNotesUpdatedAt);
      setPmNotesConflict(null);
      pmNotesDirtyRef.current = false;
      setPmNotesSaved(true);
    } catch (notesError) {
      setPmNotesError(notesError instanceof Error ? notesError.message : "Unable to save PM notes.");
    } finally {
      setPmNotesSaving(false);
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

  const closeProjectDetail = () => {
    if (pmNotesDirtyRef.current && !window.confirm(DISCARD_PM_NOTES_MESSAGE)) return;
    pmNotesDirtyRef.current = false;
    setSelectedId(null);
    setPmNotesError("");
    setPmNotesConflict(null);
  };

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || busy) return;
    if (workflowConfirmation) {
      setWorkflowConfirmation(null);
      return;
    }
    setShowAdd(false);
    setShowAdminLogin(false);
    closeProjectDetail();
  };

  const requestWorkflowConfirmation = (confirmation: WorkflowConfirmation) => {
    setError("");
    setWorkflowConfirmation(confirmation);
  };

  const confirmWorkflowAction = () => {
    if (!workflowConfirmation) return;
    void performAction(
      workflowConfirmation.action,
      {},
      workflowConfirmation.successMessage,
    );
  };

  const renderFinalPaymentTask = (project: PaymentTrackProject) => {
    const pendingPayment = pendingLaterPayment(project);
    if (project.outstandingCents <= 0 && !pendingPayment) {
      return (
        <ParallelActionCard
          icon={<Banknote size={18} />}
          owner="Sales / Administrator"
          title="Customer final payment"
          description="Final payment is tracked independently from the project workflow."
        >
          <div className={styles.parallelComplete}><CheckCircle2 size={15} /> Balance paid in full</div>
        </ParallelActionCard>
      );
    }

    if (pendingPayment) {
      return (
        <ParallelActionCard
          icon={<ShieldCheck size={18} />}
          owner="Administrator"
          title="Confirm customer payment"
          description={`Sales has acknowledged a payment. Record the actual amount received against ${formatMoney(project.outstandingCents)} outstanding.`}
        >
          {role === "admin" ? (
            <>
              <label className={styles.parallelAmountField}>
                Actual amount received (AUD)
                <span className={styles.moneyField}>
                  <b>$</b>
                  <input
                    aria-label="Actual final payment received in AUD"
                    value={actionAmount}
                    onChange={(event) => setActionAmount(event.target.value)}
                    type="number"
                    min="0"
                    step="0.01"
                  />
                </span>
              </label>
              <button
                className={styles.primaryButton}
                type="button"
                disabled={busy || actionAmount === ""}
                onClick={() => confirmAmount("confirm_final_payment", "Final payment", pendingPayment.id)}
              >
                {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <ShieldCheck size={16} />}
                Confirm Actual Amount
              </button>
            </>
          ) : (
            <button className={styles.secondaryButton} type="button" onClick={() => selectRole("admin")}>
              Continue as Administrator <ChevronRight size={15} />
            </button>
          )}
        </ParallelActionCard>
      );
    }

    return (
      <ParallelActionCard
        icon={<Banknote size={18} />}
        owner="Sales"
        title="Customer final payment"
        description={`If payment has arrived, acknowledge it here. No proof is required. ${formatMoney(project.outstandingCents)} remains outstanding.`}
      >
        {role === "sales" ? (
          <button
            className={styles.primaryButton}
            type="button"
            disabled={busy}
            onClick={() => void performAction(
              "acknowledge_payment",
              {},
              "Payment marked as received. Administrator can now record the actual amount.",
            )}
          >
            {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <Banknote size={16} />}
            Payment Received
          </button>
        ) : (
          <button className={styles.secondaryButton} type="button" onClick={() => selectRole("sales")}>
            Continue as Sales <ChevronRight size={15} />
          </button>
        )}
      </ParallelActionCard>
    );
  };

  const renderActionPanel = (project: PaymentTrackProject) => {
    const status = projectStatus(project);
    if (project.stage === "done") {
      if (project.outstandingCents > 0) {
        const pendingFinalPayment = pendingLaterPayment(project);
        if (pendingFinalPayment) {
          if (role !== "admin") {
            return (
              <ReadOnlyNextStep
                owner="Administrator"
                label="Confirm the final payment and record the actual amount received."
                buttonLabel="Continue as Administrator"
                onContinue={() => selectRole("admin")}
              />
            );
          }
          return (
            <AmountAction
              amount={actionAmount}
              busy={busy}
              label="Actual final payment received"
              buttonLabel="Final Payment Confirmed"
              onAmount={setActionAmount}
              onSubmit={() => confirmAmount("confirm_final_payment", "Final payment", pendingFinalPayment.id)}
            />
          );
        }
        if (role !== "sales") {
          return (
            <ReadOnlyNextStep
              owner="Sales"
              label={`Acknowledge receipt of the remaining ${formatMoney(project.outstandingCents)}.`}
              buttonLabel="Continue as Sales"
              onContinue={() => selectRole("sales")}
            />
          );
        }
        return (
          <SimpleAction
            icon={<Banknote size={18} />}
            title="Customer payment received"
            description={`Acknowledge the payment against the remaining ${formatMoney(project.outstandingCents)}. Administrator will record the actual amount.`}
            button="Payment Received"
            busy={busy}
            onClick={() => void performAction(
              "acknowledge_payment",
              {},
              "Payment marked as received. Administrator can now record the actual amount.",
            )}
          />
        );
      }
      return (
        <div className={`${styles.actionPanel} ${styles.completedPanel}`}>
          <CheckCircle2 size={20} />
          <div><strong>Paid in full</strong><span>All required confirmations and customer payments have been recorded.</span></div>
        </div>
      );
    }

    if (project.stage === "deposit_not_paid" && !project.deposit.proof) {
      if (role !== "specialist") {
        return (
          <ReadOnlyNextStep
            owner="Specialist"
            label="Upload the customer’s deposit payment proof."
            buttonLabel="Continue as Specialist"
            onContinue={() => selectRole("specialist")}
          />
        );
      }
      return (
        <ProofAction
          busy={busy}
          file={proofFile}
          label="Deposit payment proof"
          buttonLabel="Deposit Paid — Upload Proof"
          onFile={setProofFile}
          onSubmit={() => void uploadProof("deposit")}
        />
      );
    }

    if (project.stage === "deposit_not_paid") {
      if (role !== "admin") {
        return (
          <ReadOnlyNextStep
            owner="Administrator"
            label="Confirm the deposit and record the actual amount received."
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

    if (project.stage === "material_delivery" && !project.deliveredAt) {
      if (role !== "pm") {
        return (
          <ReadOnlyNextStep
            owner="Project Manager"
            label="Schedule material delivery and confirm when delivered."
            buttonLabel="Continue as Project Manager"
            onContinue={() => selectRole("pm")}
          />
        );
      }
      return (
        <div className={styles.actionPanel}>
          <div className={styles.actionHeading}>
            <span><Truck size={17} /></span>
            <div><strong>Material delivery</strong><small>Set a delivery date before completing delivery.</small></div>
          </div>
          <label className={styles.actionField}>
            Delivery date
            <input type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} />
          </label>
          <div className={styles.actionButtons}>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={busy || !deliveryDate}
              onClick={() => void performAction("schedule_delivery", { deliveryDate }, "Delivery date saved.")}
            >
              {busy ? <LoaderCircle className={styles.spinning} size={15} /> : <CalendarDays size={15} />}
              Save Schedule
            </button>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={busy || !project.deliveryScheduledFor || deliveryDate !== project.deliveryScheduledFor}
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
            buttonLabel="Continue as Sales"
            onContinue={() => selectRole("sales")}
          />
        );
      }
      return (
        <SimpleAction
          icon={<Banknote size={18} />}
          title="Customer payment received"
          description="No proof is required. Administrator will record the actual amount received."
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
      if (role !== "pm") {
        return (
          <ReadOnlyNextStep
            owner="Project Manager"
            label="Confirm when installation has been completed."
            buttonLabel="Continue as Project Manager"
            onContinue={() => selectRole("pm")}
          />
        );
      }
      return (
        <SimpleAction
          icon={<Wrench size={18} />}
          title="Installation in progress"
          description="Confirm only after the installation work is complete."
          button="Mark Installed"
          busy={busy}
          onClick={() => void performAction("mark_installed", {}, "Installation marked complete. Project moved to Waiting COES.")}
        />
      );
    }

    if (project.stage === "waiting_coes") {
      return (
        <div className={styles.parallelWorkflow}>
          <div className={styles.parallelWorkflowIntro}>
            <div>
              <strong>COES and final payment</strong>
              <small>These tasks run independently. The project can continue after COES even when the customer balance is still outstanding.</small>
            </div>
          </div>
          <div className={styles.parallelWorkflowGrid}>
            <ParallelActionCard
              icon={<FileCheck2 size={18} />}
              owner="Project Manager"
              title="Certificate of Electrical Safety"
              description="Confirm the COES when it has been received. Final payment does not block this step."
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
              ) : (
                <button className={styles.secondaryButton} type="button" onClick={() => selectRole("pm")}>
                  Continue as Project Manager <ChevronRight size={15} />
                </button>
              )}
            </ParallelActionCard>
            {renderFinalPaymentTask(project)}
          </div>
        </div>
      );
    }

    if (project.stage === "stc_rebate") {
      const canConfirmStc = role === "specialist" || role === "admin";
      const showPaymentTask = project.outstandingCents > 0 || Boolean(pendingLaterPayment(project));
      return (
        <div className={styles.parallelWorkflow}>
          <div className={styles.parallelWorkflowIntro}>
            <div>
              <strong>Rebate receipts and final payment</strong>
              <small>Confirm each applicable rebate independently. An outstanding customer payment remains available alongside these checks.</small>
            </div>
          </div>
          <div className={`${styles.parallelWorkflowGrid} ${showPaymentTask ? styles.rebateWorkflowGrid : styles.singleParallelTask}`}>
            <ParallelActionCard
              icon={<BadgeCheck size={18} />}
              owner="Specialist / Administrator"
              title="Rebate receipts"
              description="Confirm each applicable STC or Solar Rebate receipt. Every receipt asks for confirmation before it is saved."
              wide={!showPaymentTask}
            >
              <div className={styles.stcActions}>
                <StcAction
                  label="Solar STC"
                  required={project.stcSolarRequired}
                  received={Boolean(project.stcSolarReceivedAt)}
                  busy={busy}
                  canConfirm={canConfirmStc}
                  onClick={() => requestWorkflowConfirmation({
                    action: "confirm_stc_solar",
                    title: "Confirm Solar STC received?",
                    description: "Only confirm after the Solar STC payment has been received. If this is the final required rebate receipt, the project will move to Done.",
                    confirmLabel: "Confirm Solar STC",
                    successMessage: "Solar STC payment confirmed.",
                  })}
                  onSwitchRole={() => selectRole("specialist")}
                />
                <StcAction
                  label="Battery STC"
                  required={project.stcBatteryRequired}
                  received={Boolean(project.stcBatteryReceivedAt)}
                  busy={busy}
                  canConfirm={canConfirmStc}
                  onClick={() => requestWorkflowConfirmation({
                    action: "confirm_stc_battery",
                    title: "Confirm Battery STC received?",
                    description: "Only confirm after the Battery STC payment has been received. If this is the final required rebate receipt, the project will move to Done.",
                    confirmLabel: "Confirm Battery STC",
                    successMessage: "Battery STC payment confirmed.",
                  })}
                  onSwitchRole={() => selectRole("specialist")}
                />
                <StcAction
                  label="Solar Rebate"
                  required={project.solarRebateRequired}
                  received={Boolean(project.solarRebateReceivedAt)}
                  busy={busy}
                  canConfirm={canConfirmStc}
                  onClick={() => requestWorkflowConfirmation({
                    action: "confirm_solar_rebate",
                    title: "Confirm Solar Rebate received?",
                    description: "Only confirm after the Solar Rebate payment has been received. If this is the final required rebate receipt, the project will move to Done.",
                    confirmLabel: "Confirm Solar Rebate",
                    successMessage: "Solar Rebate payment confirmed.",
                  })}
                  onSwitchRole={() => selectRole("specialist")}
                />
              </div>
            </ParallelActionCard>
            {showPaymentTask ? renderFinalPaymentTask(project) : null}
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
          <h1 id="payment-track-title">Payment Track</h1>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.roleSelect}>
            <span>Working as</span>
            <select
              aria-label="Working role"
              value={role}
              disabled={authenticatedRole !== "admin"}
              onChange={(event) => selectRole(event.target.value as PaymentTrackRole)}
            >
              {(authenticatedRole === "admin"
                ? Object.keys(ROLE_LABELS) as PaymentTrackRole[]
                : [authenticatedRole] as PaymentTrackRole[]).map((option) => (
                <option key={option} value={option}>{ROLE_LABELS[option]}</option>
              ))}
            </select>
          </label>
          {authenticatedRole !== "admin" && adminSession.admin && role === "admin" ? (
            <button className={styles.adminButton} type="button" disabled={busy} onClick={() => void logoutAdmin()}>
              <ShieldCheck size={16} /> Admin active <LogOut size={14} />
            </button>
          ) : null}
          <button className={styles.primaryButton} type="button" onClick={(event) => openAdd(event.currentTarget)}>
            <Plus size={16} /> Add Project
          </button>
        </div>
      </header>

      <div className={styles.metrics} aria-label="Payment Track summary">
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

      {notice ? (
        <div className={styles.notice} role="status">
          <CheckCircle2 size={16} /><span>{notice}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={14} /></button>
        </div>
      ) : null}
      {error ? (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} /><span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}><X size={14} /></button>
        </div>
      ) : null}

      <div className={styles.boardToolbar}>
        <label className={styles.searchField}>
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, proposal, specialist or item…" />
        </label>
        <div className={styles.toolbarMeta}>
          <span>{filtered.length} {filtered.length === 1 ? "project" : "projects"}</span>
          <button type="button" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw className={refreshing ? styles.spinning : ""} size={15} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.loadingState}><LoaderCircle className={styles.spinning} size={20} /> Loading payment projects…</div>
      ) : (
        <div className={styles.boardScroller} tabIndex={0} aria-label="Payment workflow board">
          <div className={styles.board}>
            {STAGES.map((column) => {
              const columnProjects = filtered.filter((project) => project.stage === column.id);
              if (column.id === "done") columnProjects.sort(compareDoneProjects);
              return (
                <section className={`${styles.column} ${styles[column.tone]}`} key={column.id} aria-labelledby={`column-${column.id}`}>
                  <header>
                    <span className={styles.columnDot} aria-hidden="true" />
                    <div>
                      <h2 id={`column-${column.id}`}>{column.title}</h2>
                      <p>{column.description}</p>
                    </div>
                    <b>{columnProjects.length}</b>
                  </header>
                  <div className={styles.cardList}>
                    {columnProjects.map((project) => {
                      const status = projectStatus(project);
                      const nextStep = projectNextStep(project, role);
                      const canContinue = nextStep.roles.includes(role);
                      const isSettledDone = project.stage === "done" && project.outstandingCents === 0;
                      return (
                        <button
                          className={`${styles.projectCard} ${isSettledDone ? styles.settledDoneCard : ""}`}
                          key={project.id}
                          type="button"
                          onClick={(event) => openProject(project, event.currentTarget)}
                          aria-label={`Open ${customerName(project)}, proposal ${project.quoteNumber}`}
                        >
                          {isSettledDone ? (
                            <>
                              <h3>{customerName(project)}</h3>
                              <p className={styles.cardAddress}><MapPin size={13} /> {customerAddress(project)}</p>
                            </>
                          ) : (
                            <>
                              <div className={styles.cardTopline}>
                                <span>{project.reference}</span>
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
                              <div className={styles.cardFooter}>
                                <span className={`${styles.substatus} ${styles[status.tone]}`}>{status.label}</span>
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
              <button type="button" aria-label="Close" disabled={busy} onClick={() => setWorkflowConfirmation(null)}><X size={19} /></button>
            </header>
            <div className={styles.confirmationBody}>
              <span className={styles.confirmationIcon}><BadgeCheck size={24} /></span>
              <p id="workflow-confirmation-description">{workflowConfirmation.description}</p>
            </div>
            <footer className={styles.confirmationFooter}>
              <button
                autoFocus
                className={styles.secondaryButton}
                type="button"
                disabled={busy}
                onClick={() => setWorkflowConfirmation(null)}
              >
                Cancel
              </button>
              <button className={styles.primaryButton} type="button" disabled={busy} onClick={confirmWorkflowAction}>
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
              <div><span>Sales workspace</span><h2 id="add-project-title">Add payment project</h2></div>
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
                  <div>
                    <strong>Import a Solar Proposal</strong>
                    <p>We will extract the Specialist, Proposal Number, customer, system items, deposit and Balance Due. You can verify everything in Project Details.</p>
                  </div>
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
                <div className={styles.importChecks}>
                  <span><CheckCircle2 size={15} /> Starts in Deposit Not Paid</span>
                  <span><CheckCircle2 size={15} /> Original PDF stays attached</span>
                </div>
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
                    <label>Specialist name<input required name="specialistName" placeholder="Project owner" /></label>
                    <label className={styles.fullField}>Specialist phone<input name="specialistPhone" inputMode="tel" placeholder="Mobile number" /></label>
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
                      <small>Use a new line for each item. Quantity defaults to 1.</small>
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
              <p>Sign in before confirming money received. This keeps payment approvals separate from operational updates.</p>
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
        <div className={styles.backdrop} onMouseDown={closeFromBackdrop}>
          <div className={`${styles.modal} ${styles.detailModal}`} role="dialog" aria-modal="true" aria-labelledby="project-detail-title">
            <header>
              <div>
                <span>{selected.reference} · Proposal {selected.quoteNumber}</span>
                <h2 id="project-detail-title">{customerName(selected)}</h2>
              </div>
              <button type="button" aria-label="Close" disabled={busy} onClick={closeProjectDetail}><X size={19} /></button>
            </header>
            <div className={styles.detailStageBar}>
              <span className={`${styles.stageBadge} ${styles[STAGES.find((item) => item.id === selected.stage)?.tone || "blue"]}`}>
                {stageLabel(selected.stage)}
              </span>
              <span className={styles.detailStatus}>{projectStatus(selected).label}</span>
              <span className={styles.roleBadge}>Viewing as {ROLE_LABELS[role]}</span>
            </div>
            <div className={styles.detailBody}>
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

              <section className={styles.pmNotesPanel} aria-labelledby={`pm-notes-title-${selected.id}`}>
                <header className={styles.pmNotesHeader}>
                  <span className={styles.pmNotesIcon}><FileText size={18} /></span>
                  <div>
                    <h3 id={`pm-notes-title-${selected.id}`}>PM Notes</h3>
                    <p>Delivery, installation, grid-connection and project handover details visible to every role.</p>
                  </div>
                  <small>
                    {selected.pmNotesUpdatedAt
                      ? `Last saved ${formatDate(selected.pmNotesUpdatedAt, true)} by ${selected.pmNotesUpdatedBy || "Project Manager"}`
                      : "Not saved yet"}
                  </small>
                </header>

                {role === "pm" ? (
                  <div className={styles.pmNotesEditor}>
                    <label htmlFor={`pm-notes-${selected.id}`}>Project Manager notes</label>
                    <textarea
                      id={`pm-notes-${selected.id}`}
                      value={pmNotesDraft}
                      maxLength={5_000}
                      rows={5}
                      aria-describedby={`pm-notes-hint-${selected.id} pm-notes-count-${selected.id}`}
                      placeholder="Add delivery access, installation, grid-connection or handover details…"
                      disabled={busy}
                      onChange={(event) => {
                        setPmNotesDraft(event.target.value);
                        pmNotesDirtyRef.current = event.target.value !== selected.pmNotes;
                        setPmNotesSaved(false);
                        setPmNotesError("");
                      }}
                    />
                    <div className={styles.pmNotesFooter}>
                      <div>
                        <span id={`pm-notes-hint-${selected.id}`}>Leave this empty and save to clear the notes.</span>
                        <span id={`pm-notes-count-${selected.id}`}>{pmNotesDraft.length.toLocaleString("en-AU")} / 5,000 characters</span>
                      </div>
                      <button
                        className={styles.primaryButton}
                        type="button"
                        disabled={busy || pmNotesDraft === selected.pmNotes || pmNotesDraft.length > 5_000}
                        onClick={() => void savePmNotes()}
                      >
                        {pmNotesSaving ? <LoaderCircle className={styles.spinning} size={16} /> : <FileCheck2 size={16} />}
                        {pmNotesSaving ? "Saving Notes…" : "Save Notes"}
                      </button>
                    </div>
                    <div className={styles.pmNotesFeedback} aria-live="polite">
                      {pmNotesSaved ? <span className={styles.pmNotesSuccess}><CheckCircle2 size={15} /> PM notes saved successfully.</span> : null}
                      {pmNotesError ? <span className={styles.pmNotesError} role="alert"><AlertCircle size={15} /> {pmNotesError}</span> : null}
                    </div>
                    {pmNotesConflict ? (
                      <aside className={styles.pmNotesConflict} aria-label="Latest saved PM notes">
                        <div>
                          <strong>Latest saved version</strong>
                          <small>
                            {pmNotesConflict.updatedAt
                              ? `${formatDate(pmNotesConflict.updatedAt, true)} by ${pmNotesConflict.updatedBy || "Project Manager"}`
                              : "No previous saved version"}
                          </small>
                        </div>
                        <p>{pmNotesConflict.notes || "The latest saved version is empty."}</p>
                      </aside>
                    ) : null}
                  </div>
                ) : (
                  <div className={styles.pmNotesReadOnly}>
                    <p className={selected.pmNotes ? "" : styles.pmNotesEmpty}>
                      {selected.pmNotes || "No PM notes have been added yet."}
                    </p>
                    <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => selectRole("pm")}>
                      Continue as Project Manager <ChevronRight size={15} />
                    </button>
                  </div>
                )}
              </section>

              {renderActionPanel(selected)}

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
                    <div><dt>Specialist</dt><dd>{selected.specialist.name || "—"}</dd></div>
                    <div><dt>Specialist phone</dt><dd>{selected.specialist.phone || "—"}</dd></div>
                    <div><dt>Delivery date</dt><dd>{formatDate(selected.deliveryScheduledFor)}</dd></div>
                    <div><dt>Created</dt><dd>{formatDate(selected.createdAt, true)}</dd></div>
                  </dl>
                </section>
              </div>

              <section className={styles.detailSection}>
                <h3><Boxes size={16} /> System Items <span>{selected.items.length}</span></h3>
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

              <section className={styles.detailSection}>
                <h3><Paperclip size={16} /> Files</h3>
                <div className={styles.fileGrid}>
                  {[
                    selected.contract,
                    selected.deposit.proof,
                    selected.collection.proof,
                    ...selected.finalPayments.map((payment) => payment.proof),
                  ].filter(Boolean).map((file) => file ? (
                    <a key={file.id} className={styles.fileCard} href={file.url} target="_blank" rel="noreferrer">
                      <span><FileText size={18} /></span>
                      <div><strong>{file.originalName}</strong><small>{file.kind.replaceAll("_", " ")} · {fileSize(file.size)}</small></div>
                      <ExternalLink size={14} />
                    </a>
                  ) : null)}
                  {!selected.contract && !selected.deposit.proof && !selected.collection.proof && !selected.finalPayments.some((payment) => payment.proof) ? <p className={styles.noFiles}>No files attached yet.</p> : null}
                </div>
              </section>

              {paymentRecords.length ? (
                <section className={styles.detailSection}>
                  <h3><Banknote size={16} /> Payment Records <span>{paymentRecords.length}</span></h3>
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
                  </div>
                </section>
              ) : null}

            </div>
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
  description,
  children,
  wide = false,
}: {
  icon: React.ReactNode;
  owner: string;
  title: string;
  description: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <article className={`${styles.parallelActionCard} ${wide ? styles.parallelActionWide : ""}`}>
      <div className={styles.parallelActionHeading}>
        <span>{icon}</span>
        <div><small>{owner}</small><strong>{title}</strong></div>
      </div>
      <p>{description}</p>
      {children}
    </article>
  );
}

function ReadOnlyNextStep({
  owner,
  label,
  buttonLabel,
  onContinue,
}: {
  owner: string;
  label: string;
  buttonLabel?: string;
  onContinue?: () => void;
}) {
  return (
    <div className={styles.readOnlyStep}>
      <span><Clock3 size={18} /></span>
      <div><strong>Next owner: {owner}</strong><small>{label}</small></div>
      {buttonLabel && onContinue ? (
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
}: {
  busy: boolean;
  file: File | null;
  label: string;
  buttonLabel: string;
  onFile: (file: File | null) => void;
  onSubmit: () => void;
}) {
  return (
    <div className={styles.actionPanel}>
      <div className={styles.actionHeading}>
        <span><UploadCloud size={18} /></span>
        <div><strong>{label}</strong><small>Attach the customer’s screenshot or PDF before submitting.</small></div>
      </div>
      <label className={styles.compactUpload}>
        <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
        <Paperclip size={15} />
        <span>{file?.name || "Choose payment proof"}</span>
        <small>{file ? fileSize(file.size) : "PDF, JPG, PNG or WebP · max 10 MB"}</small>
      </label>
      <button className={styles.primaryButton} type="button" disabled={busy || !file} onClick={onSubmit}>
        {busy ? <LoaderCircle className={styles.spinning} size={16} /> : <UploadCloud size={16} />}
        {buttonLabel}
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
        <div><strong>Administrator payment confirmation</strong><small>Record the amount actually received. Zero is allowed; negative values are not.</small></div>
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
  description,
  button,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  button: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className={styles.actionPanel}>
      <div className={styles.actionHeading}>
        <span>{icon}</span>
        <div><strong>{title}</strong><small>{description}</small></div>
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
  onClick,
  onSwitchRole,
}: {
  label: string;
  required: boolean;
  received: boolean;
  busy: boolean;
  canConfirm: boolean;
  onClick: () => void;
  onSwitchRole: () => void;
}) {
  if (!required) return <div className={styles.stcRow}><span>{label}</span><small>Not applicable</small></div>;
  if (received) return <div className={`${styles.stcRow} ${styles.received}`}><span>{label}</span><small><CheckCircle2 size={14} /> Received</small></div>;
  return (
    <div className={styles.stcRow}>
      <span>{label}</span>
      <button
        type="button"
        aria-label={canConfirm ? `Confirm ${label} received` : `Continue as Specialist to confirm ${label}`}
        disabled={busy}
        onClick={canConfirm ? onClick : onSwitchRole}
      >
        {canConfirm ? <BadgeCheck size={14} /> : <UserRound size={14} />}
        {canConfirm ? "Confirm Received" : "Continue as Specialist"}
      </button>
    </div>
  );
}
