// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { groupOrders, type Order } from "../../inventory-operations/types.ts";
import type { PaymentTrackProject } from "../../payment-track/types";

export type AgentConversationContext = {
  role: "user" | "assistant";
  content: string;
};

export type InventoryUsageOrder = {
  orderIds: number[];
  status: string;
  quantity: number;
  plannedDate: string | null;
  deliveredAt: string | null;
  customer?: string;
  assignee?: string;
};

export type InventoryUsageProject = {
  proposal: string;
  status: string;
  quantity: number;
  installedAt: string | null;
  customer?: string;
  assignee?: string;
};

export type InventoryUsageSnapshot = {
  sku: string;
  totals: {
    deliveredOrders: number;
    activeOrders: number;
    cancelledOrders: number;
    installedProjects: number;
    projectCommitments: number;
  };
  deliveredOrders: InventoryUsageOrder[];
  activeOrders: InventoryUsageOrder[];
  cancelledOrders: InventoryUsageOrder[];
  installedProjects: InventoryUsageProject[];
  projectCommitments: InventoryUsageProject[];
};

export type InventoryUsageAnswerSnapshot = InventoryUsageSnapshot & {
  inventoryOrdersAvailable: boolean;
  projectTrackAvailable: boolean;
  sourceWarnings: string[];
};

const IDENTIFIER = /\b(?=[a-z0-9_.-]{2,40}\b)(?=[a-z0-9_.-]*[a-z])(?=[a-z0-9_.-]*\d)[a-z0-9_.-]+\b/giu;
const STRUCTURED_ALPHA_IDENTIFIER = /\b[A-Z]{2,}(?:[_.-][A-Z]{2,})+\b/gu;
const KNOWN_ALPHA_IDENTIFIER = /\b(?:BOLLARD|CANOPY)\b/giu;
const NON_SKU_WORDS = new Set([
  "A", "AN", "AND", "ARE", "AUD", "BY", "CANCELLED", "CUSTOMER", "CUSTOMERS", "DELIVERED", "DELIVERY",
  "E3", "FOR", "FROM", "HAS", "HAVE", "HOW", "IN", "INSTALL", "INSTALLED", "INSTALLER", "INVENTORY", "IS", "IT", "ITEM", "ITEMS", "ITS",
  "ORDER", "ORDERS", "PM", "PROJECT", "PROJECTS", "QR", "SKU", "STC", "STOCK", "THAT", "THE", "THEM", "THESE", "THIS", "THOSE", "TO",
  "USED", "USES", "USING", "WHAT", "WHICH", "WHO", "WIP", "WITH",
]);

export function normalizedInventorySku(value: string) {
  return value.trim().toLocaleLowerCase("en-AU").replace(/[^a-z0-9]/gu, "");
}

