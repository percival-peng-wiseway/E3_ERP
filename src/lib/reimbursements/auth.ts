import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getErpSession } from "@/lib/auth/session";

export const REIMBURSEMENT_ADMIN_COOKIE = "e3_reimbursement_admin";
export const REIMBURSEMENT_CLAIMANT_COOKIE = "e3_reimbursement_claimant";
export const REIMBURSEMENT_ADMIN_SESSION_SECONDS = 8 * 60 * 60;
export const REIMBURSEMENT_CLAIMANT_SESSION_SECONDS = 180 * 24 * 60 * 60;

const DEVELOPMENT_SECRET = "local-reimbursement-session-secret-change-before-production";

function developmentFallbackEnabled() {
  return process.env.NODE_ENV !== "production" && !process.env.REIMBURSEMENT_ADMIN_PASSWORD;
}

export function reimbursementAdminConfiguration() {
  const demo = developmentFallbackEnabled();
  const production = process.env.NODE_ENV === "production";
  const suppliedPassword = process.env.REIMBURSEMENT_ADMIN_PASSWORD || "";
  const suppliedSecret = process.env.REIMBURSEMENT_SESSION_SECRET || "";
  const productionReady = Boolean(suppliedPassword && suppliedSecret.length >= 32);
  return {
    password: production ? (productionReady ? suppliedPassword : "") : suppliedPassword || "admin",
    secret: production ? (productionReady ? suppliedSecret : "") : suppliedSecret || DEVELOPMENT_SECRET,
    configured: productionReady,
    demoPassword: demo ? "admin" : undefined,
  };
}

function equalText(left: string, right: string) {
  const leftDigest = createHmac("sha256", "reimbursement-compare").update(left).digest();
  const rightDigest = createHmac("sha256", "reimbursement-compare").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyReimbursementAdminPassword(value: string) {
  const configuration = reimbursementAdminConfiguration();
  return Boolean(configuration.password && equalText(value, configuration.password));
}

export function createReimbursementAdminToken() {
  const { secret } = reimbursementAdminConfiguration();
  if (!secret) throw new Error("Reimbursement administrator access is not configured.");
  const expiresAt = Math.floor(Date.now() / 1000) + REIMBURSEMENT_ADMIN_SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({ role: "admin", expiresAt }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function reimbursementCookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const [candidate, ...rest] = part.trim().split("=");
    if (candidate === name) return rest.join("=");
  }
  return "";
}

export function isReimbursementAdmin(request: Request) {
  const employeeSession = getErpSession(request);
  if (employeeSession) return employeeSession.user.role === "admin";
  const { secret } = reimbursementAdminConfiguration();
  const token = reimbursementCookieValue(request, REIMBURSEMENT_ADMIN_COOKIE);
  if (!secret || !token) return false;
  const [payload, suppliedSignature, ...extra] = token.split(".");
  if (!payload || !suppliedSignature || extra.length) return false;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!equalText(suppliedSignature, expectedSignature)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      role?: unknown;
      expiresAt?: unknown;
    };
    return decoded.role === "admin"
      && typeof decoded.expiresAt === "number"
      && decoded.expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function createReimbursementClaimantToken() {
  return randomBytes(32).toString("base64url");
}

export function reimbursementClaimantToken(request: Request) {
  const token = reimbursementCookieValue(request, REIMBURSEMENT_CLAIMANT_COOKIE);
  return /^[A-Za-z0-9_-]{40,60}$/.test(token) ? token : "";
}

export function hashReimbursementClaimantToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
