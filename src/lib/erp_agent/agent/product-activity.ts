import type { InventoryItem, Order } from "../../inventory-operations/types";
import type { InventoryItem as ERPInventoryItem, Quotation } from "../../erp/types";
import type { PaymentTrackProject } from "../../payment-track/types";

type ProductActivitySources = {
  operations: { inventory: InventoryItem[]; orders: Order[]; deliveryHistory: Order[] } | null;
  erpInventory: ERPInventoryItem[] | null;
  quotations: Quotation[] | null;
  projects: PaymentTrackProject[] | null;
};

export type ProductActivityArgs = {
  query: string;
  from: string;
  to: string;
  includeCustomerNames: boolean;
  limit: number;
};

function normalized(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-AU");
}

function normalizedSku(value: unknown) {
  return normalized(value).replace(/[^a-z0-9]/gu, "");
}

function productTerms(query: string) {
  const value = normalized(query);
  const terms = new Set([value]);
  if (/\b(?:battery|batteries)\b|电池|储能电池/iu.test(value)) {
    ["battery", "batteries", "电池", "储能电池"].forEach((term) => terms.add(term));
  }
  if (/\b(?:inverter|inverters)\b|逆变器/iu.test(value)) {
    ["inverter", "inverters", "逆变器"].forEach((term) => terms.add(term));
  }
  if (/\bsolar\s*panels?\b|太阳能板|光伏板|组件/iu.test(value)) {
    ["solar panel", "solar panels", "太阳能板", "光伏板", "组件"].forEach((term) => terms.add(term));
  }
  return [...terms].filter(Boolean);
}

function matchesProduct(values: unknown[], terms: string[], matchingSkus: Set<string>) {
  if (values.some((value) => matchingSkus.has(normalizedSku(value)))) return true;
  return values.some((value) => {
    const text = normalized(value);
    return terms.some((term) => text.includes(term));
  });
}

function datePart(value: unknown) {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] || null;
}

function inRange(value: unknown, from: string, to: string) {
  const date = datePart(value);
  return Boolean(date && date >= from && date <= to);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function counts<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}

function quantitiesByStatus(lines: Array<{ status: string; quantity: number }>) {
  return lines.reduce<Record<string, number>>((result, line) => {
    result[line.status] = (result[line.status] || 0) + line.quantity;
    return result;
  }, {});
}

function uniqueOrders(orders: readonly Order[], history: readonly Order[]) {
  const byId = new Map<number, Order>();
  for (const order of [...history, ...orders]) byId.set(order.id, order);
  return [...byId.values()];
}

function projectProductLines(project: PaymentTrackProject, terms: string[], matchingSkus: Set<string>) {
  const itemLines = project.items
    .filter((item) => matchesProduct([item.category, item.description, item.model], terms, matchingSkus))
    .map((item) => ({
      kind: "project_item" as const,
      category: item.category,
      description: item.description,
      model: item.model,
      quantity: item.quantity,
      capacity: item.capacity,
    }));
  if (itemLines.length) return itemLines;
  return project.deliverySelections
    .filter((item) => matchesProduct([item.sku], terms, matchingSkus))
    .map((item) => ({
      kind: "delivery_selection" as const,
      category: "",
      description: "",
      model: item.sku,
      quantity: item.quantity,
      capacity: "",
    }));
}

/**
 * Build a read-only, cross-source activity view. Source totals remain separate:
 * the same real-world sale can appear in more than one system and there is no
 * durable join key that would make adding those totals reliable.
 */
