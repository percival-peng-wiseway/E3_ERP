"use client";

import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Eye,
  FileText,
  LoaderCircle,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
  WalletCards,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErpRole } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import type {
  ReimbursementAction,
  ReimbursementClaim,
  ReimbursementListResponse,
  ReimbursementMutationResponse,
  ReimbursementStatus,
} from "@/lib/reimbursements/types";
import styles from "./reimbursement-workspace.module.css";

type WorkspaceView = "mine" | "review" | "payment" | "reimbursed";
type DetailMode = "view" | "review" | "payment";

const MAX_INVOICE_SIZE = 10 * 1024 * 1024;
const INVOICE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const STATUS_LABELS: Record<ReimbursementStatus, string> = {
  submitted: "Admin Review",
  pending_payment: "Pending Payment",
  reimbursed: "Reimbursed",
  rejected: "Rejected",
};

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function todayIso() {
  const now = new Date();
  const localTime = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 10);
}

function claimNote(claim: ReimbursementClaim) {
  return claim.note || claim.description || "";
}

function fileSize(value: number) {
  return value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const message = (value as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export function ReimbursementWorkspace({ authenticatedRole, openEntityTarget }: {
  authenticatedRole: ErpRole;
  openEntityTarget?: { entityId: string; requestId: number };
}) {
  const [claims, setClaims] = useState<ReimbursementClaim[]>([]);
  const [view, setView] = useState<WorkspaceView>("mine");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showSubmission, setShowSubmission] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [detail, setDetail] = useState<{ claim: ReimbursementClaim; mode: DetailMode } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const claimsRequestIdRef = useRef(0);
  const handledOpenEntityRequestRef = useRef(0);
  const isAdmin = authenticatedRole === "admin";

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const loadClaims = useCallback(async (quiet = false) => {
    const requestId = ++claimsRequestIdRef.current;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/reimbursements", { cache: "no-store" });
      const body = await readJsonResponse<ReimbursementListResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to load reimbursements."));
      if (requestId !== claimsRequestIdRef.current) return;
      setClaims(Array.isArray(body.data) ? body.data : []);
      setError("");
    } catch (loadError) {
      if (requestId !== claimsRequestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load reimbursements.");
    } finally {
      if (requestId === claimsRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClaims();
  }, [loadClaims]);

  const activeModal = showSubmission || Boolean(detail);
  useEffect(() => {
    if (!activeModal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current) return;
      setShowSubmission(false);
      setDetail(null);
    };
    document.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", close);
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [activeModal]);

  const counts = useMemo(() => ({
    submitted: claims.filter((claim) => claim.status === "submitted").length,
    pendingPayment: claims.filter((claim) => claim.status === "pending_payment").length,
    reimbursed: claims.filter((claim) => claim.status === "reimbursed").length,
    pendingValue: claims
      .filter((claim) => claim.status === "submitted" || claim.status === "pending_payment")
      .reduce((total, claim) => total + claim.amountCents, 0),
  }), [claims]);

  const visibleClaims = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("en-AU");
    return claims.filter((claim) => {
      if (view === "review" && claim.status !== "submitted") return false;
      if (view === "payment" && claim.status !== "pending_payment") return false;
      if (view === "reimbursed" && claim.status !== "reimbursed") return false;
      if (!term) return true;
      return [claim.reference, claim.claimantName, claimNote(claim)]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLocaleLowerCase("en-AU")
        .includes(term);
    });
  }, [claims, search, view]);

  const openModal = (element: HTMLElement | null) => {
    returnFocusRef.current = element;
  };

  const submitClaim = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!selectedFile || selectedFile.size > MAX_INVOICE_SIZE || !INVOICE_TYPES.has(selectedFile.type)) {
      setError("Attach a PDF, JPG, PNG or WebP invoice up to 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = new FormData(form);
      payload.set("invoice", selectedFile);
      const response = await fetch("/api/reimbursements", { method: "POST", body: payload });
      const body = await readJsonResponse<ReimbursementMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to submit the reimbursement."));
      setClaims((current) => [body.data, ...current]);
      setShowSubmission(false);
      setSelectedFile(null);
      form.reset();
      setView("mine");
      setNotice(`${body.data.reference} was submitted for Admin Review.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to submit the reimbursement.");
    } finally {
      setBusy(false);
    }
  };

  const openDetail = useCallback((claim: ReimbursementClaim, mode: DetailMode, element: HTMLElement | null) => {
    openModal(element);
    setReviewNote(claim.reviewNote || "");
    setPaymentReference(claim.paymentReference || "");
    setDetail({ claim, mode });
  }, []);

  useEffect(() => {
    if (!openEntityTarget || loading || handledOpenEntityRequestRef.current === openEntityTarget.requestId) return;
    handledOpenEntityRequestRef.current = openEntityTarget.requestId;
    const claim = claims.find((candidate) => candidate.id === openEntityTarget.entityId);
    if (!claim) {
      setError("The reimbursement linked to this reminder is no longer available.");
      return;
    }
    const mode: DetailMode = isAdmin && claim.status === "submitted"
      ? "review"
      : isAdmin && claim.status === "pending_payment" ? "payment" : "view";
    setSearch("");
    setView(mode === "review" ? "review" : mode === "payment" ? "payment" : "mine");
    openDetail(claim, mode, null);
  }, [claims, isAdmin, loading, openDetail, openEntityTarget]);

  const performAction = async (action: ReimbursementAction) => {
    if (!detail || busy) return;
    if (action === "reject" && !reviewNote.trim()) {
      setError("Add a reason before rejecting this claim.");
      return;
    }
    if (action === "mark_paid" && !paymentReference.trim()) {
      setError("Add a payment reference before marking this claim as paid.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reimbursements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: detail.claim.id,
          action,
          note: action === "mark_paid" ? "" : reviewNote,
          paymentReference,
        }),
      });
      const body = await readJsonResponse<ReimbursementMutationResponse & { error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to update the reimbursement."));
      setClaims((current) => current.map((claim) => claim.id === body.data.id ? body.data : claim));
      setDetail(null);
      setNotice(action === "approve"
        ? `${body.data.reference} moved to Pending Payment.`
        : action === "reject"
          ? `${body.data.reference} was rejected.`
          : `${body.data.reference} was marked as Reimbursed.`);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update the reimbursement.");
    } finally {
      setBusy(false);
    }
  };

  const deleteClaim = async () => {
    if (!detail || busy || authenticatedRole !== "admin") return;
    const claim = detail.claim;
    if (!window.confirm(`Delete reimbursement ${claim.reference} for “${claim.claimantName}”? This cannot be undone.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/reimbursements/${encodeURIComponent(claim.id)}`, { method: "DELETE" });
      const body = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to delete the reimbursement."));
      setClaims((current) => current.filter((item) => item.id !== claim.id));
      setDetail(null);
      setNotice(`${claim.reference} was deleted.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the reimbursement.");
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<[WorkspaceView, string, number]> = isAdmin
    ? [
        ["mine", "All Claims", claims.length],
        ["review", "Admin Review", counts.submitted],
        ["payment", "Pending Payment", counts.pendingPayment],
        ["reimbursed", "Reimbursed", counts.reimbursed],
      ]
    : [
        ["mine", "My Claims", claims.length],
        ["reimbursed", "Reimbursed", counts.reimbursed],
      ];

  return (
    <section className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>EXPENSES · REIMBURSEMENTS</span>
          <h1>Reimbursements</h1>
        </div>
        <div className={`${styles.headerActions} ${!isAdmin ? styles.employeeHeaderActions : ""}`}>
          {isAdmin ? <span className={styles.adminActive}><ShieldCheck size={16} />ERP Administrator</span> : null}
          <button
            className={styles.primaryButton}
            onClick={(event) => { openModal(event.currentTarget); setSelectedFile(null); setShowSubmission(true); }}
          >
            <Plus size={16} />New reimbursement
          </button>
        </div>
      </header>

      <section className={styles.metrics} aria-label="Reimbursement summary">
        <Metric icon={Clock3} label="Admin Review" value={String(counts.submitted)} tone="amber" />
        <Metric icon={WalletCards} label="Pending Payment" value={String(counts.pendingPayment)} tone="blue" />
        <Metric icon={CheckCircle2} label="Reimbursed" value={String(counts.reimbursed)} tone="green" />
        <Metric icon={CircleDollarSign} label="Awaiting Action" value={formatMoney(counts.pendingValue)} tone="violet" />
      </section>

      {notice && <div className={styles.notice} role="status"><CheckCircle2 size={16} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15} /></button></div>}
      {error && <div className={styles.error} role="alert"><AlertCircle size={16} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}

      <section className={styles.panel}>
        <nav
          className={styles.tabs}
          aria-label="Reimbursement views"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(140px, 1fr))` }}
        >
          {tabs.map(([id, label, count]) => (
            <button key={id} className={view === id ? styles.activeTab : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </nav>

        <div className={styles.toolbar}>
          <label className={styles.searchField}><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search reference, name or note" aria-label="Search reimbursements" /></label>
          <button className={styles.refreshButton} onClick={() => void loadClaims()} disabled={loading || busy}>{loading ? <LoaderCircle className={styles.spinning} size={15} /> : null}Refresh</button>
        </div>

        {loading ? (
          <div className={styles.loadingState}><LoaderCircle className={styles.spinning} size={24} />Loading reimbursements…</div>
        ) : visibleClaims.length === 0 ? (
          <div className={styles.emptyState}>
            <span><ReceiptText size={25} /></span>
            <h2>{view === "mine" ? (isAdmin ? "No reimbursement claims" : "No claims for your account") : `No claims in ${view === "review" ? "Admin Review" : view === "payment" ? "Pending Payment" : "Reimbursed"}`}</h2>
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.claimTable}>
              <thead><tr><th>Reference</th><th>Name</th><th>Date &amp; note</th><th>Amount</th><th>Status</th><th>Invoice</th><th><span className={styles.srOnly}>Action</span></th></tr></thead>
              <tbody>{visibleClaims.map((claim) => (
                <tr key={claim.id}>
                  <td><strong>{claim.reference}</strong><small>{formatDate(claim.submittedAt)}</small></td>
                  <td><strong>{claim.claimantName}</strong></td>
                  <td><strong>{formatDate(claim.expenseDate)}</strong><small>{claimNote(claim) || "No note"}</small></td>
                  <td className={styles.amount}>{formatMoney(claim.amountCents)}</td>
                  <td><StatusBadge status={claim.status} /></td>
                  <td><a className={styles.invoiceLink} href={claim.invoice.url} target="_blank" rel="noreferrer"><FileText size={14} /><span>{claim.invoice.originalName}</span></a></td>
                  <td><button className={styles.rowAction} onClick={(event) => openDetail(claim, view === "review" ? "review" : view === "payment" ? "payment" : "view", event.currentTarget)}><Eye size={15} />{view === "review" ? "Review" : view === "payment" ? "Pay" : "View"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {showSubmission && (
        <Modal title="New reimbursement" onClose={() => { if (!busy) { setShowSubmission(false); setSelectedFile(null); } }}>
          <form className={styles.form} onSubmit={submitClaim}>
            <div className={styles.formGrid}>
              <label>Name<input name="claimantName" autoComplete="name" autoFocus required /></label>
              <label>Date<input name="expenseDate" type="date" defaultValue={todayIso()} max={todayIso()} required /></label>
              <label>Amount (AUD)<span className={styles.moneyInput}><b>$</b><input name="amount" type="number" min="0.01" max="10000000" step="0.01" inputMode="decimal" required /></span></label>
              <label className={styles.fullField}><span className={styles.fieldLabel}>Note</span><textarea name="note" rows={3} maxLength={2000} /></label>
              <label className={`${styles.uploadField} ${styles.fullField}`}>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} required />
                <span><UploadCloud size={23} /></span>
                <strong>{selectedFile ? selectedFile.name : "Upload invoice"}</strong>
                <small>{selectedFile ? fileSize(selectedFile.size) : "PDF, JPG, PNG or WebP · maximum 10 MB"}</small>
              </label>
            </div>
            <footer className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={() => { setShowSubmission(false); setSelectedFile(null); }} disabled={busy}>Cancel</button><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spinning} size={15} /> : <ReceiptText size={15} />}Submit for Review</button></footer>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.claim.reference} subtitle={`${detail.claim.claimantName} · ${formatMoney(detail.claim.amountCents)}`} onClose={() => !busy && setDetail(null)}>
          <div className={styles.detailBody}>
            <div className={styles.detailSummary}>
              <Detail label="Status"><StatusBadge status={detail.claim.status} /></Detail>
              <Detail label="Name">{detail.claim.claimantName}</Detail>
              <Detail label="Date">{formatDate(detail.claim.expenseDate)}</Detail>
              <Detail label="Amount"><strong className={styles.detailAmount}>{formatMoney(detail.claim.amountCents)}</strong></Detail>
              <Detail label="Note">{claimNote(detail.claim) || "—"}</Detail>
            </div>
            <a className={styles.invoiceCard} href={detail.claim.invoice.url} target="_blank" rel="noreferrer"><span><FileText size={20} /></span><div><strong>{detail.claim.invoice.originalName}</strong><small>{fileSize(detail.claim.invoice.size)} · Open invoice</small></div><Eye size={16} /></a>
            {isAdmin && detail.mode === "review" && <label className={styles.actionField}>Review note<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} placeholder="Required when rejecting; optional when approving" /></label>}
            {isAdmin && detail.mode === "payment" && <label className={styles.actionField}>Payment reference<input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Bank transaction or payment reference" autoFocus /></label>}
            <div className={styles.timeline}><h3>Status history</h3>{detail.claim.history.map((entry) => <div key={entry.id}><i /><span><strong>{entry.action.replaceAll("_", " ")}</strong><small>{formatDate(entry.at)} · {entry.actor}{entry.note ? ` · ${entry.note}` : ""}</small></span></div>)}</div>
          </div>
          <footer className={styles.modalFooter}>
            {authenticatedRole === "admin" ? <button className={styles.rejectButton} onClick={() => void deleteClaim()} disabled={busy}><Trash2 size={15} />Delete claim</button> : null}
            <button className={styles.secondaryButton} onClick={() => setDetail(null)} disabled={busy}>Close</button>
            {isAdmin && detail.mode === "review" && <><button className={styles.rejectButton} onClick={() => void performAction("reject")} disabled={busy}>Reject</button><button className={styles.primaryButton} onClick={() => void performAction("approve")} disabled={busy}>{busy && <LoaderCircle className={styles.spinning} size={15} />}Approve for Payment</button></>}
            {isAdmin && detail.mode === "payment" && <button className={styles.paidButton} onClick={() => void performAction("mark_paid")} disabled={busy}>{busy ? <LoaderCircle className={styles.spinning} size={15} /> : <CheckCircle2 size={15} />}Mark Paid</button>}
          </footer>
        </Modal>
      )}
    </section>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Clock3; label: string; value: string; tone: string }) {
  return <article><span className={`${styles.metricIcon} ${styles[tone]}`}><Icon size={18} /></span><div><small>{label}</small><strong>{value}</strong></div></article>;
}

function StatusBadge({ status }: { status: ReimbursementStatus }) {
  return <span className={`${styles.status} ${styles[status]}`}>{STATUS_LABELS[status]}</span>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><span>{label}</span><p>{children}</p></div>;
}

function Modal({ title, subtitle, children, onClose, compact = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; compact?: boolean }) {
  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`${styles.modal} ${compact ? styles.compactModal : ""}`} role="dialog" aria-modal="true" aria-labelledby="reimbursement-dialog-title"><header><div>{subtitle ? <span>{subtitle}</span> : null}<h2 id="reimbursement-dialog-title">{title}</h2></div><button onClick={onClose} aria-label="Close"><X size={19} /></button></header>{children}</section></div>;
}
