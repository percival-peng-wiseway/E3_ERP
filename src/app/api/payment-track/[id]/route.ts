import { NextRequest } from "next/server";
import { isPaymentTrackAdmin } from "@/lib/payment-track/auth";
import {
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
  readPaymentTrackJson,
} from "@/lib/payment-track/request";
import { parsePaymentTrackPmNotesBody } from "@/lib/payment-track/pm-notes";
import {
  PAYMENT_TRACK_ACTIONS,
  PAYMENT_TRACK_ROLES,
  type PaymentTrackAction,
  type PaymentTrackRole,
} from "@/lib/payment-track/types";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 16 * 1024;
const INSTALLATION_SCHEDULE_FIELDS = new Set([
  "action",
  "actorRole",
  "actorName",
  "installationDate",
]);

function hasOnlyInstallationScheduleFields(body: Record<string, unknown>) {
  return Object.keys(body).every((field) => INSTALLATION_SCHEDULE_FIELDS.has(field));
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
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");

  try {
    const body = await readPaymentTrackJson(request, MAX_JSON_SIZE);
    const action = typeof body.action === "string" && PAYMENT_TRACK_ACTIONS.includes(body.action as PaymentTrackAction)
      ? body.action as PaymentTrackAction
      : null;
    const actorRole = typeof body.actorRole === "string" && PAYMENT_TRACK_ROLES.includes(body.actorRole as PaymentTrackRole)
      ? body.actorRole as PaymentTrackRole
      : null;
    const actorName = optionalPaymentTrackText(body.actorName, 120);
    if (!action || !actorRole || actorName === null) {
      return paymentTrackError(400, "invalid_action", "The project action is invalid.");
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
      || actorRole === "admin";
    if (adminAction && !isPaymentTrackAdmin(request)) {
      return paymentTrackError(401, "admin_required", "Administrator access is required.");
    }

    let amountCents: number | undefined;
    if (action === "confirm_deposit" || action === "confirm_collection" || action === "confirm_final_payment") {
      const parsed = paymentTrackAmountToCents(body.amount);
      if (parsed === null) return paymentTrackError(400, "invalid_amount", "Enter a non-negative amount, including 0 if nothing was received.");
      amountCents = parsed;
    }
    let paymentId: string | undefined;
    if (action === "confirm_final_payment") {
      if (typeof body.paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.paymentId)) {
        return paymentTrackError(400, "invalid_payment_id", "Choose the payment awaiting confirmation.");
      }
      paymentId = body.paymentId;
    }
    let deliveryDate: string | undefined;
    if (action === "schedule_delivery") {
      if (!paymentTrackDateIsValid(body.deliveryDate)) {
        return paymentTrackError(400, "invalid_delivery_date", "Choose a valid delivery date.");
      }
      deliveryDate = body.deliveryDate;
    }
    let installationDate: string | undefined;
    if (action === "schedule_installation") {
      if (actorRole !== "pm") {
        return paymentTrackError(403, "role_forbidden", "Only the Project Manager can schedule installation.");
      }
      if (!hasOnlyInstallationScheduleFields(body) || !paymentTrackDateIsValid(body.installationDate)) {
        return paymentTrackError(
          400,
          "invalid_installation_date",
          "Choose a valid installation date without extra fields.",
        );
      }
      installationDate = body.installationDate;
    }

    const project = await transitionPaymentTrackProject(id, action, {
      actorRole,
      actorName: actorName || undefined,
      amountCents,
      paymentId,
      deliveryDate,
      installationDate,
      notes,
      expectedPmNotesUpdatedAt,
    });
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "The project action is too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The project action is invalid.");
    return paymentTrackError(500, "update_failed", "The payment project could not be updated.");
  }
}
