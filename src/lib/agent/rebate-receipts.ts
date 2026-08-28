import type { AgentAnswer } from "../erp/types";
import type { PaymentTrackProject } from "../payment-track/types";

type RebateReceiptKind = "solar_stc" | "battery_stc" | "solar_rebate";

type RebateReceiptProject = Pick<
  PaymentTrackProject,
  | "id"
  | "reference"
  | "quoteNumber"
  | "customer"
  | "stcSolarRequired"
  | "stcBatteryRequired"
  | "solarRebateRequired"
  | "stcSolarReceivedAt"
  | "stcBatteryReceivedAt"
  | "solarRebateReceivedAt"
  | "stcSolarReceivedAmountCents"
  | "stcBatteryReceivedAmountCents"
  | "solarRebateReceivedAmountCents"
>;

type RebateReceiptAmountIntent = {
  kinds: RebateReceiptKind[];
  hasExplicitProjectIdentifier: boolean;
};

const RECEIPT_LABELS: Record<RebateReceiptKind, { en: string; zh: string }> = {
  solar_stc: { en: "Solar STC", zh: "Solar STC" },
  battery_stc: { en: "Battery STC", zh: "Battery STC" },
  solar_rebate: { en: "Solar Rebate", zh: "Solar Rebate" },
};

const PROJECT_IDENTIFIER = /\b(?:pay[-_][a-z0-9_-]*\d|cpec[-_]?\d+|q(?:n|tn)[a-z0-9_-]*\d)\b/iu;

function normalized(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-AU");
}

