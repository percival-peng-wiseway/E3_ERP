import { NextResponse } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import { buildWorkspaceNotifications } from "@/lib/notifications/service";
import { isReimbursementAdmin } from "@/lib/reimbursements/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const session = getErpSession(request);
    if (!session) {
      return noStoreJson({
        error: "Authentication is required.",
        code: "authentication_required",
      }, { status: 401 });
    }

    const result = await buildWorkspaceNotifications(session.user.role, {
      includeReimbursements: session.user.role === "admin" || isReimbursementAdmin(request),
    });
    const visibleCount = result.data.notifications.length;
    result.data.counts = {
      all: visibleCount,
      sales: session.user.role === "sales" ? visibleCount : 0,
      specialist: session.user.role === "specialist" ? visibleCount : 0,
      pm: session.user.role === "pm" ? visibleCount : 0,
      admin: session.user.role === "admin" ? visibleCount : 0,
    };
    return noStoreJson(result);
  } catch {
    return noStoreJson({
      error: {
        code: "NOTIFICATIONS_UNAVAILABLE",
        message: "Notifications are temporarily unavailable.",
      },
    }, { status: 500 });
  }
}