export function buildProductActivitySnapshot(
  sources: ProductActivitySources,
  args: ProductActivityArgs,
) {
  const terms = productTerms(args.query);
  const matchingSkus = new Set<string>();
  for (const item of sources.operations?.inventory || []) {
    if (matchesProduct([item.sku, item.category], terms, new Set())) matchingSkus.add(normalizedSku(item.sku));
  }
  for (const item of sources.erpInventory || []) {
    if (matchesProduct([item.sku, item.name, item.category], terms, new Set())) matchingSkus.add(normalizedSku(item.sku));
  }

  const stock = (sources.operations?.inventory || [])
    .filter((item) => matchesProduct([item.sku, item.category], terms, matchingSkus))
    .map((item) => ({
      sku: item.sku,
      category: item.category,
      status: item.status,
      onHand: item.on_hand,
      reserved: item.reserved,
      pending: item.pending,
      available: item.available,
      consumption: item.consumption,
    }));

  const quotationRecords = (sources.quotations || []).flatMap((quotation) => {
    if (!inRange(quotation.createdAt, args.from, args.to)) return [];
    const items = quotation.items
      .filter((item) => matchesProduct([item.sku, item.description], terms, matchingSkus))
      .map((item) => ({
        sku: item.sku || null,
        description: item.description,
        quantity: item.quantity,
        uom: item.uom,
        amount: item.amount,
      }));
    if (!items.length) return [];
    return [{
      number: quotation.number,
      status: quotation.status,
      createdAt: quotation.createdAt,
      validUntil: quotation.validUntil,
      owner: quotation.owner || null,
      total: quotation.total,
      currency: quotation.currency,
      ...(args.includeCustomerNames ? { customer: quotation.customer } : {}),
      items,
      matchingQuantity: sum(items.map((item) => item.quantity)),
    }];
  });
  const quotationStatusLines = quotationRecords.map((record) => ({
    status: record.status,
    quantity: record.matchingQuantity,
  }));

  const orders = uniqueOrders(sources.operations?.orders || [], sources.operations?.deliveryHistory || []);
  const matchingOrders = orders.filter((order) => matchesProduct([order.sku], terms, matchingSkus));
  const orderRecords = matchingOrders
    .filter((order) => inRange(order.created_at, args.from, args.to) || inRange(order.delivered_at, args.from, args.to))
    .map((order) => ({
      id: order.id,
      orderGroup: order.order_group,
      sku: order.sku,
      quantity: order.quantity,
      status: order.status,
      createdAt: order.created_at,
      plannedDate: order.planned_date,
      deliveredAt: order.delivered_at,
      ...(args.includeCustomerNames ? { customer: order.customer } : {}),
    }));
  const createdOrders = matchingOrders.filter((order) => inRange(order.created_at, args.from, args.to));
  const deliveredOrders = matchingOrders.filter((order) => order.status === "delivered"
    && inRange(order.delivered_at, args.from, args.to));

  const projectRecords = (sources.projects || []).flatMap((project) => {
    const items = projectProductLines(project, terms, matchingSkus);
    if (!items.length || ![
      project.createdAt,
      project.deliveredAt,
      project.installedAt,
      project.updatedAt,
    ].some((date) => inRange(date, args.from, args.to))) return [];
    return [{
      reference: project.reference,
      proposal: project.quoteNumber,
      stage: project.stage,
      workMode: project.workMode,
      financials: {
        currency: project.currency,
        balanceDue: project.balanceDueCents / 100,
        outstanding: project.outstandingCents / 100,
        overpayment: project.overpaymentCents / 100,
      },
      delivery: {
        selectedItems: project.deliverySelections.map((item) => ({ sku: item.sku, quantity: item.quantity })),
        preparedAt: project.deliveryPreparedAt,
        scheduledFor: project.deliveryScheduledFor,
        scheduledTime: project.deliveryScheduledTime,
        deliveredAt: project.deliveredAt,
      },
      installation: {
        scheduledFor: project.installationScheduledFor,
        scheduledTime: project.installationScheduledTime,
        installedAt: project.installedAt,
      },
      rebateReceipts: {
        solarStcRequired: project.stcSolarRequired,
        solarStcReceivedAt: project.stcSolarReceivedAt,
        batteryStcRequired: project.stcBatteryRequired,
        batteryStcReceivedAt: project.stcBatteryReceivedAt,
        solarRebateRequired: project.solarRebateRequired,
        solarRebateReceivedAt: project.solarRebateReceivedAt,
      },
      createdAt: project.createdAt,
      deliveredAt: project.deliveredAt,
      installedAt: project.installedAt,
      updatedAt: project.updatedAt,
      completedAt: project.completedAt,
      ...(args.includeCustomerNames ? {
        customer: `${project.customer.firstName} ${project.customer.lastName}`.trim(),
      } : {}),
      items,
      matchingQuantity: sum(items.map((item) => item.quantity)),
    }];
  });
  const projectCreated = projectRecords.filter((project) => inRange(project.createdAt, args.from, args.to));
  const projectDelivered = projectRecords.filter((project) => inRange(project.deliveredAt, args.from, args.to));
  const projectInstalled = projectRecords.filter((project) => inRange(project.installedAt, args.from, args.to));

  const unavailableSources = [
    ...(sources.operations ? [] : ["inventory_orders"]),
    ...(sources.quotations ? [] : ["quotations"]),
    ...(sources.projects ? [] : ["project_track"]),
  ];
  const found = stock.length > 0 || quotationRecords.length > 0 || matchingOrders.length > 0 || projectRecords.length > 0;

  return {
    query: args.query,
    from: args.from,
    to: args.to,
    complete: unavailableSources.length === 0,
    found,
    unavailableSources,
    matchedSkus: [...matchingSkus].filter(Boolean),
    metricDefinitions: {
      acceptedQuotationQuantity: "Matching line quantity on quotations created in the date range with status accepted; this is not proof of delivery or payment.",
      createdOrderQuantity: "Matching Inventory order quantity created in the date range, separated by current order status.",
      deliveredOrderQuantity: "Matching Inventory order quantity whose delivered_at is in the date range and current status is delivered.",
      deliveredProjectQuantity: "Matching Project Track item quantity whose project deliveredAt is in the date range.",
      installedProjectQuantity: "Matching Project Track item quantity whose project installedAt is in the date range.",
      reconciliation: "These source totals may describe the same job and must not be added together without a reliable cross-system join key.",
    },
    inventory: sources.operations ? {
      available: true,
      count: stock.length,
      onHand: sum(stock.map((item) => item.onHand)),
      reserved: sum(stock.map((item) => item.reserved)),
      availableQuantity: sum(stock.map((item) => item.available)),
      items: stock.slice(0, args.limit),
    } : { available: false },
    quotations: sources.quotations ? {
      available: true,
      recordCount: quotationRecords.length,
      recordCountsByStatus: counts(quotationRecords.map((record) => record.status)),
      lineQuantityByStatus: quantitiesByStatus(quotationStatusLines),
      acceptedQuotationQuantity: sum(quotationRecords
        .filter((record) => record.status === "accepted")
        .map((record) => record.matchingQuantity)),
      records: quotationRecords.slice(0, args.limit),
    } : { available: false },
    inventoryOrders: sources.operations ? {
      available: true,
      createdRecordCount: createdOrders.length,
      createdRecordCountsByStatus: counts(createdOrders.map((order) => order.status)),
      createdQuantityByStatus: quantitiesByStatus(createdOrders.map((order) => ({ status: order.status, quantity: order.quantity }))),
      createdOrderQuantity: sum(createdOrders.map((order) => order.quantity)),
      deliveredRecordCount: deliveredOrders.length,
      deliveredOrderQuantity: sum(deliveredOrders.map((order) => order.quantity)),
      records: orderRecords.slice(0, args.limit),
    } : { available: false },
    projectTrack: sources.projects ? {
      available: true,
      recordCount: projectRecords.length,
      recordCountsByStage: counts(projectRecords.map((project) => project.stage)),
      createdProjectQuantity: sum(projectCreated.map((project) => project.matchingQuantity)),
      deliveredProjectQuantity: sum(projectDelivered.map((project) => project.matchingQuantity)),
      installedProjectQuantity: sum(projectInstalled.map((project) => project.matchingQuantity)),
      records: projectRecords.slice(0, args.limit),
    } : { available: false },
  };
}
