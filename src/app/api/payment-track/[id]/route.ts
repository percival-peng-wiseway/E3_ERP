import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isPaymentTrackAdmin } from "@/lib/payment-track/auth";
import {
  deletePaymentTrackProject,
  PaymentTrackRepositoryError,
  transitionPaymentTrackProject,
} from "@/lib/payment-track/repository";
import {
  declaredPaymentTrackBodyTooLarge,
  optionalPaymentTrackText,
  paymentTrackAmountToCents,
  paymentTrackDateIsValid,
  paymentTrackError,
  paymentTrackJson,
  PaymentTrackRequestBodyTooLarge,
  readLimitedPaymentTrackBody,
  readPaymentTrackJson,
} from "@/lib/payment-track/request";
import { parsePaymentTrackPmNotesBody } from "@/lib/payment-track/pm-notes";
import {
  PAYMENT_TRACK_ACTIONS,
  PAYMENT_TRACK_ROLES,
  PAYMENT_TRACK_SCHEDULE_ASSIGNEES,
  PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH,
  PAYMENT_TRACK_WORK_MODES,
  type PaymentTrackAction,
  type PaymentTrackRole,
  type PaymentTrackScheduleAssignee,
  type PaymentTrackWorkMode,
} from "@/lib/payment-track/types";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 16 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_CONFIRMATION_ACTIONS = new Set<PaymentTrackAction>([
  "confirm_deposit",
  "confirm_collection",
  "confirm_final_payment",
  "confirm_stc_solar",
  "confirm_stc_battery",
  "confirm_solar_rebate",
]);
const INSTALLATION_SCHEDULE_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "installationDate",
  "installationTime",
  "installationAssignee",
  "expectedUpdatedAt",
]);
const DELIVERY_SCHEDULE_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "deliveryDate",
  "deliveryTime",
  "deliveryAssignee",
  "expectedUpdatedAt",
]);
const DELIVERY_PREPARATION_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "selections",
  "expectedUpdatedAt",
]);
const WORK_SCHEDULE_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "workMode",
  "deliveryDate",
  "deliveryTime",
  "deliveryAssignee",
  "installationAssignee",
  "selections",
  "expectedUpdatedAt",
]);
const ACKNOWLEDGE_PAYMENT_FIELDS = new Set(["action", "actorRole", "actorName", "amount"]);
const DELIVERY_PRE_SCHEDULE_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "selections",
  "preferredDate",
  "preferredTime",
  "notes",
  "expectedUpdatedAt",
]);
const INSTALLATION_PRE_SCHEDULE_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "preferredDate",
  "preferredTime",
  "notes",
  "expectedUpdatedAt",
]);
const SKIP_STAGE_FIELDS = new Set(["action", "actorRole", "actorName", "reason", "expectedUpdatedAt"]);

function paymentTrackTimeIsValid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function paymentTrackScheduleAssigneeIsValid(value: unknown): value is PaymentTrackScheduleAssignee {
  return typeof value === "string"
    && PAYMENT_TRACK_SCHEDULE_ASSIGNEES.includes(value as PaymentTrackScheduleAssignee);
}

function hasOnlyInstallationScheduleFields(body: Record<string, unknown>) {
  return Object.keys(body).every((field) => INSTALLATION_SCHEDULE_FIELDS.has(field));
}

function hasOnlyDeliveryScheduleFields(body: Record<string, unknown>) {
  return Object.keys(body).every((field) => DELIVERY_SCHEDULE_FIELDS.has(field));
}

function scheduleRequestNotes(value: unknown) {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const notes = value.trim();
  if (notes.length > 2_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(notes)) return null;
  return notes;
}

function deliverySelections(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const parsed = [] as Array<{ sku: string; quantity: number }>;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).some((field) => !["sku", "quantity"].includes(field))
      || typeof candidate.sku !== "string"
      || !candidate.sku.trim()
      || candidate.sku.length > 160
      || /[\u0000-\u001F\u007F]/.test(candidate.sku)
      || !Number.isInteger(candidate.quantity)
      || (candidate.quantity as number) < 1
      || (candidate.quantity as number) > 100_000) return null;
    parsed.push({
      sku: candidate.sku.trim(),
      quantity: candidate.quantity as number,
    });
  }
  return parsed;
}

