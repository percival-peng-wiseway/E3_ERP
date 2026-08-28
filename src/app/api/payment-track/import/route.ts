import { NextRequest } from "next/server";
import { parsePaymentTrackCreateInput } from "@/lib/payment-track/create-input";
import {
  createImportedPaymentTrackProject,
  PaymentTrackRepositoryError,
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
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AGREEMENT_SIZE = 15 * 1024 * 1024;
const MAX_PARSED_AGREEMENT_SIZE = 128 * 1024;
const MAX_MULTIPART_SIZE = MAX_AGREEMENT_SIZE + MAX_PARSED_AGREEMENT_SIZE + 256 * 1024;
const CLIENT_EXTRACTION_VERSION = 1;

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_MULTIPART_SIZE)) {
    return paymentTrackError(413, "file_too_large", "The Solar Proposal must be 15 MB or smaller.");
  }

  try {
    const form = await readPaymentTrackForm(request, MAX_MULTIPART_SIZE);
    if (!strictFormFields(form, new Set(["agreement", "actorRole", "parsedAgreement"]))) {
      return paymentTrackError(400, "invalid_form", "The proposal form contains invalid or duplicate fields.");
    }
    if (form.get("actorRole") !== "sales") {
      return paymentTrackError(403, "role_forbidden", "Only Sales can import a proposal.");
    }
    if (!isAuthorizedActorRequest(request, "sales")) {
      return paymentTrackError(403, "role_forbidden", "Only Sales or an Administrator can import a proposal.");
    }
    const agreement = form.get("agreement");
    if (!(agreement instanceof File) || agreement.size < 1 || agreement.size > MAX_AGREEMENT_SIZE) {
      return paymentTrackError(400, "invalid_agreement", "Attach one Solar Proposal PDF up to 15 MB.");
    }
    if (agreement.type !== "application/pdf") {
      return paymentTrackError(415, "unsupported_agreement", "The Solar Proposal must be a PDF.");
    }
    const signature = new Uint8Array(await agreement.slice(0, 5).arrayBuffer());
    const trailer = new TextDecoder().decode(new Uint8Array(
      await agreement.slice(Math.max(0, agreement.size - 4_096)).arrayBuffer(),
    ));
    if (!paymentTrackFileSignatureMatches("application/pdf", signature) || !trailer.includes("%%EOF")) {
      return paymentTrackError(415, "invalid_agreement_content", "The uploaded file is not a valid Solar Proposal PDF.");
    }
    const parsedAgreement = form.get("parsedAgreement");
    if (typeof parsedAgreement !== "string"
      || new TextEncoder().encode(parsedAgreement).byteLength > MAX_PARSED_AGREEMENT_SIZE) {
      return paymentTrackError(400, "client_parse_required", "Refresh the page and choose the Solar Proposal again.");
    }
    const parsedBody: unknown = JSON.parse(parsedAgreement);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return paymentTrackError(400, "invalid_agreement_data", "The extracted proposal details are invalid.");
    }
    const { extractionVersion, ...createFields } = parsedBody as Record<string, unknown>;
    if (extractionVersion !== CLIENT_EXTRACTION_VERSION) {
      return paymentTrackError(400, "client_parse_required", "Refresh the page and choose the Solar Proposal again.");
    }
    // Extraction runs in the first-party browser because instantiating PDF.js
    // exceeds the Worker's fixed memory budget. The authenticated Sales role
    // already has the equivalent Manual Entry permission; the server still
    // enforces exact fields, all value bounds, the PDF envelope and duplicate
    // Proposal Number protection before it writes anything.
    const input = parsePaymentTrackCreateInput(createFields, {
      exact: true,
      deriveStcFlags: true,
    });
    if (!input) {
      return paymentTrackError(400, "invalid_agreement_data", "The extracted proposal details are invalid.");
    }
    const project = await createImportedPaymentTrackProject(input, {
      blob: agreement,
      originalName: safePaymentTrackOriginalName(agreement.name, "agreement.pdf"),
      contentType: "application/pdf",
      size: agreement.size,
    });
    return paymentTrackJson({ data: project }, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) {
      return paymentTrackError(413, "file_too_large", "The Solar Proposal must be 15 MB or smaller.");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return paymentTrackError(400, "invalid_form", "The proposal form is invalid.");
    }
    return paymentTrackError(500, "import_failed", "The proposal could not be imported.");
  }
}
