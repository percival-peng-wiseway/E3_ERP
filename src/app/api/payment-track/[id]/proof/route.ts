import { NextRequest } from "next/server";
import {
  PaymentTrackRepositoryError,
  uploadPaymentTrackProof,
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
import type {
  PaymentTrackRole,
  PaymentTrackUploadContentType,
} from "@/lib/payment-track/types";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PROOF_SIZE = 10 * 1024 * 1024;
const MAX_MULTIPART_SIZE = MAX_PROOF_SIZE + 256 * 1024;
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
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_MULTIPART_SIZE)) {
    return paymentTrackError(413, "file_too_large", "The payment proof must be 10 MB or smaller.");
  }
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return paymentTrackError(400, "invalid_id", "The project ID is invalid.");

  try {
    const form = await readPaymentTrackForm(request, MAX_MULTIPART_SIZE);
    if (!strictFormFields(form, new Set(["proof", "kind", "actorRole"]))) {
      return paymentTrackError(400, "invalid_form", "The proof form contains invalid or duplicate fields.");
    }
    const kind = form.get("kind");
    const role = form.get("actorRole");
    if (kind !== "deposit") {
      return paymentTrackError(400, "invalid_kind", "Only the initial deposit requires payment proof.");
    }
    if (role !== "sales") {
      return paymentTrackError(403, "role_forbidden", "Only Sales can upload deposit proof.");
    }
    if (!isAuthorizedActorRequest(request, role)) {
      return paymentTrackError(403, "role_forbidden", "Your signed-in role cannot perform the Sales step.");
    }
    const proof = form.get("proof");
    if (!(proof instanceof File) || proof.size < 1 || proof.size > MAX_PROOF_SIZE) {
      return paymentTrackError(400, "invalid_proof", "Attach one proof file up to 10 MB.");
    }
    if (!ACCEPTED_TYPES.includes(proof.type as PaymentTrackUploadContentType)) {
      return paymentTrackError(415, "unsupported_proof", "Use a PDF, JPG, PNG or WebP payment proof.");
    }
    const contentType = proof.type as PaymentTrackUploadContentType;
    const bytes = new Uint8Array(await proof.arrayBuffer());
    if (!paymentTrackFileSignatureMatches(contentType, bytes)) {
      return paymentTrackError(415, "invalid_proof_content", "The proof contents do not match its file type.");
    }
    const project = await uploadPaymentTrackProof(id, "deposit", role as PaymentTrackRole, {
      bytes,
      originalName: safePaymentTrackOriginalName(proof.name, "payment-proof"),
      contentType,
      size: proof.size,
    });
    return paymentTrackJson({ data: project });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) {
      return paymentTrackError(413, "file_too_large", "The payment proof must be 10 MB or smaller.");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return paymentTrackError(400, "invalid_form", "The proof form is invalid.");
    }
    return paymentTrackError(500, "proof_failed", "The payment proof could not be uploaded.");
  }
}
