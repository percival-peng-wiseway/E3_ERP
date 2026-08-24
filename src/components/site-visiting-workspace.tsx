"use client";

import {
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  ImagePlus,
  LoaderCircle,
  MapPin,
  Navigation,
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
  SiteVisitCheckAnswer,
  SiteVisitChecklistItem,
  SiteVisitPhoto,
  SiteVisitStatus,
} from "@/lib/site-visits/types";
import styles from "./site-visiting-workspace.module.css";

type StatusFilter = "all" | SiteVisitStatus;

const STATUS_LABELS: Record<SiteVisitStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ANSWER_OPTIONS: Array<{ value: SiteVisitCheckAnswer; label: string }> = [
  { value: "not_checked", label: "Not checked" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Unsure" },
];

const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;

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

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" }).format(date);
}

function scheduleKey(visit: SiteVisit) {
  return `${visit.scheduledDate}T${visit.scheduledTime}`;
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

function editableVisitPayload(visit: SiteVisit, status = visit.status) {
  return {
    projectName: visit.projectName,
    address: visit.address,
    contact: visit.contact,
    scheduledDate: visit.scheduledDate,
    scheduledTime: visit.scheduledTime,
    assignee: visit.assignee,
    notes: visit.notes,
    checklist: visit.checklist,
    status,
  };
}

function retriedPhotoUrl(url: string, attempt: number) {
  if (!attempt) return url;
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
}

function SiteVisitPhotoCard({
  photo,
  busy,
  onDelete,
}: {
  photo: SiteVisitPhoto;
  busy: boolean;
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
        <button onClick={() => onDelete(photo.id)} disabled={busy} aria-label={`Delete ${photo.originalName}`}>
          <Trash2 size={16} />
        </button>
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
  const [detailDirty, setDetailDirty] = useState(false);
  const suggestedSchedule = useMemo(defaultSchedule, []);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

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
      setDetailDirty(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeModal, detail, detailDirty]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => ({
    scheduled: visits.filter((visit) => visit.status === "scheduled").length,
    inProgress: visits.filter((visit) => visit.status === "in_progress").length,
    completed: visits.filter((visit) => visit.status === "completed").length,
    today: visits.filter((visit) => visit.scheduledDate === localToday() && visit.status !== "cancelled").length,
  }), [visits]);

  const visibleVisits = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("en-AU");
    const statusOrder: Record<SiteVisitStatus, number> = {
      in_progress: 0,
      scheduled: 1,
      completed: 2,
      cancelled: 3,
    };
    return visits
      .filter((visit) => statusFilter === "all" || visit.status === statusFilter)
      .filter((visit) => !term || [
        visit.projectName,
        visit.address,
        visit.contact,
        visit.assignee,
        visit.notes,
      ].join(" ").toLocaleLowerCase("en-AU").includes(term))
      .slice()
      .sort((left, right) => statusOrder[left.status] - statusOrder[right.status]
        || scheduleKey(left).localeCompare(scheduleKey(right)));
  }, [search, statusFilter, visits]);

  function replaceVisit(visit: SiteVisit, updateDraft = true) {
    setVisits((current) => current.map((item) => item.id === visit.id ? visit : item));
    if (updateDraft) setDetail(cloneVisit(visit));
  }

  function openDetail(visit: SiteVisit) {
    setError("");
    setDetail(cloneVisit(visit));
    setDetailDirty(false);
  }

  function closeDetail() {
    if (busy) return;
    if (detailDirty && !window.confirm("Discard the unsaved site visit changes?")) return;
    setDetail(null);
    setDetailDirty(false);
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
          scheduledDate: String(data.get("scheduledDate") || ""),
          scheduledTime: String(data.get("scheduledTime") || ""),
          assignee: String(data.get("assignee") || ""),
          notes: String(data.get("notes") || ""),
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
      setNotice(`${visit.projectName} was scheduled.`);
      openDetail(visit);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create the site visit.");
    } finally {
      setBusy(false);
    }
  }

  async function patchVisit(visit: SiteVisit, status = visit.status) {
    const response = await fetch(`/api/site-visits/${encodeURIComponent(visit.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editableVisitPayload(visit, status)),
    });
    const body = await responseBody(response) as { data?: { visit?: SiteVisit } } | null;
    if (!response.ok || !body?.data?.visit) {
      throw new Error(apiError(body, "Unable to save the site visit."));
    }
    return body.data.visit;
  }

  async function saveDetail() {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const saved = await patchVisit(detail);
      replaceVisit(saved);
      setDetailDirty(false);
      setNotice("Site visit details saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the site visit.");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: SiteVisitStatus) {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const saved = await patchVisit(detail, status);
      replaceVisit(saved);
      setDetailDirty(false);
      setNotice(`Site visit moved to ${STATUS_LABELS[status]}.`);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Unable to update the visit status.");
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
      setDetailDirty(false);
      setNotice("Site visit deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the site visit.");
    } finally {
      setBusy(false);
    }
  }

  function updateDetail(patch: Partial<SiteVisit>) {
    setDetail((current) => current ? { ...current, ...patch } : current);
    setDetailDirty(true);
  }

  function updateCheck(id: string, patch: Partial<SiteVisitChecklistItem>) {
    setDetail((current) => current ? {
      ...current,
      checklist: current.checklist.map((item) => item.id === id ? { ...item, ...patch } : item),
    } : current);
    setDetailDirty(true);
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
        current = await patchVisit(detail);
        replaceVisit(current);
        setDetailDirty(false);
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
      const response = await fetch(
        `/api/site-visits/${encodeURIComponent(detail.id)}/photos/${encodeURIComponent(photoId)}`,
        { method: "DELETE" },
      );
      const body = await responseBody(response) as { data?: { visit?: SiteVisit } } | null;
      if (!response.ok || !body?.data?.visit) {
        throw new Error(apiError(body, "Unable to remove the site photo."));
      }
      const serverVisit = body.data.visit;
      setVisits((current) => current.map((visit) => visit.id === serverVisit.id ? serverVisit : visit));
      setDetail((current) => current ? {
        ...current,
        photos: serverVisit.photos,
        updatedAt: serverVisit.updatedAt,
      } : current);
      setNotice("Site photo removed.");
    } catch (photoError) {
      setError(photoError instanceof Error ? photoError.message : "Unable to remove the site photo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.workspace}>
      <header className={styles.hero}>
        <div>
          <span className={styles.kicker}>FIELD OPERATIONS</span>
          <h1>Site Visiting</h1>
          <p>Schedule a visit, capture site conditions and keep every photo and note with the project.</p>
        </div>
        <button className={styles.primaryButton} onClick={() => { setError(""); setCreateOpen(true); }}>
          <Plus size={18} />New site visit
        </button>
      </header>

      {(error || notice) && (
        <div className={`${styles.message} ${error ? styles.errorMessage : styles.successMessage}`} role={error ? "alert" : "status"}>
          {error ? <CircleAlert size={19} /> : <CheckCircle2 size={19} />}
          <span>{error || notice}</span>
          <button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss message"><X size={17} /></button>
        </div>
      )}

      <div className={styles.metrics}>
        <Metric label="Today" value={counts.today} icon={<CalendarDays size={19} />} tone="blue" />
        <Metric label="Scheduled" value={counts.scheduled} icon={<Clock3 size={19} />} tone="amber" />
        <Metric label="In progress" value={counts.inProgress} icon={<Navigation size={19} />} tone="violet" />
        <Metric label="Completed" value={counts.completed} icon={<CheckCircle2 size={19} />} tone="green" />
      </div>

      <div className={styles.toolbar}>
        <label className={styles.searchBox}>
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search project, address or assignee" />
        </label>
        <div className={styles.filters} aria-label="Filter site visits by status">
          {(["all", "scheduled", "in_progress", "completed", "cancelled"] as StatusFilter[]).map((status) => (
            <button
              key={status}
              className={statusFilter === status ? styles.activeFilter : ""}
              onClick={() => setStatusFilter(status)}
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
            <VisitCard key={visit.id} visit={visit} onOpen={() => openDetail(visit)} />
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <span><MapPin size={28} /></span>
          <h2>{visits.length ? "No visits match this view" : "Schedule your first site visit"}</h2>
          <p>{visits.length ? "Try another search or status filter." : "Create the project now, then open it on your phone when you arrive on site."}</p>
          {!visits.length && <button className={styles.primaryButton} onClick={() => setCreateOpen(true)}><Plus size={18} />New site visit</button>}
        </div>
      )}

      {createOpen && (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setCreateOpen(false);
        }}>
          <section className={`${styles.sheet} ${styles.createSheet}`} role="dialog" aria-modal="true" aria-labelledby="create-site-visit-title">
            <div className={styles.sheetHeader}>
              <div><span>NEW VISIT</span><h2 id="create-site-visit-title">Schedule a site visit</h2></div>
              <button onClick={() => setCreateOpen(false)} disabled={busy} aria-label="Close"><X size={21} /></button>
            </div>
            {error && <ModalMessage message={error} error onDismiss={() => setError("")} />}
            <form className={styles.createForm} onSubmit={createVisit}>
              <div className={styles.formBody}>
                <label className={styles.fullField}><span>Project or customer name *</span><input name="projectName" required maxLength={160} autoFocus placeholder="e.g. Smith residence" /></label>
                <label className={styles.fullField}><span>Site address *</span><textarea name="address" required maxLength={300} rows={2} placeholder="Street address, suburb and postcode" /></label>
                <label><span>Visit date *</span><input name="scheduledDate" type="date" required defaultValue={suggestedSchedule.date} /></label>
                <label><span>Visit time *</span><input name="scheduledTime" type="time" required defaultValue={suggestedSchedule.time} /></label>
                <label><span>Contact</span><input name="contact" maxLength={240} inputMode="tel" placeholder="Name or phone number" /></label>
                <label><span>Assigned to</span><input name="assignee" maxLength={120} placeholder="Team member" /></label>
                <label className={styles.fullField}><span>Planning notes</span><textarea name="notes" maxLength={10000} rows={3} placeholder="Access instructions or anything to know before the visit" /></label>
              </div>
              <div className={styles.sheetFooter}>
                <button type="button" className={styles.secondaryButton} onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
                <button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spinner} size={18} /> : <CalendarDays size={18} />}Schedule visit</button>
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
                <p><CalendarDays size={14} />{formatDate(detail.scheduledDate)} at {formatTime(detail.scheduledTime)}</p>
              </div>
              <button onClick={closeDetail} disabled={busy} aria-label="Close"><X size={21} /></button>
            </div>
            {(error || notice) && <ModalMessage message={error || notice} error={Boolean(error)} onDismiss={() => { setError(""); setNotice(""); }} />}

            <div className={styles.detailBody}>
              <div className={styles.visitActions}>
                {detail.status === "scheduled" && <button className={styles.startButton} onClick={() => void changeStatus("in_progress")} disabled={busy}><Navigation size={18} />Start visit</button>}
                {detail.status === "in_progress" && <button className={styles.completeButton} onClick={() => void changeStatus("completed")} disabled={busy}><CheckCircle2 size={18} />Complete visit</button>}
                {detail.status === "completed" && <button className={styles.secondaryButton} onClick={() => void changeStatus("in_progress")} disabled={busy}>Reopen visit</button>}
                {detail.status === "cancelled" && <button className={styles.secondaryButton} onClick={() => void changeStatus("scheduled")} disabled={busy}>Restore schedule</button>}
                <a className={styles.mapButton} href={mapsUrl(detail.address)} target="_blank" rel="noreferrer"><Navigation size={17} />Directions</a>
              </div>

              <div className={styles.detailGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelTitle}><span><CalendarDays size={18} /></span><div><h3>Visit details</h3><p>Schedule and contact information</p></div></div>
                  <div className={styles.fieldGrid}>
                    <label className={styles.fullField}><span>Project or customer</span><input value={detail.projectName} maxLength={160} onChange={(event) => updateDetail({ projectName: event.target.value })} /></label>
                    <label className={styles.fullField}><span>Site address</span><textarea value={detail.address} maxLength={300} rows={2} onChange={(event) => updateDetail({ address: event.target.value })} /></label>
                    <label><span>Date</span><input type="date" value={detail.scheduledDate} onChange={(event) => updateDetail({ scheduledDate: event.target.value })} /></label>
                    <label><span>Time</span><input type="time" value={detail.scheduledTime} onChange={(event) => updateDetail({ scheduledTime: event.target.value })} /></label>
                    <label><span>Contact</span><input value={detail.contact} maxLength={240} inputMode="tel" placeholder="Name or phone" onChange={(event) => updateDetail({ contact: event.target.value })} /></label>
                    <label><span>Assigned to</span><input value={detail.assignee} maxLength={120} placeholder="Team member" onChange={(event) => updateDetail({ assignee: event.target.value })} /></label>
                  </div>
                </section>

                <section className={`${styles.panel} ${styles.checklistPanel}`}>
                  <div className={styles.panelTitle}><span><ClipboardCheck size={18} /></span><div><h3>Site checks</h3><p>{detail.checklist.filter((item) => item.answer !== "not_checked").length} of {detail.checklist.length} checked</p></div></div>
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
                              onClick={() => updateCheck(item.id, { answer: option.value })}
                            >
                              {item.answer === option.value && <Check size={15} />}{option.label}
                            </button>
                          ))}
                        </div>
                        <label><span>Check notes</span><textarea value={item.notes} maxLength={2000} rows={2} placeholder="Add measurements, damage or follow-up details" onChange={(event) => updateCheck(item.id, { notes: event.target.value })} /></label>
                      </article>
                    ))}
                  </div>
                </section>
              </div>

              <section className={styles.panel}>
                <div className={styles.panelTitle}><span><Camera size={18} /></span><div><h3>Site photos</h3><p>{detail.photos.length} attached to this visit</p></div></div>
                <div className={styles.photoActions}>
                  <button className={styles.cameraButton} onClick={() => cameraInputRef.current?.click()} disabled={busy}><Camera size={20} /><span><strong>Take a photo</strong><small>Open the rear camera</small></span></button>
                  <button className={styles.uploadButton} onClick={() => galleryInputRef.current?.click()} disabled={busy}><ImagePlus size={20} /><span><strong>Add from phone</strong><small>Select up to 10 photos</small></span></button>
                  <input ref={cameraInputRef} className={styles.hiddenInput} tabIndex={-1} aria-hidden="true" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void uploadPhotos(event)} />
                  <input ref={galleryInputRef} className={styles.hiddenInput} tabIndex={-1} aria-hidden="true" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void uploadPhotos(event)} />
                </div>
                {detail.photos.length ? (
                  <div className={styles.photoGrid}>
                    {detail.photos.map((photo) => (
                      <SiteVisitPhotoCard
                        key={photo.id}
                        photo={photo}
                        busy={busy}
                        onDelete={(photoId) => void deletePhoto(photoId)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={styles.photoEmpty}><Upload size={24} /><span>No photos yet. Use the camera when you arrive on site.</span></div>
                )}
              </section>

              <section className={styles.panel}>
                <div className={styles.panelTitle}><span><ClipboardCheck size={18} /></span><div><h3>General notes</h3><p>Observations, measurements and next steps</p></div></div>
                <textarea className={styles.notesArea} value={detail.notes} maxLength={10000} rows={6} placeholder="Add anything the office or installation team should know…" onChange={(event) => updateDetail({ notes: event.target.value })} />
              </section>

              <div className={styles.dangerZone}>
                {detail.status !== "cancelled" && <button onClick={() => void changeStatus("cancelled")} disabled={busy}>Cancel visit</button>}
                {authenticatedRole === "admin" ? <button onClick={() => void deleteVisit()} disabled={busy}><Trash2 size={16} />Delete visit</button> : null}
              </div>
            </div>

            <div className={styles.stickyFooter}>
              <div>{detailDirty ? "You have unsaved changes" : "All changes saved"}</div>
              <button className={styles.primaryButton} onClick={() => void saveDetail()} disabled={busy || !detailDirty}>
                {busy ? <LoaderCircle className={styles.spinner} size={18} /> : <Save size={18} />}Save changes
              </button>
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
      <button onClick={onDismiss} aria-label="Dismiss message"><X size={16} /></button>
    </div>
  );
}

function StatusBadge({ status }: { status: SiteVisitStatus }) {
  return <span className={`${styles.statusBadge} ${styles[`status_${status}`]}`}>{STATUS_LABELS[status]}</span>;
}

function VisitCard({ visit, onOpen }: { visit: SiteVisit; onOpen: () => void }) {
  const checked = visit.checklist.filter((item) => item.answer !== "not_checked").length;
  const today = visit.scheduledDate === localToday();
  return (
    <article className={styles.visitCard}>
      <div className={styles.cardTop}>
        <StatusBadge status={visit.status} />
        {today && visit.status !== "cancelled" && <span className={styles.todayBadge}>Today</span>}
      </div>
      <h2>{visit.projectName}</h2>
      <p className={styles.address} title={visit.address}>
        <MapPin size={16} />
        <span>{visit.address}</span>
      </p>
      <div className={styles.cardMeta}>
        <span><CalendarDays size={15} />{formatDate(visit.scheduledDate)}</span>
        <span><Clock3 size={15} />{formatTime(visit.scheduledTime)}</span>
        {visit.assignee && <span><UserRound size={15} />{visit.assignee}</span>}
      </div>
      <div className={styles.cardFooter}>
        <div className={styles.cardProgress}>
          <span><ClipboardCheck size={15} />{checked}/{visit.checklist.length} site checks</span>
          <span><Camera size={15} />{visit.photos.length} photos</span>
        </div>
        <button className={styles.openButton} onClick={onOpen} aria-label={`Open site visit for ${visit.projectName}`}>
          Open visit <ChevronRight size={16} />
        </button>
      </div>
    </article>
  );
}
