import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { PaymentTrackUploadContentType } from "./types";
import { readLimitedPaymentTrackBody } from "./body-reader";
export {
  PaymentTrackRequestBodyTooLarge,
  readLimitedPaymentTrackBody,
  readPaymentTrackForm,
} from "./body-reader";
export {
  optionalPaymentTrackText,
  paymentTrackAmountToCents,
  requiredPaymentTrackText,
} from "./input-validation";

export function paymentTrackJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export function paymentTrackError(status: number, code: string, message: string, details?: unknown) {
  return paymentTrackJson({ error: message, code, ...(details === undefined ? {} : { details }) }, { status });
}

export function declaredPaymentTrackBodyTooLarge(request: Request, maximum: number) {
  const value = Number(request.headers.get("content-length"));
  return Number.isFinite(value) && value > maximum;
}

export async function readPaymentTrackJson(request: Request, maximum: number) {
  const bytes = await readLimitedPaymentTrackBody(request, maximum);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected an object");
  return value as Record<string, unknown>;
}

export function strictFormFields(form: FormData, allowed: Set<string>) {
  const seen = new Set<string>();
  for (const [name] of form.entries()) {
    if (!allowed.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

export function safePaymentTrackOriginalName(value: string, fallback: string) {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim() || fallback;
  return name.slice(0, 180);
}

export function paymentTrackFileSignatureMatches(type: PaymentTrackUploadContentType, bytes: Uint8Array) {
  if (type === "application/pdf") {
    return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  }
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") {
    const expected = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes.length >= expected.length
      && timingSafeEqual(Buffer.from(bytes.subarray(0, 8)), Buffer.from(expected));
  }
  return bytes.length >= 12
    && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
}

export function paymentTrackDateIsValid(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
