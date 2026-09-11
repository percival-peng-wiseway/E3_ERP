import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import { updatePaymentTrackStcEstimate, PaymentTrackRepositoryError } from "@/lib/payment-track/repository";
import { paymentTrackAmountToCents } from "@/lib/payment-track/input-validation";
import { paymentTrackJson, paymentTrackError, readPaymentTrackJson, PaymentTrackRequestBodyTooLarge } from "@/lib/payment-track/request";

export const dynamic = "force-dynamic";
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return paymentTrackError(401, "authentication_required", "Sign in to edit STC amounts.");
  if (session.user.role !== "admin" || !isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "Only an Administrator can edit expected STC amounts.");
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "Invalid project ID.");
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) return paymentTrackError(415, "invalid_content_type", "Send JSON.");
  try {
    const body = await readPaymentTrackJson(request, 4096);
    const solar = body.solar === null ? null : paymentTrackAmountToCents(body.solar);
    const battery = body.battery === null ? null : paymentTrackAmountToCents(body.battery);
    if ((body.solar !== null && solar === null) || (body.battery !== null && battery === null) || typeof body.expectedUpdatedAt !== "string"
      || Object.keys(body).some(key => !["solar", "battery", "expectedUpdatedAt"].includes(key))) return paymentTrackError(400, "invalid_amount", "Enter valid STC amounts or leave them blank.");
    return paymentTrackJson({ data: await updatePaymentTrackStcEstimate(id, session.user.role, session.user.displayName, solar, battery, body.expectedUpdatedAt) });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "Request too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "Invalid JSON.");
    return paymentTrackError(500, "save_failed", "Could not save expected STC amounts.");
  }
}
