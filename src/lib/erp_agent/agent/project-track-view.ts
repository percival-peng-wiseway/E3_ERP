import type {
  PaymentTrackProject,
  PaymentTrackScheduleRequest,
  PaymentTrackWorkMode,
} from "@/lib/payment-track/types";
// @ts-expect-error -- Node's strip-types test runner requires the explicit extension.
import { isPaymentTrackWaitingForRebateQr } from "../../payment-track/types.ts";

export type AgentScheduleState =
  | "not_started"
  | "waiting_for_rebate_qr_code"
  | "unscheduled"
  | "pre_scheduled"
  | "scheduled"
  | "delivered"
  | "installed";

export type AgentProjectWorkflowFilter =
  | "waiting_for_rebate_qr_code"
  | "unscheduled"
  | "pre_scheduled"
  | "scheduled"
  | "delivered"
  | "installed";

export type AgentProjectPrivacyFlags = {
  includeAssignee: boolean;
  includeLocation: boolean;
  includeCustomerContactDetails: boolean;
  includePmNotes: boolean;
};

function hasDeliverySchedule(project: PaymentTrackProject) {
  return Boolean(
    project.deliveryScheduledFor
    && project.deliveryScheduledTime
    && project.deliveryAssignee,
  );
}

function hasInstallationSchedule(project: PaymentTrackProject) {
  return Boolean(
    project.installationScheduledFor
    && project.installationScheduledTime
    && project.installationAssignee,
  );
}

function hasCombinedSchedule(project: PaymentTrackProject) {
  return hasDeliverySchedule(project)
    && hasInstallationSchedule(project)
    && project.deliveryScheduledFor === project.installationScheduledFor
    && project.deliveryScheduledTime === project.installationScheduledTime;
}

function deliveryIsCurrent(project: PaymentTrackProject) {
  return (project.stage === "working_in_progress"
      && (project.workMode === "delivery_only" || project.workMode === "delivery_and_installation"))
    || project.stage === "material_delivery";
}

function installationIsCurrent(project: PaymentTrackProject) {
  return (project.stage === "working_in_progress"
      && (project.workMode === "installation_only" || project.workMode === "delivery_and_installation"))
    || project.stage === "installing";
}

export function agentDeliveryScheduleState(project: PaymentTrackProject): AgentScheduleState {
  if (project.deliveredAt) return "delivered";
  if (hasDeliverySchedule(project)) return "scheduled";
  if (project.deliveryScheduleRequest && project.deliverySelections.length) return "pre_scheduled";
  return deliveryIsCurrent(project) ? "unscheduled" : "not_started";
}

export function agentInstallationScheduleState(project: PaymentTrackProject): AgentScheduleState {
  if (project.installedAt) return "installed";
  if (hasInstallationSchedule(project)) return "scheduled";
  if (project.installationScheduleRequest) return "pre_scheduled";
  return installationIsCurrent(project) ? "unscheduled" : "not_started";
}

export function agentProjectWorkflowStatus(project: PaymentTrackProject): string {
  if (project.stage === "working_in_progress") {
    if (project.installedAt) return "installed";
    if (project.deliveredAt) return "delivered";
    const scheduled = project.workMode === "delivery_only"
      ? hasDeliverySchedule(project)
      : project.workMode === "installation_only"
        ? hasInstallationSchedule(project)
        : project.workMode === "delivery_and_installation" && hasCombinedSchedule(project);
    if (scheduled) return "scheduled";
    return isPaymentTrackWaitingForRebateQr(project)
      ? "waiting_for_rebate_qr_code"
      : "unscheduled";
  }
  if (project.stage === "material_delivery") return agentDeliveryScheduleState(project);
  if (project.stage === "installing") return agentInstallationScheduleState(project);
  return project.stage;
}

