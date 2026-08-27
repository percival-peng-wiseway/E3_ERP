import assert from "node:assert/strict";
import test from "node:test";
import type * as StockPolicy from "./stock-policy";

const policyModule = "./stock-policy.ts";
const {
  inventoryCategoryAllowsNegativeStock,
  inventoryItemCanFulfilSelection,
} = await import(policyModule) as typeof StockPolicy;

test("only Solar Panel categories allow negative stock", () => {
  for (const category of ["太阳能板", "Solar Panel", " solar-panels "]) {
    assert.equal(inventoryCategoryAllowsNegativeStock(category), true);
  }

  for (const category of ["电池", "Inverter", "安装配件", "Bollard", "Canopy", "其他"]) {
    assert.equal(inventoryCategoryAllowsNegativeStock(category), false);
  }
});

test("Solar Panel project selections are not blocked by warehouse availability", () => {
  assert.equal(inventoryItemCanFulfilSelection({ category: "太阳能板", available: -20 }, 14), true);
  assert.equal(inventoryItemCanFulfilSelection({ category: "Solar Panel", available: 0 }, 14), true);
  assert.equal(inventoryItemCanFulfilSelection({ category: "电池", available: 1 }, 2), false);
  assert.equal(inventoryItemCanFulfilSelection({ category: "电池", available: 2 }, 2), true);
  assert.equal(inventoryItemCanFulfilSelection(undefined, 1), false);
});
