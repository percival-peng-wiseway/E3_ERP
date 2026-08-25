"use client";

import {
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileText,
  ImagePlus,
  LoaderCircle,
  MapPin,
  Navigation,
  Phone,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErpRole } from "@/lib/auth/types";
import type {
  SiteVisit,
  SiteVisitActionInput,
  SiteVisitCheckAnswer,
  SiteVisitChecklistItem,
  SiteVisitPhoto,
  SiteVisitStatus,
} from "@/lib/site-visits/types";
import styles from "./site-visiting-workspace.module.css";

type StatusFilter = "all" | SiteVisitStatus;

const STATUS_LABELS: Record<SiteVisitStatus, string> = {
  pending_approval: "Awaiting approval",
  approved: "Awaiting schedule",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_ORDER: Record<SiteVisitStatus, number> = {
  pending_approval: 0,
  approved: 1,
  scheduled: 2,
  in_progress: 3,
  completed: 4,
  cancelled: 5,
};

const WORKFLOW_STAGES = [
  { label: "Request", status: "pending_approval" },
  { label: "Approved", status: "approved" },
  { label: "Scheduled", status: "scheduled" },
  { label: "Visit", status: "in_progress" },
  { label: "Done", status: "completed" },
] as const satisfies ReadonlyArray<{ label: string; status: SiteVisitStatus }>;

type SiteVisitAction = SiteVisitActionInput["action"];
type SimpleWorkflowAction = Exclude<SiteVisitAction, "update_request" | "schedule" | "save_visit">;
type DetailDirtyKind = "request" | "visit" | null;
type ScheduleDraft = { scheduledDate: string; scheduledTime: string; assignee: string };

const ANSWER_OPTIONS: Array<{ value: SiteVisitCheckAnswer; label: string }> = [
  { value: "not_checked", label: "Not checked" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Unsure" },
];

const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;
const CHECK_NOTE_PLACEHOLDERS: Record<string, string> = {
  ac_cable_run_under_20m: "Add measured length and cable route",
  roof_material: "Enter roof material and profile",
  bat_location: "Enter proposed BAT location and access details",
};

type PhotoLoadState = "loading" | "ready" | "waiting" | "failed";

function cloneVisit(visit: SiteVisit): SiteVisit {
  return {
    ...visit,
    checklist: visit.checklist.map((item) => ({ ...item })),
    photos: visit.photos.map((photo) => ({ ...photo })),
  };
}

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function defaultSchedule() {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  if (date.getHours() >= 18) {
    date.setDate(date.getDate() + 1);
    date.setHours(9);
  } else if (date.getHours() < 8) {
    date.setHours(8);
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    time: `${String(date.getHours()).padStart(2, "0")}:00`,
  };
}

function formatDate(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatTime(value: string | null) {
  if (!value) return "Time pending";
  const [hours, minutes] = value.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" }).format(date);
}

function scheduleKey(visit: SiteVisit) {
  return `${visit.scheduledDate || visit.requestedDate}T${visit.scheduledTime || visit.requestedTime}`;
}

function hasActualSchedule(visit: SiteVisit) {
  return Boolean(visit.scheduledDate && visit.scheduledTime);
}

function visitScheduleDraft(visit: SiteVisit, fallback: ReturnType<typeof defaultSchedule>): ScheduleDraft {
  return {
    scheduledDate: visit.scheduledDate || visit.requestedDate || fallback.date,
    scheduledTime: visit.scheduledTime || visit.requestedTime || fallback.time,
    assignee: visit.assignee,
  };
}

function mapsUrl(address: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const message = (value as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

async function responseBody(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function retriedPhotoUrl(url: string, attempt: number) {
  if (!attempt) return url;
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
}

function SiteVisitPhotoCard({
  photo,
  busy,
  editable,
  onDelete,
}: {
  photo: SiteVisitPhoto;
  busy: boolean;
  editable: boolean;
  onDelete: (photoId: string) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [loadState, setLoadState] = useState<PhotoLoadState>("loading");
  const retryTimerRef = useRef<number | null>(null);

  function clearRetryTimer() {
    if (retryTimerRef.current === null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }

  useEffect(() => {
    clearRetryTimer();
    setAttempt(0);
    setFailedAttempts(0);
    setLoadState("loading");
    return clearRetryTimer;
  }, [photo.id, photo.url]);

  function photoLoaded() {
    clearRetryTimer();
    setLoadState("ready");
  }

  function photoFailed() {
    clearRetryTimer();
    const delay = PHOTO_RETRY_DELAYS_MS[failedAttempts];
    if (delay === undefined) {
      setLoadState("failed");
      return;
    }
    setLoadState("waiting");
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setFailedAttempts((current) => current + 1);
      setAttempt((current) => current + 1);
      setLoadState("loading");
    }, delay);
  }

  function retryPhotoNow() {
    clearRetryTimer();
    setFailedAttempts(0);
    setAttempt((current) => current + 1);
    setLoadState("loading");
  }

  const photoName = photo.originalName || "Site visit photo";
  return (
    <figure>
      <div className={`${styles.photoPreview} ${loadState === "ready" ? "" : styles.photoPreviewPending}`}>
        <a href={photo.url} target="_blank" rel="noreferrer" aria-label={`Open ${photoName}`}>
          <img
            src={retriedPhotoUrl(photo.url, attempt)}
            alt={photoName}
            onLoad={photoLoaded}
            onError={photoFailed}
          />
        </a>
        {loadState !== "ready" ? (
          <div className={styles.photoLoadStatus} role={loadState === "failed" ? "alert" : "status"}>
            {loadState === "failed" ? (
              <>
                <span>Photo is not ready yet.</span>
                <button type="button" onClick={retryPhotoNow}>Retry photo</button>
              </>
            ) : (
              <>
                <LoaderCircle className={styles.spinner} size={18} />
                <span>{loadState === "waiting" ? "Photo syncing…" : "Loading photo…"}</span>
              </>
            )}
          </div>
        ) : null}
      </div>
      <figcaption>
        <span>{photo.originalName}</span>
        {editable ? (
          <button type="button" onClick={() => onDelete(photo.id)} disabled={busy} aria-label={`Delete ${photo.originalName}`}>
            <Trash2 size={16} />
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function SiteVisitingWorkspace({ authenticatedRole }: { authenticatedRole: ErpRole }) {
  const [visits, setVisits] = useState<SiteVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<SiteVisit | null>(null);
  const [detailDirtyKind, setDetailDirtyKind] = useState<DetailDirtyKind>(null);
  const suggestedSchedule = useMemo(defaultSchedule, []);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => ({
    scheduledDate: suggestedSchedule.date,
    scheduledTime: suggestedSchedule.time,
    assignee: "",
  }));
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const detailCloseButtonRef = useRef<HTMLButtonElement>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const requestIdRef = useRef(0);
  const busyRef = useRef(false);
  const detailDirty = detailDirtyKind !== null;

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const loadVisits = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const response = await fetch("/api/site-visits", { cache: "no-store" });
      const body = await responseBody(response) as { data?: { visits?: SiteVisit[] } } | null;
      if (!response.ok) throw new Error(apiError(body, "Unable to load site visits."));
      if (requestId !== requestIdRef.current) return;
      setVisits(Array.isArray(body?.data?.visits) ? body.data.visits : []);
      setError("");
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load site visits.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVisits();
  }, [loadVisits]);

  const activeModal = createOpen || Boolean(detail);
  useEffect(() => {
    if (!activeModal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current) return;
      if (detail && detailDirty && !window.confirm("Discard the unsaved site visit changes?")) return;
      setCreateOpen(false);
      setDetail(null);
      setDetailDirtyKind(null);
      window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeModal, detail, detailDirty]);

  useEffect(() => {
    if (!detail) return;
    window.requestAnimationFrame(() => detailCloseButtonRef.current?.focus());
  }, [detail?.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => ({
    pendingApproval: visits.filter((visit) => visit.status === "pending_approval").length,
    approved: visits.filter((visit) => visit.status === "approved").length,
    scheduled: visits.filter((visit) => visit.status === "scheduled").length,
    inProgress: visits.filter((visit) => visit.status === "in_progress").length,
    completed: visits.filter((visit) => visit.status === "completed").length,
  }), [visits]);

  const visibleVisits = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("en-AU");
    return visits
      .filter((visit) => statusFilter === "all" || visit.status === statusFilter)
      .filter((visit) => !term || [
        visit.projectName,
        visit.address,
        visit.contact,
        visit.reason,
        visit.assignee,
        visit.notes,
      ].join(" ").toLocaleLowerCase("en-AU").includes(term))
      .slice()
      .sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
        || scheduleKey(left).localeCompare(scheduleKey(right)));
  }, [search, statusFilter, visits]);

  function replaceVisit(visit: SiteVisit, updateDraft = true) {
    setVisits((current) => current.map((item) => item.id === visit.id ? visit : item));
    if (updateDraft) {
      setDetail(cloneVisit(visit));
      setScheduleDraft(visitScheduleDraft(visit, suggestedSchedule));
    }
  }

  function openDetail(visit: SiteVisit, trigger: HTMLButtonElement) {
    setError("");
    detailTriggerRef.current = trigger;
    setDetail(cloneVisit(visit));
    setScheduleDraft(visitScheduleDraft(visit, suggestedSchedule));
    setDetailDirtyKind(null);
  }

  function closeDetail() {
    if (busy) return;
    if (detailDirty && !window.confirm("Discard the unsaved site visit changes?")) return;
    setDetail(null);
    setDetailDirtyKind(null);
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }

  async function createVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/site-visits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectName: String(data.get("projectName") || ""),
          address: String(data.get("address") || ""),
          contact: String(data.get("contact") || ""),
          reason: String(data.get("reason") || ""),
          requestedDate: String(data.get("requestedDate") || ""),
          requestedTime: String(data.get("requestedTime") || ""),
        }),
      });
      const body = await responseBody(response) as { data?: { visit?: SiteVisit } } | null;
      if (!response.ok || !body?.data?.visit) {
        throw new Error(apiError(body, "Unable to create the site visit."));
      }
      const visit = body.data.visit;
      setVisits((current) => [...current, visit]);
      setCreateOpen(false);
      form.reset();
      setNotice(`${visit.projectName} was submitted for approval.`);
      detailTriggerRef.current = null;
      setDetail(cloneVisit(visit));
      setScheduleDraft(visitScheduleDraft(visit, suggestedSchedule));
      setDetailDirtyKind(null);
      window.dispatchEvent(new CustomEvent("erp:site-visits-updated", { detail: { source: "site-visiting" } }));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create the site visit.");
    } finally {
      setBusy(false);
    }
  }

  async function patchVisitAction(visit: SiteVisit, input: SiteVisitActionInput) {
    const response = await fetch(`/api/site-visits/${encodeURIComponent(visit.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await responseBody(response) as { data?: { visit?: SiteVisit } } | null;
    if (!response.ok || !body?.data?.visit) {
      throw new Error(apiError(body, "Unable to save the site visit."));
    }
    window.dispatchEvent(new CustomEvent("erp:site-visits-updated", { detail: { source: "site-visiting" } }));
    return body.data.visit;
  }

  async function persistDirtyDetail(source: SiteVisit) {
    if (!detailDirtyKind) return source;
    const input: SiteVisitActionInput = detailDirtyKind === "request"
      ? {
          action: "update_request",
          expectedUpdatedAt: source.updatedAt,
          projectName: source.projectName,
          address: source.address,
          contact: source.contact,
          reason: source.reason,
          requestedDate: source.requestedDate,
          requestedTime: source.requestedTime,
        }
      : {
          action: "save_visit",
          expectedUpdatedAt: source.updatedAt,
          projectName: source.projectName,
          address: source.address,
          contact: source.contact,
          checklist: source.checklist,
          notes: source.notes,
        };
    const saved = await patchVisitAction(source, input);
    replaceVisit(saved);
    setDetailDirtyKind(null);
    return saved;
  }

  async function saveDetail() {
    if (!detail || !detailDirtyKind) return;
    setBusy(true);
    setError("");
    try {
      const savedKind = detailDirtyKind;
      await persistDirtyDetail(detail);
      setNotice(savedKind === "request" ? "Site visit request saved." : "Site visit details saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the site visit.");
    } finally {
      setBusy(false);
    }
  }

  async function runWorkflowAction(action: SimpleWorkflowAction, successMessage: string) {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const current = await persistDirtyDetail(detail);
      const saved = await patchVisitAction(current, {
        action,
        expectedUpdatedAt: current.updatedAt,
      } as SiteVisitActionInput);
      replaceVisit(saved);
      setDetailDirtyKind(null);
      setNotice(successMessage);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Unable to update the visit status.");
    } finally {
      setBusy(false);
    }
  }

  async function scheduleVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !scheduleDraft.scheduledDate || !scheduleDraft.scheduledTime || !scheduleDraft.assignee.trim()) return;
    setBusy(true);
    setError("");
    try {
      const current = await persistDirtyDetail(detail);
      const saved = await patchVisitAction(current, {
        action: "schedule",
        expectedUpdatedAt: current.updatedAt,
        scheduledDate: scheduleDraft.scheduledDate,
        scheduledTime: scheduleDraft.scheduledTime,
        assignee: scheduleDraft.assignee,
      });
      replaceVisit(saved);
      setDetailDirtyKind(null);
      setNotice(current.status === "approved" ? "Site visit scheduled." : "Site visit schedule updated.");
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "Unable to schedule the site visit.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteVisit() {
    if (authenticatedRole !== "admin" || !detail || !window.confirm(`Delete the site visit for “${detail.projectName}”? Photos will also be removed.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/site-visits/${encodeURIComponent(detail.id)}`, { method: "DELETE" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to delete the site visit."));
      setVisits((current) => current.filter((visit) => visit.id !== detail.id));
      setDetail(null);
      setDetailDirtyKind(null);
      setNotice("Site visit deleted.");
      window.dispatchEvent(new CustomEvent("erp:site-visits-updated", { detail: { source: "site-visiting" } }));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the site visit.");
    } finally {
      setBusy(false);
    }
  }

  function updateDetail(patch: Partial<SiteVisit>, kind: Exclude<DetailDirtyKind, null>) {
    setDetail((current) => current ? { ...current, ...patch } : current);
    setDetailDirtyKind(kind);
  }

  function updateCheck(id: string, patch: Partial<SiteVisitChecklistItem>) {
    setDetail((current) => current ? {
      ...current,
      checklist: current.checklist.map((item) => item.id === id ? { ...item, ...patch } : item),
    } : current);
    setDetailDirtyKind("visit");
  }

  async function uploadPhotos(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!detail || !files.length) return;
    if (files.length > 10) {
      setError("Upload no more than 10 photos at a time.");
      return;
    }
    const invalid = files.find((file) => file.size < 1
      || file.size > MAX_PHOTO_SIZE
      || !ACCEPTED_PHOTO_TYPES.has(file.type));
    if (invalid) {
      setError("Use JPG, PNG or WebP photos up to 10 MB each.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      let current = detail;
      if (detailDirty) {
        current = await persistDirtyDetail(detail);
        setDetailDirtyKind(null);
      }
      const data = new FormData();
      files.forEach((file) => data.append("photos", file, file.name));
      const response = await fetch(`/api/site-visits/${encodeURIComponent(current.id)}/photos`, {
        method: "POST",
        body: data,
      });
      const body = await responseBody(response) as { data?: { visit?: SiteVisit } } | null;
      if (!response.ok || !body?.data?.visit) {
        throw new Error(apiError(body, "Unable to add the site photos."));
      }
      replaceVisit(body.data.visit);
      setNotice(`${files.length} ${files.length === 1 ? "photo" : "photos"} added.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to add the site photos.");
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoto(photoId: string) {
    if (!detail || !window.confirm("Remove this site photo?")) return;
    setBusy(true);
    setError("");
    try {
      let current = detail;
      if (detailDirty) {
        current = await persistDirtyDetail(detail);
      }
      const response = await fetch(
        `/api/site-visits/${encodeURIComponent(current.id)}/photos/${encodeURIComponent(photoId)}`,
        { method: "DELETE" },
      );
      const body = await responseBody(response) as { data?: { visit?: SiteVisit } } | null;
      if (!response.ok || !body?.data?.visit) {
        throw new Error(apiError(body, "Unable to remove the site photo."));
      }
      const serverVisit = body.data.visit;
      replaceVisit(serverVisit);
      setDetailDirtyKind(null);
      setNotice("Site photo removed.");
    } catch (photoError) {
      setError(photoError instanceof Error ? photoError.message : "Unable to remove the site photo.");
    } finally {
      setBusy(false);
    }
  }

  const canApprove = authenticatedRole === "admin";
  const canSchedule = authenticatedRole === "admin" || authenticatedRole === "pm";
  const requestEditable = detail?.status === "pending_approval";
  const visitEditable = detail?.status === "scheduled" || detail?.status === "in_progress";
  const coreDetailsEditable = requestEditable || visitEditable;
  const coreDetailsDirtyKind: Exclude<DetailDirtyKind, null> = requestEditable ? "request" : "visit";
  const showOnSiteDetails = detail?.status === "scheduled"
    || detail?.status === "in_progress"
    || detail?.status === "completed";

  return (
    <section className={styles.workspace}>
      <header className={styles.hero}>
        <div>
          <span className={styles.kicker}>FIELD OPERATIONS</span>
          <h1>Site Visiting</h1>
          <p>Request, approve and schedule each visit before the team captures site conditions.</p>
        </div>
        <button type="button" className={styles.primaryButton} onClick={() => { setError(""); setCreateOpen(true); }}>
          <Plus size={18} />New site visit
        </button>
      </header>

      {(error || notice) && (
        <div className={`${styles.message} ${error ? styles.errorMessage : styles.successMessage}`} role={error ? "alert" : "status"}>
          {error ? <CircleAlert size={19} /> : <CheckCircle2 size={19} />}
          <span>{error || notice}</span>
          <button type="button" onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss message"><X size={17} /></button>
        </div>
      )}

      <div className={styles.metrics}>
        <Metric label="Awaiting approval" value={counts.pendingApproval} icon={<Clock3 size={19} />} tone="amber" />
        <Metric label="Awaiting schedule" value={counts.approved} icon={<CheckCircle2 size={19} />} tone="blue" />
        <Metric label="Scheduled" value={counts.scheduled} icon={<CalendarDays size={19} />} tone="teal" />
        <Metric label="In progress" value={counts.inProgress} icon={<Navigation size={19} />} tone="violet" />
        <Metric label="Completed" value={counts.completed} icon={<CheckCircle2 size={19} />} tone="green" />
      </div>

      <div className={styles.toolbar}>
        <label className={styles.searchBox}>
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, address, phone or assignee" />
        </label>
        <div className={styles.filters} role="group" aria-label="Filter site visits by status">
          {(["all", "pending_approval", "approved", "scheduled", "in_progress", "completed", "cancelled"] as StatusFilter[]).map((status) => (
            <button
              type="button"
              key={status}
              className={statusFilter === status ? styles.activeFilter : ""}
              onClick={() => setStatusFilter(status)}
              aria-pressed={statusFilter === status}
            >
              {status === "all" ? "All" : STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={24} />Loading site visits…</div>
      ) : visibleVisits.length ? (
        <div className={styles.visitGrid}>
          {visibleVisits.map((visit) => (
            <VisitCard key={visit.id} visit={visit} onOpen={(trigger) => openDetail(visit, trigger)} />
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <span><MapPin size={28} /></span>
          <h2>{visits.length ? "No visits match this view" : "Create your first site visit request"}</h2>
          <p>{visits.length ? "Try another search or status filter." : "Submit the customer request now, then approve and schedule it before the visit."}</p>
          {!visits.length && <button type="button" className={styles.primaryButton} onClick={() => setCreateOpen(true)}><Plus size={18} />New site visit</button>}
        </div>
      )}

      {createOpen && (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setCreateOpen(false);
        }}>
          <section className={`${styles.sheet} ${styles.createSheet}`} role="dialog" aria-modal="true" aria-labelledby="create-site-visit-title">
            <div className={styles.sheetHeader}>
              <div><span>NEW REQUEST</span><h2 id="create-site-visit-title">Request a site visit</h2></div>
              <button type="button" onClick={() => setCreateOpen(false)} disabled={busy} aria-label="Close"><X size={21} /></button>
            </div>
            {error && <ModalMessage message={error} error onDismiss={() => setError("")} />}
            <form className={styles.createForm} onSubmit={createVisit}>
              <div className={styles.formBody}>
                <label className={styles.fullField}><span>Customer name *</span><input name="projectName" required maxLength={160} autoComplete="name" autoFocus placeholder="e.g. Smith residence" /></label>
                <label className={styles.fullField}><span>Site address *</span><textarea name="address" required maxLength={300} rows={2} autoComplete="street-address" placeholder="Street address, suburb and postcode" /></label>
                <label className={styles.fullField}><span>Phone *</span><input name="contact" required maxLength={240} inputMode="tel" autoComplete="tel" placeholder="Customer phone number" /></label>
                <label className={styles.fullField}><span>Reason for visit *</span><textarea name="reason" required maxLength={2000} rows={3} placeholder="Explain why the site visit is needed" /></label>
                <label><span>Preferred date *</span><input name="requestedDate" type="date" required defaultValue={suggestedSchedule.date} /></label>
                <label><span>Preferred time *</span><input name="requestedTime" type="time" required defaultValue={suggestedSchedule.time} /></label>
              </div>
              <div className={styles.sheetFooter}>
                <button type="button" className={styles.secondaryButton} onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
                <button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spinner} size={18} /> : <ClipboardCheck size={18} />}Submit for approval</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {detail && (
        <div className={styles.overlay} role="presentation">
          <section className={`${styles.sheet} ${styles.detailSheet}`} role="dialog" aria-modal="true" aria-labelledby="site-visit-detail-title">
            <div className={styles.sheetHeader}>
              <div className={styles.detailTitle}>
                <StatusBadge status={detail.status} />
                <h2 id="site-visit-detail-title">{detail.projectName}</h2>
                <p><CalendarDays size={14} />{hasActualSchedule(detail) ? `${formatDate(detail.scheduledDate)} at ${formatTime(detail.scheduledTime)}` : `Preferred ${formatDate(detail.requestedDate)} at ${formatTime(detail.requestedTime)}`}</p>
              </div>
              <button ref={detailCloseButtonRef} type="button" onClick={closeDetail} disabled={busy} aria-label="Close"><X size={21} /></button>
            </div>
            {(error || notice) && <ModalMessage message={error || notice} error={Boolean(error)} onDismiss={() => { setError(""); setNotice(""); }} />}

            <div className={styles.detailBody}>
              <WorkflowProgress status={detail.status} />

              <div className={styles.detailGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelTitle}><span><FileText size={18} /></span><div><h3>Request details</h3><p>Customer, reason and preferred time</p></div></div>
                  <div className={styles.fieldGrid}>
                    <label className={styles.fullField}><span>Customer name</span><input value={detail.projectName} maxLength={160} readOnly={!coreDetailsEditable} onChange={(event) => updateDetail({ projectName: event.target.value }, coreDetailsDirtyKind)} /></label>
                    <label className={styles.fullField}><span>Site address</span><textarea value={detail.address} maxLength={300} rows={2} readOnly={!coreDetailsEditable} onChange={(event) => updateDetail({ address: event.target.value }, coreDetailsDirtyKind)} /></label>
                    <label className={styles.fullField}><span>Phone</span><input value={detail.contact} maxLength={240} inputMode="tel" autoComplete="tel" readOnly={!coreDetailsEditable} placeholder="No phone recorded" onChange={(event) => updateDetail({ contact: event.target.value }, coreDetailsDirtyKind)} /></label>
                    <label className={styles.fullField}><span>Reason for visit</span><textarea value={detail.reason} maxLength={2000} rows={3} readOnly={!requestEditable} placeholder="No reason recorded" onChange={(event) => updateDetail({ reason: event.target.value }, "request")} /></label>
                    <label><span>Preferred date</span><input type="date" value={detail.requestedDate} readOnly={!requestEditable} onChange={(event) => updateDetail({ requestedDate: event.target.value }, "request")} /></label>
                    <label><span>Preferred time</span><input type="time" value={detail.requestedTime} readOnly={!requestEditable} onChange={(event) => updateDetail({ requestedTime: event.target.value }, "request")} /></label>
                  </div>
                </section>

                {detail.status === "pending_approval" ? (
                  <section className={`${styles.panel} ${styles.stagePanel}`}>
                    <div className={styles.panelTitle}><span><CheckCircle2 size={18} /></span><div><h3>Approval</h3><p>The request must be approved before scheduling</p></div></div>
                    <div className={styles.stageCallout}>
                      <strong>{canApprove ? "Review this request" : "Awaiting administrator approval"}</strong>
                      <p>{canApprove ? "Confirm the customer details, reason and preferred time, then approve the request." : "An administrator will review this request. Site checks and photos unlock after it is scheduled."}</p>
                    </div>
                  </section>
                ) : detail.status === "cancelled" && !hasActualSchedule(detail) ? (
                  <section className={`${styles.panel} ${styles.stagePanel}`}>
                    <div className={styles.panelTitle}><span><CircleAlert size={18} /></span><div><h3>Request cancelled</h3><p>This request is no longer active</p></div></div>
                    <div className={styles.stageCallout}><strong>Cancelled before scheduling</strong><p>{canSchedule ? "Restore the request to return it to its previous stage." : "A Project Manager or Administrator can restore this request."}</p></div>
                  </section>
                ) : (
                  <section className={`${styles.panel} ${styles.schedulePanel}`}>
                    <div className={styles.panelTitle}><span><CalendarDays size={18} /></span><div><h3>Visit schedule</h3><p>{detail.status === "approved" ? "Set the confirmed visit time and assignee" : "Confirmed appointment and team member"}</p></div></div>
                    {(detail.status === "approved" || detail.status === "scheduled") && canSchedule ? (
                      <form className={styles.scheduleForm} onSubmit={scheduleVisit}>
                        <label><span>Visit date *</span><input type="date" required value={scheduleDraft.scheduledDate} onChange={(event) => setScheduleDraft((current) => ({ ...current, scheduledDate: event.target.value }))} /></label>
                        <label><span>Visit time *</span><input type="time" required value={scheduleDraft.scheduledTime} onChange={(event) => setScheduleDraft((current) => ({ ...current, scheduledTime: event.target.value }))} /></label>
                        <label className={styles.fullField}><span>Assigned to *</span><input required maxLength={120} value={scheduleDraft.assignee} placeholder="Team member" onChange={(event) => setScheduleDraft((current) => ({ ...current, assignee: event.target.value }))} /></label>
                        <button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spinner} size={18} /> : <CalendarDays size={18} />}{detail.status === "approved" ? "Confirm schedule" : "Update schedule"}</button>
                      </form>
                    ) : hasActualSchedule(detail) ? (
                      <dl className={styles.scheduleSummary}>
                        <div><dt>Date</dt><dd>{formatDate(detail.scheduledDate)}</dd></div>
                        <div><dt>Time</dt><dd>{formatTime(detail.scheduledTime)}</dd></div>
                        <div><dt>Assigned to</dt><dd>{detail.assignee || "Not assigned"}</dd></div>
                      </dl>
                    ) : (
                      <div className={styles.stageCallout}><strong>Approved and ready to schedule</strong><p>A Project Manager or Administrator needs to confirm the date, time and assignee.</p></div>
                    )}
                  </section>
                )}
              </div>

              {showOnSiteDetails ? (
                <>
                <section className={`${styles.panel} ${styles.checklistPanel}`}>
                  <div className={styles.panelTitle}><span><ClipboardCheck size={18} /></span><div><h3 id="site-visit-checks-title">Site checks</h3><p>{detail.checklist.filter((item) => item.answer !== "not_checked").length} of {detail.checklist.length} checked</p></div></div>
                  {detail.status === "completed" ? (
                    <div
                      className={styles.completedChecksTableRegion}
                      role="region"
                      aria-labelledby="site-visit-checks-title"
                      tabIndex={0}
                    >
                      <table className={styles.completedChecksTable}>
                        <caption className={styles.srOnly}>Completed site checks for {detail.projectName}</caption>
                        <thead>
                          <tr><th scope="col">Project</th><th scope="col">Situation</th><th scope="col">Notes</th></tr>
                        </thead>
                        <tbody>
                          {detail.checklist.map((item) => (
                            <tr key={item.id}>
                              <td className={styles.completedCheckProject}>{item.label}</td>
                              <td>
                                <span className={`${styles.completedCheckSituation} ${styles[`answer_${item.answer}`]}`}>
                                  {ANSWER_OPTIONS.find((option) => option.value === item.answer)?.label ?? "Not checked"}
                                </span>
                              </td>
                              <td className={styles.completedCheckNotes}>{item.notes.trim() || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className={styles.checklist}>
                      {detail.checklist.map((item) => (
                        <article className={styles.checkItem} key={item.id}>
                          <div><h4>{item.label}</h4><small>Select what you found on site</small></div>
                          <div className={styles.answerGrid}>
                            {ANSWER_OPTIONS.map((option) => (
                              <button
                                type="button"
                                key={option.value}
                                className={`${styles.answerButton} ${item.answer === option.value ? styles[`answer_${option.value}`] : ""}`}
                                disabled={!visitEditable || busy}
                                onClick={() => updateCheck(item.id, { answer: option.value })}
                              >
                                {item.answer === option.value && <Check size={15} />}{option.label}
                              </button>
                            ))}
                          </div>
                          <label><span>Check notes</span><textarea value={item.notes} maxLength={2000} rows={2} readOnly={!visitEditable} placeholder={CHECK_NOTE_PLACEHOLDERS[item.id] || "Add measurements, damage or follow-up details"} onChange={(event) => updateCheck(item.id, { notes: event.target.value })} /></label>
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className={styles.panel}>
                <div className={styles.panelTitle}><span><Camera size={18} /></span><div><h3>Site photos</h3><p>{detail.photos.length} attached to this visit</p></div></div>
                {visitEditable ? <div className={styles.photoActions}>
                  <button type="button" className={styles.cameraButton} onClick={() => cameraInputRef.current?.click()} disabled={busy}><Camera size={20} /><span><strong>Take a photo</strong><small>Open the rear camera</small></span></button>
                  <button type="button" className={styles.uploadButton} onClick={() => galleryInputRef.current?.click()} disabled={busy}><ImagePlus size={20} /><span><strong>Add from phone</strong><small>Select up to 10 photos</small></span></button>
                  <input ref={cameraInputRef} className={styles.hiddenInput} tabIndex={-1} aria-hidden="true" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void uploadPhotos(event)} />
                  <input ref={galleryInputRef} className={styles.hiddenInput} tabIndex={-1} aria-hidden="true" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void uploadPhotos(event)} />
                </div> : null}
                {detail.photos.length ? (
                  <div className={styles.photoGrid}>
                    {detail.photos.map((photo) => (
                      <SiteVisitPhotoCard
                        key={photo.id}
                        photo={photo}
                        busy={busy}
                        editable={visitEditable}
                        onDelete={(photoId) => void deletePhoto(photoId)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={styles.photoEmpty}><Upload size={24} /><span>{visitEditable ? "No photos yet. Use the camera when you arrive on site." : "No photos were attached to this visit."}</span></div>
                )}
              </section>

              <section className={styles.panel}>
                <div className={styles.panelTitle}><span><ClipboardCheck size={18} /></span><div><h3>General notes</h3><p>Observations, measurements and next steps</p></div></div>
                <textarea className={styles.notesArea} value={detail.notes} maxLength={10000} rows={6} readOnly={!visitEditable} placeholder="Add anything the office or installation team should know…" onChange={(event) => updateDetail({ notes: event.target.value }, "visit")} />
              </section>
                </>
              ) : null}

              <div className={styles.visitActions}>
                {detail.status === "pending_approval" && canApprove ? <button type="button" className={styles.approveButton} onClick={() => void runWorkflowAction("approve", "Site visit approved and ready to schedule.")} disabled={busy}><CheckCircle2 size={18} />Approve request</button> : null}
                {detail.status === "scheduled" ? <button type="button" className={styles.startButton} onClick={() => void runWorkflowAction("start", "Site visit started.")} disabled={busy}><Navigation size={18} />Start visit</button> : null}
                {detail.status === "in_progress" ? <button type="button" className={styles.completeButton} onClick={() => void runWorkflowAction("complete", "Site visit completed.")} disabled={busy}><CheckCircle2 size={18} />Complete visit</button> : null}
                {detail.status === "completed" && canSchedule ? <button type="button" className={styles.secondaryButton} onClick={() => void runWorkflowAction("reopen", "Site visit reopened.")} disabled={busy}>Reopen visit</button> : null}
                {detail.status === "cancelled" && canSchedule ? <button type="button" className={styles.secondaryButton} onClick={() => void runWorkflowAction("restore", "Site visit restored.")} disabled={busy}>Restore visit</button> : null}
                <a className={styles.mapButton} href={mapsUrl(detail.address)} target="_blank" rel="noreferrer"><Navigation size={17} />Directions</a>
              </div>

              <div className={styles.dangerZone}>
                {canSchedule && detail.status !== "cancelled" && detail.status !== "completed" ? <button type="button" onClick={() => void runWorkflowAction("cancel", detail.status === "pending_approval" ? "Site visit request cancelled." : "Site visit cancelled.")} disabled={busy}>{detail.status === "pending_approval" ? "Cancel request" : "Cancel visit"}</button> : null}
                {authenticatedRole === "admin" ? <button type="button" onClick={() => void deleteVisit()} disabled={busy}><Trash2 size={16} />Delete visit</button> : null}
              </div>
            </div>

            <div className={styles.stickyFooter}>
              <div>{detailDirty ? "You have unsaved changes" : requestEditable || visitEditable ? "All changes saved" : "Read only at this stage"}</div>
              {requestEditable || visitEditable ? <button type="button" className={styles.primaryButton} onClick={() => void saveDetail()} disabled={busy || !detailDirty}>
                {busy ? <LoaderCircle className={styles.spinner} size={18} /> : <Save size={18} />}Save changes
              </button> : <span className={styles.readOnlyLabel}>No editable site fields</span>}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) {
  return <div className={styles.metric}><span className={styles[`metric_${tone}`]}>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function ModalMessage({ message, error, onDismiss }: { message: string; error: boolean; onDismiss: () => void }) {
  return (
    <div className={`${styles.modalMessage} ${error ? styles.modalError : styles.modalSuccess}`} role={error ? "alert" : "status"}>
      {error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message"><X size={16} /></button>
    </div>
  );
}

function StatusBadge({ status }: { status: SiteVisitStatus }) {
  return <span className={`${styles.statusBadge} ${styles[`status_${status}`]}`}>{STATUS_LABELS[status]}</span>;
}

function WorkflowProgress({ status, compact = false }: { status: SiteVisitStatus; compact?: boolean }) {
  const currentIndex = status === "cancelled"
    ? -1
    : WORKFLOW_STAGES.findIndex((stage) => stage.status === status);
  return (
    <ol
      className={`${styles.workflowProgress} ${compact ? styles.compactWorkflow : ""}`}
      aria-label={`Site visit workflow: ${STATUS_LABELS[status]}`}
    >
      {WORKFLOW_STAGES.map((stage, index) => (
        <li
          key={stage.status}
          className={currentIndex === index
            ? styles.workflowCurrent
            : currentIndex > index ? styles.workflowComplete : ""}
          aria-current={currentIndex === index ? "step" : undefined}
        >
          <i aria-hidden="true">{currentIndex > index ? <Check size={11} /> : index + 1}</i>
          <span>{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}

function VisitCard({ visit, onOpen }: { visit: SiteVisit; onOpen: (trigger: HTMLButtonElement) => void }) {
  const checked = visit.checklist.filter((item) => item.answer !== "not_checked").length;
  const actualSchedule = hasActualSchedule(visit);
  const today = actualSchedule && visit.scheduledDate === localToday() && visit.status !== "cancelled";
  const beforeSchedule = !actualSchedule;
  const displayDate = actualSchedule ? visit.scheduledDate : visit.requestedDate;
  const displayTime = actualSchedule ? visit.scheduledTime : visit.requestedTime;
  return (
    <article className={styles.visitCard}>
      <div className={styles.cardTop}>
        <StatusBadge status={visit.status} />
        {today && visit.status !== "cancelled" && <span className={styles.todayBadge}>Today</span>}
      </div>
      <WorkflowProgress status={visit.status} compact />
      <h2>{visit.projectName}</h2>
      <p className={styles.address} title={visit.address}>
        <MapPin size={16} />
        <span>{visit.address}</span>
      </p>
      <div className={styles.cardMeta}>
        <span><CalendarDays size={15} />{beforeSchedule ? "Preferred " : ""}{formatDate(displayDate)}</span>
        <span><Clock3 size={15} />{formatTime(displayTime)}</span>
        {visit.assignee && <span><UserRound size={15} />{visit.assignee}</span>}
      </div>
      <div className={styles.cardFooter}>
        <div className={styles.cardProgress}>
          {beforeSchedule ? (
            <>
              <span className={styles.cardReason}><FileText size={15} />{visit.reason || "No reason recorded"}</span>
              <span><Phone size={15} />{visit.contact || "No phone recorded"}</span>
            </>
          ) : (
            <>
              <span><ClipboardCheck size={15} />{checked}/{visit.checklist.length} site checks</span>
              <span><Camera size={15} />{visit.photos.length} photos</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        className={styles.cardOpenButton}
        onClick={(event) => onOpen(event.currentTarget)}
        aria-label={`Open site visit details for ${visit.projectName}, ${STATUS_LABELS[visit.status]}`}
      />
    </article>
  );
}
