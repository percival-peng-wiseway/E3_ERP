import {
  isAuthorizedMutationRequest,
  isSameOriginRequest,
  proxyRequestHeaders,
  proxyResponseHeaders,
} from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";

const DEFAULT_QUOTEHELP_URL = "https://quote.e3energy.com.au";
const REQUEST_BODY_LIMIT = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const ALLOWED_METHODS_BY_PATH: Record<string, ReadonlySet<string>> = {
  session: new Set(["GET"]),
  login: new Set(["POST"]),
  logout: new Set(["POST"]),
  settings: new Set(["PUT"]),
  quotes: new Set(["POST", "PUT", "DELETE"]),
  "quotes/import": new Set(["POST"]),
};
const COOKIE_NAMESPACE = {
  prefix: "__erp_quotehelp_",
  path: "/api/quotehelp",
};

type RouteContext = { params: Promise<{ path: string[] }> };

class PayloadTooLargeError extends Error {}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: message, code }, { status });
}

function quoteHelpTarget(request: Request, normalizedPath: string): URL {
  const target = new URL(process.env.QUOTEHELP_APP_URL || DEFAULT_QUOTEHELP_URL);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Unsupported QuoteHelp upstream protocol");
  }
  target.pathname = `/api/${normalizedPath}`;
  target.search = new URL(request.url).search;
  target.hash = "";
  return target;
}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new PayloadTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function asRequestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function relay(upstream: Response, request: Request): Response {
  const hasNoBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(hasNoBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream, request, COOKIE_NAMESPACE),
  });
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: unknown }).name === "TimeoutError" ||
      (error as { name?: unknown }).name === "AbortError")
  );
}

async function proxyQuoteHelp(request: Request, context: RouteContext): Promise<Response> {
  const originAllowed = request.method === "GET"
    ? isSameOriginRequest(request)
    : isAuthorizedMutationRequest(request);
  if (!originAllowed) {
    return jsonError(403, "REQUEST_FORBIDDEN", "Requests must come from the same-origin application or use a valid internal service token for writes.");
  }

  const { path } = await context.params;
  const normalizedPath = Array.isArray(path) ? path.join("/") : "";
  const allowedMethods = ALLOWED_METHODS_BY_PATH[normalizedPath];
  if (!allowedMethods) {
    return jsonError(404, "PATH_NOT_ALLOWED", "This QuoteHelp API path is not allowed.");
  }
  if (!allowedMethods.has(request.method)) {
    return jsonError(405, "METHOD_NOT_ALLOWED", "This request method is not allowed.");
  }

  let target: URL;
  try {
    target = quoteHelpTarget(request, normalizedPath);
  } catch (error) {
    console.error("Invalid QuoteHelp proxy configuration", error);
    return jsonError(500, "UPSTREAM_MISCONFIGURED", "The QuoteHelp service URL is invalid.");
  }
  let body: Uint8Array | undefined;
  if (request.method !== "GET") {
    try {
      const bytes = await readLimitedBody(request, REQUEST_BODY_LIMIT);
      if (bytes.byteLength) body = bytes;
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return jsonError(413, "PAYLOAD_TOO_LARGE", "The request body cannot exceed 25 MiB.");
      }
      return jsonError(400, "INVALID_BODY", "The request body could not be read.");
    }
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: proxyRequestHeaders(
        request,
        COOKIE_NAMESPACE,
        request.headers.get("content-type") || undefined,
      ),
      body: body ? asRequestBody(body) : undefined,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return relay(upstream, request);
  } catch (error) {
    console.error("QuoteHelp API proxy failed", error);
    return isTimeout(error)
      ? jsonError(504, "UPSTREAM_TIMEOUT", "The QuoteHelp service timed out.")
      : jsonError(502, "UPSTREAM_UNAVAILABLE", "The QuoteHelp service is temporarily unavailable.");
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxyQuoteHelp(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxyQuoteHelp(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxyQuoteHelp(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxyQuoteHelp(request, context);
}
