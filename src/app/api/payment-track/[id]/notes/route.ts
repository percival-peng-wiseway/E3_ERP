import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import { updatePaymentTrackProjectNotes, PaymentTrackRepositoryError } from "@/lib/payment-track/repository";
import { paymentTrackError, paymentTrackJson, readPaymentTrackJson, PaymentTrackRequestBodyTooLarge } from "@/lib/payment-track/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return paymentTrackError(401, "authentication_required", "Sign in to edit project notes.");
  if (session.user.role === "installer") return paymentTrackError(403, "role_forbidden", "Installer access is read-only.");
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  try {
    const body = await readPaymentTrackJson(request, 32 * 1024);
    const expected = body.expectedNotesUpdatedAt;
    if (Object.keys(body).some((key) => !["notes", "expectedNotesUpdatedAt"].includes(key))
      || typeof body.notes !== "string"
      || (expected !== null && (typeof expected !== "string" || !Number.isFinite(Date.parse(expected))
        || new Date(expected).toISOString() !== expected))) {
      return paymentTrackError(400, "invalid_notes", "Provide notes and their current version without extra fields.");
    }
    const project = await updatePaymentTrackProjectNotes(id, session.user.role, session.user.displayName, body.notes, expected);
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "Project notes are too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The notes request is invalid.");
    return paymentTrackError(500, "notes_failed", "Project notes could not be saved.");
  }
}