export function agentProjectMatchesWorkflowFilter(
  project: PaymentTrackProject,
  status: AgentProjectWorkflowFilter | null,
) {
  if (!status) return true;
  // Completion remains a searchable fact after the state machine advances
  // from WIP to Waiting COES, STC Rebate or Done.
  if (status === "delivered") return Boolean(project.deliveredAt);
  if (status === "installed") return Boolean(project.installedAt);
  return agentProjectWorkflowStatus(project) === status;
}

function requestView(
  request: PaymentTrackScheduleRequest | null,
  includeNotes: boolean,
) {
  return request ? {
    preferredDate: request.preferredDate,
    preferredTime: request.preferredTime,
    ...(includeNotes ? { notes: request.notes || null } : {}),
    submittedAt: request.submittedAt,
  } : null;
}

/**
 * Read-only, file-free projection used by the Agent. It deliberately exposes
 * the scheduling facts shown in Project Track while omitting proofs, history
 * and private file URLs.
 */
export function projectTrackAgentView(
  project: PaymentTrackProject,
  privacy: AgentProjectPrivacyFlags,
) {
  // Legacy projects used an uploaded file as the readiness signal. Keep that
  // fact queryable while exposing neither the file nor its private URL.
  const solarRebateQrConfirmedAt = project.solarRebateQrConfirmedAt
    || project.solarRebateQrCode?.uploadedAt
    || null;
  const solarRebateQrConfirmedBy = project.solarRebateQrConfirmedAt
    ? project.solarRebateQrConfirmedBy || null
    : project.solarRebateQrCode?.uploadedByRole || null;
  return {
    reference: project.reference,
    proposalNumber: project.quoteNumber,
    stage: project.stage,
    workflowStatus: agentProjectWorkflowStatus(project),
    workMode: project.workMode,
    customer: {
      name: `${project.customer.firstName} ${project.customer.lastName}`.trim(),
      ...(privacy.includeCustomerContactDetails ? {
        phone: project.customer.phone,
        email: project.customer.email,
      } : {}),
      ...(privacy.includeLocation ? {
        address: [
          project.customer.addressLine1,
          project.customer.suburb,
          project.customer.state,
          project.customer.postcode,
        ].filter(Boolean).join(", "),
      } : {}),
    },
    salesRepresentative: project.specialist.name,
    ...(privacy.includePmNotes ? {
      pmNotes: project.pmNotes || null,
      pmNotesUpdatedAt: project.pmNotesUpdatedAt,
      pmNotesUpdatedBy: project.pmNotesUpdatedBy,
    } : {}),
    currency: project.currency,
    originalBalanceDue: project.balanceDueCents / 100,
    amountDue: project.outstandingCents / 100,
    overpayment: project.overpaymentCents / 100,
    expectedDeposit: project.expectedDepositCents === null
      ? null
      : project.expectedDepositCents / 100,
    confirmedPayments: [
      { type: "deposit", receipt: project.deposit },
      { type: "delivery_collection", receipt: project.collection },
      ...project.finalPayments.map((receipt) => ({ type: "later_payment", receipt })),
    ].filter(({ receipt }) => receipt.confirmedAt && receipt.confirmedAmountCents !== null)
      .map(({ type, receipt }) => ({
        type,
        amount: (receipt.confirmedAmountCents || 0) / 100,
        confirmedAt: receipt.confirmedAt,
      })),
    pendingReportedPayments: project.finalPayments
      .filter((receipt) => !receipt.confirmedAt && receipt.reportedAmountCents)
      .map((receipt) => ({
        id: receipt.id,
        reportedAmount: (receipt.reportedAmountCents || 0) / 100,
        reportedAt: receipt.acknowledgedAt,
      })),
    schedule: {
      delivery: {
        status: agentDeliveryScheduleState(project),
        request: requestView(project.deliveryScheduleRequest, privacy.includePmNotes),
        scheduledDate: project.deliveryScheduledFor,
        scheduledTime: project.deliveryScheduledTime,
        ...(privacy.includeAssignee ? { assignee: project.deliveryAssignee } : {}),
        completedAt: project.deliveredAt,
        chosenWarehouseItems: project.deliverySelections.map((item) => ({
          sku: item.sku,
          quantity: item.quantity,
        })),
      },
      installation: {
        status: agentInstallationScheduleState(project),
        request: requestView(project.installationScheduleRequest, privacy.includePmNotes),
        scheduledDate: project.installationScheduledFor,
        scheduledTime: project.installationScheduledTime,
        ...(privacy.includeAssignee ? { assignee: project.installationAssignee } : {}),
        completedAt: project.installedAt,
      },
    },
    coesReceivedAt: project.coesReceivedAt,
    stcSolarRequired: project.stcSolarRequired,
    stcBatteryRequired: project.stcBatteryRequired,
    solarRebateRequired: project.solarRebateRequired,
    solarRebateQrRequired: project.solarRebateQrRequired,
    solarRebateQrConfirmedAt,
    solarRebateQrConfirmedBy,
    stcSolarReceivedAt: project.stcSolarReceivedAt,
    stcBatteryReceivedAt: project.stcBatteryReceivedAt,
    solarRebateReceivedAt: project.solarRebateReceivedAt,
    rebateReceipts: {
      solarStc: {
        required: project.stcSolarRequired,
        receivedAt: project.stcSolarReceivedAt,
        amount: typeof project.stcSolarReceivedAmountCents === "number"
          ? project.stcSolarReceivedAmountCents / 100
          : null,
      },
      batteryStc: {
        required: project.stcBatteryRequired,
        receivedAt: project.stcBatteryReceivedAt,
        amount: typeof project.stcBatteryReceivedAmountCents === "number"
          ? project.stcBatteryReceivedAmountCents / 100
          : null,
      },
      solarRebate: {
        required: project.solarRebateRequired,
        receivedAt: project.solarRebateReceivedAt,
        amount: typeof project.solarRebateReceivedAmountCents === "number"
          ? project.solarRebateReceivedAmountCents / 100
          : null,
      },
    },
    items: project.items.slice(0, 15).map((item) => ({
      category: item.category,
      description: item.description,
      model: item.model,
      quantity: item.quantity,
      capacity: item.capacity,
    })),
    updatedAt: project.updatedAt,
  };
}

