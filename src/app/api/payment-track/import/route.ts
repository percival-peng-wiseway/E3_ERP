import { NextRequest } from "next/server";
import {
  PaymentAgreementParseError,
  parsePaymentAgreementPdf,
} from "@/lib/payment-track/pdf-parser";
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
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AGREEMENT_SIZE = 15 * 1024 * 1024;
const MAX_MULTIPART_SIZE = MAX_AGREEMENT_SIZE + 256 * 1024;

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_MULTIPART_SIZE)) {
    return paymentTrackError(413, "file_too_large", "The Solar Proposal must be 15 MB or smaller.");
  }

  try {
    const form = await readPaymentTrackForm(request, MAX_MULTIPART_SIZE);
    if (!strictFormFields(form, new Set(["agreement", "actorRole"]))) {
      return paymentTrackError(400, "invalid_form", "The proposal form contains invalid or duplicate fields.");
    }
    if (form.get("actorRole") !== "sales") {
      return paymentTrackError(403, "role_forbidden", "Only Sales can import a proposal.");
    }
    const agreement = form.get("agreement");
    if (!(agreement instanceof File) || agreement.size < 1 || agreement.size > MAX_AGREEMENT_SIZE) {
      return paymentTrackError(400, "invalid_agreement", "Attach one Solar Proposal PDF up to 15 MB.");
    }
    if (agreement.type !== "application/pdf") {
      return paymentTrackError(415, "unsupported_agreement", "The Solar Proposal must be a PDF.");
    }
    const bytes = new Uint8Array(await agreement.arrayBuffer());
    if (!paymentTrackFileSignatureMatches("application/pdf", bytes)) {
      return paymentTrackError(415, "invalid_agreement_content", "The uploaded file is not a valid Solar Proposal PDF.");
    }

    const parsed = await parsePaymentAgreementPdf(bytes);
    const project = await createImportedPaymentTrackProject({
      quoteNumber: parsed.quoteNumber,
      specialist: parsed.specialist,
      customer: parsed.customer,
      items: parsed.items,
      balanceDueCents: parsed.balanceDueCents,
      expectedDepositCents: parsed.expectedDepositCents,
      stcSolarRequired: parsed.stcSolarRequired,
      stcBatteryRequired: parsed.stcBatteryRequired,
      solarRebateRequired: parsed.solarRebateRequired,
    }, {
      bytes,
      originalName: safePaymentTrackOriginalName(agreement.name, "agreement.pdf"),
      contentType: "application/pdf",
      size: agreement.size,
    });
    return paymentTrackJson({ data: project }, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentAgreementParseError) {
      return paymentTrackError(422, "extraction_failed", error.message, { missingFields: error.missingFields });
    }
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