function stageSkipReason(value: unknown) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (!reason
    || reason.length > PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(reason)) return null;
  return reason;
}

function paymentTrackUpdatedAtIsValid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_JSON_SIZE)) {
    return paymentTrackError(413, "request_too_large", "The project action is too large.");
  }
  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");

  try {
    const body = await readPaymentTrackJson(request, MAX_JSON_SIZE);
    const action = typeof body.action === "string" && PAYMENT_TRACK_ACTIONS.includes(body.action as PaymentTrackAction)
      ? body.action as PaymentTrackAction
      : null;
    const actorRole = typeof body.actorRole === "string" && PAYMENT_TRACK_ROLES.includes(body.actorRole as PaymentTrackRole)
      ? body.actorRole as PaymentTrackRole
      : null;
    const session = getErpSession(request);
    const actorName = session?.user.displayName || optionalPaymentTrackText(body.actorName, 120);
    if (!action || !actorRole || actorName === null) {
      return paymentTrackError(400, "invalid_action", "The project action is invalid.");
    }
    if (!isAuthorizedActorRequest(request, actorRole)) {
      return paymentTrackError(403, "role_forbidden", "Your signed-in role cannot perform this action.");
    }
    if (PAYMENT_CONFIRMATION_ACTIONS.has(action)
      && (actorRole !== "admin" || !isAuthorizedActorRequest(request, "admin"))) {
      return paymentTrackError(403, "admin_required", "Only an Administrator can confirm money received.");
    }
    let reason: string | undefined;
    let expectedUpdatedAt: string | undefined;
    if (action === "skip_stage") {
      if (actorRole !== "admin") {
        return paymentTrackError(403, "admin_required", "Only an Administrator can skip a Project Track stage.");
      }
      const parsedReason = stageSkipReason(body.reason);
      if (!parsedReason) {
        return paymentTrackError(
          400,
          "invalid_skip_reason",
          `Provide an Administrator stage override reason of up to ${PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH} characters.`,
        );
      }
      if (!Object.keys(body).every((field) => SKIP_STAGE_FIELDS.has(field))
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(
          400,
          "invalid_skip_request",
          "Reload the project and submit the exact project version shown in the Administrator override dialog, without extra fields.",
        );
      }
      reason = parsedReason;
      expectedUpdatedAt = body.expectedUpdatedAt;
    }

    let notes: string | undefined;
    let expectedPmNotesUpdatedAt: string | null | undefined;
    if (action === "update_pm_notes") {
      const parsed = parsePaymentTrackPmNotesBody(body);
      if (!parsed) {
        return paymentTrackError(
          400,
          "invalid_pm_notes",
          "Provide valid PM notes and the version you last loaded, without extra fields.",
        );
      }
      if (actorRole !== "pm") {
        return paymentTrackError(403, "role_forbidden", "Only the Project Manager can update PM notes.");
      }
      notes = parsed.notes;
      expectedPmNotesUpdatedAt = parsed.expectedPmNotesUpdatedAt;
    }

    const adminAction = action === "confirm_deposit"
      || action === "confirm_collection"
      || action === "confirm_final_payment"
      || action === "continue_to_stc"
      || action === "skip_stage"
      || actorRole === "admin";
    if (adminAction && !isPaymentTrackAdmin(request)) {
      return paymentTrackError(401, "admin_required", "Administrator access is required.");
    }

    let amountCents: number | undefined;
    if (action === "confirm_deposit" || action === "confirm_collection" || action === "confirm_final_payment" || action === "acknowledge_payment") {
      const parsed = paymentTrackAmountToCents(body.amount);
      if (parsed === null || (action === "acknowledge_payment" && parsed <= 0)) {
        return paymentTrackError(400, "invalid_amount", action === "acknowledge_payment"
          ? "Enter the positive amount Sales believes was received."
          : "Enter a non-negative amount, including 0 if nothing was received.");
      }
      amountCents = parsed;
    }
    let paymentId: string | undefined;
    if (action === "confirm_final_payment") {
      if (typeof body.paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.paymentId)) {
        return paymentTrackError(400, "invalid_payment_id", "Choose the payment awaiting confirmation.");
      }
      paymentId = body.paymentId;
    }
    if (action === "acknowledge_payment") {
      if (actorRole !== "sales") {
        return paymentTrackError(403, "role_forbidden", "Only Sales can record a received payment.");
      }
      if (!Object.keys(body).every((field) => ACKNOWLEDGE_PAYMENT_FIELDS.has(field))) {
        return paymentTrackError(400, "invalid_payment_request", "Enter the received amount without extra fields.");
      }
    }
    let deliveryDate: string | undefined;
    let deliveryTime: string | undefined;
    let deliveryAssignee: PaymentTrackScheduleAssignee | undefined;
    let preferredDate: string | undefined;
    let preferredTime: string | undefined;
    let preparedDeliverySelections;
    if (action === "prepare_delivery") {
      preparedDeliverySelections = deliverySelections(body.selections);
      if (actorRole !== "sales") {
        return paymentTrackError(403, "role_forbidden", "Only Sales can prepare warehouse items.");
      }
      if (!Object.keys(body).every((field) => DELIVERY_PREPARATION_FIELDS.has(field))
        || !preparedDeliverySelections
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(400, "invalid_delivery_items", "Choose one or more valid warehouse SKU and quantity lines without extra fields.");
      }
      expectedUpdatedAt = body.expectedUpdatedAt;
    }
    if (action === "pre_schedule_delivery") {
      const parsedSelections = deliverySelections(body.selections);
      const parsedNotes = scheduleRequestNotes(body.notes);
      if (actorRole !== "sales") {
        return paymentTrackError(403, "role_forbidden", "Only Sales can submit a delivery scheduling request.");
      }
      if (!Object.keys(body).every((field) => DELIVERY_PRE_SCHEDULE_FIELDS.has(field))
        || !parsedSelections
        || !paymentTrackDateIsValid(body.preferredDate)
        || !paymentTrackTimeIsValid(body.preferredTime)
        || parsedNotes === null
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(
          400,
          "invalid_delivery_pre_schedule",
          "Choose warehouse items, a valid preferred delivery date and time, and optional notes without extra fields.",
        );
      }
      preparedDeliverySelections = parsedSelections;
      preferredDate = body.preferredDate;
      preferredTime = body.preferredTime;
      notes = parsedNotes;
      expectedUpdatedAt = body.expectedUpdatedAt;
    }
    if (action === "schedule_delivery") {
      if (actorRole !== "pm") {
        return paymentTrackError(403, "role_forbidden", "Only the Project Manager can schedule delivery.");
      }
      if (!hasOnlyDeliveryScheduleFields(body)
        || !paymentTrackDateIsValid(body.deliveryDate)
        || !paymentTrackTimeIsValid(body.deliveryTime)
        || !paymentTrackScheduleAssigneeIsValid(body.deliveryAssignee)
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(400, "invalid_delivery_schedule", "Choose a valid delivery date, time and assignee.");
      }
      deliveryDate = body.deliveryDate;
      deliveryTime = body.deliveryTime;
      deliveryAssignee = body.deliveryAssignee;
      expectedUpdatedAt = body.expectedUpdatedAt;
    }
    let installationDate: string | undefined;
    let installationTime: string | undefined;
    let installationAssignee: PaymentTrackScheduleAssignee | undefined;
    let workMode: PaymentTrackWorkMode | undefined;
    if (action === "schedule_work") {
      const parsedSelections = body.selections === undefined ? undefined : deliverySelections(body.selections);
      const parsedMode = typeof body.workMode === "string"
        && PAYMENT_TRACK_WORK_MODES.includes(body.workMode as PaymentTrackWorkMode)
        ? body.workMode as PaymentTrackWorkMode
        : null;
      const includesDelivery = parsedMode === "delivery_only" || parsedMode === "delivery_and_installation";
      const includesInstallation = parsedMode === "installation_only" || parsedMode === "delivery_and_installation";
      if (actorRole !== "pm") {
        return paymentTrackError(403, "role_forbidden", "Only the Project Manager can schedule work.");
      }
      if (!Object.keys(body).every((field) => WORK_SCHEDULE_FIELDS.has(field))
        || !parsedMode
        || !paymentTrackDateIsValid(body.deliveryDate)
        || !paymentTrackTimeIsValid(body.deliveryTime)
        || (includesDelivery && (!parsedSelections || !paymentTrackScheduleAssigneeIsValid(body.deliveryAssignee)))
        || (includesInstallation && !paymentTrackScheduleAssigneeIsValid(body.installationAssignee))
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(400, "invalid_work_schedule", "Choose the work type, date, time, required team members and delivery items.");
      }
      workMode = parsedMode;
      deliveryDate = body.deliveryDate;
      deliveryTime = body.deliveryTime;
      deliveryAssignee = includesDelivery ? body.deliveryAssignee as PaymentTrackScheduleAssignee : undefined;
      installationAssignee = includesInstallation ? body.installationAssignee as PaymentTrackScheduleAssignee : undefined;
      preparedDeliverySelections = includesDelivery ? parsedSelections || undefined : undefined;
      expectedUpdatedAt = body.expectedUpdatedAt;
    }
    if (action === "pre_schedule_installation") {
      const parsedNotes = scheduleRequestNotes(body.notes);
      if (actorRole !== "sales") {
        return paymentTrackError(403, "role_forbidden", "Only Sales can submit an installation scheduling request.");
      }
      if (!Object.keys(body).every((field) => INSTALLATION_PRE_SCHEDULE_FIELDS.has(field))
        || !paymentTrackDateIsValid(body.preferredDate)
        || !paymentTrackTimeIsValid(body.preferredTime)
        || parsedNotes === null
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(
          400,
          "invalid_installation_pre_schedule",
          "Choose a valid preferred installation date and time, and optional notes without extra fields.",
        );
      }
      preferredDate = body.preferredDate;
      preferredTime = body.preferredTime;
      notes = parsedNotes;
      expectedUpdatedAt = body.expectedUpdatedAt;
    }
    if (action === "schedule_installation") {
      if (actorRole !== "pm") {
        return paymentTrackError(403, "role_forbidden", "Only the Project Manager can schedule installation.");
      }
      if (!hasOnlyInstallationScheduleFields(body)
        || !paymentTrackDateIsValid(body.installationDate)
        || !paymentTrackTimeIsValid(body.installationTime)
        || !paymentTrackScheduleAssigneeIsValid(body.installationAssignee)
        || !paymentTrackUpdatedAtIsValid(body.expectedUpdatedAt)) {
        return paymentTrackError(
          400,
          "invalid_installation_schedule",
          "Choose a valid installation date, time and assignee without extra fields.",
        );
      }
      installationDate = body.installationDate;
      installationTime = body.installationTime;
      installationAssignee = body.installationAssignee;
      expectedUpdatedAt = body.expectedUpdatedAt;
    }

    const project = await transitionPaymentTrackProject(id, action, {
      actorRole,
      actorName: actorName || undefined,
      amountCents,
      paymentId,
      preferredDate,
      preferredTime,
      deliveryDate,
      deliveryTime,
      deliveryAssignee,
      deliverySelections: preparedDeliverySelections,
      installationDate,
      installationTime,
      installationAssignee,
      workMode,
      reason,
      expectedUpdatedAt,
      notes,
      expectedPmNotesUpdatedAt,
    });
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "The project action is too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The project action is invalid.");
    return paymentTrackError(500, "update_failed", "The project could not be updated.");
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return paymentTrackError(403, "forbidden", "This request is not allowed.");
  }
  if (!isAuthorizedActorRequest(request, "admin")) {
    return paymentTrackError(403, "role_forbidden", "Only Administrators can delete projects in Project Track.");
  }
  if (!isPaymentTrackAdmin(request)) {
    return paymentTrackError(401, "admin_required", "Administrator access is required.");
  }

  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  if ([...request.nextUrl.searchParams.keys()].length) {
    return paymentTrackError(400, "invalid_query", "Delete does not accept query parameters.");
  }

  try {
    const body = await readLimitedPaymentTrackBody(request, 1);
    if (body.byteLength) {
      return paymentTrackError(400, "invalid_request", "Delete does not accept a request body.");
    }
    await deletePaymentTrackProject(id);
    return paymentTrackJson({ data: { id } });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) {
      return paymentTrackError(error.status, error.code, error.message);
    }
    if (error instanceof PaymentTrackRequestBodyTooLarge) {
      return paymentTrackError(400, "invalid_request", "Delete does not accept a request body.");
    }
    return paymentTrackError(500, "delete_failed", "The project could not be deleted.");
  }
}
