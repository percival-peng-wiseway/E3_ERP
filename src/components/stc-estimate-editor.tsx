"use client";
import { useState, type FormEvent } from "react";
import type { PaymentTrackProject } from "@/lib/payment-track/types";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./amount-due-editor.module.css";

export function StcEstimateEditor({ project, busy, onBusyChange, onSaved }: { project: PaymentTrackProject; busy: boolean; onBusyChange: (value: boolean) => void; onSaved: (value: PaymentTrackProject) => void }) {
  const [snapshot, setSnapshot] = useState<PaymentTrackProject | null>(null);
  const [solar, setSolar] = useState("");
  const [battery, setBattery] = useState("");
  const [error, setError] = useState("");
  const money = (value?: number | null) => value == null ? "Not entered" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value / 100);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!snapshot || busy) return;
    onBusyChange(true); setError("");
    try {
      const response = await fetch(`/api/payment-track/${project.id}/stc-estimate`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ solar: solar.trim() || null, battery: battery.trim() || null, expectedUpdatedAt: snapshot.updatedAt }) });
      const result = await readJsonResponse<{ data: PaymentTrackProject; error?: string }>(response);
      if (!response.ok) throw new Error(result.error || "Unable to save STC amounts.");
      onSaved(result.data); setSnapshot(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to save STC amounts."); }
    finally { onBusyChange(false); }
  }
  return <section className={styles.panel} aria-label="Expected STC amounts">
    <header><strong>Expected STC amounts</strong>{!snapshot ? <button type="button" disabled={busy} onClick={() => { setSnapshot(project); setSolar(project.stcSolarExpectedAmountCents == null ? "" : (project.stcSolarExpectedAmountCents / 100).toFixed(2)); setBattery(project.stcBatteryExpectedAmountCents == null ? "" : (project.stcBatteryExpectedAmountCents / 100).toFixed(2)); setError(""); }}>Edit STC amounts</button> : null}</header>
    {snapshot ? <form onSubmit={save}><div className={styles.fields}>
      <label>Expected Solar STC (AUD)<input inputMode="decimal" value={solar} disabled={busy} onChange={event => setSolar(event.target.value)} placeholder="Unknown" /></label>
      <label>Expected Battery STC (AUD)<input inputMode="decimal" value={battery} disabled={busy} onChange={event => setBattery(event.target.value)} placeholder="Unknown" /></label>
    </div><p>Enter the expected STC proceeds from the contract. Leave unknown amounts blank. Received STC is excluded from the outstanding total.</p>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => setSnapshot(null)}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save STC amounts"}</button></div>
    </form> : <p>Solar: {money(project.stcSolarExpectedAmountCents)} · Battery: {money(project.stcBatteryExpectedAmountCents)}</p>}
  </section>;
}
