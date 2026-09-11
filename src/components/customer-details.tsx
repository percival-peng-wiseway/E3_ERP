"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { LoaderCircle, Pencil, UserRound } from "lucide-react";
import type { PaymentTrackCustomer, PaymentTrackProject } from "@/lib/payment-track/types";
import { parsePaymentTrackCustomer } from "@/lib/payment-track/create-input";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./customer-details.module.css";

type CustomerProject = Pick<PaymentTrackProject, "id" | "customer" | "customerUpdatedAt">;
const FIELDS: Array<{ key: keyof PaymentTrackCustomer; label: string; max: number; type?: string; placeholder?: string }> = [
  { key: "firstName", label: "First name", max: 80 },
  { key: "lastName", label: "Last name", max: 80 },
  { key: "phone", label: "Phone", max: 40, type: "tel" },
  { key: "email", label: "Email", max: 180, type: "email" },
  { key: "addressLine1", label: "Installation address", max: 180 },
  { key: "suburb", label: "Suburb", max: 100 },
  { key: "state", label: "State", max: 30 },
  { key: "postcode", label: "Postcode", max: 20 },
  { key: "coupling", label: "Coupling", max: 80, placeholder: "e.g. AC or DC" },
  { key: "nmi", label: "NMI", max: 32, placeholder: "National Metering Identifier" },
];
function draftCustomer(customer: PaymentTrackCustomer): Required<PaymentTrackCustomer> {
  return Object.fromEntries(FIELDS.map(({ key }) => [key, customer[key] || ""])) as Required<PaymentTrackCustomer>;
}

export function CustomerDetails({ project, editable = false, disabled = false, onSaved, onBusyChange }: {
  project: CustomerProject;
  editable?: boolean;
  disabled?: boolean;
  onSaved?: (project: PaymentTrackProject) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [current, setCurrent] = useState(project);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftCustomer(project.customer));
  const [version, setVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { setCurrent(project); }, [project.id, project.customer, project.customerUpdatedAt]);
  const busy = saving || disabled;
  const customer = current.customer;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !editable || conflict) return;
    if (!parsePaymentTrackCustomer(draft)) { setError("Enter a customer name and valid customer information."); return; }
    setSaving(true); onBusyChange?.(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/payment-track/${project.id}/customer`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer: draft, expectedCustomerUpdatedAt: version }),
      });
      const body = await readJsonResponse<{ data: PaymentTrackProject; error?: string }>(response);
      if (!response.ok) { setConflict(response.status === 409); throw new Error(body.error || "Unable to save customer information."); }
      setCurrent(body.data); setEditing(false); setNotice("Customer information saved."); onSaved?.(body.data);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save customer information."); }
    finally { setSaving(false); onBusyChange?.(false); }
  }
  async function reload() {
    if (busy) return;
    setSaving(true); onBusyChange?.(true);
    try {
      const response = await fetch(`/api/timetable/projects/${project.id}`, { cache: "no-store" });
      const body = await readJsonResponse<{ data: CustomerProject; error?: string }>(response);
      if (!response.ok) throw new Error(body.error || "Unable to reload customer information.");
      setCurrent(body.data); setDraft(draftCustomer(body.data.customer)); setVersion(body.data.customerUpdatedAt || null);
      setConflict(false); setError(""); setNotice("Latest customer information loaded. Review before saving.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to reload customer information."); }
    finally { setSaving(false); onBusyChange?.(false); }
  }
  return <section className={styles.section}>
    <header className={styles.heading}><h3><UserRound size={16} />Customer</h3>{editable && !editing ? <button type="button" disabled={busy} onClick={() => {
      setDraft(draftCustomer(current.customer)); setVersion(current.customerUpdatedAt || null); setError(""); setNotice(""); setConflict(false); setEditing(true);
    }}><Pencil size={13} />Edit</button> : null}</header>
    {editing ? <form onSubmit={(event) => void save(event)}>
      <div className={styles.fields}>{FIELDS.map((field, index) => <label key={field.key} htmlFor={`${id}-${field.key}`}>{field.label}<input
        id={`${id}-${field.key}`} autoFocus={index === 0} type={field.type || "text"} value={draft[field.key]}
        maxLength={field.max} disabled={busy} placeholder={field.placeholder}
        list={field.key === "coupling" ? `${id}-couplings` : undefined}
        onChange={(e) => setDraft((previous) => ({ ...previous, [field.key]: e.target.value }))}
      /></label>)}</div>
      <datalist id={`${id}-couplings`}><option value="AC" /><option value="DC" /></datalist>
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(""); setConflict(false); setNotice(""); }}>Cancel</button><button type="submit" disabled={busy || conflict}>{saving ? <LoaderCircle size={14} /> : null}{saving ? "Saving…" : "Save customer"}</button></div>
    </form> : <dl>
      <div><dt>Name</dt><dd>{[customer.firstName, customer.lastName].filter(Boolean).join(" ") || "—"}</dd></div>
      <div><dt>Phone</dt><dd>{customer.phone ? <a href={`tel:${customer.phone}`}>{customer.phone}</a> : "—"}</dd></div>
      <div><dt>Email</dt><dd>{customer.email || "—"}</dd></div>
      <div><dt>Installation</dt><dd>{[customer.addressLine1, customer.suburb, customer.state, customer.postcode].filter(Boolean).join(", ") || "—"}</dd></div>
      <div><dt>Coupling</dt><dd>{customer.coupling || "—"}</dd></div>
      <div><dt>NMI</dt><dd>{customer.nmi || "—"}</dd></div>
    </dl>}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {conflict ? <button type="button" disabled={busy} onClick={() => void reload()}>Discard draft &amp; reload latest</button> : null}
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
  </section>;
}
