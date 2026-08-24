import { NextResponse } from "next/server";
import {
  buildWorkspaceNotifications,
  isNotificationRoleFilter,
} from "@/lib/notifications/service";
import { isReimbursementAdmin } from "@/lib/reimbursements/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const role = new URL(request.url).searchParams.get("role") || "all";
  if (!isNotificationRoleFilter(role)) {
    return noStoreJson({
      error: {
        code: "INVALID_ROLE",
        message: "Role must be all, sales, specialist, pm or admin.",
      },
    }, { status: 400 });
  }

  try {
    return noStoreJson(await buildWorkspaceNotifications(role, {
      includeReimbursements: isReimbursementAdmin(request),
    }));
  } catch {
    return noStoreJson({
      error: {
        code: "NOTIFICATIONS_UNAVAILABLE",
        message: "Notifications are temporarily unavailable.",
      },
    }, { status: 500 });
  }
}
