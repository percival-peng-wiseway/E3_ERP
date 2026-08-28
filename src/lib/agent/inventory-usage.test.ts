import assert from "node:assert/strict";
import test from "node:test";
import type { Order } from "../inventory-operations/types";
import type { PaymentTrackProject } from "../payment-track/types";
const usageModule = "./inventory-usage.ts";
const {
  buildInventoryUsageSnapshot,
  formatInventoryUsageAnswer,
  inventorySkuCandidates,
  isBareInventorySkuLookup,
  inventoryUsageRequestsAssignee,
  inventoryUsageRequestsCustomers,
  inventoryUsageRequestsPending,
  isInventoryStockIntent,
  isInventoryUsageIntent,
  resolveInventoryUsageMessage,
} = await import(usageModule) as typeof import("./inventory-usage");

function order(overrides: Partial<Order>): Order {
  return {
    id: 1,
    order_group: "group-1",
    sales_rep: "Sales",
    customer: "Customer One",
    phone: "0400000000",
    sku: "KH10.",
    quantity: 1,
    created_at: "2026-08-20 00:00:00",
    status: "delivered",
    address: "Private address",
    planned_date: "2026-08-21",
    driver: null,
    delivered_at: "2026-08-21 01:00:00",
    note: "Private note",
    driver_email: null,
    delivery_time: null,
    ...overrides,
  };
}

function project(overrides: Partial<PaymentTrackProject>): PaymentTrackProject {
  return {
    quoteNumber: "QN-KH10-1",
    reference: "legacy-reference",
    stage: "waiting_coes",
    installedAt: "2026-08-22T00:00:00.000Z",
    deliverySelections: [],
    items: [{
      id: "item-1", category: "Inverter", description: "Hybrid inverter",
      model: "KH10", quantity: 1, capacity: "10kW",
    }],
    customer: {
      firstName: "Installed", lastName: "Customer", phone: "0499999999",
      email: "private@example.com", addressLine1: "Secret Street",
      suburb: "Melbourne", state: "VIC", postcode: "3000",
    },
    ...overrides,
  } as PaymentTrackProject;
}

test("recognizes SKU usage questions without treating stock questions as usage", () => {
  for (const message of [
    "哪些订单用KH10？",
    "哪些客户用了kh10？",
    "Which customer used KH10?",
    "Which orders contain KH10?",
    "KH10 usage history",
    "KH10有哪些订单还没送货？",
    "哪些项目还没安装KH10？",
  ]) assert.equal(isInventoryUsageIntent(message), true, message);
  for (const message of ["KH10还有多少库存？", "How many KH10 are available?", "What is KH10 used for?"]) {
    assert.equal(isInventoryUsageIntent(message), false, message);
  }
  assert.equal(isInventoryUsageIntent("KH10 installation tomorrow"), false);
  assert.equal(isInventoryUsageIntent("哪些项目安装了 KH10？"), true);
  assert.equal(isInventoryStockIntent("Compare KH10 stock with customers who used it"), true);
  assert.deepEqual(inventorySkuCandidates("Compare KH10. with CPEC5256 and QN202605050003"), ["KH10"]);
  assert.deepEqual(inventorySkuCandidates("Which orders used BAT-ONE and CANOPY?"), ["BAT-ONE", "CANOPY"]);
  assert.deepEqual(inventorySkuCandidates("Which orders used canopy?"), ["canopy"]);
  assert.deepEqual(inventorySkuCandidates("Look up SKU bollard"), ["bollard"]);
  assert.deepEqual(inventorySkuCandidates("What is KH10 used for?"), ["KH10"]);
  assert.deepEqual(inventorySkuCandidates("Which customer used it?"), []);
  assert.deepEqual(inventorySkuCandidates("Which VIC customers used KH10?"), ["KH10"]);
  assert.equal(isBareInventorySkuLookup("KH10?"), true);
  assert.equal(isBareInventorySkuLookup("Look up KH10"), true);
  assert.equal(isBareInventorySkuLookup("Look up SKU bollard"), true);
  assert.equal(isBareInventorySkuLookup("Look up stock KH10"), true);
  assert.equal(isBareInventorySkuLookup("What is KH10 used for?"), false);
});

test("customer, assignee and pending intent gates stay independent", () => {
  assert.equal(inventoryUsageRequestsCustomers("Which customer used KH10?"), true);
  assert.equal(inventoryUsageRequestsAssignee("Which customer used KH10?"), false);
  assert.equal(inventoryUsageRequestsCustomers("Who installed KH10?"), false);
  assert.equal(inventoryUsageRequestsAssignee("Who installed KH10?"), true);
  assert.equal(inventoryUsageRequestsCustomers("谁安装了KH10？"), false);
  assert.equal(inventoryUsageRequestsAssignee("谁安装了KH10？"), true);
  assert.equal(inventoryUsageRequestsCustomers("Who used KH10 in an installed project?"), true);
  assert.equal(inventoryUsageRequestsAssignee("Who used KH10 in an installed project?"), false);
  assert.equal(inventoryUsageRequestsCustomers("Who are the customers who installed KH10?"), true);
  assert.equal(inventoryUsageRequestsAssignee("Who are the customers who installed KH10?"), false);
  assert.equal(inventoryUsageRequestsPending("Which KH10 orders haven't been delivered?"), true);
  assert.equal(inventoryUsageRequestsPending("哪些项目还没安装KH10？"), true);
});

