import assert from "node:assert/strict";
import test from "node:test";
import type * as InventoryPolicy from "./types";

const policyModule = "./types.ts";
const {
  inventoryOperationRequiredRole,
  inventoryRoleCanAddStock,
} = await import(policyModule) as typeof InventoryPolicy;

test("Project Managers and Administrators retain the New Stock workflow", () => {
  assert.equal(inventoryRoleCanAddStock("pm"), true);
  assert.equal(inventoryRoleCanAddStock("admin"), true);
  assert.equal(inventoryRoleCanAddStock("sales"), false);
  assert.equal(inventoryRoleCanAddStock("specialist"), false);
  assert.equal(inventoryOperationRequiredRole("arrival"), "pm");
});

test("New Stock access does not broaden Administrator-only inventory controls", () => {
  for (const action of [
    "adminLogin",
    "adminLogout",
    "editInventory",
    "reportLoss",
    "deleteSku",
    "deleteLog",
    "clearLogs",
    "setStatus",
  ] as const) {
    assert.equal(inventoryOperationRequiredRole(action), "admin");
  }
  assert.equal(inventoryOperationRequiredRole("sale"), "sales");
  assert.equal(inventoryOperationRequiredRole("schedule"), "pm");
});
