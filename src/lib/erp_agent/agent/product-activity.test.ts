import assert from "node:assert/strict";
import test from "node:test";
import type { InventoryItem, Order } from "../../inventory-operations/types";
import type { Quotation } from "../../erp/types";
import type { PaymentTrackProject } from "../../payment-track/types";
const modulePath = "./product-activity.ts";
const { buildProductActivitySnapshot } = await import(modulePath) as typeof import("./product-activity");

const inventory: InventoryItem = {
  sku: "BAT-ONE",
  category: "Battery",
  status: "充足",
  on_hand: 12,
  reserved: 2,
  pending: 1,
  available: 10,
  consumption: 6,
};

const deliveredOrder: Order = {
  id: 10,
  order_group: "group-10",
  sales_rep: "Sales",
  customer: "Private Order Customer",
  phone: "0400000000",
  sku: "BAT-ONE",
  quantity: 1,
  created_at: "2026-08-10 10:00:00",
  status: "delivered",
  address: "Private address",
  planned_date: "2026-08-12",
  driver: "Private driver",
  delivered_at: "2026-08-12 10:00:00",
  note: "Private note",
  driver_email: "driver@example.com",
  delivery_time: "10:00",
};

function quotation(status: Quotation["status"], quantity: number, number: string): Quotation {
  return {
    id: number,
    number,
    customer: "Private Quote Customer",
    status,
    subtotal: 100,
    tax: 10,
    total: 110,
    currency: "AUD",
    validUntil: "2026-09-30",
    createdAt: "2026-08-05T00:00:00.000Z",
    items: [{
      id: `${number}-line`, sku: "BAT-ONE", description: "Home battery",
      quantity, uom: "ea", unitPrice: 100, amount: 100,
    }],
  };
}

const project = {
  reference: "PAY-10",
  quoteNumber: "QN-10",
  stage: "waiting_coes",
  workMode: "delivery_and_installation",
  customer: {
    firstName: "Private", lastName: "Project Customer", phone: "0499999999",
    email: "private@example.com", addressLine1: "Secret Street", suburb: "Melbourne",
    state: "VIC", postcode: "3000",
  },
  items: [{
    id: "battery-line", category: "Battery", description: "Home battery",
    model: "BAT-ONE", quantity: 4, capacity: "40 kWh",
  }],
  deliverySelections: [{ sku: "BAT-ONE", quantity: 4 }],
  createdAt: "2026-07-20T00:00:00.000Z",
  deliveredAt: "2026-08-18T00:00:00.000Z",
  installedAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
} as PaymentTrackProject;

test("cross-source product activity keeps business milestones separate", () => {
  const result = buildProductActivitySnapshot({
    operations: { inventory: [inventory], orders: [deliveredOrder], deliveryHistory: [deliveredOrder] },
    erpInventory: [],
    quotations: [quotation("accepted", 2, "Q-ACCEPTED"), quotation("draft", 3, "Q-DRAFT")],
    projects: [project],
  }, {
    query: "电池",
    from: "2026-08-01",
    to: "2026-08-31",
    includeCustomerNames: false,
    limit: 20,
  });

  assert.equal(result.complete, true);
  assert.equal(result.found, true);
  assert.equal(result.quotations.acceptedQuotationQuantity, 2);
  assert.equal(result.inventoryOrders.createdOrderQuantity, 1);
  assert.equal(result.inventoryOrders.deliveredOrderQuantity, 1, "order/history duplicates are counted once");
  assert.equal(result.projectTrack.deliveredProjectQuantity, 4);
  assert.equal(result.projectTrack.installedProjectQuantity, 4);
  assert.match(result.metricDefinitions.reconciliation, /must not be added/u);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Private|0400000000|Secret Street|example\.com/u);
});

test("cross-source result is incomplete when any required system is unavailable", () => {
  const result = buildProductActivitySnapshot({
    operations: { inventory: [inventory], orders: [], deliveryHistory: [] },
    erpInventory: [],
    quotations: null,
    projects: [project],
  }, {
    query: "battery",
    from: "2026-08-01",
    to: "2026-08-31",
    includeCustomerNames: false,
    limit: 20,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.unavailableSources, ["quotations"]);
});

test("customer names are returned only with explicit permission", () => {
  const result = buildProductActivitySnapshot({
    operations: { inventory: [inventory], orders: [deliveredOrder], deliveryHistory: [] },
    erpInventory: [],
    quotations: [quotation("accepted", 2, "Q-ACCEPTED")],
    projects: [project],
  }, {
    query: "battery",
    from: "2026-08-01",
    to: "2026-08-31",
    includeCustomerNames: true,
    limit: 20,
  });
  assert.match(JSON.stringify(result), /Private Order Customer|Private Quote Customer|Private Project Customer/u);
});
