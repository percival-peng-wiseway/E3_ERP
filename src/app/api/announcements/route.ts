import { getErpSession, isErpAdmin } from "@/lib/auth/session";
import {
  AnnouncementRepositoryError,
  createAnnouncement,
  listAnnouncements,
} from "@/lib/announcements/repository";
import {
  announcementError,
  AnnouncementInvalidJson,
  announcementJson,
  AnnouncementRequestTooLarge,
  declaredAnnouncementBodyTooLarge,
  isAnnouncementJsonRequest,
  readAnnouncementJsonObject,
} from "@/lib/announcements/request";
import { parseAnnouncementCreate } from "@/lib/announcements/validation";
import { isSameOriginRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function hasQueryParameters(request: Request) {
  return [...new URL(request.url).searchParams.keys()].length > 0;
}

export async function GET(request: Request) {
  if (!getErpSession(request)) {
    return announcementError(401, "authentication_required", "Sign in to view public announcements.");
  }
  if (hasQueryParameters(request)) {
    return announcementError(400, "invalid_query", "Announcements do not accept query parameters.");
  }
  try {
    return announcementJson({ data: await listAnnouncements() });
  } catch {
    return announcementError(500, "storage_unavailable", "Public announcements could not be loaded.");
  }
}

export async function POST(request: Request) {
  const session = getErpSession(request);
  if (!session) {
    return announcementError(401, "authentication_required", "Sign in to publish a public announcement.");
  }
  if (!isSameOriginRequest(request)) {
    return announcementError(403, "origin_forbidden", "Only same-origin requests are allowed.");
  }
  if (!isErpAdmin(request)) {
    return announcementError(403, "admin_required", "Administrator access is required.");
  }
  if (hasQueryParameters(request)) {
    return announcementError(400, "invalid_query", "Publishing does not accept query parameters.");
  }
  if (declaredAnnouncementBodyTooLarge(request)) {
    return announcementError(413, "request_too_large", "The announcement request is too large.");
  }
  if (!isAnnouncementJsonRequest(request)) {
    return announcementError(415, "unsupported_media_type", "Submit the announcement as JSON.");
  }

  try {
    const input = parseAnnouncementCreate(await readAnnouncementJsonObject(request));
    if (!input) {
      return announcementError(
        400,
        "invalid_announcement",
        "Send only title and content. Content is required and the title may be blank.",
      );
    }
    const announcement = await createAnnouncement(input, session.user.displayName);
    return announcementJson({ data: announcement }, { status: 201 });
  } catch (error) {
    if (error instanceof AnnouncementRequestTooLarge) {
      return announcementError(413, "request_too_large", "The announcement request is too large.");
    }
    if (error instanceof AnnouncementInvalidJson) {
      return announcementError(400, "invalid_json", "The request body is invalid.");
    }
    if (error instanceof AnnouncementRepositoryError) {
      return announcementError(error.status, error.code, error.message);
    }
    return announcementError(500, "save_failed", "The public announcement could not be saved.");
  }
}
