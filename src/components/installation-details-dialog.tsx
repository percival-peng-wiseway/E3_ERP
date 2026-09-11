"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { CustomerDetails } from "./customer-details";
import type { PaymentTrackProject } from "@/lib/payment-track/types";
import { installationDetails, customerLabel, type InstallationDetails } from "@/lib/timetable/types";
import styles from "./installer-workspace.module.css";

export function InstallationDetailsContent({ details: d, editable = false, onSaved, onBusyChange }: { details: InstallationDetails; editable?: boolean; onSaved?: (project: PaymentTrackProject) => void; onBusyChange?: (busy: boolean) => void }) {
  return <div className={styles.detailsGrid}>
    <CustomerDetails key={d.id} project={d} editable={editable} onSaved={onSaved} onBusyChange={onBusyChange} />
    <section><h3>Schedule & ownership</h3><dl>
      <div><dt>Sales</dt><dd>{d.specialist.name || "—"}</dd></div>
      <div><dt>Sales phone</dt><dd>{d.specialist.phone || "—"}</dd></div>
      <div><dt>Material delivery</dt><dd>{[d.deliveryScheduledFor, d.deliveryScheduledTime, d.deliveryAssignee].filter(Boolean).join(" · ") || "Not scheduled"}</dd></div>
      <div><dt>Installation</dt><dd>{[d.installationScheduledFor, d.installationScheduledTime, d.installationAssignee].filter(Boolean).join(" · ") || "Not scheduled"}</dd></div>
    </dl></section>
    <section className={styles.wide}><h3>Order Items <small>{d.items.length}</small></h3>
      {d.items.length ? <div className={styles.tableScroll}><table><thead><tr><th>Category</th><th>Model</th><th>Description</th><th>Quantity</th><th>Capacity</th></tr></thead>
        <tbody>{d.items.map((item) => <tr key={item.id}><td>{item.category}</td><td>{item.model || "—"}</td><td>{item.description || "—"}</td><td>{item.quantity}</td><td>{item.capacity || "—"}</td></tr>)}</tbody></table></div> : <p>No order items</p>}
    </section>
    <section><h3>Chosen Items <small>{d.deliverySelections.length}</small></h3>
      {d.deliverySelections.length ? <ul className={styles.chosen}>{d.deliverySelections.map((item) => <li key={item.sku}><strong>{item.sku}</strong><span>× {item.quantity}</span></li>)}</ul> : <p>No warehouse items chosen</p>}
    </section>
    <section><h3>Notes</h3><p className={styles.notes}>{d.projectNotes || "No shared notes"}</p>
      {d.pmNotes ? <><h3>PM Notes</h3><p className={styles.notes}>{d.pmNotes}</p></> : null}
    </section>
  </div>;
}

export function InstallationDetailsDialog({ projectId, initialDetails, onClose, canEditCustomer = false }: {
  projectId?: string; initialDetails?: InstallationDetails; onClose: () => void; canEditCustomer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [details, setDetails] = useState<InstallationDetails | null>(initialDetails || null);
  const [error, setError] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setDetails(null); setError("");
    void fetch(`/api/timetable/projects/${encodeURIComponent(projectId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json() as { data: InstallationDetails; error?: string }; if (!response.ok) throw new Error(body.error || "Unable to load project details."); setDetails(body.data); })
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load project details."); });
    return () => controller.abort();
  }, [projectId]);
  return <dialog ref={ref} className={styles.dialog} onCancel={(event) => { if (savingCustomer) event.preventDefault(); else onClose(); }} onClick={(e) => { if (!savingCustomer && e.target === ref.current) onClose(); }} aria-labelledby="installation-details-title">
    <header><div><small>{details ? [details.reference, details.quoteNumber].filter(Boolean).join(" · ") : "Time Table"}</small><h2 id="installation-details-title">{details ? customerLabel(details) : "Installation details"}</h2></div><button type="button" disabled={savingCustomer} onClick={onClose} aria-label="Close installation details"><X size={20} /></button></header>
    {error ? <p role="alert">{error}</p> : details ? <InstallationDetailsContent details={details} editable={canEditCustomer && Boolean(projectId)} onBusyChange={setSavingCustomer} onSaved={(project) => { setDetails(installationDetails(project)); window.dispatchEvent(new CustomEvent("erp:payment-track-updated")); }} /> : <p role="status">Loading installation details…</p>}
  </dialog>;
}
