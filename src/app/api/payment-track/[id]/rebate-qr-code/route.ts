import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  confirmPaymentTrackSolarRebateQrReceived,
  PaymentTrackRepositoryError,
} from "@/lib/payment-track/repository";
import {
  declaredPaymentTrackBodyTooLarge,
  paymentTrackError,
  paymentTrackJson,
  PaymentTrackRequestBodyTooLarge,
  readPaymentTrackJson,
} from "@/lib/payment-track/request";
import { parsePaymentTrackQrConfirmation } from "@/lib/payment-track/qr-confirmation";
import {
  isAuthorizedActorRequest,
  isAuthorizedMutationRequest,
  isSameOriginRequest,
} from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 16 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  // This employee action intentionally has no bearer-token path: a current
  // signed-in PM session and a same-origin browser request are both required.
  const isBrowserRequest = request.headers.has("origin") || request.headers.has("sec-fetch-site");
  if (!isBrowserRequest || !isSameOriginRequest(request)) {
    return paymentTrackError(403, "forbidden", "This request is not allowed.");
  }
  const session = getErpSession(request);
  if (!session) {
    return paymentTrackError(401, "unauthorized", "Sign in again before confirming receipt of the QR code.");
  }
  if (!isAuthorizedMutationRequest(request)) {
    return paymentTrackError(403, "forbidden", "This request is not allowed.");
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return paymentTrackError(415, "unsupported_media_type", "Submit the QR code receipt confirmation as JSON.");
  }
  if (declaredPaymentTrackBodyTooLarge(request, MAX_JSON_SIZE)) {
    return paymentTrackError(413, "request_too_large", "The confirmation request is too large.");
  }
  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) {
    return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  }

  try {
    const body = await readPaymentTrackJson(request, MAX_JSON_SIZE);
    const confirmation = parsePaymentTrackQrConfirmation(body);
    if (!confirmation) {
      return paymentTrackError(
        400,
        "invalid_confirmation",
        "Reload the project and submit the exact QR code receipt confirmation shown, without extra fields.",
      );
    }
    if (!isAuthorizedActorRequest(request, "pm")) {
      return paymentTrackError(
        403,
        "role_forbidden",
        "Only the Project Manager can confirm receipt of the Solar Rebate QR code.",
      );
    }
    const project = await confirmPaymentTrackSolarRebateQrReceived(
      id,
      "pm",
      confirmation.expectedUpdatedAt,
      session.user.displayName,
    );
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) {
      return paymentTrackError(error.status, error.code, error.message);
    }
    if (error instanceof PaymentTrackRequestBodyTooLarge) {
      return paymentTrackError(413, "request_too_large", "The confirmation request is too large.");
    }
    if (error instanceof SyntaxError) {
      return paymentTrackError(400, "invalid_json", "The QR code receipt confirmation is invalid.");
    }
    return paymentTrackError(500, "qr_confirmation_failed", "Receipt of the Solar Rebate QR code could not be confirmed.");
  }
}
