import { DemoProvider } from "./demo-provider";
import { HttpProvider } from "./http-provider";
import type { ERPProvider } from "./provider";

export * from "./types";
export * from "./provider";
export { DemoProvider } from "./demo-provider";
export { HttpProvider } from "./http-provider";

export function getERPProvider(): ERPProvider {
  const inventoryUrl = process.env.ERP_INVENTORY_API_URL?.trim();
  const quotationUrl = process.env.ERP_QUOTATION_API_URL?.trim();

  if (!inventoryUrl && !quotationUrl) return new DemoProvider();

  return new HttpProvider({
    inventoryUrl,
    quotationUrl,
    token: process.env.ERP_API_TOKEN,
    fallback: new DemoProvider(),
  });
}
