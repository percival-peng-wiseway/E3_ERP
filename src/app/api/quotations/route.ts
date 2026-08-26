import { NextResponse } from "next/server";
import { getERPProvider, type QuotationQuery, type QuotationStatus } from "@/lib/erp";

export const dynamic = "force-dynamic";

const QUOTATION_STATUSES = new Set<QuotationStatus>([
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
]);

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const statusValue = url.searchParams.get("status");
    const query: QuotationQuery = {
      search: url.searchParams.get("search") || undefined,
      customer: url.searchParams.get("customer") || undefined,
      status:
        statusValue && QUOTATION_STATUSES.has(statusValue as QuotationStatus)
          ? (statusValue as QuotationStatus)
          : undefined,
      limit: positiveInteger(url.searchParams.get("limit")),
    };
    const provider = getERPProvider(request);
    const data = await provider.listQuotations(query);

    return NextResponse.json({
      data,
      meta: {
        source: provider.source,
        total: data.length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Quotation API error", error);
    return NextResponse.json(
      { error: { code: "QUOTATIONS_UNAVAILABLE", message: "Quotation data is temporarily unavailable." } },
      { status: 502 },
    );
  }
}
