type CookieNamespace = {
  prefix: string;
  path: string;
};

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
    return isSameOriginRequest(request);
  }

  const expected = process.env.ERP_INTERNAL_API_TOKEN;
  const authorization = request.headers.get("authorization");
  return Boolean(expected && authorization === `Bearer ${expected}`);
}

function namespacedRequestCookie(request: Request, namespace: CookieNamespace): string | undefined {
  const source = request.headers.get("cookie");
  if (!source) return undefined;

  const selected: string[] = [];
  for (const part of source.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator);
    if (!name.startsWith(namespace.prefix)) continue;
    const upstreamName = name.slice(namespace.prefix.length);
    if (!upstreamName) continue;
    selected.push(`${upstreamName}=${trimmed.slice(separator + 1)}`);
  }
  return selected.length ? selected.join("; ") : undefined;
}

export function proxyRequestHeaders(
  request: Request,
  namespace: CookieNamespace,
  contentType?: string,
): Headers {
  const headers = new Headers({ Accept: request.headers.get("accept") || "application/json" });
  const cookie = namespacedRequestCookie(request, namespace);
  if (cookie) headers.set("cookie", cookie);
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

function upstreamSetCookies(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatible.getSetCookie === "function") return compatible.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function isLoopbackHttp(request: Request): boolean {
  if (requestProtocol(request) !== "http") return false;
  try {
    const host = request.headers.get("host") || new URL(request.url).host;
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function rewriteSetCookie(
  source: string,
  namespace: CookieNamespace,
  allowInsecureLoopback: boolean,
): string | null {
  const parts = source.split(";");
  const nameValue = parts.shift()?.trim() || "";
  const separator = nameValue.indexOf("=");
  if (separator < 1) return null;

  const name = nameValue.slice(0, separator);
  const value = nameValue.slice(separator + 1);
  const attributes: string[] = [];
  let hasHttpOnly = false;
  let hasSameSite = false;

  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    if (!attribute) continue;
    const lower = attribute.toLowerCase();
    if (lower.startsWith("domain=") || lower.startsWith("path=")) continue;
    if (allowInsecureLoopback && lower === "secure") continue;
    if (lower === "httponly") hasHttpOnly = true;
    if (lower.startsWith("samesite=")) hasSameSite = true;
    attributes.push(attribute);
  }

  if (!hasHttpOnly) attributes.push("HttpOnly");
  if (!hasSameSite) attributes.push("SameSite=Lax");
  return [
    `${namespace.prefix}${name}=${value}`,
    `Path=${namespace.path}`,
    ...attributes,
  ].join("; ");
}

export function proxyResponseHeaders(
  upstream: Response,
  request: Request,
  namespace: CookieNamespace,
): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");

  for (const source of upstreamSetCookies(upstream.headers)) {
    const rewritten = rewriteSetCookie(source, namespace, isLoopbackHttp(request));
    if (rewritten) headers.append("set-cookie", rewritten);
  }
  return headers;
}
