import { calculateQuote } from "@/lib/quotehelp/calculate";
import { defaultSettings, normalizeSettings } from "@/lib/quotehelp/defaults";
import type { AppSettings, QuoteRecord } from "@/lib/quotehelp/model";
import { proxyRequestHeaders } from "@/lib/server/proxy-cookie";
import { HttpProvider } from "./http-provider";
import { LiveERPProviderCore } from "./live-provider-core";
import { ProjectConsumptionInventorySource } from "./project-consumption-source";
import type { Quotation } from "./types";

const DEFAULT_INVENTORY_URL = "https://inventory.e3energy.com.au/api/inventory";
const DEFAULT_QUOTEHELP_URL = "https://quote.e3energy.com.au";
const QUOTEHELP_COOKIE_NAMESPACE = { prefix: "__erp_quotehelp_", path: "/api" };

type QuoteHelpSession = { quotes?: QuoteRecord[]; settings?: AppSettings };

function unwrapSession(value: unknown): QuoteHelpSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QuoteHelp returned an invalid session.");
  const record = value as Record<string, unknown>;
  const candidate = record.data ?? record;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("QuoteHelp returned an invalid session.");
  return candidate as QuoteHelpSession;
}

function quotationFromQuoteHelp(quote: QuoteRecord, settings: AppSettings): Quotation {
  const result = calculateQuote(quote.payload, settings);
  const total = Math.max(0, quote.payload.customerBalance)
    + Math.max(0, result.solarStc)
    + Math.max(0, result.batteryStc)
    + Math.max(0, quote.payload.solarVicRebate)
    + Math.max(0, quote.payload.solarVicLoan)
    - Math.abs(quote.payload.discount);
  return {
    id: quote.id,
    number: quote.projectName || quote.id,
    customer: quote.payload.customerName || "Unnamed customer",
    customerContact: quote.payload.phone || undefined,
    status: quote.status === "done" ? "accepted" : "draft",
    subtotal: total / 1.1,
    tax: total - total / 1.1,
    total,
    currency: "AUD",
    validUntil: "",
    createdAt: quote.createdAt,
    owner: quote.payload.initiator || quote.ownerName || undefined,
    items: result.lineItems.map((item) => ({
      id: item.key,
      description: item.label,
      quantity: 1,
      uom: "item",
      unitPrice: item.salesPrice,
      amount: item.salesPrice,
    })),
  };
}

async function quoteHelpQuotations(request?: Request): Promise<Quotation[]> {
  if (!request) throw new Error("An authenticated request is required for the live QuoteHelp source.");
  const target = new URL(process.env.QUOTEHELP_APP_URL?.trim() || DEFAULT_QUOTEHELP_URL);
  target.pathname = "/api/session";
  target.search = "";
  const response = await fetch(target, {
    headers: proxyRequestHeaders(request, QUOTEHELP_COOKIE_NAMESPACE),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Live QuoteHelp session returned HTTP ${response.status}.`);
  const session = unwrapSession(await response.json());
  if (!Array.isArray(session.quotes)) throw new Error("QuoteHelp session did not include quotations.");
  const settings = normalizeSettings(session.settings ?? defaultSettings);
  return session.quotes.map((quote) => quotationFromQuoteHelp(quote, settings));
}

export class LiveERPProvider extends LiveERPProviderCore {
  constructor(request?: Request) {
    const upstreamInventory = new HttpProvider({
      inventoryUrl: process.env.ERP_INVENTORY_API_URL?.trim()
        || process.env.INVENTORY_OPERATIONS_API_URL?.trim()
        || DEFAULT_INVENTORY_URL,
    });
    const inventory = new ProjectConsumptionInventorySource(upstreamInventory);
    const quotationUrl = process.env.ERP_QUOTATION_API_URL?.trim();
    const quotationApi = quotationUrl
      ? new HttpProvider({ quotationUrl, token: process.env.ERP_API_TOKEN })
      : undefined;
    super({
      inventory,
      quotationApi,
      quoteHelpQuotations: () => quoteHelpQuotations(request),
    });
  }
}