function parseRebateReceiptAmountIntent(rawMessage: string): RebateReceiptAmountIntent | null {
  const message = normalized(rawMessage);
  const amountIntent = /\bhow\s+much\b|\b(?:amount|total|value)\b|多少钱|多少(?:钱)?|金额|总额|合计/iu.test(message);
  const receivedIntent = /\b(?:received?|receipt|paid|payment|collected|funding)\b|收了|收到|已收|实收|到账|入账|收款/iu.test(message);
  if (!amountIntent || !receivedIntent) return null;
  // A project may be described as a Solar Rebate project while the user is
  // asking about the customer's deposit or final payment. Keep those queries
  // on the customer-payment path even when the project label mentions rebate.
  if (/\b(?:deposit|delivery\s+collection|final\s+payment|customer\s+payments?|client\s+payments?|outstanding)\b|定金|尾款|客户.{0,3}(?:付款|支付|货款)/iu.test(message)) {
    return null;
  }

  const kinds: RebateReceiptKind[] = [];
  const solarStc = /\bsolar[\s_-]*stc\b|(?:太阳能|光伏)[\s_-]*stc/iu.test(message);
  const batteryStc = /\bbattery[\s_-]*stc\b|电池[\s_-]*stc/iu.test(message);
  const solarRebate = /\b(?:solar[\s_-]*(?:vic[\s_-]*)?rebate|vic[\s_-]*solar[\s_-]*rebate|solarvic(?:'s)?[\s_-]*(?:solar[\s_-]*pv[\s_-]*)?rebate)\b|(?:太阳能|光伏|solar\s*vic|vic\s*solar).{0,8}(?:补贴|返利)/iu.test(message);

  if (solarStc) kinds.push("solar_stc");
  if (batteryStc) kinds.push("battery_stc");
  if (solarRebate) kinds.push("solar_rebate");

  // Generic STC means both certificate streams. Generic rebate wording means
  // Solar Rebate. Together, "STC Rebate" intentionally covers all three
  // third-party funding receipts in the Project Track stage.
  if (!solarStc && !batteryStc && /\bstc\b/iu.test(message)) {
    kinds.push("solar_stc", "battery_stc");
  }
  if (!solarRebate && /\brebates?\b|补贴|返利/iu.test(message)) {
    kinds.push("solar_rebate");
  }

  const uniqueKinds = [...new Set(kinds)];
  if (!uniqueKinds.length) return null;
  return {
    kinds: uniqueKinds,
    hasExplicitProjectIdentifier: PROJECT_IDENTIFIER.test(message),
  };
}

export function isRebateReceiptAmountIntent(rawMessage: string) {
  return parseRebateReceiptAmountIntent(rawMessage) !== null;
}

function receiptState(project: RebateReceiptProject, kind: RebateReceiptKind) {
  if (kind === "solar_stc") {
    return {
      required: project.stcSolarRequired,
      receivedAt: project.stcSolarReceivedAt,
      amountCents: project.stcSolarReceivedAmountCents ?? null,
    };
  }
  if (kind === "battery_stc") {
    return {
      required: project.stcBatteryRequired,
      receivedAt: project.stcBatteryReceivedAt,
      amountCents: project.stcBatteryReceivedAmountCents ?? null,
    };
  }
  return {
    required: project.solarRebateRequired,
    receivedAt: project.solarRebateReceivedAt,
    amountCents: project.solarRebateReceivedAmountCents ?? null,
  };
}

function aud(cents: number) {
  return `AUD ${new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)}`;
}

function melbourneDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function projectName(project: RebateReceiptProject) {
  return `${project.customer.firstName} ${project.customer.lastName}`.trim() || "Unnamed customer";
}

function specificallyMentionedProjects(
  projects: readonly RebateReceiptProject[],
  rawMessage: string,
) {
  const message = normalized(rawMessage);
  return projects.filter((project) => [
    project.reference,
    project.quoteNumber,
    projectName(project),
  ].some((value) => {
    const candidate = normalized(value);
    return candidate.length >= 3 && message.includes(candidate);
  }));
}

function suggestions(isChinese: boolean) {
  return isChinese
    ? ["查看待确认的 STC/Rebate 收款", "显示客户未收尾款"]
    : ["Show pending STC/Rebate receipts", "Show customer outstanding balances"];
}

function specificProjectAnswer(
  projects: readonly RebateReceiptProject[],
  kinds: readonly RebateReceiptKind[],
  isChinese: boolean,
): AgentAnswer {
  const sections = projects.map((project) => {
    const lines = kinds.map((kind) => {
      const state = receiptState(project, kind);
      const label = RECEIPT_LABELS[kind][isChinese ? "zh" : "en"];
      if (state.receivedAt) {
        const date = melbourneDate(state.receivedAt);
        if (typeof state.amountCents === "number") {
          return `- ${label}: **${aud(state.amountCents)}** · ${isChinese ? `到账于 ${date}` : `received ${date}`}`;
        }
        return `- ${label}: ${isChinese ? `已到账（${date}），但未记录金额` : `received ${date}; amount not recorded`}`;
      }
      if (state.required) return `- ${label}: ${isChinese ? "待确认到账" : "awaiting receipt confirmation"}`;
      return `- ${label}: ${isChinese ? "不适用" : "not applicable"}`;
    });
    return `**${project.reference} · ${project.quoteNumber} · ${projectName(project)}**\n${lines.join("\n")}`;
  });
  const separation = isChinese
    ? "以上是第三方补贴资金，与客户付款分开记录，不会减少客户未收尾款。"
    : "These are third-party funding receipts. They are recorded separately from customer payments and do not reduce customer outstanding balances.";
  return {
    mode: "local",
    answer: `${sections.join("\n\n")}\n\n${separation}`,
    suggestions: suggestions(isChinese),
  };
}

function aggregateAnswer(
  projects: readonly RebateReceiptProject[],
  kinds: readonly RebateReceiptKind[],
  isChinese: boolean,
): AgentAnswer {
  let grandTotalCents = 0;
  let recordedCount = 0;
  let missingAmountCount = 0;
  let pendingCount = 0;
  const lines = kinds.map((kind) => {
    let totalCents = 0;
    let count = 0;
    for (const project of projects) {
      const state = receiptState(project, kind);
      if (!state.receivedAt) {
        if (state.required) pendingCount += 1;
        continue;
      }
      if (typeof state.amountCents !== "number") {
        missingAmountCount += 1;
        continue;
      }
      totalCents += state.amountCents;
      count += 1;
    }
    grandTotalCents += totalCents;
    recordedCount += count;
    const label = RECEIPT_LABELS[kind][isChinese ? "zh" : "en"];
    return isChinese
      ? `- ${label}: **${aud(totalCents)}**（${count} 笔已记录金额）`
      : `- ${label}: **${aud(totalCents)}** across ${count} receipt${count === 1 ? "" : "s"} with recorded amounts`;
  });

  const heading = isChinese
    ? `已记录金额的第三方补贴收款合计为 **${aud(grandTotalCents)}**，共 **${recordedCount} 笔**：`
    : `Recorded third-party funding receipts total **${aud(grandTotalCents)}** across **${recordedCount} receipt${recordedCount === 1 ? "" : "s"}**:`;
  const caveats = [
    missingAmountCount
      ? isChinese
        ? `另有 ${missingAmountCount} 笔已确认到账，但历史记录没有金额，因此未计入合计。`
        : `${missingAmountCount} received receipt${missingAmountCount === 1 ? " has" : "s have"} no recorded amount and ${missingAmountCount === 1 ? "is" : "are"} excluded from the total.`
      : "",
    pendingCount
      ? isChinese
        ? `另有 ${pendingCount} 笔要求的补贴收款仍待确认。`
        : `${pendingCount} required receipt${pendingCount === 1 ? " is" : "s are"} still awaiting confirmation.`
      : "",
    isChinese
      ? "这些金额是第三方补贴资金，与客户付款分开统计，不会减少客户未收尾款。"
      : "These amounts are third-party funding. They are separate from customer payments and do not reduce customer outstanding balances.",
  ].filter(Boolean).join(" ");

  return {
    mode: "local",
    answer: `${heading}\n\n${lines.join("\n")}\n\n${caveats}`,
    suggestions: suggestions(isChinese),
  };
}

export function formatRebateReceiptAmountAnswer(
  rawMessage: string,
  projects: readonly RebateReceiptProject[],
): AgentAnswer | null {
  const intent = parseRebateReceiptAmountIntent(rawMessage);
  if (!intent) return null;
  const isChinese = /[\u3400-\u9fff]/u.test(rawMessage);
  const mentioned = specificallyMentionedProjects(projects, rawMessage);
  if (mentioned.length) return specificProjectAnswer(mentioned, intent.kinds, isChinese);
  if (intent.hasExplicitProjectIdentifier) {
    return {
      mode: "local",
      answer: isChinese
        ? "Project Track 中没有找到这个项目，因此没有汇总其他项目的补贴收款金额。"
        : "That project was not found in Project Track, so no other projects were included in the rebate receipt total.",
      suggestions: suggestions(isChinese),
    };
  }
  return aggregateAnswer(projects, intent.kinds, isChinese);
}
