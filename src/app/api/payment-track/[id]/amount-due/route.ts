import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import { updatePaymentTrackAmountDue, PaymentTrackRepositoryError } from "@/lib/payment-track/repository";
import { paymentTrackAmountToCents } from "@/lib/payment-track/input-validation";
import { paymentTrackError, paymentTrackJson, readPaymentTrackJson, PaymentTrackRequestBodyTooLarge } from "@/lib/payment-track/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return paymentTrackError(401, "authentication_required", "Sign in to edit Amount Due.");
  // Module admin cookies and client-submitted roles cannot grant this permission.
  if (session.user.role !== "admin") return paymentTrackError(403, "role_forbidden", "Only an Administrator can change Amount Due.");
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return paymentTrackError(415, "invalid_content_type", "Send Amount Due as JSON.");
  try {
    const body = await readPaymentTrackJson(request, 4 * 1024);
    const amount = paymentTrackAmountToCents(body.amountDue);
    if (amount === null || typeof body.expectedUpdatedAt !== "string"
      || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) || new Date(body.expectedUpdatedAt).toISOString() !== body.expectedUpdatedAt
      || (body.reason !== undefined && typeof body.reason !== "string")
      || Object.keys(body).some((key) => !["amountDue", "expectedUpdatedAt", "reason"].includes(key))) {
      return paymentTrackError(400, "invalid_amount_adjustment", "Provide a non-negative amount with up to two decimal places and the current project version.");
    }
    return paymentTrackJson({ data: await updatePaymentTrackAmountDue(id, session.user.role, session.user.displayName, amount, body.expectedUpdatedAt, body.reason as string | undefined) });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "The adjustment request is too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The adjustment request is invalid.");
    return paymentTrackError(500, "amount_due_save_failed", "Amount Due could not be saved.");
  }
}
