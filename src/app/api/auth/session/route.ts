import { NextRequest, NextResponse } from "next/server";
import { erpAuthConfiguration, getErpSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest) {
  const session = getErpSession(request);
  const response = NextResponse.json({
    data: {
      authenticated: Boolean(session),
      user: session?.user || null,
      expiresAt: session?.expiresAt || null,
      configured: erpAuthConfiguration().configured,
    },
  }, { status: session ? 200 : 401 });
  response.headers.set("cache-control", "no-store");
  return response;
}
