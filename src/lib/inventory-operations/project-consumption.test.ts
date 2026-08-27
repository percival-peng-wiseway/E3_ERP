import assert from "node:assert/strict";
import test from "node:test";
import type * as ProjectConsumption from "./project-consumption";
import type { ApiState } from "./types";

const modulePath = "./project-consumption.ts";
const {
  applyProjectSolarConsumptionToErpInventory,
  applyProjectSolarConsumptionToOperationsState,
  solarPanelInventorySku,
} = await import(modulePath) as typeof ProjectConsumption;

function project(
  id: string,
  sku: string,
  quantity: number,
): ProjectConsumption.SolarConsumptionProject {
  return {
    id,
    customer: {
      firstName: "Amit",
      lastName: "Singh",
      phone: "0400000000",
      addressLine1: "12 Example Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    installedAt: "2026-08-27T00:00:00.000Z",
    solarPanelConsumption: {
      recordedAt: "2026-08-27T00:00:00.000Z",
      recordedBy: "Kevin",
      items: [{ sku, quantity }],
    },
  };
}

function state(): ApiState {
  return {
    inventory: [
      { sku: "LR7-54HVH-475M", category: "太阳能板", status: "充足", on_hand: 0, reserved: 0, pending: 0, available: 0, consumption: 2 },
      { sku: "CQ7-L4", category: "电池", status: "充足", on_hand: 1, reserved: 0, pending: 0, available: 1, consumption: 0 },
    ],
    orders: [],
    deliveryHistory: [],
    lossHistory: [],
    logs: [],
    admin: false,
  };
}

test("certification suffixes are removed when matching project models to Inventory SKUs", () => {
  assert.equal(solarPanelInventorySku("LR7-54HVH-475M (IEC 61215-2021)"), "LR7-54HVH-475M");
  assert.equal(solarPanelInventorySku("MODEL (w)"), "MODEL (w)");
});

test("installed Solar Panels can become negative and create consumption history", () => {
  const result = applyProjectSolarConsumptionToOperationsState(
    state(),
    [project("one", "LR7-54HVH-475M (IEC 61215-2021)", 14)],
  );
  assert.deepEqual(result.inventory[0], {
    sku: "LR7-54HVH-475M",
    category: "太阳能板",
    status: "缺货",
    on_hand: -14,
    reserved: 0,
    pending: 0,
    available: -14,
    consumption: 16,
  });
  assert.deepEqual(result.inventory[1], state().inventory[1]);
  assert.equal(result.deliveryHistory.length, 0);
  assert.equal(result.projectConsumptionHistory?.length, 1);
  assert.equal(result.projectConsumptionHistory?.[0].sku, "LR7-54HVH-475M");
  assert.equal(result.projectConsumptionHistory?.[0].quantity, 14);
  assert.equal(result.projectConsumptionHistory?.[0].customer, "Amit Singh");
  assert.equal(result.projectConsumptionHistory?.[0].created_at, "2026-08-27T00:00:00.000Z");
});

test("multiple installed projects aggregate once and a direct-supplier SKU is synthesized", () => {
  const result = applyProjectSolarConsumptionToOperationsState(state(), [
    project("one", "DIRECT-475 (IEC 61215)", 8),
    project("two", "DIRECT-475", 6),
  ]);
  assert.deepEqual(result.inventory.at(-1), {
    sku: "DIRECT-475",
    category: "太阳能板",
    status: "缺货",
    on_hand: -14,
    reserved: 0,
    pending: 0,
    available: -14,
    consumption: 14,
  });
  assert.equal(result.deliveryHistory.length, 0);
  assert.equal(result.projectConsumptionHistory?.length, 2);
  assert.notEqual(result.projectConsumptionHistory?.[0].id, result.projectConsumptionHistory?.[1].id);
});

test("projects without an atomic consumption marker never change inventory", () => {
  const noMarker = { ...project("one", "LR7-54HVH-475M", 14), solarPanelConsumption: null };
  const original = state();
  const result = applyProjectSolarConsumptionToOperationsState(original, [noMarker]);
  assert.equal(result, original);
});

test("the unified Inventory API receives the same negative Solar Panel balance", () => {
  const result = applyProjectSolarConsumptionToErpInventory([
    {
      id: "panel",
      sku: "LR7-54HVH-475M",
      name: "LONGi panel",
      warehouse: "Main",
      onHand: 2,
      reserved: 0,
      available: 2,
      reorderLevel: 0,
      uom: "panel",
      status: "in_stock",
      category: "Solar Panel",
    },
  ], [project("one", "LR7-54HVH-475M (IEC 61215-2021)", 14)]);
  assert.equal(result[0].onHand, -12);
  assert.equal(result[0].available, -12);
  assert.equal(result[0].status, "out_of_stock");
});
