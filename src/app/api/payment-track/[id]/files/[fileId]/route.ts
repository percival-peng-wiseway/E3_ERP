import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { isPaymentTrackAdmin } from "@/lib/payment-track/auth";
import {
  getPaymentTrackFile,
  PaymentTrackRepositoryError,
} from "@/lib/payment-track/repository";
import { paymentTrackError } from "@/lib/payment-track/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function equalToken(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; fileId: string }> },
) {
  const { id, fileId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(fileId)) {
    return paymentTrackError(400, "invalid_file", "The file reference is invalid.");
  }

  try {
    const file = await getPaymentTrackFile(id, fileId);
    if (!file) return paymentTrackError(404, "not_found", "Project Track file not found.");
    const suppliedToken = request.nextUrl.searchParams.get("token") || "";
    if (!isPaymentTrackAdmin(request) && !equalToken(suppliedToken, file.accessToken)) {
      return paymentTrackError(403, "forbidden", "You do not have access to this file.");
    }

    const storedBytes = await file.read();
    const bytes = new Uint8Array(storedBytes.byteLength);
    bytes.set(storedBytes);
    const encodedName = encodeURIComponent(file.originalName).replaceAll("'", "%27");
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
        "content-length": String(bytes.byteLength),
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": file.contentType,
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) {
      const response = paymentTrackError(error.status, error.code, error.message);
      if (error.code === "file_not_ready") response.headers.set("retry-after", "5");
      return response;
    }
    return paymentTrackError(500, "file_unavailable", "The file is temporarily unavailable.");
  }
}
