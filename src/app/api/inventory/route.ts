import { NextResponse } from "next/server";
import { getERPProvider, type InventoryQuery, type InventoryStatus } from "@/lib/erp";

export const dynamic = "force-dynamic";

const INVENTORY_STATUSES = new Set<InventoryStatus>([
  "in_stock",
  "low_stock",
  "out_of_stock",
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
    const query: InventoryQuery = {
      search: url.searchParams.get("search") || undefined,
      warehouse: url.searchParams.get("warehouse") || undefined,
      status:
        statusValue && INVENTORY_STATUSES.has(statusValue as InventoryStatus)
          ? (statusValue as InventoryStatus)
          : undefined,
      lowStockOnly: ["1", "true", "yes"].includes(
        (url.searchParams.get("lowStockOnly") ?? "").toLowerCase(),
      ),
      limit: positiveInteger(url.searchParams.get("limit")),
    };
    const provider = getERPProvider();
    const data = await provider.listInventory(query);

    return NextResponse.json({
      data,
      meta: {
        source: provider.source,
        total: data.length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Inventory API error", error);
    return NextResponse.json(
      { error: { code: "INVENTORY_UNAVAILABLE", message: "Inventory data is temporarily unavailable." } },
      { status: 502 },
    );
  }
}
