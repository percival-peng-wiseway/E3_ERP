import { createHmac, timingSafeEqual } from "node:crypto";
import { getErpSession } from "@/lib/auth/session";
import {
  reimbursementAdminConfiguration,
  verifyReimbursementAdminPassword,
} from "@/lib/reimbursements/auth";

export const PAYMENT_TRACK_ADMIN_COOKIE = "e3_payment_track_admin";
export const PAYMENT_TRACK_ADMIN_SESSION_SECONDS = 8 * 60 * 60;

function equalText(left: string, right: string) {
  const leftDigest = createHmac("sha256", "payment-track-compare").update(left).digest();
  const rightDigest = createHmac("sha256", "payment-track-compare").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function paymentTrackAdminConfiguration() {
  return reimbursementAdminConfiguration();
}

export function verifyPaymentTrackAdminPassword(value: string) {
  return verifyReimbursementAdminPassword(value);
}

export function createPaymentTrackAdminToken() {
  const { secret } = paymentTrackAdminConfiguration();
  if (!secret) throw new Error("Project Track administrator access is not configured.");
  const expiresAt = Math.floor(Date.now() / 1000) + PAYMENT_TRACK_ADMIN_SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({ scope: "payment_track", role: "admin", expiresAt }), "utf8")
    .toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

export function isPaymentTrackAdmin(request: Request) {
  const employeeSession = getErpSession(request);
  if (employeeSession) return employeeSession.user.role === "admin";
  const { secret } = paymentTrackAdminConfiguration();
  const token = cookieValue(request, PAYMENT_TRACK_ADMIN_COOKIE);
  if (!secret || !token) return false;
  const [payload, suppliedSignature, ...extra] = token.split(".");
  if (!payload || !suppliedSignature || extra.length) return false;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!equalText(suppliedSignature, expectedSignature)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      scope?: unknown;
      role?: unknown;
      expiresAt?: unknown;
    };
    return decoded.scope === "payment_track"
      && decoded.role === "admin"
      && typeof decoded.expiresAt === "number"
      && decoded.expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
