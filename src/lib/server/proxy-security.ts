import { erpSessionCanActAs, getErpSession } from "@/lib/auth/session";
export { proxyRequestHeaders, proxyResponseHeaders } from "./proxy-cookie";

function requestProtocol(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded || new URL(request.url).protocol.replace(":", "");
}

/**
 * Browser CSRF guard for same-origin operational routes. This is intentionally
 * separate from authentication: server-to-server callers may omit Origin.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    if (originUrl.origin === requestUrl.origin) return true;

    // Host is the HTTP request target and cannot be changed by cross-origin
    // browser JavaScript. Do not trust a client-supplied x-forwarded-host.
    const host = request.headers.get("host");
    return Boolean(host && originUrl.origin === `${requestProtocol(request)}://${host}`);
  } catch {
    return false;
  }
}

/**
 * Write routes require either a verifiable same-origin browser request or an
 * explicit server-to-server bearer token. A missing Origin is never treated as
 * authorization by itself.
 */
export function isAuthorizedMutationRequest(request: Request): boolean {
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return isSameOriginRequest(request) && Boolean(getErpSession(request));
  }

  const expected = process.env.ERP_INTERNAL_API_TOKEN;
  const authorization = request.headers.get("authorization");
  return Boolean(expected && authorization === `Bearer ${expected}`);
}

export function isAuthorizedActorRequest(request: Request, actorRole: string): boolean {
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return isSameOriginRequest(request) && erpSessionCanActAs(request, actorRole);
  }

  const expected = process.env.ERP_INTERNAL_API_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}
