"use client";
import { useId, useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import type { PaymentTrackProject } from "@/lib/payment-track/types";
import { confirmedCustomerPayments, MAX_RECEIVABLE_CENTS } from "@/lib/payment-track/amount-due";
import { paymentTrackAmountToCents } from "@/lib/payment-track/input-validation";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./amount-due-editor.module.css";
const money = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

export function AmountDueEditor({ project, busy, onBusyChange, onSaved, onReload }: {
  project: PaymentTrackProject; busy: boolean; onBusyChange: (busy: boolean) => void;
  onSaved: (project: PaymentTrackProject) => void; onReload: () => void;
}) {
  const id = useId();
  const [snapshot, setSnapshot] = useState<PaymentTrackProject | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const parsed = paymentTrackAmountToCents(amount);
  const received = confirmedCustomerPayments(snapshot || project);
  const nextTotal = parsed === null ? null : parsed === (snapshot || project).outstandingCents ? (snapshot || project).balanceDueCents : received + parsed;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || busy || parsed === null || nextTotal === null || nextTotal > MAX_RECEIVABLE_CENTS || conflict) return;
    onBusyChange(true); setError("");
    try {
      const response = await fetch(`/api/payment-track/${project.id}/amount-due`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountDue: amount, expectedUpdatedAt: snapshot.updatedAt, reason }),
      });
      const body = await readJsonResponse<{ data: PaymentTrackProject; error?: string }>(response);
      if (!response.ok) { setConflict(response.status === 409); throw new Error(body.error || "Unable to save Amount Due."); }
      onSaved(body.data); setSnapshot(null); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save Amount Due."); }
    finally { onBusyChange(false); }
  }
  const history = project.history.filter((entry) => entry.action === "amount_due_adjusted" && entry.amountAdjustment).slice().reverse();
  return <section className={styles.panel} aria-label="Administrator Amount Due adjustment">
    <header><strong>Amount Due adjustment</strong>{!snapshot ? <button type="button" disabled={busy} onClick={() => {
      setSnapshot(project); setAmount((project.outstandingCents / 100).toFixed(2)); setReason(""); setError(""); setConflict(false); setSaved(false);
    }}><Pencil size={14} />Edit Amount Due</button> : null}</header>
    {snapshot ? <form onSubmit={(event) => void save(event)}>
      <div className={styles.fields}>
        <label htmlFor={`${id}-amount`}>New Amount Due (AUD)<input id={`${id}-amount`} autoFocus inputMode="decimal" required value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 4100.00" /></label>
        <label htmlFor={`${id}-reason`}>Reason (optional)<input id={`${id}-reason`} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
      </div>
      <p>Current Amount Due: <strong>{money(snapshot.outstandingCents)}</strong> · Confirmed payments: <strong>{money(received)}</strong></p>
      <p>Total receivable after adjustment: <strong>{nextTotal !== null && nextTotal <= MAX_RECEIVABLE_CENTS ? money(nextTotal) : "Enter a valid amount"}</strong>. Existing payment records and project stage stay unchanged.</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        {conflict ? <button type="button" disabled={busy} onClick={() => { setSnapshot(null); setError(""); setConflict(false); onReload(); }}>Discard draft &amp; reload project</button> : null}
        <button type="button" disabled={busy} onClick={() => { setSnapshot(null); setError(""); }}>Cancel</button>
        <button type="submit" disabled={busy || parsed === null || nextTotal === null || nextTotal > MAX_RECEIVABLE_CENTS || parsed === snapshot.outstandingCents || conflict}>{busy ? "Saving…" : "Save Amount Due"}</button>
      </div>
    </form> : saved ? <p role="status">Amount Due saved.</p> : null}
    {history.length ? <details className={styles.history}><summary>Adjustment history ({history.length})</summary><ul>{history.map((entry) => <li key={entry.id}>
      <strong>{money(entry.amountAdjustment!.previousAmountDueCents)} → {money(entry.amountAdjustment!.amountDueCents)}</strong>
      <span>{entry.actorName} · {new Date(entry.at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })} (Melbourne)</span>
      <span>Total receivable: {money(entry.amountAdjustment!.previousBalanceDueCents)} → {money(entry.amountAdjustment!.balanceDueCents)}</span>
      {entry.note ? <span>{entry.note}</span> : null}
    </li>)}</ul></details> : null}
  </section>;
}
