import { NextRequest, NextResponse } from "next/server";
import { isReimbursementAdmin } from "@/lib/reimbursements/auth";
import {
  deleteReimbursement,
  ReimbursementRepositoryError,
} from "@/lib/reimbursements/repository";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function errorResponse(status: number, code: string, message: string) {
  return noStoreJson({ error: message, code }, { status });
}

async function requestHasBody(request: Request) {
  if (!request.body) return false;
  const reader = request.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return false;
    if (value.byteLength) {
      await reader.cancel().catch(() => undefined);
      return true;
    }
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return errorResponse(403, "forbidden", "This request is not allowed.");
  }
  if (!isReimbursementAdmin(request)) {
    return errorResponse(403, "admin_required", "Administrator access is required.");
  }

  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) {
    return errorResponse(400, "invalid_id", "The reimbursement ID is invalid.");
  }
  if ([...request.nextUrl.searchParams.keys()].length) {
    return errorResponse(400, "invalid_query", "Delete does not accept query parameters.");
  }

  try {
    if (await requestHasBody(request)) {
      return errorResponse(400, "invalid_request", "Delete does not accept a request body.");
    }
    await deleteReimbursement(id);
    return noStoreJson({ data: { id } });
  } catch (error) {
    if (error instanceof ReimbursementRepositoryError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "delete_failed", "The reimbursement could not be deleted.");
  }
}
