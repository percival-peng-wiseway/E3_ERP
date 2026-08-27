// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as projectConsumption from "../inventory-operations/project-consumption.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as paymentTrackRepository from "../payment-track/repository.ts";
import type { SolarConsumptionProject } from "../inventory-operations/project-consumption";
import type { ERPProvider } from "./provider";
import type { InventoryItem, InventoryQuery } from "./types";

type InventorySource = Pick<ERPProvider, "listInventory" | "getInventoryItem">;

const { applyProjectSolarConsumptionToErpInventory } = projectConsumption;
const { listPaymentTrackProjects } = paymentTrackRepository;

function normalized(value: string | undefined) {
  return (value || "").trim().toLocaleLowerCase("en-AU");
}

function applyQuery(items: InventoryItem[], query: InventoryQuery) {
  let result = items;
  if (query.search) {
    const term = normalized(query.search);
    result = result.filter((item) => [
      item.id,
      item.sku,
      item.name,
      item.category,
      item.supplier,
      item.warehouse,
    ].some((value) => normalized(value).includes(term)));
  }
  if (query.warehouse) {
    result = result.filter((item) => normalized(item.warehouse) === normalized(query.warehouse));
  }
  if (query.status) result = result.filter((item) => item.status === query.status);
  if (query.lowStockOnly) result = result.filter((item) => item.status !== "in_stock");
  if (query.limit !== undefined && Number.isFinite(query.limit)) {
    result = result.slice(0, Math.max(0, Math.floor(query.limit)));
  }
  return result;
}

/** Adds atomic Project Track installation consumption to every ERP inventory read. */
export class ProjectConsumptionInventorySource implements InventorySource {
  private readonly source: InventorySource;
  private readonly projects: () => Promise<SolarConsumptionProject[]>;

  constructor(
    source: InventorySource,
    projects: () => Promise<SolarConsumptionProject[]> = listPaymentTrackProjects,
  ) {
    this.source = source;
    this.projects = projects;
  }

  async listInventory(query: InventoryQuery = {}) {
    const [inventory, projects] = await Promise.all([
      this.source.listInventory(),
      this.projects(),
    ]);
    return applyQuery(applyProjectSolarConsumptionToErpInventory(inventory, projects), query);
  }

  async getInventoryItem(identifier: string) {
    const term = normalized(identifier);
    return (await this.listInventory()).find((item) => (
      normalized(item.id) === term
      || normalized(item.sku) === term
      || normalized(item.name) === term
    )) ?? null;
  }
}
