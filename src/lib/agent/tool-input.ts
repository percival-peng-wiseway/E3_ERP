type UnknownRecord = Record<string, unknown>;

export type NormalizedInventoryArgs = {
  query: string;
  status: string;
  limit: number;
};

/** Normalize bounded inventory tool input without depending on runtime data sources. */
export function normalizedInventoryArgs(args: UnknownRecord): NormalizedInventoryArgs | null {
  const allowedKeys = new Set(["query", "sku", "status", "limit"]);
  if (Object.keys(args).some((key) => !allowedKeys.has(key))) return null;

  const query = args.query ?? args.sku ?? "";
  if (typeof query !== "string" || query.length > 200) return null;
  if (args.query !== undefined && args.sku !== undefined && args.query !== args.sku) return null;

  const rawStatus = args.status ?? "all";
  if (typeof rawStatus !== "string") return null;
  const statusKey = rawStatus.trim().toLocaleLowerCase("en-AU").replace(/[\s-]+/gu, "_");
  const aliases: Record<string, string> = {
    all: "all",
    attention: "attention",
    needs_attention: "attention",
    need_attention: "attention",
    insufficient: "attention",
    sufficient: "sufficient",
    in_stock: "sufficient",
    instock: "sufficient",
    low: "low_stock",
    low_stock: "low_stock",
    lowstock: "low_stock",
    on_order: "on_order",
    onorder: "on_order",
    over_stock: "overstock",
    overstock: "overstock",
    out_of_stock: "out_of_stock",
    outofstock: "out_of_stock",
  };
  const status = aliases[statusKey];
  const allowedStatuses = ["all", "attention", "sufficient", "low_stock", "on_order", "overstock", "out_of_stock"];
  if (!allowedStatuses.includes(status)) return null;

  const rawLimit = args.limit ?? 10;
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (!Number.isInteger(limit) || (limit as number) < 1) return null;
  return { query: query.trim(), status, limit: Math.min(limit as number, 20) };
}