export function projectTrackScheduleSearchValues(
  project: PaymentTrackProject,
  includeAssignee: boolean,
): unknown[] {
  return [
    agentProjectWorkflowStatus(project),
    project.workMode,
    project.deliveryScheduledFor,
    project.deliveryScheduledTime,
    ...(includeAssignee ? [project.deliveryAssignee] : []),
    project.deliveredAt,
    project.deliveryScheduleRequest?.preferredDate,
    project.deliveryScheduleRequest?.preferredTime,
    project.installationScheduledFor,
    project.installationScheduledTime,
    ...(includeAssignee ? [project.installationAssignee] : []),
    project.installedAt,
    project.installationScheduleRequest?.preferredDate,
    project.installationScheduleRequest?.preferredTime,
    ...project.deliverySelections.flatMap((item) => [item.sku, item.quantity]),
  ];
}

/**
 * Assignee data is exposed only when the question explicitly asks for the
 * assigned worker. A standalone "who" can mean the customer/project and must
 * not silently widen any privacy scope.
 */
export function agentQueryExplicitlyRequestsAssignee(rawMessage: string) {
  const message = rawMessage.trim().toLocaleLowerCase("en-AU");
  if (/\b(?:assigned|assignee|driver|installer|delivery\s+person|installation\s+person)\b|负责人|送货人|安装人/u.test(message)) {
    return true;
  }
  return /\bwho\b.{0,32}\b(?:driving|delivering|installing|handling)\b/u.test(message)
    || /谁.{0,16}(?:负责|送货|配送|安装)|(?:负责|送货|配送|安装).{0,16}谁/u.test(message);
}

