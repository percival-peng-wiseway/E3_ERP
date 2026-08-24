import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  createReimbursementClaimantToken,
  hashReimbursementClaimantToken,
  isReimbursementAdmin,
  REIMBURSEMENT_CLAIMANT_COOKIE,
  REIMBURSEMENT_CLAIMANT_SESSION_SECONDS,
  reimbursementClaimantToken,
} from "@/lib/reimbursements/auth";
import {
  createReimbursement,
  ReimbursementRepositoryError,
  transitionReimbursement,
} from "@/lib/reimbursements/repository";
import { REIMBURSEMENT_ACTIONS, type ReimbursementAction } from "@/lib/reimbursements/types";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
const MAX_MULTIPART_SIZE = MAX_UPLOAD_SIZE + 128 * 1024;
const MAX_JSON_SIZE = 32 * 1024;
const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
type AcceptedType = (typeof ACCEPTED_TYPES)[number];

class RequestBodyTooLarge extends Error {}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function errorResponse(status: number, code: string, message: string) {
  return noStoreJson({ error: message, code }, { status });
}

function declaredBodyTooLarge(request: Request, maximum: number) {
  const value = Number(request.headers.get("content-length"));
  return Number.isFinite(value) && value > maximum;
}

async function readLimitedBody(request: Request, maximum: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonObject(request: Request, maximum: number) {
  const bytes = await readLimitedBody(request, maximum);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected an object");
  return value as Record<string, unknown>;
}

function requiredText(value: FormDataEntryValue | unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length <= maximum ? text : null;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function amountToCents(value: string) {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 1_000_000_000 ? cents : null;
}

function safeOriginalName(value: string) {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").replaceAll("\\", "/").split("/").pop()?.trim() || "invoice";
  return name.slice(0, 180);
}

function fileSignatureMatches(type: AcceptedType, bytes: Uint8Array) {
  if (type === "application/pdf") {
    return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  }
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") {
    const expected = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes.length >= expected.length && timingSafeEqual(Buffer.from(bytes.subarray(0, 8)), Buffer.from(expected));
  }
  return bytes.length >= 12
    && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
}

export async function GET(request: NextRequest) {
  try {
    const { listReimbursements } = await import("@/lib/reimbursements/repository");
    const admin = isReimbursementAdmin(request);
    const claimantToken = reimbursementClaimantToken(request);
    return noStoreJson({
      data: await listReimbursements(admin
        ? { includeAll: true }
        : { ownerTokenHash: claimantToken ? hashReimbursementClaimantToken(claimantToken) : undefined }),
      meta: { admin },
    });
  } catch {
    return errorResponse(500, "storage_unavailable", "Reimbursement records are temporarily unavailable.");
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return errorResponse(403, "forbidden", "This request is not allowed.");
  if (declaredBodyTooLarge(request, MAX_MULTIPART_SIZE)) return errorResponse(413, "file_too_large", "The invoice must be 10 MB or smaller.");

  try {
    const contentTypeHeader = request.headers.get("content-type") || "";
    if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data;")) {
      return errorResponse(415, "unsupported_request", "Submit the reimbursement as a form with one invoice.");
    }
    const rawBody = await readLimitedBody(request, MAX_MULTIPART_SIZE);
    const form = await new Response(rawBody, { headers: { "content-type": contentTypeHeader } }).formData();
    const allowedFields = new Set([
      "claimantName", "expenseDate", "amount", "note", "invoice",
    ]);
    const seenFields = new Set<string>();
    for (const [name] of form.entries()) {
      if (!allowedFields.has(name) || seenFields.has(name)) {
        return errorResponse(400, "invalid_form", "The reimbursement form contains invalid or duplicate fields.");
      }
      seenFields.add(name);
    }
    const claimantName = getErpSession(request)?.user.displayName
      || requiredText(form.get("claimantName"), 120);
    const expenseDate = requiredText(form.get("expenseDate"), 10);
    const note = optionalText(form.get("note"), 2_000);
    const amount = requiredText(form.get("amount"), 20);
    const amountCents = amount ? amountToCents(amount) : null;
    const invoiceValue = form.get("invoice");

    if (!claimantName || !expenseDate || !validDate(expenseDate) || !amountCents || note === null) {
      return errorResponse(400, "invalid_claim", "Complete the name, date and amount with valid information.");
    }
    if (!(invoiceValue instanceof File) || invoiceValue.size < 1 || invoiceValue.size > MAX_UPLOAD_SIZE) {
      return errorResponse(400, "invalid_invoice", "Attach one invoice file up to 10 MB.");
    }
    if (!ACCEPTED_TYPES.includes(invoiceValue.type as AcceptedType)) {
      return errorResponse(415, "unsupported_invoice", "Use a PDF, JPG, PNG or WebP invoice.");
    }

    const bytes = new Uint8Array(await invoiceValue.arrayBuffer());
    const contentType = invoiceValue.type as AcceptedType;
    if (!fileSignatureMatches(contentType, bytes)) {
      return errorResponse(415, "invalid_invoice_content", "The invoice contents do not match its file type.");
    }

    const claimantToken = reimbursementClaimantToken(request) || createReimbursementClaimantToken();
    const claim = await createReimbursement({
      claimantName,
      expenseDate,
      note,
      amountCents,
      currency: "AUD",
      ownerTokenHash: hashReimbursementClaimantToken(claimantToken),
    }, {
      bytes,
      originalName: safeOriginalName(invoiceValue.name),
      contentType,
      size: invoiceValue.size,
    });
    const response = noStoreJson({ data: claim }, { status: 201 });
    response.cookies.set(REIMBURSEMENT_CLAIMANT_COOKIE, claimantToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/api/reimbursements",
      maxAge: REIMBURSEMENT_CLAIMANT_SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      return errorResponse(413, "file_too_large", "The invoice must be 10 MB or smaller.");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return errorResponse(400, "invalid_form", "The reimbursement form is invalid.");
    }
    return errorResponse(500, "create_failed", "The reimbursement could not be submitted.");
  }
}

export async function PATCH(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return errorResponse(403, "forbidden", "This request is not allowed.");
  if (!isReimbursementAdmin(request)) return errorResponse(401, "admin_required", "Administrator access is required.");
  if (declaredBodyTooLarge(request, MAX_JSON_SIZE)) return errorResponse(413, "request_too_large", "The request is too large.");

  try {
    const body = await readJsonObject(request, MAX_JSON_SIZE);
    const id = requiredText(body.id, 100);
    const action = typeof body.action === "string" && REIMBURSEMENT_ACTIONS.includes(body.action as ReimbursementAction)
      ? body.action as ReimbursementAction
      : null;
    const note = optionalText(body.note, 1_000);
    const paymentReference = optionalText(body.paymentReference, 200);
    if (!id || !action || note === null || paymentReference === null) {
      return errorResponse(400, "invalid_action", "The reimbursement action is invalid.");
    }
    if (action === "reject" && !note) return errorResponse(400, "note_required", "Add a reason before rejecting this claim.");
    if (action === "mark_paid" && !paymentReference) {
      return errorResponse(400, "payment_reference_required", "Add a payment reference before marking this claim as paid.");
    }

    const claim = await transitionReimbursement(id, action, {
      note,
      paymentReference,
      actor: "Administrator",
    });
    return noStoreJson({ data: claim });
  } catch (error) {
    if (error instanceof ReimbursementRepositoryError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof SyntaxError) return errorResponse(400, "invalid_json", "The request body is invalid.");
    if (error instanceof RequestBodyTooLarge) return errorResponse(413, "request_too_large", "The request is too large.");
    return errorResponse(500, "update_failed", "The reimbursement could not be updated.");
  }
}
