import { DemoProvider } from "./demo-provider";
import type { ERPProvider } from "./provider";
import type {
  ERPDataSource,
  InventoryItem,
  InventoryQuery,
  InventoryStatus,
  Quotation,
  QuotationItem,
  QuotationQuery,
  QuotationStatus,
} from "./types";

type UnknownRecord = Record<string, unknown>;

export interface HttpProviderOptions {
  inventoryUrl?: string;
  quotationUrl?: string;
  token?: string;
  fallback?: ERPProvider;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstValue(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function textValue(record: UnknownRecord, keys: string[], fallback = ""): string {
  const value = firstValue(record, keys);
  return value === undefined ? fallback : String(value);
}

function numberValue(record: UnknownRecord, keys: string[], fallback = 0): number {
  const raw = firstValue(record, keys);
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumber(record: UnknownRecord, keys: string[]): number | undefined {
  const raw = firstValue(record, keys);
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function optionalText(record: UnknownRecord, keys: string[]): string | undefined {
  const value = firstValue(record, keys);
  return value === undefined ? undefined : String(value);
}

function asRecords(payload: unknown): UnknownRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  const candidates = [
    payload.data,
    payload.inventory,
    payload.items,
    payload.results,
    payload.message,
    isRecord(payload.data) ? payload.data.inventory : undefined,
    isRecord(payload.data) ? payload.data.items : undefined,
    isRecord(payload.data) ? payload.data.results : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }

  return [payload];
}

function normalizedInventoryStatusValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-AU")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeInventoryStatus(
  available: number,
  reorderLevel: number | undefined,
  sourceStatus: unknown,
): InventoryStatus {
  if (available <= 0) return "out_of_stock";

  const status = normalizedInventoryStatusValue(sourceStatus);
  if (["low stock", "低库存"].includes(status)) return "low_stock";
  if (["out of stock", "缺货"].includes(status)) return "out_of_stock";
  if (["in stock", "sufficient", "overstock", "on order", "充足", "积压", "订购中"].includes(status)) {
    return "in_stock";
  }
  if (reorderLevel !== undefined && available <= reorderLevel) return "low_stock";

  return "in_stock";
}

function normalizeInventory(record: UnknownRecord, index: number): InventoryItem {
  const onHand = numberValue(record, ["onHand", "on_hand", "stock", "actual_qty", "stock_qty", "qty"]);
  const reserved = numberValue(record, ["pending", "reserved", "reserved_qty", "reserved_stock"]);
  const available = numberValue(
    record,
    ["available", "available_qty", "free_qty", "projected_qty"],
    onHand - reserved,
  );
  const sourceReorderLevel = optionalNumber(record, [
    "reorderLevel",
    "reorder_level",
    "minimum_stock",
    "min_qty",
  ]);
  const reorderLevel = sourceReorderLevel ?? 0;
  const sku = textValue(record, ["sku", "item_code", "code"], `ITEM-${index + 1}`);
  const item: InventoryItem & { consumption?: number } = {
    id: textValue(record, ["id", "name", "item_id"], sku),
    sku,
    name: textValue(record, ["item_name", "display_name", "title", "name"], sku),
    warehouse: textValue(record, ["warehouse", "warehouse_name", "stock_location"], "Default Warehouse"),
    onHand,
    reserved,
    available,
    reorderLevel,
    uom: textValue(record, ["uom", "stock_uom", "unit"], "unit"),
    status: normalizeInventoryStatus(
      available,
      sourceReorderLevel,
      firstValue(record, ["status", "stock_status"]),
    ),
    category: optionalText(record, ["category", "item_group", "group"]),
    location: optionalText(record, ["location", "bin", "rack", "shelf"]),
    unitCost: optionalNumber(record, ["unitCost", "unit_cost", "valuation_rate", "cost"]),
    currency: optionalText(record, ["currency"]),
    supplier: optionalText(record, ["supplier", "default_supplier", "supplier_name"]),
    updatedAt: optionalText(record, ["updatedAt", "updated_at", "modified", "last_updated"]),
  };

  const consumption = optionalNumber(record, ["consumption"]);
  if (consumption !== undefined) item.consumption = consumption;

  return item;
}

function normalizeQuotationStatus(value: unknown): QuotationStatus {
  const status = String(value ?? "draft").trim().toLowerCase();
  if (status === "1") return "sent";
  if (status === "2") return "rejected";
  if (["accepted", "ordered", "converted", "won", "approved"].includes(status)) return "accepted";
  if (["rejected", "lost", "cancelled", "canceled", "declined"].includes(status)) return "rejected";
  if (["expired", "lapsed"].includes(status)) return "expired";
  if (["sent", "open", "submitted", "pending", "awaiting response"].includes(status)) return "sent";
  return "draft";
}

function normalizeQuotationItem(record: UnknownRecord, index: number): QuotationItem {
  const quantity = numberValue(record, ["quantity", "qty"], 1);
  const unitPrice = numberValue(record, ["unitPrice", "unit_price", "rate", "price"]);
  const discount = optionalNumber(record, ["discount", "discount_percentage", "discountPercent"]);
  const computed = quantity * unitPrice * (1 - (discount ?? 0) / 100);
  return {
    id: textValue(record, ["id", "name", "line_id"], `line-${index + 1}`),
    sku: optionalText(record, ["sku", "item_code", "code"]),
    description: textValue(
      record,
      ["description", "item_name", "title", "name"],
      `Quotation item ${index + 1}`,
    ),
    quantity,
    uom: textValue(record, ["uom", "unit"], "unit"),
    unitPrice,
    discount,
    amount: numberValue(record, ["amount", "line_total", "net_amount"], computed),
  };
}

function normalizeQuotation(record: UnknownRecord, index: number): Quotation {
  const rawItems = firstValue(record, ["items", "lines", "quotation_items"]);
  const items = Array.isArray(rawItems)
    ? rawItems.filter(isRecord).map(normalizeQuotationItem)
    : [];
  const computedSubtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const subtotal = numberValue(record, ["subtotal", "net_total", "amount"], computedSubtotal);
  const tax = numberValue(record, ["tax", "tax_total", "total_taxes_and_charges"]);
  const number = textValue(
    record,
    ["number", "quotation_number", "name", "id"],
    `QTN-${index + 1}`,
  );

  return {
    id: textValue(record, ["id", "name", "quotation_id"], number),
    number,
    customer: textValue(record, ["customer", "customer_name", "party_name"], "Unnamed customer"),
    customerContact: optionalText(record, ["customerContact", "customer_contact", "contact_display"]),
    status: normalizeQuotationStatus(firstValue(record, ["status", "workflow_state", "docstatus"])),
    subtotal,
    tax,
    total: numberValue(record, ["total", "grand_total", "rounded_total"], subtotal + tax),
    currency: textValue(record, ["currency"], "AUD"),
    validUntil: textValue(record, ["validUntil", "valid_until", "valid_till"], ""),
    createdAt: textValue(record, ["createdAt", "created_at", "creation", "transaction_date"], ""),
    owner: optionalText(record, ["owner", "sales_rep", "account_manager"]),
    notes: optionalText(record, ["notes", "terms", "remarks"]),
    items,
  };
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function applyInventoryQuery(items: InventoryItem[], query: InventoryQuery): InventoryItem[] {
  let result = items;
  if (query.search) {
    const term = normalizeSearch(query.search);
    result = result.filter((item) =>
      [item.id, item.sku, item.name, item.category, item.supplier, item.warehouse]
        .filter(Boolean)
        .some((value) => normalizeSearch(String(value)).includes(term)),
    );
  }
  if (query.warehouse) {
    const warehouse = normalizeSearch(query.warehouse);
    result = result.filter((item) => normalizeSearch(item.warehouse).includes(warehouse));
  }
  if (query.status) result = result.filter((item) => item.status === query.status);
  if (query.lowStockOnly) result = result.filter((item) => item.status !== "in_stock");
  if (query.limit !== undefined && Number.isFinite(query.limit)) {
    result = result.slice(0, Math.max(0, Math.floor(query.limit)));
  }
  return result;
}

function applyQuotationQuery(items: Quotation[], query: QuotationQuery): Quotation[] {
  let result = items;
  if (query.search) {
    const term = normalizeSearch(query.search);
    result = result.filter((item) =>
      [item.id, item.number, item.customer, item.customerContact, item.owner]
        .filter(Boolean)
        .some((value) => normalizeSearch(String(value)).includes(term)),
    );
  }
  if (query.customer) {
    const customer = normalizeSearch(query.customer);
    result = result.filter((item) => normalizeSearch(item.customer).includes(customer));
  }
  if (query.status) result = result.filter((item) => item.status === query.status);
  if (query.limit !== undefined && Number.isFinite(query.limit)) {
    result = result.slice(0, Math.max(0, Math.floor(query.limit)));
  }
  return result;
}

function authorizationHeader(token: string): string {
  return /^(bearer|token|basic)\s/i.test(token) ? token : `Bearer ${token}`;
}

export class HttpProvider implements ERPProvider {
  readonly source: ERPDataSource;
  private readonly inventoryUrl?: string;
  private readonly quotationUrl?: string;
  private readonly token?: string;
  private readonly fallback: ERPProvider;

  constructor(options: HttpProviderOptions) {
    this.inventoryUrl = options.inventoryUrl?.trim() || undefined;
    this.quotationUrl = options.quotationUrl?.trim() || undefined;
    this.token = options.token?.trim() || undefined;
    this.fallback = options.fallback ?? new DemoProvider();
    this.source = this.inventoryUrl && this.quotationUrl ? "http" : "hybrid";
  }

  private async fetchRecords(url: string): Promise<UnknownRecord[]> {
    const headers: HeadersInit = { Accept: "application/json" };
    if (this.token) headers.Authorization = authorizationHeader(this.token);

    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`The upstream ERP API returned ${response.status} ${response.statusText}`);
    }
    return asRecords(await response.json());
  }

  async listInventory(query: InventoryQuery = {}): Promise<InventoryItem[]> {
    if (!this.inventoryUrl) return this.fallback.listInventory(query);
    const records = await this.fetchRecords(this.inventoryUrl);
    return applyInventoryQuery(records.map(normalizeInventory), query);
  }

  async getInventoryItem(identifier: string): Promise<InventoryItem | null> {
    const items = await this.listInventory();
    const term = normalizeSearch(identifier);
    return (
      items.find(
        (item) =>
          normalizeSearch(item.id) === term ||
          normalizeSearch(item.sku) === term ||
          normalizeSearch(item.name) === term,
      ) ?? null
    );
  }

  async listQuotations(query: QuotationQuery = {}): Promise<Quotation[]> {
    if (!this.quotationUrl) return this.fallback.listQuotations(query);
    const records = await this.fetchRecords(this.quotationUrl);
    return applyQuotationQuery(records.map(normalizeQuotation), query);
  }

  async getQuotation(identifier: string): Promise<Quotation | null> {
    const items = await this.listQuotations();
    const term = normalizeSearch(identifier);
    return (
      items.find(
        (item) => normalizeSearch(item.id) === term || normalizeSearch(item.number) === term,
      ) ?? null
    );
  }
}
