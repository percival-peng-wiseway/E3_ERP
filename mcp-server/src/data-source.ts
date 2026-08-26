import {
  type InventoryItem,
  type Quotation,
  type QuotationLine,
  type QuotationStatus
} from "./demo-data.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsFromEnvelope(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    if (!payload.every(isRecord)) throw new Error("ERP workspace API returned an invalid record list");
    return payload;
  }
  if (!isRecord(payload)) throw new Error("ERP workspace API returned an invalid record list");
  const nested = isRecord(payload.data) ? payload.data : undefined;
  const candidates = [
    payload.data,
    payload.inventory,
    payload.quotations,
    payload.items,
    nested?.inventory,
    nested?.quotations,
    nested?.items
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    if (!candidate.every(isRecord)) throw new Error("ERP workspace API returned an invalid record list");
    return candidate;
  }
  throw new Error("ERP workspace API returned an invalid record list");
}

function text(record: JsonRecord, key: string, fallback = ""): string {
  const value = record[key];
  return value === undefined || value === null ? fallback : String(value);
}

function number(record: JsonRecord, key: string, fallback = 0): number {
  const parsed = Number(record[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasValue(record: JsonRecord, keys: string[]): boolean {
  return keys.some((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
}

function isInventoryRecord(record: JsonRecord): boolean {
  return hasValue(record, ["id", "name", "sku"])
    && hasValue(record, ["onHand", "available", "on_hand", "available_qty"]);
}

function isQuotationRecord(record: JsonRecord): boolean {
  return hasValue(record, ["id", "number", "name"])
    && hasValue(record, ["customer", "customer_name"]);
}

function quotationStatus(value: unknown): QuotationStatus {
  return ["draft", "sent", "accepted", "rejected", "expired"].includes(String(value))
    ? (String(value) as QuotationStatus)
    : "draft";
}

function mapInventory(record: JsonRecord): InventoryItem {
  const name = text(record, "name", text(record, "sku", "Unnamed item"));
  return {
    id: text(record, "id", text(record, "sku")),
    sku: text(record, "sku"),
    name,
    description: text(record, "description", name),
    category: text(record, "category", "Uncategorised"),
    warehouse: text(record, "warehouse", "Default Warehouse"),
    location: text(record, "location"),
    unit: text(record, "uom", "pcs"),
    quantityOnHand: number(record, "onHand"),
    quantityReserved: number(record, "reserved"),
    quantityAvailable: number(record, "available"),
    reorderLevel: number(record, "reorderLevel"),
    unitCost: number(record, "unitCost"),
    currency: text(record, "currency", "AUD"),
    supplier: text(record, "supplier"),
    lastUpdated: text(record, "updatedAt", new Date().toISOString())
  };
}

function mapQuotationLine(value: unknown, index: number): QuotationLine {
  const record = isRecord(value) ? value : {};
  return {
    id: text(record, "id", `line-${index + 1}`),
    ...(record.sku ? { sku: String(record.sku) } : {}),
    name: text(record, "description", text(record, "name", `Quotation item ${index + 1}`)),
    quantity: number(record, "quantity", 1),
    unit: text(record, "uom", "pcs"),
    unitPrice: number(record, "unitPrice"),
    discountPercent: number(record, "discount"),
    lineTotal: number(record, "amount")
  };
}

function mapQuotation(record: JsonRecord): Quotation {
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems.map(mapQuotationLine);
  const subtotal = number(
    record,
    "subtotal",
    items.reduce((sum, item) => sum + item.lineTotal, 0)
  );
  const tax = number(record, "tax");
  const customer = text(record, "customer", "Unnamed customer");
  const id = text(record, "id", text(record, "number"));
  return {
    id,
    quotationNumber: text(record, "number", id),
    customerId: customer,
    customerName: customer,
    contactName: text(record, "customerContact"),
    status: quotationStatus(record.status),
    issueDate: text(record, "createdAt"),
    validUntil: text(record, "validUntil"),
    currency: text(record, "currency", "AUD"),
    subtotal,
    discountTotal: 0,
    taxTotal: tax,
    grandTotal: number(record, "total", subtotal + tax),
    owner: text(record, "owner"),
    notes: text(record, "notes"),
    items
  };
}

async function fetchWorkspace(path: string): Promise<JsonRecord[]> {
  const base = process.env.ERP_WORKSPACE_API_URL?.trim().replace(/\/$/, "");
  if (!base) return [];

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = process.env.ERP_WORKSPACE_API_TOKEN?.trim();
  if (token) headers.Authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;

  const response = await fetch(`${base}${path}`, {
    headers,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`ERP workspace API ${path} returned ${response.status}`);
  }
  return recordsFromEnvelope(await response.json());
}

export async function loadInventoryItems(): Promise<readonly InventoryItem[]> {
  if (!process.env.ERP_WORKSPACE_API_URL?.trim()) {
    throw new Error("ERP_WORKSPACE_API_URL is required; demo inventory fallback is disabled.");
  }
  const records = await fetchWorkspace("/api/inventory");
  if (!records.every(isInventoryRecord)) throw new Error("ERP workspace API returned invalid inventory records");
  return records.map(mapInventory);
}

export async function loadQuotations(): Promise<readonly Quotation[]> {
  if (!process.env.ERP_WORKSPACE_API_URL?.trim()) {
    throw new Error("ERP_WORKSPACE_API_URL is required; demo quotation fallback is disabled.");
  }
  const records = await fetchWorkspace("/api/quotations");
  if (!records.every(isQuotationRecord)) throw new Error("ERP workspace API returned invalid quotation records");
  return records.map(mapQuotation);
}
