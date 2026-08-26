import { HttpProvider } from "./http-provider";
import { LiveERPProvider } from "./live-provider";
import type { ERPProvider } from "./provider";

export * from "./types";
export * from "./provider";
export { DemoProvider } from "./demo-provider";
export { HttpProvider } from "./http-provider";
export { LiveERPProvider } from "./live-provider";

export function getERPProvider(request?: Request): ERPProvider {
  return new LiveERPProvider(request);
}
