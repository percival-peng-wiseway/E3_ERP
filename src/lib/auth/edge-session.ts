import { ERP_USERNAMES } from "@/lib/auth/directory";
import { isAcceptableErpSessionSecret } from "@/lib/auth/session-secret";

const SESSION_COOKIE = "e3_erp_session";
const DEVELOPMENT_SESSION_SECRET = "local-e3-erp-session-secret-change-before-production";
const ACTIVE_USERNAMES = new Set(ERP_USERNAMES);

type SessionPayload = {
  version?: unknown;
  username?: unknown;
  expiresAt?: unknown;
};

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

function base64UrlBytes(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function hasValidEdgeSession(request: Request) {
  const suppliedSecret = process.env.ERP_AUTH_SESSION_SECRET?.trim() || "";
  const secret = isAcceptableErpSessionSecret(suppliedSecret)
    ? suppliedSecret
    : process.env.NODE_ENV === "production" ? "" : DEVELOPMENT_SESSION_SECRET;
  const token = cookieValue(request, SESSION_COOKIE);
  if (secret.length < 32 || !token || token.length > 2_048) return false;
  const [encoded, signature, ...extra] = token.split(".");
  if (!encoded || !signature || extra.length) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlBytes(signature),
      new TextEncoder().encode(encoded),
    );
    if (!validSignature) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(encoded))) as SessionPayload;
    return payload.version === 1
      && typeof payload.username === "string"
      && ACTIVE_USERNAMES.has(payload.username)
      && typeof payload.expiresAt === "number"
      && Number.isSafeInteger(payload.expiresAt)
      && payload.expiresAt > Math.floor(Date.now() / 1_000);
  } catch {
    return false;
  }
}
