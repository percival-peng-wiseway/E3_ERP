import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";
import { uploadPaymentTrackAttachment, PaymentTrackRepositoryError } from "@/lib/payment-track/repository";
import {
  declaredPaymentTrackBodyTooLarge, paymentTrackError, paymentTrackJson,
  paymentTrackFileSignatureMatches, readPaymentTrackForm, safePaymentTrackOriginalName,
  strictFormFields, PaymentTrackRequestBodyTooLarge,
} from "@/lib/payment-track/request";
import type { PaymentTrackUploadContentType } from "@/lib/payment-track/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_BODY_SIZE = MAX_FILE_SIZE + 256 * 1024;
const PREVIEW_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = getErpSession(request);
  if (!session) return paymentTrackError(401, "authentication_required", "Sign in to upload project files.");
  if (session.user.role === "installer") return paymentTrackError(403, "role_forbidden", "Installer access is read-only.");
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_BODY_SIZE)) return paymentTrackError(413, "file_too_large", "Each file must be 10 MB or smaller.");
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  try {
    const form = await readPaymentTrackForm(request, MAX_BODY_SIZE);
    if (!strictFormFields(form, new Set(["file"]))) return paymentTrackError(400, "invalid_form", "Attach one file without extra fields.");
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_FILE_SIZE) {
      return paymentTrackError(400, "invalid_file", "Choose a non-empty file up to 10 MB.");
    }
    // Only validated PDF/images can open inline. All other formats download as
    // opaque attachments, including Word, Excel and browser-active documents.
    const contentType: PaymentTrackUploadContentType = PREVIEW_TYPES.has(file.type)
      ? file.type as PaymentTrackUploadContentType : "application/octet-stream";
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (contentType !== "application/octet-stream" && !paymentTrackFileSignatureMatches(contentType, bytes)) {
      return paymentTrackError(415, "invalid_file_content", "The file contents do not match its file type.");
    }
    const project = await uploadPaymentTrackAttachment(id, session.user.role, session.user.displayName, {
      bytes, contentType, size: file.size, originalName: safePaymentTrackOriginalName(file.name, "project-file"),
    });
    return paymentTrackJson({ data: project }, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "file_too_large", "Each file must be 10 MB or smaller.");
    if (error instanceof TypeError || error instanceof SyntaxError) return paymentTrackError(400, "invalid_form", "The file upload is invalid.");
    return paymentTrackError(500, "upload_failed", "The project file could not be uploaded.");
  }
}