export function agentProjectWorkModeFilter(rawMessage: string): PaymentTrackWorkMode | null {
  const message = rawMessage.trim().toLocaleLowerCase("en-AU");
  if (/\b(?:combined|deliver(?:y)?\s*(?:and|&)\s*install(?:ation|ment|ing)?)\b|送装一体|(?:送货|配送).{0,6}安装|安装.{0,6}(?:送货|配送)/u.test(message)) {
    return "delivery_and_installation";
  }
  if (/\b(?:deliver(?:y)?[\s_-]*only|only[\s_-]*deliver(?:y)?)\b|仅送货|只送货|仅配送|只配送/u.test(message)) {
    return "delivery_only";
  }
  if (/\b(?:install(?:ation|ment)?[\s_-]*only|only[\s_-]*install(?:ation|ment)?)\b|仅安装|只安装/u.test(message)) {
    return "installation_only";
  }
  return null;
}

export function projectTrackAgentSearchTerms(rawMessage: string) {
  return rawMessage.trim().toLocaleLowerCase("en-AU")
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will)\s+you|can\s+i)\s+(?:please\s+)?/gu, "")
    .replace(/^(?:please\s+)?(?:tell\s+me\b|let\s+me\s+(?:see|know)\b)\s*/gu, "")
    .replace(/\bproject\s*track(?:ing)?\b|\bworking\s+in\s+progress\b|\bwaiting\s+coes\b|\bstc\s+rebate\b|\bwaiting[\s_-]*(?:for[\s_-]*)?(?:solar[\s_-]*rebate[\s_-]*)?qr(?:[\s_-]*code)?\b|\bdeposit[\s_-]*(?:not[\s_-]*paid|unpaid)\b|\bpre[\s_-]*scheduled\b/gu, " ")
    .replace(/\b(?:deliver(?:y)?\s*(?:and|&)\s*install(?:ation|ment|ing)?|deliver(?:y)?[\s_-]*only|only[\s_-]*deliver(?:y)?|install(?:ation|ment)?[\s_-]*only|only[\s_-]*install(?:ation|ment)?)\b/gu, " ")
    .replace(/\b(?:show|list|find|search|get|check|checking|give|tell|let|know|see|please|me|what|which|who|when|where|how|many|much|is|are|do|does|did|has|have|there|any|we|us|our|the|all|each|every|and|or|to|for|of|in|on|at|as|by|from|across|about|with|this|current|currently|next|last|week|today|tomorrow|project|projects|jobs?|work|records?|entries|results?|data|information|details?|reports?|counts?|numbers?|customer|customers|status|stage|workflow|overview|summary|payment|payments|receivable|receivables|outstanding|unpaid|amount|balances?|total|remaining|final|due|wip|schedule|scheduled|unscheduled|delivered|installed|completed|done|date|time|assigned|assignee|driver|installer|item|items|sku|material|materials|warehouse|chosen|selected|note|notes|remark|remarks|instruction|instructions|address|location|phone|email|contact|combined|delivery|deliver|installation|installment|install|only)\b/gu, " ")
    .replace(/项目追踪|项目跟踪|项目进度|项目看板|请问|请|麻烦|帮我|给我|查看|显示|列出|查找|检查|看看|看一下|查一下|有没有|有哪些|所有|全部|每个|客户|项目|工作|任务|记录|条目|列表|清单|详情|明细|数据|报告|结果|状态|阶段|进行中|概况|总览|汇总|当前|目前|现在|定金未付|预排期|等待补贴二维码|等待返现二维码|二维码|尾款|总额|合计|总共|多少|有多少|几个|数量|收款|欠款|应收|未排期|已排期|已送达|已送货|已安装|完成|谁|什么时候|哪天|日期|几点|时间|本周|上周|下周|安排|负责人|送货人|安装人|物料|商品|仓库|已选|选择|备注|说明|地址|位置|电话|邮箱|联系方式|送装一体|仅送货|只送货|仅配送|只配送|仅安装|只安装|送货|配送|安装|的/gu, " ")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter((term) => term.length >= 2);
}
