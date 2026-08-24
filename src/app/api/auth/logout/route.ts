import { NextRequest, NextResponse } from "next/server";
import { ERP_SESSION_COOKIE } from "@/lib/auth/session";
import { isSameOriginRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "This logout request is not allowed.", code: "forbidden" }, { status: 403 });
  }
  const response = NextResponse.json({ data: { signedOut: true } });
  response.headers.set("cache-control", "no-store");
  response.cookies.set(ERP_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
