export type WeeklyWorkCounts = {
  total: number;
  completed: number;
  scheduled: number;
  pending: number;
  cancelled: number;
};

export type WeeklyBusinessSummarySnapshot = {
  from: string;
  to: string;
  work: {
    delivery: WeeklyWorkCounts;
    installation: WeeklyWorkCounts;
    combined: WeeklyWorkCounts;
    siteVisits: WeeklyWorkCounts;
  } | null;
  inventory: {
    itemCount: number;
    onHand: number;
    available: number;
    attentionItems: Array<{ sku: string; available: number }>;
  } | null;
  payments: {
    confirmedCount: number;
    confirmedAmountCents: number;
    confirmedWithoutAmount: number;
    outstandingProjectCount: number;
    outstandingAmountCents: number;
  } | "restricted" | null;
  scheduleWarningCount: number;
};

type PaymentReceiptLike = {
  confirmedAt: string | null;
  confirmedAmountCents: number | null;
};

export type WeeklyPaymentProjectLike = {
  outstandingCents: number;
  deposit: PaymentReceiptLike;
  collection: PaymentReceiptLike;
  finalPayments: PaymentReceiptLike[];
};

const MELBOURNE_TIME_ZONE = "Australia/Melbourne";
const DAY_MS = 24 * 60 * 60 * 1_000;

function exactDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDateDays(value: string, days: number) {
  if (!exactDate(value)) throw new Error("Invalid date.");
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function melbourneDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

/** Monday-to-Sunday business week in Australia/Melbourne. */
export function melbourneBusinessWeek(now = new Date()) {
  const today = melbourneDate(now);
  if (!today) throw new Error("Invalid business date.");
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const from = addDateDays(today, -daysFromMonday);
  return { from, to: addDateDays(from, 6) };
}

export function summarizeConfirmedPayments(
  projects: readonly WeeklyPaymentProjectLike[],
  from: string,
  to: string,
) {
  const receipts = projects.flatMap((project) => [project.deposit, project.collection, ...project.finalPayments]);
  let confirmedCount = 0;
  let confirmedAmountCents = 0;
  let confirmedWithoutAmount = 0;
  for (const receipt of receipts) {
    const date = receipt.confirmedAt ? melbourneDate(receipt.confirmedAt) : null;
    if (!date || date < from || date > to) continue;
    confirmedCount += 1;
    if (Number.isSafeInteger(receipt.confirmedAmountCents) && (receipt.confirmedAmountCents || 0) >= 0) {
      confirmedAmountCents += receipt.confirmedAmountCents || 0;
    } else {
      confirmedWithoutAmount += 1;
    }
  }
  const outstanding = projects.filter((project) => Number.isSafeInteger(project.outstandingCents) && project.outstandingCents > 0);
  return {
    confirmedCount,
    confirmedAmountCents,
    confirmedWithoutAmount,
    outstandingProjectCount: outstanding.length,
    outstandingAmountCents: outstanding.reduce((sum, project) => sum + project.outstandingCents, 0),
  };
}

function money(cents: number) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

function workRow(label: string, counts: WeeklyWorkCounts) {
  return `| ${label} | ${counts.total} | ${counts.completed} | ${counts.scheduled} | ${counts.pending} |`;
}

function unavailableRow(label: string) {
  return `| ${label} | Unavailable | — | — | — |`;
}

export function formatWeeklyBusinessSummary(snapshot: WeeklyBusinessSummarySnapshot, language: "english" | "chinese") {
  const chinese = language === "chinese";
  const heading = chinese
    ? `## 本周业务汇总（${snapshot.from} 至 ${snapshot.to}）`
    : `## This week summary (${snapshot.from} to ${snapshot.to})`;
  const scheduleHeading = chinese ? "### 送货、安装与 Site Visiting" : "### Delivery, installation and Site Visiting";
  const scheduleHeader = chinese
    ? "| 工作类型 | 总数 | 已完成 | 已排期 | 待排期 |\n|---|---:|---:|---:|---:|"
    : "| Work type | Total | Completed | Scheduled | Pending |\n|---|---:|---:|---:|---:|";
  const rows = snapshot.work ? [
    workRow(chinese ? "送货" : "Delivery", snapshot.work.delivery),
    workRow(chinese ? "安装" : "Installation", snapshot.work.installation),
    workRow(chinese ? "送货并安装" : "Delivery & installation", snapshot.work.combined),
    workRow("Site Visiting", snapshot.work.siteVisits),
  ] : [unavailableRow(chinese ? "排期数据" : "Schedule data")];
  const scheduleNote = chinese
    ? "送货并安装只计算一次；待排期包含未排期和预排期。"
    : "Combined delivery and installation is counted once; pending includes unscheduled and pre-scheduled work.";

  const inventoryHeading = chinese ? "### 库存（当前快照）" : "### Inventory (current snapshot)";
  const inventoryText = snapshot.inventory
    ? chinese
      ? `库存共有 **${snapshot.inventory.itemCount}** 个 SKU，在手 **${snapshot.inventory.onHand.toLocaleString("en-AU")}**，可用 **${snapshot.inventory.available.toLocaleString("en-AU")}**；**${snapshot.inventory.attentionItems.length}** 项需要关注。${snapshot.inventory.attentionItems.length ? `\n\n${snapshot.inventory.attentionItems.slice(0, 8).map((item) => `- **${item.sku}**：可用 ${item.available.toLocaleString("en-AU")}`).join("\n")}` : ""}`
      : `Inventory has **${snapshot.inventory.itemCount} SKUs**, **${snapshot.inventory.onHand.toLocaleString("en-AU")} on hand** and **${snapshot.inventory.available.toLocaleString("en-AU")} available**; **${snapshot.inventory.attentionItems.length}** items need attention.${snapshot.inventory.attentionItems.length ? `\n\n${snapshot.inventory.attentionItems.slice(0, 8).map((item) => `- **${item.sku}**: ${item.available.toLocaleString("en-AU")} available`).join("\n")}` : ""}`
    : chinese ? "库存数据暂时无法核实。" : "Inventory data is currently unavailable.";

  const paymentsHeading = chinese ? "### 收款状况" : "### Payment collection";
  let paymentsText: string;
  if (snapshot.payments === "restricted") {
    paymentsText = chinese
      ? "收款金额仅限管理员查看；本次汇总未读取财务数据。"
      : "Payment amounts are restricted to administrators; this summary did not read finance data.";
  } else if (!snapshot.payments) {
    paymentsText = chinese ? "收款数据暂时无法核实。" : "Payment data is currently unavailable.";
  } else {
    const missing = snapshot.payments.confirmedWithoutAmount
      ? chinese
        ? ` 另有 ${snapshot.payments.confirmedWithoutAmount} 条已确认记录没有确认金额，因此未计入总额。`
        : ` ${snapshot.payments.confirmedWithoutAmount} confirmed record(s) had no confirmed amount and were excluded from the total.`
      : "";
    paymentsText = chinese
      ? `- 本周已确认收款：**${snapshot.payments.confirmedCount} 笔 · ${money(snapshot.payments.confirmedAmountCents)}**。${missing}\n- 当前未收款快照：**${snapshot.payments.outstandingProjectCount} 个项目 · ${money(snapshot.payments.outstandingAmountCents)}**。`
      : `- Confirmed this week: **${snapshot.payments.confirmedCount} payments · ${money(snapshot.payments.confirmedAmountCents)}**.${missing}\n- Outstanding now: **${snapshot.payments.outstandingProjectCount} projects · ${money(snapshot.payments.outstandingAmountCents)}**.`;
  }

  const warning = snapshot.scheduleWarningCount
    ? `\n\n> ${chinese ? `${snapshot.scheduleWarningCount} 个排期数据源暂时不可用；表格只包含已核实数据。` : `${snapshot.scheduleWarningCount} schedule source(s) were unavailable; the table includes verified data only.`}`
    : "";
  return [
    heading,
    scheduleHeading,
    `${scheduleHeader}\n${rows.join("\n")}`,
    scheduleNote,
    inventoryHeading,
    inventoryText,
    paymentsHeading,
    paymentsText,
  ].join("\n\n") + warning;
}
