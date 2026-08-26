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

    const notificationRole = session.user.role === "specialist" ? "sales" : session.user.role;
    const result = await buildWorkspaceNotifications(notificationRole, {
      includeReimbursements: notificationRole === "admin" || isReimbursementAdmin(request),
      username: session.user.username,
    });
    const visibleCount = result.data.notifications.length;
    result.data.counts = {
      all: visibleCount,
      sales: notificationRole === "sales" ? visibleCount : 0,
      specialist: 0,
      pm: notificationRole === "pm" ? visibleCount : 0,
      admin: notificationRole === "admin" ? visibleCount : 0,
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
