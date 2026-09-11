import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import { updatePaymentTrackCustomer, PaymentTrackRepositoryError } from "@/lib/payment-track/repository";
import { paymentTrackError, paymentTrackJson, readPaymentTrackJson, PaymentTrackRequestBodyTooLarge } from "@/lib/payment-track/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return paymentTrackError(401, "authentication_required", "Sign in to edit customer information.");
  if (session.user.role === "installer") return paymentTrackError(403, "role_forbidden", "Installer access is read-only.");
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return paymentTrackError(415, "invalid_content_type", "Send customer information as JSON.");
  try {
    const body = await readPaymentTrackJson(request, 16 * 1024);
    const expected = body.expectedCustomerUpdatedAt;
    if (Object.keys(body).some((key) => !["customer", "expectedCustomerUpdatedAt"].includes(key))
      || (expected !== null && (typeof expected !== "string" || !Number.isFinite(Date.parse(expected))
        || new Date(expected).toISOString() !== expected))
      || !body.customer || typeof body.customer !== "object" || Array.isArray(body.customer)
      || ["firstName", "lastName", "phone", "email", "addressLine1", "suburb", "state", "postcode", "coupling", "nmi"]
        .some((key) => typeof (body.customer as Record<string, unknown>)[key] !== "string")) {
      return paymentTrackError(400, "invalid_customer", "Provide the customer fields and their current version without extra fields.");
    }
    const project = await updatePaymentTrackCustomer(id, session.user.role, session.user.displayName, body.customer, expected);
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "Customer information is too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The customer information request is invalid.");
    return paymentTrackError(500, "customer_save_failed", "Customer information could not be saved.");
  }
}
