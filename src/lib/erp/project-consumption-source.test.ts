import assert from "node:assert/strict";
import test from "node:test";
import type * as ConsumptionSource from "./project-consumption-source";
import type { SolarConsumptionProject } from "../inventory-operations/project-consumption";
import type { InventoryItem } from "./types";

const sourceModule = "./project-consumption-source.ts";
const { ProjectConsumptionInventorySource } = await import(sourceModule) as typeof ConsumptionSource;

const inventory: InventoryItem[] = [{
  id: "panel",
  sku: "PANEL-475",
  name: "Panel 475",
  warehouse: "Main",
  onHand: 3,
  reserved: 0,
  available: 3,
  reorderLevel: 0,
  uom: "panel",
  status: "in_stock",
  category: "Solar Panel",
}];

const installedProject = {
  id: "project",
  customer: {
    firstName: "Customer",
    lastName: "One",
    phone: "",
    addressLine1: "",
    suburb: "",
    state: "",
    postcode: "",
  },
  installedAt: "2026-08-27T00:00:00.000Z",
  solarPanelConsumption: {
    recordedAt: "2026-08-27T00:00:00.000Z",
    recordedBy: "Kevin",
    items: [{ sku: "PANEL-475", quantity: 5 }],
  },
} satisfies SolarConsumptionProject;

test("project-adjusted inventory is filtered after the negative balance is applied", async () => {
  let receivedQuery: unknown = "not called";
  const source = new ProjectConsumptionInventorySource({
    listInventory: async (query) => {
      receivedQuery = query;
      return inventory;
    },
    getInventoryItem: async () => null,
  }, async () => [installedProject]);

  const lowStock = await source.listInventory({ lowStockOnly: true });
  assert.equal(receivedQuery, undefined);
  assert.equal(lowStock.length, 1);
  assert.equal(lowStock[0].available, -2);
  assert.equal(lowStock[0].status, "out_of_stock");
  assert.equal((await source.getInventoryItem("panel-475"))?.available, -2);
});