test("pronoun follow-ups use only one SKU from the latest relevant user message", () => {
  assert.equal(resolveInventoryUsageMessage("which customer used them?", [
    { role: "user", content: "Which orders use KH10?" },
    { role: "assistant", content: "CQ7 was also mentioned." },
  ]), "which customer used them? KH10");
  assert.equal(resolveInventoryUsageMessage("哪些客户用了它？", [
    { role: "user", content: "比较 KH10 和 CQ7" },
  ]), "哪些客户用了它？");
  assert.equal(resolveInventoryUsageMessage("Which customer used it?", [
    { role: "user", content: "How much KH10 stock is available?" },
  ]), "Which customer used it? KH10");
  assert.equal(resolveInventoryUsageMessage("Which customer used that?", [
    { role: "user", content: "How much KH10 stock is available?" },
  ]), "Which customer used that? KH10");
  assert.equal(resolveInventoryUsageMessage("which customer used them?", [
    { role: "assistant", content: "KH10 has five available." },
  ]), "which customer used them?");
  assert.equal(resolveInventoryUsageMessage("which customer used them?", [
    { role: "user", content: "How much KH10 stock is available?" },
    { role: "assistant", content: "Five." },
    { role: "user", content: "Show outstanding Project Track balances." },
    { role: "assistant", content: "Here are the balances." },
  ]), "which customer used them?", "an unrelated user turn blocks stale SKU inheritance");
});

test("usage lineage separates delivered orders from installed projects and excludes cancellations", () => {
  const delivered = order({ id: 10, order_group: null });
  const snapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [
      delivered,
      order({ id: 11, order_group: "cancelled", status: "cancelled", delivered_at: null, customer: "Cancelled Customer" }),
      order({ id: 12, order_group: "other", sku: "KH100", customer: "Wrong Customer" }),
    ],
    deliveryHistory: [delivered],
    projects: [
      project({ quoteNumber: "QN-INSTALLED" }),
      project({ quoteNumber: "QN-PENDING", stage: "working_in_progress", installedAt: null }),
      project({ quoteNumber: "QN-OTHER", items: [{
        id: "other", category: "Inverter", description: "Other", model: "KH100", quantity: 1, capacity: "",
      }] }),
    ],
    includeCustomerNames: false,
    includeAssignees: false,
    includeCancelled: false,
    limit: 20,
  });
  assert.equal(snapshot.deliveredOrders.length, 1, "orders/history duplicate is counted once");
  assert.equal(snapshot.cancelledOrders.length, 0);
  assert.equal(snapshot.installedProjects.length, 1);
  assert.equal(snapshot.projectCommitments.length, 1);
  assert.equal(snapshot.installedProjects[0]?.proposal, "QN-INSTALLED");
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /0400000000|Private address|Private note|private@example|Secret Street/u);
  assert.doesNotMatch(serialized, /Cancelled Customer|Wrong Customer/u);
});

test("customer names are an explicit projection and never widen to contact details", () => {
  const snapshot = buildInventoryUsageSnapshot({
    sku: "kh10",
    orders: [order({ id: 20, customer: "Delivered Customer" })],
    deliveryHistory: [],
    projects: [project({ quoteNumber: "QN-CUSTOMER" })],
    includeCustomerNames: true,
    includeAssignees: false,
    includeCancelled: false,
    limit: 20,
  });
  assert.equal(snapshot.deliveredOrders[0]?.customer, "Delivered Customer");
  assert.equal(snapshot.installedProjects[0]?.customer, "Installed Customer");
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /0400000000|0499999999|private@example|Secret Street|Private note/u);
});

test("current cancelled state overrides stale delivered history and never counts as used", () => {
  const history = order({ id: 25, status: "delivered", delivered_at: "2026-08-21 01:00:00" });
  const current = order({ id: 25, status: "cancelled", delivered_at: "2026-08-21 01:00:00" });
  const snapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [current],
    deliveryHistory: [history],
    projects: [],
    includeCustomerNames: false,
    includeAssignees: false,
    includeCancelled: true,
    limit: 20,
  });
  assert.equal(snapshot.deliveredOrders.length, 0);
  assert.equal(snapshot.cancelledOrders.length, 1);
  assert.equal(snapshot.totals.deliveredOrders, 0);
  assert.equal(snapshot.totals.cancelledOrders, 1);
});

