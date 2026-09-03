import { NextRequest, NextResponse } from "next/server";
import { hasValidEdgeSession } from "@/lib/auth/edge-session";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
]);

const REMOTE_READ_ONLY_POST_PATHS = new Set([
  "/api/agent",
  "/api/agent/attachments/status",
  "/api/agent/chat",
]);

function remoteDataMutationBlocked(request: NextRequest) {
  if (process.env.ERP_REMOTE_DATA_READ_ONLY !== "true") return false;
  if (!request.nextUrl.pathname.startsWith("/api/")) return false;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return method !== "POST" || !REMOTE_READ_ONLY_POST_PATHS.has(request.nextUrl.pathname);
}

function remoteDataReadOnlyResponse() {
  const response = NextResponse.json({
    error: "This local environment is connected to production data in read-only mode.",
    code: "remote_data_read_only",
  }, { status: 403 });
  response.headers.set("cache-control", "no-store");
  return response;
}

function trustedServerRequest(request: NextRequest) {
  const expected = process.env.ERP_INTERNAL_API_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const authenticated = await hasValidEdgeSession(request);

  if (PUBLIC_PATHS.has(pathname)) {
    if (pathname === "/login" && authenticated) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (authenticated || (pathname.startsWith("/api/") && trustedServerRequest(request))) {
    if (remoteDataMutationBlocked(request)) return remoteDataReadOnlyResponse();
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const response = NextResponse.json({
      error: "Authentication is required.",
      code: "authentication_required",
    }, { status: 401 });
    response.headers.set("cache-control", "no-store");
    return response;
  }

  const loginUrl = new URL("/login", request.url);
  const destination = `${pathname}${search}`;
  if (destination !== "/") loginUrl.searchParams.set("next", destination);
  return NextResponse.redirect(loginUrl);
}

export const runtime = "experimental-edge";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
