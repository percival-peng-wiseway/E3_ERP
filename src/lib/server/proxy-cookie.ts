export type CookieNamespace = {
  prefix: string;
  path: string;
  legacyPaths?: string[];
};

type NamespacedCookie = {
  namespacedName: string;
  upstreamName: string;
  value: string;
};

function requestProtocol(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded || new URL(request.url).protocol.replace(":", "");
}

function namespacedRequestCookies(request: Request, namespace: CookieNamespace): NamespacedCookie[] {
  const source = request.headers.get("cookie");
  if (!source) return [];

  const selected: NamespacedCookie[] = [];
  const seen = new Set<string>();
  for (const part of source.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator);
    if (!name.startsWith(namespace.prefix)) continue;
    const upstreamName = name.slice(namespace.prefix.length);
    if (!upstreamName || seen.has(upstreamName)) continue;
    seen.add(upstreamName);
    selected.push({
      namespacedName: name,
      upstreamName,
      value: trimmed.slice(separator + 1),
    });
  }
  return selected;
}

function namespacedRequestCookie(request: Request, namespace: CookieNamespace): string | undefined {
  const selected = namespacedRequestCookies(request, namespace)
    .map(({ upstreamName, value }) => `${upstreamName}=${value}`);
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

  const refreshedCookieNames = new Set<string>();
  for (const source of upstreamSetCookies(upstream.headers)) {
    const rewritten = rewriteSetCookie(source, namespace, isLoopbackHttp(request));
    if (rewritten) headers.append("set-cookie", rewritten);
    const nameValue = source.split(";", 1)[0] || "";
    const separator = nameValue.indexOf("=");
    const name = separator > 0 ? nameValue.slice(0, separator).trim() : "";
    if (name) refreshedCookieNames.add(name);
    for (const legacyPath of namespace.legacyPaths || []) {
      if (name) headers.append(
        "set-cookie",
        `${namespace.prefix}${name}=; Path=${legacyPath}; Max-Age=0; HttpOnly; SameSite=Lax`,
      );
    }
  }

  // Existing QuoteHelp cookies were historically scoped to /api/quotehelp.
  // Promote them when the proxy is next used even if the upstream session
  // endpoint does not refresh Set-Cookie, then expire the narrower copy.
  if (namespace.legacyPaths?.length) {
    const secure = isLoopbackHttp(request) ? "" : "; Secure";
    for (const cookie of namespacedRequestCookies(request, namespace)) {
      if (refreshedCookieNames.has(cookie.upstreamName)) continue;
      headers.append(
        "set-cookie",
        `${cookie.namespacedName}=${cookie.value}; Path=${namespace.path}; HttpOnly; SameSite=Lax${secure}`,
      );
      for (const legacyPath of namespace.legacyPaths) {
        headers.append(
          "set-cookie",
          `${cookie.namespacedName}=; Path=${legacyPath}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
        );
      }
    }
  }
  return headers;
}