test("warehouse selections override quoted items when tracing installed materials", () => {
  const snapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [],
    deliveryHistory: [],
    projects: [
      project({ quoteNumber: "QN-QUOTED-ONLY", deliverySelections: [{ sku: "CQ7", quantity: 1 }] }),
      project({
        quoteNumber: "QN-SELECTED",
        deliverySelections: [{ sku: "KH10.", quantity: 2 }],
        items: [{ id: "other", category: "Inverter", description: "Other", model: "KH100", quantity: 1, capacity: "" }],
      }),
    ],
    includeCustomerNames: false,
    includeAssignees: false,
    includeCancelled: false,
    limit: 20,
  });
  assert.deepEqual(snapshot.installedProjects.map((item) => item.proposal), ["QN-SELECTED"]);
  assert.equal(snapshot.installedProjects[0]?.quantity, 2);
});

test("answer projection keeps sources separate and excludes contacts, notes and balances", () => {
  const snapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [order({ id: 30, customer: "Delivered Customer" })],
    deliveryHistory: [],
    projects: [project({ quoteNumber: "QN-INSTALLED" })],
    includeCustomerNames: true,
    includeAssignees: false,
    includeCancelled: false,
    limit: 20,
  });
  const answer = formatInventoryUsageAnswer({
    ...snapshot,
    inventoryOrdersAvailable: true,
    projectTrackAvailable: true,
    sourceWarnings: [],
  }, "Which customers used KH10?");
  assert.match(answer, /Inventory delivered orders: \*\*1\*\*/u);
  assert.match(answer, /Project Track installed projects: \*\*1\*\*/u);
  assert.match(answer, /Delivered Customer/u);
  assert.match(answer, /Installed Customer/u);
  assert.match(answer, /not added together/u);
  assert.doesNotMatch(answer, /AUD|\$|0400000000|0499999999|private@example|Secret Street|Private note/u);
});

test("answer projection reports a missing source as unavailable instead of zero", () => {
  const snapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [], deliveryHistory: [], projects: [],
    includeCustomerNames: true, includeAssignees: false, includeCancelled: false, limit: 20,
  });
  const answer = formatInventoryUsageAnswer({
    ...snapshot,
    inventoryOrdersAvailable: false,
    projectTrackAvailable: true,
    sourceWarnings: ["Inventory order history is temporarily unavailable."],
  }, "哪些客户用了 KH10？");
  assert.match(answer, /Inventory 已送达订单：暂时无法读取/u);
  assert.match(answer, /Project Track 已安装项目：\*\*0\*\*/u);
  assert.doesNotMatch(answer, /Inventory 已送达订单：\*\*0\*\*/u);
});

test("pending-only answers exclude completed work and assignee questions do not expose customers", () => {
  const pendingSnapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [
      order({ id: 40, status: "delivered", delivered_at: "2026-08-21 01:00:00" }),
      order({ id: 41, status: "scheduled", delivered_at: null, planned_date: "2026-08-30" }),
    ],
    deliveryHistory: [],
    projects: [
      project({ quoteNumber: "QN-DONE" }),
      project({ quoteNumber: "QN-PENDING", stage: "working_in_progress", installedAt: null }),
    ],
    includeCustomerNames: false,
    includeAssignees: false,
    includeCancelled: false,
    limit: 20,
  });
  const pendingAnswer = formatInventoryUsageAnswer({
    ...pendingSnapshot,
    inventoryOrdersAvailable: true,
    projectTrackAvailable: true,
    sourceWarnings: [],
  }, "Which projects with KH10 are not installed?");
  assert.match(pendingAnswer, /Projects not yet installed: \*\*1\*\*/u);
  assert.match(pendingAnswer, /QN-PENDING/u);
  assert.doesNotMatch(pendingAnswer, /QN-DONE|Project Track installed projects/u);
  const completedChineseAnswer = formatInventoryUsageAnswer({
    ...pendingSnapshot,
    inventoryOrdersAvailable: true,
    projectTrackAvailable: true,
    sourceWarnings: [],
  }, "谁安装了KH10？");
  assert.match(completedChineseAnswer, /QN-DONE/u);
  assert.doesNotMatch(completedChineseAnswer, /QN-PENDING|尚未安装/u);

  const assigneeSnapshot = buildInventoryUsageSnapshot({
    sku: "KH10",
    orders: [order({ id: 42, driver: "Kevin", customer: "Private Customer" })],
    deliveryHistory: [],
    projects: [project({
      quoteNumber: "QN-INSTALLER",
      installationAssignee: "Leo",
      installedAt: "2026-08-28T14:30:00.000Z",
    })],
    includeCustomerNames: false,
    includeAssignees: true,
    includeCancelled: false,
    limit: 20,
  });
  const assigneeAnswer = formatInventoryUsageAnswer({
    ...assigneeSnapshot,
    inventoryOrdersAvailable: true,
    projectTrackAvailable: true,
    sourceWarnings: [],
  }, "Who installed KH10?");
  assert.match(assigneeAnswer, /Installer: Leo/u);
  assert.match(assigneeAnswer, /2026-08-29/u, "UTC installation timestamps use the Melbourne business date");
  assert.doesNotMatch(assigneeAnswer, /Private Customer|Installed Customer/u);
});
