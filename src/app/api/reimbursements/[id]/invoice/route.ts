import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { isReimbursementAdmin } from "@/lib/reimbursements/auth";
import { getReimbursementInvoice } from "@/lib/reimbursements/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function equalToken(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: message, code }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id || id.length > 100) return errorResponse(400, "invalid_id", "The invoice ID is invalid.");

  try {
    const invoice = await getReimbursementInvoice(id);
    if (!invoice) return errorResponse(404, "not_found", "Invoice not found.");
    const suppliedToken = request.nextUrl.searchParams.get("token") || "";
    const admin = isReimbursementAdmin(request);
    const session = getErpSession(request);
    const ownerMatches = Boolean(
      session
      && typeof invoice.ownerUsername === "string"
      && invoice.ownerUsername.toLocaleLowerCase("en-AU") === session.user.username.toLocaleLowerCase("en-AU"),
    );
    // Administrators retain their existing invoice-review access. Everyone
    // else must present the per-file token; an ERP user must additionally own
    // the claim, so a token left in a shared browser cannot cross accounts.
    if (!admin && (!equalToken(suppliedToken, invoice.accessToken) || (session && !ownerMatches))) {
      return errorResponse(403, "forbidden", "You do not have access to this invoice.");
    }

    const storedBytes = await invoice.read();
    const bytes = new Uint8Array(storedBytes.byteLength);
    bytes.set(storedBytes);
    const encodedName = encodeURIComponent(invoice.originalName).replaceAll("'", "%27");
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
        "content-length": String(bytes.byteLength),
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": invoice.contentType,
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return errorResponse(500, "invoice_unavailable", "The invoice is temporarily unavailable.");
  }
}
