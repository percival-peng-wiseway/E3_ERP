"use client";

import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  PackageCheck,
  Plus,
  Trash2,
  Warehouse,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/client/http";
import type { ApiState, InventoryItem } from "@/lib/inventory-operations/types";
import { inventoryItemCanFulfilSelection } from "@/lib/inventory-operations/stock-policy";
import type {
  PaymentTrackDeliverySelection,
  PaymentTrackProject,
} from "@/lib/payment-track/types";
import styles from "./payment-track-workspace.module.css";

type DraftRow = PaymentTrackDeliverySelection & { id: string };

function initialRows(selections: PaymentTrackDeliverySelection[]): DraftRow[] {
  if (selections.length) {
    return selections.map((entry, index) => ({
      id: `saved-${index + 1}`,
      sku: entry.sku,
      quantity: entry.quantity,
    }));
  }
  return [{ id: "row-1", sku: "", quantity: 1 }];
}

function errorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error
    && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return fallback;
}

export function MaterialDeliveryPicker({
  project,
  selections,
  onBack,
  onSaved,
}: {
  project: PaymentTrackProject;
  selections: PaymentTrackDeliverySelection[];
  onBack: () => void;
  onSaved: (selections: PaymentTrackDeliverySelection[]) => void;
}) {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [rows, setRows] = useState<DraftRow[]>(() => initialRows(selections));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const nextRowId = useRef(rows.length + 1);

  useEffect(() => {
    let active = true;
    void fetch("/api/inventory/operations", { cache: "no-store" })
      .then(async (response) => {
        const body = await readJsonResponse<ApiState & { error?: unknown }>(response);
        if (!response.ok || !Array.isArray(body.inventory)) {
          throw new Error(errorMessage(body, "Unable to load warehouse inventory."));
        }
        if (active) setInventory(body.inventory);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load warehouse inventory.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const sortedInventory = useMemo(() => [...inventory].sort((left, right) => (
    left.sku.localeCompare(right.sku, "en-AU", { numeric: true })
  )), [inventory]);
  const inventoryBySku = useMemo(() => new Map(inventory.map((item) => [item.sku, item])), [inventory]);
  const selectedTotals = useMemo(() => {
    const totals = new Map<string, number>();
    rows.forEach((row) => {
      if (row.sku) totals.set(row.sku, (totals.get(row.sku) || 0) + row.quantity);
    });
    return totals;
  }, [rows]);
  const duplicates = useMemo(() => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    rows.forEach((row) => {
      if (!row.sku) return;
      if (seen.has(row.sku)) repeated.add(row.sku);
      seen.add(row.sku);
    });
    return [...repeated];
  }, [rows]);
  const shortages = [...selectedTotals].filter(([sku, quantity]) => (
    !inventoryItemCanFulfilSelection(inventoryBySku.get(sku), quantity)
  ));
  const incomplete = rows.some((row) => !row.sku || !Number.isInteger(row.quantity) || row.quantity < 1);
  const canSave = !loading && !incomplete && !duplicates.length && !shortages.length;

  const addRow = () => {
    if (rows.length >= 100) return;
    const id = `row-${nextRowId.current}`;
    nextRowId.current += 1;
    setRows((current) => [...current, { id, sku: "", quantity: 1 }]);
  };

  const updateRow = (id: string, patch: Partial<PaymentTrackDeliverySelection>) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const removeRow = (id: string) => {
    if (rows.length === 1) return;
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const save = () => {
    if (!canSave) return;
    onSaved(rows.map(({ sku, quantity }) => ({ sku, quantity })));
  };

  return (
    <>
      <header className={styles.deliveryDrawerHeader}>
        <div>
          <span>{project.reference} · Proposal {project.quoteNumber}</span>
          <h2 id="material-delivery-picker-title">Choose warehouse items</h2>
        </div>
        <button type="button" aria-label="Close item selection" onClick={onBack}><X size={19} /></button>
      </header>

      <div className={styles.deliveryDrawerBody}>
        <section className={styles.deliveryOrderReference} aria-labelledby="order-reference-title">
          <header><div><Boxes size={16} /><h3 id="order-reference-title">Order requirements</h3></div><span>{project.items.length}</span></header>
          <div className={styles.deliveryOrderList}>
            {project.items.map((item) => (
              <div key={item.id}>
                <span>{item.category || "Item"}</span>
                <strong>{item.model || item.description || "Unnamed item"}</strong>
                <b>× {item.quantity}</b>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.deliverySelectionForm} aria-labelledby="chosen-items-form-title">
          <header>
            <div><Warehouse size={16} /><h3 id="chosen-items-form-title">Items</h3></div>
            <button type="button" disabled={rows.length >= 100} onClick={addRow}><Plus size={14} /> Add item</button>
          </header>

          {error ? <div className={styles.error} role="alert"><AlertCircle size={15} /><span>{error}</span></div> : null}
          {duplicates.length ? <div className={styles.deliveryWarning} role="alert"><AlertCircle size={15} />Combine duplicate SKUs into one item line.</div> : null}
          {shortages.length ? (
            <div className={styles.deliveryWarning} role="alert"><AlertCircle size={15} />Not enough available stock for {shortages.map(([sku]) => sku).join(", ")}.</div>
          ) : null}

          <div className={styles.deliverySelectionLabels}><span>SKU</span><span>Quantity</span><span aria-hidden="true" /></div>
          <div className={styles.deliverySelectionRows}>
            {rows.map((row, rowIndex) => {
              const stock = row.sku ? inventoryBySku.get(row.sku) : undefined;
              const rowLabel = `Item row ${rowIndex + 1}${row.sku ? `, ${row.sku}` : ""}`;
              return (
                <div key={row.id} className={styles.deliverySelectionRow}>
                  <div>
                    <select
                      aria-label={`${rowLabel}: select SKU`}
                      value={row.sku}
                      disabled={loading}
                      onChange={(event) => updateRow(row.id, { sku: event.target.value })}
                    >
                      <option value="">{loading ? "Loading warehouse…" : "Select SKU"}</option>
                      {sortedInventory.map((item) => (
                        <option
                          key={item.sku}
                          value={item.sku}
                          disabled={rows.some((candidate) => candidate.id !== row.id && candidate.sku === item.sku)}
                        >
                          {item.sku} — {item.category || "Uncategorised"} ({item.available} available)
                        </option>
                      ))}
                    </select>
                    {stock ? <small>{stock.category || "Uncategorised"} · {stock.on_hand} on hand · {stock.available} available</small> : null}
                  </div>
                  <input
                    aria-label={`${rowLabel}: quantity`}
                    type="number"
                    min={1}
                    max={100000}
                    value={row.quantity}
                    onChange={(event) => updateRow(row.id, { quantity: Math.max(1, Math.min(100000, Number(event.target.value) || 1)) })}
                  />
                  <button type="button" aria-label={`Remove ${rowLabel.toLocaleLowerCase("en-AU")}`} disabled={rows.length === 1} onClick={() => removeRow(row.id)}><Trash2 size={15} /></button>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <footer className={styles.deliveryDrawerFooter}>
        <div aria-live="polite">{canSave ? <><CheckCircle2 size={14} /> Ready to use</> : <><AlertCircle size={14} /> Select valid available items</>}</div>
        <button className={styles.secondaryButton} type="button" onClick={onBack}>Cancel</button>
        <button className={styles.primaryButton} type="button" disabled={!canSave} onClick={save}>
          <PackageCheck size={15} /> Use chosen items
        </button>
      </footer>
    </>
  );
}
