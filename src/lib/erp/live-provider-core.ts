import type { ERPProvider } from "./provider";
import type { InventoryItem, InventoryQuery, Quotation, QuotationQuery } from "./types";

type InventorySource = Pick<ERPProvider, "listInventory" | "getInventoryItem">;
type QuotationSource = Pick<ERPProvider, "listQuotations" | "getQuotation">;

export type LiveERPProviderSources = {
  inventory: InventorySource;
  quotationApi?: QuotationSource;
  quoteHelpQuotations: () => Promise<Quotation[]>;
};

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-AU");
}

function filterQuotations(items: Quotation[], query: QuotationQuery): Quotation[] {
  let result = items;
  if (query.search) {
    const term = normalized(query.search);
    result = result.filter((item) => [item.number, item.customer, item.owner]
      .some((value) => normalized(value || "").includes(term)));
  }
  if (query.customer) result = result.filter((item) => normalized(item.customer).includes(normalized(query.customer || "")));
  if (query.status) result = result.filter((item) => item.status === query.status);
  return query.limit === undefined ? result : result.slice(0, Math.max(0, Math.floor(query.limit)));
}

/**
 * Delegates only to explicitly supplied live sources. Source errors always
 * propagate; this layer deliberately has no demo or empty-data fallback.
 */
export class LiveERPProviderCore implements ERPProvider {
  readonly source = "http" as const;
  private readonly sources: LiveERPProviderSources;

  constructor(sources: LiveERPProviderSources) {
    this.sources = sources;
  }

  listInventory(query?: InventoryQuery): Promise<InventoryItem[]> {
    return this.sources.inventory.listInventory(query);
  }

  getInventoryItem(identifier: string): Promise<InventoryItem | null> {
    return this.sources.inventory.getInventoryItem(identifier);
  }

  async listQuotations(query: QuotationQuery = {}): Promise<Quotation[]> {
    if (this.sources.quotationApi) return this.sources.quotationApi.listQuotations(query);
    return filterQuotations(await this.sources.quoteHelpQuotations(), query);
  }

  async getQuotation(identifier: string): Promise<Quotation | null> {
    if (this.sources.quotationApi) return this.sources.quotationApi.getQuotation(identifier);
    const term = normalized(identifier);
    return (await this.sources.quoteHelpQuotations())
      .find((item) => normalized(item.id) === term || normalized(item.number) === term) ?? null;
  }
}
