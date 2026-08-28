import { NextRequest } from "next/server";
import {
  isPaymentTrackAdmin,
  paymentTrackAdminConfiguration,
} from "@/lib/payment-track/auth";
import {
  createManualPaymentTrackProject,
  listPaymentTrackProjects,
  PaymentTrackRepositoryError,
} from "@/lib/payment-track/repository";
import { parsePaymentTrackCreateInput } from "@/lib/payment-track/create-input";
import {
  declaredPaymentTrackBodyTooLarge,
  paymentTrackError,
  paymentTrackJson,
  PaymentTrackRequestBodyTooLarge,
  readPaymentTrackJson,
} from "@/lib/payment-track/request";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 128 * 1024;

export async function GET(request: NextRequest) {
  try {
    const configuration = paymentTrackAdminConfiguration();
    return paymentTrackJson({
      data: await listPaymentTrackProjects(),
      meta: {
        admin: isPaymentTrackAdmin(request),
        configured: configuration.configured,
        ...(configuration.demoPassword ? { demoPassword: configuration.demoPassword } : {}),
      },
    });
  } catch {
    return paymentTrackError(500, "storage_unavailable", "Project Track records are temporarily unavailable.");
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_JSON_SIZE)) {
    return paymentTrackError(413, "request_too_large", "The project request is too large.");
  }
  try {
    const body = await readPaymentTrackJson(request, MAX_JSON_SIZE);
    if (!isAuthorizedActorRequest(request, "sales")) {
      return paymentTrackError(403, "role_forbidden", "Only Sales or an Administrator can create a project in Project Track.");
    }
    const input = parsePaymentTrackCreateInput(body);
    if (!input) {
      return paymentTrackError(400, "invalid_project", "Complete the Proposal Number, Sales representative, customer, item and balance information.");
    }
    return paymentTrackJson({ data: await createManualPaymentTrackProject(input) }, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "The project request is too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The project request is invalid.");
    return paymentTrackError(500, "create_failed", "The project could not be created.");
  }
}
