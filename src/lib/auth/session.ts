import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { erpRoleCanActAs } from "@/lib/auth/accounts";
import { findErpUser } from "@/lib/auth/directory";
import { isAcceptableErpSessionSecret } from "@/lib/auth/session-secret";
import type { ErpSession, ErpUser } from "@/lib/auth/types";

export const ERP_SESSION_COOKIE = "e3_erp_session";
export const ERP_SESSION_SECONDS = 12 * 60 * 60;

const DEVELOPMENT_SESSION_SECRET = "local-e3-erp-session-secret-change-before-production";

type SessionPayload = {
  version: 1;
  username: string;
  expiresAt: number;
};

function sessionSecret() {
  const supplied = process.env.ERP_AUTH_SESSION_SECRET?.trim() || "";
  if (isAcceptableErpSessionSecret(supplied)) return supplied;
  return process.env.NODE_ENV === "production" ? "" : DEVELOPMENT_SESSION_SECRET;
}

export function erpAuthConfiguration() {
  return {
    configured: Boolean(sessionSecret()),
    sessionSeconds: ERP_SESSION_SECONDS,
  };
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function signaturesMatch(left: string, right: string) {
  try {
    const leftBytes = Buffer.from(left, "base64url");
    const rightBytes = Buffer.from(right, "base64url");
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

export function createErpSessionToken(user: ErpUser) {
  const secret = sessionSecret();
  if (!secret) throw new Error("ERP employee access is not configured.");
  const payload: SessionPayload = {
    version: 1,
    username: user.username,
    expiresAt: Math.floor(Date.now() / 1000) + ERP_SESSION_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function readErpSessionToken(token: string): ErpSession | null {
  const secret = sessionSecret();
  if (!secret || !token || token.length > 2_048) return null;
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length) return null;
  if (!signaturesMatch(suppliedSignature, sign(encoded, secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (payload.version !== 1
      || typeof payload.username !== "string"
      || typeof payload.expiresAt !== "number"
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    const user = findErpUser(payload.username);
    return user ? { user, expiresAt: payload.expiresAt } : null;
  } catch {
    return null;
  }
}

export function requestCookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

export function getErpSession(request: Request) {
  return readErpSessionToken(requestCookieValue(request, ERP_SESSION_COOKIE));
}

export function isErpAdmin(request: Request) {
  return getErpSession(request)?.user.role === "admin";
}

export function erpSessionCanActAs(request: Request, actorRole: string) {
  const session = getErpSession(request);
  return Boolean(session && erpRoleCanActAs(session.user.role, actorRole));
}
