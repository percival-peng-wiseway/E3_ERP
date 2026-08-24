import type {
  DashboardData,
  InventoryItem,
  InventoryQuery,
  Quotation,
  QuotationQuery,
  ERPDataSource,
} from "./types";

export interface ERPProvider {
  readonly source: ERPDataSource;
  listInventory(query?: InventoryQuery): Promise<InventoryItem[]>;
  getInventoryItem(identifier: string): Promise<InventoryItem | null>;
  listQuotations(query?: QuotationQuery): Promise<Quotation[]>;
  getQuotation(identifier: string): Promise<Quotation | null>;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function buildDashboard(provider: ERPProvider): Promise<DashboardData> {
  const [inventory, quotations] = await Promise.all([
    provider.listInventory(),
    provider.listQuotations(),
  ]);

  const lowStock = inventory
    .filter((item) => item.status !== "in_stock")
    .sort((a, b) => a.available - b.available || a.name.localeCompare(b.name));

  const recentQuotations = [...quotations]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 5);

  const active = quotations.filter(
    (quotation) => quotation.status === "draft" || quotation.status === "sent",
  );

  const currencies = new Set(quotations.map((quotation) => quotation.currency));

  return {
    metrics: {
      totalSkus: inventory.length,
      totalOnHand: inventory.reduce((sum, item) => sum + item.onHand, 0),
      totalAvailable: inventory.reduce((sum, item) => sum + item.available, 0),
      lowStockItems: inventory.filter((item) => item.status === "low_stock").length,
      outOfStockItems: inventory.filter((item) => item.status === "out_of_stock").length,
      activeQuotations: active.length,
      quotationValue: roundMoney(active.reduce((sum, quotation) => sum + quotation.total, 0)),
      currency: currencies.size === 1 ? (quotations[0]?.currency ?? "AUD") : "MIXED",
    },
    lowStock,
    recentQuotations,
  };
}
