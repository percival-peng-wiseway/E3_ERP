import type { InventoryItem as ErpInventoryItem } from "@/lib/erp/types";
import type {
  ApiState,
  InventoryItem,
  ProjectInventoryConsumptionHistory,
} from "./types";

export type SolarConsumptionProject = {
  id: string;
  customer: {
    firstName: string;
    lastName: string;
    phone: string;
    addressLine1: string;
    suburb: string;
    state: string;
    postcode: string;
  };
  installedAt: string | null;
  solarPanelConsumption?: {
    recordedAt: string;
    recordedBy: string;
    items: Array<{ sku: string; quantity: number }>;
  } | null;
};

type ConsumptionLine = {
  project: SolarConsumptionProject;
  sku: string;
  key: string;
  quantity: number;
};

const CERTIFICATION_SUFFIX = /\s*\((?:IEC\b|AS\/?NZS\b|cert(?:ification)?\b)[^)]*\)\s*$/i;

/** Removes quotation-only certification text while preserving the actual SKU. */
export function solarPanelInventorySku(value: string) {
  let sku = value.trim().replace(/\s+/g, " ");
  while (CERTIFICATION_SUFFIX.test(sku)) sku = sku.replace(CERTIFICATION_SUFFIX, "").trim();
  return sku;
}

function skuKey(value: string) {
  return solarPanelInventorySku(value).toLocaleLowerCase("en-AU");
}

function consumptionLines(projects: readonly SolarConsumptionProject[]) {
  const lines: ConsumptionLine[] = [];
  for (const project of projects) {
    const marker = project.solarPanelConsumption;
    if (!marker) continue;
    for (const item of marker.items) {
      const sku = solarPanelInventorySku(item.sku);
      if (!sku || !Number.isSafeInteger(item.quantity) || item.quantity < 1) continue;
      lines.push({ project, sku, key: skuKey(sku), quantity: item.quantity });
    }
  }
  return lines;
}

function summedConsumption(lines: readonly ConsumptionLine[]) {
  const totals = new Map<string, { sku: string; quantity: number }>();
  for (const line of lines) {
    const current = totals.get(line.key);
    if (current) current.quantity += line.quantity;
    else totals.set(line.key, { sku: line.sku, quantity: line.quantity });
  }
  return totals;
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function customerName(project: SolarConsumptionProject) {
  return [project.customer.firstName, project.customer.lastName].filter(Boolean).join(" ").trim()
    || "Project customer";
}

function customerAddress(project: SolarConsumptionProject) {
  return [
    project.customer.addressLine1,
    project.customer.suburb,
    project.customer.state,
    project.customer.postcode,
  ].filter(Boolean).join(", ");
}

function projectConsumptionHistory(
  lines: readonly ConsumptionLine[],
  existing: readonly ProjectInventoryConsumptionHistory[],
) {
  const existingIds = new Set(existing.map((entry) => entry.id));
  const rows: ProjectInventoryConsumptionHistory[] = [];
  for (const line of lines) {
    const id = `payment-track-installation:${line.project.id}:${line.key}`;
    if (existingIds.has(id)) continue;
    const recordedAt = line.project.solarPanelConsumption?.recordedAt
      || line.project.installedAt
      || new Date(0).toISOString();
    rows.push({
      id,
      actor: line.project.solarPanelConsumption?.recordedBy || "Project Track",
      customer: customerName(line.project),
      sku: line.sku,
      quantity: line.quantity,
      created_at: recordedAt,
      address: customerAddress(line.project),
    });
  }
  return rows;
}

/**
 * Applies immutable Project Track installation markers to the upstream native
 * Inventory response. The source response is cloned and never mutated.
 */
export function applyProjectSolarConsumptionToOperationsState(
  state: ApiState,
  projects: readonly SolarConsumptionProject[],
): ApiState {
  const lines = consumptionLines(projects);
  if (!lines.length) return state;
  const totals = summedConsumption(lines);
  const matched = new Set<string>();
  const inventory = state.inventory.map((source): InventoryItem => {
    const key = skuKey(source.sku);
    const total = totals.get(key);
    if (!total) return { ...source };
    matched.add(key);
    const onHand = finiteNumber(source.on_hand) - total.quantity;
    const available = finiteNumber(source.available) - total.quantity;
    return {
      ...source,
      sku: total.sku,
      category: "太阳能板",
      status: available <= 0 ? "缺货" : source.status,
      on_hand: onHand,
      available,
      consumption: finiteNumber(source.consumption) + total.quantity,
    };
  });

  for (const [key, total] of totals) {
    if (matched.has(key)) continue;
    inventory.push({
      sku: total.sku,
      category: "太阳能板",
      status: "缺货",
      on_hand: -total.quantity,
      reserved: 0,
      pending: 0,
      available: -total.quantity,
      consumption: total.quantity,
    });
  }

  const existingHistory = state.projectConsumptionHistory || [];
  return {
    ...state,
    inventory,
    projectConsumptionHistory: [
      ...existingHistory,
      ...projectConsumptionHistory(lines, existingHistory),
    ],
  };
}

/** Applies the same project balance to the unified read-only Inventory API. */
export function applyProjectSolarConsumptionToErpInventory(
  sourceItems: readonly ErpInventoryItem[],
  projects: readonly SolarConsumptionProject[],
): ErpInventoryItem[] {
  const lines = consumptionLines(projects);
  if (!lines.length) return [...sourceItems];
  const totals = summedConsumption(lines);
  const matched = new Set<string>();
  const inventory = sourceItems.map((source): ErpInventoryItem => {
    const key = skuKey(source.sku);
    const total = totals.get(key);
    if (!total) return { ...source };
    matched.add(key);
    const available = source.available - total.quantity;
    return {
      ...source,
      sku: total.sku,
      name: source.name || total.sku,
      category: "Solar Panel",
      onHand: source.onHand - total.quantity,
      available,
      status: available <= 0 ? "out_of_stock" : source.status,
    };
  });

  for (const [key, total] of totals) {
    if (matched.has(key)) continue;
    inventory.push({
      id: `project-solar:${encodeURIComponent(key)}`,
      sku: total.sku,
      name: total.sku,
      warehouse: "Direct to site",
      onHand: -total.quantity,
      reserved: 0,
      available: -total.quantity,
      reorderLevel: 0,
      uom: "panel",
      status: "out_of_stock",
      category: "Solar Panel",
    });
  }
  return inventory;
}