export function inventorySkuCandidates(message: string) {
  const candidates = [
    ...(message.match(IDENTIFIER) || []),
    ...[...message.matchAll(/\bsku\s*[:#=-]?\s*([a-z][a-z0-9_.-]{1,39})\b/giu)].map((match) => match[1]),
    ...(message.match(STRUCTURED_ALPHA_IDENTIFIER) || []),
    ...(message.match(KNOWN_ALPHA_IDENTIFIER) || []),
    ...[...message.matchAll(/\b(?:use[sd]?|using|contain(?:s|ed)?|include(?:s|d)?|have|has|had|order(?:ed)?|deliver(?:ed)?|installed)\s+(?:sku\s+)?([a-z][a-z0-9_.-]{1,39})\b/giu)].map((match) => match[1]),
    ...[...message.matchAll(/(?:用过|用了|使用|用|有|包含|选用|选择)\s*([a-z][a-z0-9_.-]{1,39})\b/giu)].map((match) => match[1]),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    if (/^(?:pay|qtn|qn|cpec)(?:[_-]|\d)/iu.test(candidate)) continue;
    if (NON_SKU_WORDS.has(candidate.toLocaleUpperCase("en-AU"))) continue;
    const key = normalizedInventorySku(candidate);
    if (key && !unique.has(key)) unique.set(key, candidate.replace(/[.,;:!?]+$/u, ""));
  }
  return [...unique.values()];
}

export function isBareInventorySkuLookup(message: string) {
  const candidates = inventorySkuCandidates(message);
  if (candidates.length !== 1) return false;
  const normalized = message.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  const candidate = candidates[0].toLocaleLowerCase("en-AU");
  const index = normalized.indexOf(candidate);
  if (index < 0) return false;
  const remainder = `${normalized.slice(0, index)} ${normalized.slice(index + candidate.length)}`
    .replace(/[\s.,;:!?，。！？#_-]+/gu, " ")
    .trim();
  return /^(?:(?:look\s*up|lookup|check|show|find|查看|查询|显示|查)\s*)?(?:sku|inventory|stock)?$/u.test(remainder);
}

export function isInventoryUsageIntent(message: string) {
  const normalized = message.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  if (/\b(?:usage|consumption)\s+history\b|使用记录|消耗记录/u.test(normalized)) return true;
  const subject = /\b(?:customers?|clients?|orders?|projects?|jobs?|deliver(?:y|ies)|install(?:ation|ations|ed)?|where|who)\b|客户|订单|项目|送货|安装|谁|哪里/u.test(normalized);
  const relation = /\b(?:use[sd]?|using|contain(?:s|ed)?|include(?:s|d)?|have|has|had|chosen|select(?:ed)?|order(?:ed)?|deliver(?:ed)?|installed)\b|用过|用了|使用|用|有|选用|选择|包含|配置|消耗|送达|还没送货|未送货|待送货|安装了|已安装|还没安装|未安装|待安装|装了/u.test(normalized);
  return subject && relation;
}

export function isInventoryStockIntent(message: string) {
  const normalized = message.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  return /\b(?:inventory|stock|available|availability|on\s+hand|in\s+stock|how\s+many\s+(?:are\s+)?left)\b|库存|存货|可用|现货|在手|剩余/u.test(normalized);
}

export function inventoryUsageRequestsCustomers(message: string) {
  const normalized = message.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  if (/\b(?:customers?|clients?)\b|客户/u.test(normalized)) return true;
  if (!/\bwho\b|谁/u.test(normalized) || inventoryUsageRequestsAssignee(normalized)) return false;
  return /\b(?:use[sd]?|using|order(?:ed)?|receive[sd]?|have|has|had)\b|用过|用了|使用|订购|收到|有/u.test(normalized);
}

export function inventoryUsageRequestsAssignee(message: string) {
  const normalized = message.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  if (/\b(?:customers?|clients?)\b|客户/u.test(normalized)) return false;
  return /\b(?:installer|driver|technician)\b.{0,24}\b(?:installed|delivered)\b|\bwho\s+(?:installed|delivered)\b|安装人|安装员|送货人|司机|谁(?:安装了|送货|送达)/u.test(normalized);
}

export function inventoryUsageRequestsOrders(message: string) {
  return /\b(?:orders?|deliver(?:y|ies|ed)?)\b|订单|送货|送达/iu.test(message);
}

export function inventoryUsageRequestsProjects(message: string) {
  return /\b(?:projects?|jobs?|install(?:ation|ations|ed)?)\b|项目|安装/iu.test(message);
}

export function inventoryUsageRequestsCancelled(message: string) {
  return /\b(?:cancelled|canceled)\b|取消/iu.test(message);
}

export function inventoryUsageIsPast(message: string) {
  if (inventoryUsageRequestsPending(message)) return false;
  return /\b(?:used|delivered|installed|have\s+used|has\s+used)\b|用过|用了|已使用|送达|已送达|送货了|安装了|已安装|装了/iu.test(message);
}

export function inventoryUsageRequestsPending(message: string) {
  const normalized = message.trim().normalize("NFKC").toLocaleLowerCase("en-AU");
  return /\b(?:not|never|haven[’']t|hasn[’']t|not\s+yet|awaiting|pending)\b.{0,30}\b(?:deliver(?:ed)?|install(?:ed)?)\b|\b(?:deliver(?:ed)?|install(?:ed)?)\b.{0,30}\b(?:pending|not\s+yet)\b|未送达|还没送货|未送货|待送货|未安装|还没安装|待安装/u.test(normalized);
}

export function hasInventoryUsageReference(message: string) {
  return inventorySkuCandidates(message).length > 0
    || /\b(?:it|them|that|those|this|these)\b|它|它们|这个|这些|该/u.test(message);
}

/**
 * Resolve pronoun-only SKU usage follow-ups from the latest user message that
 * names exactly one identifier. Assistant text is never treated as evidence.
 */
export function resolveInventoryUsageMessage(
  message: string,
  history: readonly AgentConversationContext[],
) {
  if (!isInventoryUsageIntent(message) || inventorySkuCandidates(message).length) return message;
  if (!hasInventoryUsageReference(message)) return message;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role !== "user") continue;
    const candidates = inventorySkuCandidates(item.content);
    if (candidates.length === 1) return `${message} ${candidates[0]}`;
    // Pronouns only inherit from the immediately preceding user turn. Do not
    // reach past an unrelated or ambiguous user request to a stale SKU.
    return message;
  }
  return message;
}

function exactSkuInValue(value: string, target: string) {
  if (normalizedInventorySku(value) === target) return true;
  return inventorySkuCandidates(value).some((candidate) => normalizedInventorySku(candidate) === target);
}

function clean(value: unknown, maximum = 240) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function uniqueOrderRows(orders: readonly Order[], deliveryHistory: readonly Order[]) {
  const rows = new Map<string, Order>();
  // Current order state is authoritative when the source also repeats the
  // same line in historical delivery records.
  for (const order of [...deliveryHistory, ...orders]) {
    const id = Number(order.id);
    const key = Number.isSafeInteger(id) && id > 0
      ? `id:${id}`
      : [order.order_group, order.created_at, order.customer, order.sku, order.quantity, order.status].join(":");
    rows.set(key, order);
  }
  return [...rows.values()];
}

function orderTimestamp(order: InventoryUsageOrder) {
  return order.deliveredAt || order.plannedDate || "";
}

function projectTimestamp(project: InventoryUsageProject) {
  return project.installedAt || "";
}

export function buildInventoryUsageSnapshot(input: {
  sku: string;
  orders: readonly Order[];
  deliveryHistory: readonly Order[];
  projects: readonly PaymentTrackProject[];
  includeCustomerNames: boolean;
  includeAssignees: boolean;
  includeCancelled: boolean;
  limit: number;
}): InventoryUsageSnapshot {
  const target = normalizedInventorySku(input.sku);
  const orderViews: InventoryUsageOrder[] = [];
  const grouped = groupOrders(uniqueOrderRows(input.orders, input.deliveryHistory));
  let displaySku = input.sku.trim();
  for (const group of grouped) {
    const matchingRows = group.orders.filter((order) => exactSkuInValue(clean(order.sku), target));
    if (!matchingRows.length) continue;
    displaySku ||= clean(matchingRows[0]?.sku);
    const primary = matchingRows[0] || group.primary;
    const orderIds = group.orders
      .map((order) => Number(order.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    orderViews.push({
      orderIds: [...new Set(orderIds)].sort((a, b) => a - b),
      status: clean(primary.status, 30),
      quantity: matchingRows.reduce((sum, order) => sum + Math.max(0, Number(order.quantity) || 0), 0),
      plannedDate: clean(primary.planned_date, 40) || null,
      deliveredAt: clean(primary.delivered_at, 40) || null,
      ...(input.includeCustomerNames ? { customer: clean(primary.customer, 200) || "Unnamed customer" } : {}),
      ...(input.includeAssignees ? { assignee: clean(primary.driver, 160) || "Unassigned" } : {}),
    });
  }

  const installedProjects: InventoryUsageProject[] = [];
  const projectCommitments: InventoryUsageProject[] = [];
  for (const project of input.projects) {
    const selected = project.deliverySelections.filter((item) => exactSkuInValue(item.sku, target));
    const quoted = project.items.filter((item) => (
      exactSkuInValue(item.model, target) || exactSkuInValue(item.description, target)
    ));
    // Once warehouse selections exist they are the actual material choice;
    // quoted items are only a fallback for older projects without selections.
    const matched = project.deliverySelections.length ? selected : quoted;
    if (!matched.length) continue;
    const candidateSku = selected[0]?.sku || quoted[0]?.model;
    if (!displaySku && candidateSku) displaySku = candidateSku;
    const view: InventoryUsageProject = {
      proposal: clean(project.quoteNumber || project.reference, 100),
      status: clean(project.stage, 40),
      quantity: matched.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0),
      installedAt: clean(project.installedAt, 40) || null,
      ...(input.includeCustomerNames ? {
        customer: clean([project.customer.firstName, project.customer.lastName].filter(Boolean).join(" "), 200)
          || "Unnamed customer",
      } : {}),
      ...(input.includeAssignees ? { assignee: clean(project.installationAssignee, 160) || "Unassigned" } : {}),
    };
    if (project.installedAt) installedProjects.push(view);
    else projectCommitments.push(view);
  }

  const byNewestOrder = (a: InventoryUsageOrder, b: InventoryUsageOrder) => orderTimestamp(b).localeCompare(orderTimestamp(a));
  const deliveredOrders = orderViews
    .filter((order) => order.status !== "cancelled" && (order.status === "delivered" || Boolean(order.deliveredAt)))
    .sort(byNewestOrder);
  const cancelledOrders = input.includeCancelled
    ? orderViews.filter((order) => order.status === "cancelled").sort(byNewestOrder)
    : [];
  const activeOrders = orderViews
    .filter((order) => order.status !== "cancelled" && order.status !== "delivered" && !order.deliveredAt)
    .sort(byNewestOrder);
  const byNewestProject = (a: InventoryUsageProject, b: InventoryUsageProject) => projectTimestamp(b).localeCompare(projectTimestamp(a));
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit)));
  return {
    sku: displaySku || input.sku.trim(),
    totals: {
      deliveredOrders: deliveredOrders.length,
      activeOrders: activeOrders.length,
      cancelledOrders: cancelledOrders.length,
      installedProjects: installedProjects.length,
      projectCommitments: projectCommitments.length,
    },
    deliveredOrders: deliveredOrders.slice(0, limit),
    activeOrders: activeOrders.slice(0, limit),
    cancelledOrders: cancelledOrders.slice(0, limit),
    installedProjects: installedProjects.sort(byNewestProject).slice(0, limit),
    projectCommitments: projectCommitments.sort(byNewestProject).slice(0, limit),
  };
}

function displayDate(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

const MELBOURNE_DATE = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function displayMelbourneDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return displayDate(value);
  const parts = Object.fromEntries(MELBOURNE_DATE.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function countWithShown(total: number, shown: number, chinese: boolean) {
  if (total <= shown) return `${total}`;
  return chinese ? `${total}（显示前 ${shown} 条）` : `${total} (showing ${shown})`;
}

/**
 * Render a deliberately narrow lineage answer. It never receives contact,
 * address, note, assignee or payment fields, so those cannot leak through a
 * generic Project Track or legacy order projection.
 */
export function formatInventoryUsageAnswer(
  snapshot: InventoryUsageAnswerSnapshot,
  message: string,
) {
  const chinese = /[\u3400-\u9fff]/u.test(message);
  const wantsCustomers = inventoryUsageRequestsCustomers(message);
  const wantsOrders = inventoryUsageRequestsOrders(message);
  const wantsProjects = inventoryUsageRequestsProjects(message);
  const pastUsage = inventoryUsageIsPast(message);
  const pendingOnly = inventoryUsageRequestsPending(message);
  const showOrders = wantsCustomers || wantsOrders || !wantsProjects;
  const showProjects = wantsCustomers || wantsProjects || !wantsOrders;
  const sections: string[] = [];

  if (showOrders) {
    if (!snapshot.inventoryOrdersAvailable) {
      sections.push(chinese
        ? "Inventory 已送达订单：暂时无法读取"
        : "Inventory delivered orders: temporarily unavailable");
    } else {
      const delivered = snapshot.deliveredOrders.map((order) => {
        const reference = order.orderIds.length
          ? order.orderIds.map((id) => `#${id}`).join("/")
          : chinese ? "订单" : "Order";
        const customer = order.customer ? ` · ${order.customer}` : "";
        const assignee = order.assignee ? ` · ${chinese ? "送货人" : "Driver"}: ${order.assignee}` : "";
        return `- **${reference}**${customer}${assignee} · ${order.quantity} × ${snapshot.sku} · ${displayDate(order.deliveredAt)}`;
      }).join("\n");
      const deliveredCount = countWithShown(snapshot.totals.deliveredOrders, snapshot.deliveredOrders.length, chinese);
      if (!pendingOnly) {
        sections.push(chinese
          ? `Inventory 已送达订单：**${deliveredCount}** 条${delivered ? `\n${delivered}` : ""}`
          : `Inventory delivered orders: **${deliveredCount}**${delivered ? `\n${delivered}` : ""}`);
      }

      if (wantsOrders && (!pastUsage || pendingOnly)) {
        const active = snapshot.activeOrders.map((order) => {
          const reference = order.orderIds.length ? order.orderIds.map((id) => `#${id}`).join("/") : "Order";
          const customer = order.customer ? ` · ${order.customer}` : "";
          const assignee = order.assignee ? ` · ${chinese ? "送货人" : "Driver"}: ${order.assignee}` : "";
          return `- **${reference}**${customer}${assignee} · ${order.quantity} × ${snapshot.sku} · ${order.status} · ${displayDate(order.plannedDate)}`;
        }).join("\n");
        const activeCount = countWithShown(snapshot.totals.activeOrders, snapshot.activeOrders.length, chinese);
        sections.push(chinese
          ? `待处理/已排期订单：**${activeCount}** 条${active ? `\n${active}` : ""}`
          : `Pending or scheduled orders: **${activeCount}**${active ? `\n${active}` : ""}`);
      }
      if (snapshot.cancelledOrders.length) {
        const cancelled = snapshot.cancelledOrders.map((order) => {
          const reference = order.orderIds.length ? order.orderIds.map((id) => `#${id}`).join("/") : "Order";
          return `- **${reference}** · ${order.quantity} × ${snapshot.sku}`;
        }).join("\n");
        sections.push(chinese ? `已取消（不计入使用）：\n${cancelled}` : `Cancelled (not counted as used):\n${cancelled}`);
      }
    }
  }

  if (showProjects) {
    if (!snapshot.projectTrackAvailable) {
      sections.push(chinese
        ? "Project Track 已安装项目：暂时无法读取"
        : "Project Track installed projects: temporarily unavailable");
    } else {
      const installed = snapshot.installedProjects.map((project) => {
        const customer = project.customer ? ` · ${project.customer}` : "";
        const assignee = project.assignee ? ` · ${chinese ? "安装人" : "Installer"}: ${project.assignee}` : "";
        return `- **${project.proposal || "Project"}**${customer}${assignee} · ${project.quantity} × ${snapshot.sku} · ${displayMelbourneDate(project.installedAt)}`;
      }).join("\n");
      const installedCount = countWithShown(snapshot.totals.installedProjects, snapshot.installedProjects.length, chinese);
      if (!pendingOnly) {
        sections.push(chinese
          ? `Project Track 已安装项目：**${installedCount}** 个${installed ? `\n${installed}` : ""}`
          : `Project Track installed projects: **${installedCount}**${installed ? `\n${installed}` : ""}`);
      }
      if (wantsProjects && (!pastUsage || pendingOnly)) {
        const commitments = snapshot.projectCommitments.map((project) => {
          const customer = project.customer ? ` · ${project.customer}` : "";
          const assignee = project.assignee ? ` · ${chinese ? "安装人" : "Installer"}: ${project.assignee}` : "";
          return `- **${project.proposal || "Project"}**${customer}${assignee} · ${project.quantity} × ${snapshot.sku} · ${project.status}`;
        }).join("\n");
        const commitmentCount = countWithShown(snapshot.totals.projectCommitments, snapshot.projectCommitments.length, chinese);
        sections.push(chinese
          ? `尚未安装的项目：**${commitmentCount}** 个${commitments ? `\n${commitments}` : ""}`
          : `Projects not yet installed: **${commitmentCount}**${commitments ? `\n${commitments}` : ""}`);
      }
    }
  }

  const separation = chinese
    ? "Inventory 订单与 Project Track 没有可靠的一对一外键，因此分开显示，不合并计数。"
    : "Inventory orders and Project Track do not share a reliable one-to-one key, so their counts are shown separately and are not added together.";
  return `${sections.join("\n\n")}\n\n${separation}`;
}
