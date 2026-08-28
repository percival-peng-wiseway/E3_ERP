import { NextRequest } from "next/server";
import {
  PaymentTrackRepositoryError,
  uploadPaymentTrackSolarRebateQrCode,
} from "@/lib/payment-track/repository";
import {
  declaredPaymentTrackBodyTooLarge,
  paymentTrackError,
  paymentTrackFileSignatureMatches,
  paymentTrackJson,
  PaymentTrackRequestBodyTooLarge,
  readPaymentTrackForm,
  safePaymentTrackOriginalName,
  strictFormFields,
} from "@/lib/payment-track/request";
import type { PaymentTrackUploadContentType } from "@/lib/payment-track/types";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_QR_CODE_SIZE = 10 * 1024 * 1024;
const MAX_MULTIPART_SIZE = MAX_QR_CODE_SIZE + 256 * 1024;
const ACCEPTED_TYPES: PaymentTrackUploadContentType[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return paymentTrackError(403, "forbidden", "This request is not allowed.");
  }
  if (declaredPaymentTrackBodyTooLarge(request, MAX_MULTIPART_SIZE)) {
    return paymentTrackError(413, "file_too_large", "The QR code file must be 10 MB or smaller.");
  }
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return paymentTrackError(400, "invalid_id", "The project ID is invalid.");
  }

  try {
    const form = await readPaymentTrackForm(request, MAX_MULTIPART_SIZE);
    if (!strictFormFields(form, new Set(["qrCode", "actorRole", "expectedUpdatedAt"]))) {
      return paymentTrackError(400, "invalid_form", "The QR code form contains invalid or duplicate fields.");
    }
    if (form.get("actorRole") !== "pm" || !isAuthorizedActorRequest(request, "pm")) {
      return paymentTrackError(403, "role_forbidden", "Only the Project Manager can upload the Solar Rebate QR code.");
    }
    const expectedUpdatedAt = form.get("expectedUpdatedAt");
    if (typeof expectedUpdatedAt !== "string"
      || expectedUpdatedAt.length > 64
      || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      return paymentTrackError(400, "invalid_version", "Reload the project before uploading the QR code.");
    }
    const qrCode = form.get("qrCode");
    if (!(qrCode instanceof File) || qrCode.size < 1 || qrCode.size > MAX_QR_CODE_SIZE) {
      return paymentTrackError(400, "invalid_qr_code", "Attach one QR code file up to 10 MB.");
    }
    if (!ACCEPTED_TYPES.includes(qrCode.type as PaymentTrackUploadContentType)) {
      return paymentTrackError(415, "unsupported_qr_code", "Use a PDF, JPG, PNG or WebP QR code file.");
    }
    const contentType = qrCode.type as PaymentTrackUploadContentType;
    const bytes = new Uint8Array(await qrCode.arrayBuffer());
    if (!paymentTrackFileSignatureMatches(contentType, bytes)) {
      return paymentTrackError(415, "invalid_qr_code_content", "The QR code contents do not match its file type.");
    }
    const project = await uploadPaymentTrackSolarRebateQrCode(id, "pm", expectedUpdatedAt, {
      bytes,
      originalName: safePaymentTrackOriginalName(qrCode.name, "solar-rebate-qr-code"),
      contentType,
      size: qrCode.size,
    });
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) {
      return paymentTrackError(error.status, error.code, error.message);
    }
    if (error instanceof PaymentTrackRequestBodyTooLarge) {
      return paymentTrackError(413, "file_too_large", "The QR code file must be 10 MB or smaller.");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return paymentTrackError(400, "invalid_form", "The QR code form is invalid.");
    }
    return paymentTrackError(500, "qr_code_failed", "The Solar Rebate QR code could not be uploaded.");
  }
}
