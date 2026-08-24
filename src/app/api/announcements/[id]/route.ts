import { getErpSession, isErpAdmin } from "@/lib/auth/session";
import {
  AnnouncementRepositoryError,
  deleteAnnouncement,
  updateAnnouncement,
} from "@/lib/announcements/repository";
import {
  announcementError,
  AnnouncementInvalidJson,
  announcementJson,
  AnnouncementRequestTooLarge,
  declaredAnnouncementBodyTooLarge,
  isAnnouncementJsonRequest,
  readAnnouncementBody,
  readAnnouncementJsonObject,
} from "@/lib/announcements/request";
import { parseAnnouncementPatch } from "@/lib/announcements/validation";
import { isSameOriginRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function announcementId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return ID_PATTERN.test(id) ? id : null;
}

function mutationAuthorizationError(request: Request) {
  if (!getErpSession(request)) {
    return announcementError(401, "authentication_required", "Sign in to manage public announcements.");
  }
  if (!isSameOriginRequest(request)) {
    return announcementError(403, "origin_forbidden", "Only same-origin requests are allowed.");
  }
  if (!isErpAdmin(request)) {
    return announcementError(403, "admin_required", "Administrator access is required.");
  }
  return null;
}

function repositoryError(error: unknown) {
  return error instanceof AnnouncementRepositoryError
    ? announcementError(error.status, error.code, error.message)
    : null;
}

function hasQueryParameters(request: Request) {
  return [...new URL(request.url).searchParams.keys()].length > 0;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authorizationError = mutationAuthorizationError(request);
  if (authorizationError) return authorizationError;
  const id = await announcementId(context);
  if (!id) return announcementError(400, "invalid_id", "The announcement ID is invalid.");
  if (hasQueryParameters(request)) {
    return announcementError(400, "invalid_query", "Updating does not accept query parameters.");
  }
  if (declaredAnnouncementBodyTooLarge(request)) {
    return announcementError(413, "request_too_large", "The announcement update is too large.");
  }
  if (!isAnnouncementJsonRequest(request)) {
    return announcementError(415, "unsupported_media_type", "Submit the announcement update as JSON.");
  }

  try {
    const patch = parseAnnouncementPatch(await readAnnouncementJsonObject(request));
    if (!patch) {
      return announcementError(400, "invalid_announcement", "Update only title or content using valid values.");
    }
    return announcementJson({ data: await updateAnnouncement(id, patch) });
  } catch (error) {
    const known = repositoryError(error);
    if (known) return known;
    if (error instanceof AnnouncementRequestTooLarge) {
      return announcementError(413, "request_too_large", "The announcement update is too large.");
    }
    if (error instanceof AnnouncementInvalidJson) {
      return announcementError(400, "invalid_json", "The request body is invalid.");
    }
    return announcementError(500, "update_failed", "The public announcement could not be updated.");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authorizationError = mutationAuthorizationError(request);
  if (authorizationError) return authorizationError;
  const id = await announcementId(context);
  if (!id) return announcementError(400, "invalid_id", "The announcement ID is invalid.");
  if (hasQueryParameters(request)) {
    return announcementError(400, "invalid_query", "Deleting does not accept query parameters.");
  }

  try {
    const body = await readAnnouncementBody(request, 1);
    if (body.byteLength) {
      return announcementError(400, "invalid_request", "DELETE does not accept a request body.");
    }
    await deleteAnnouncement(id);
    return announcementJson({ data: { id } });
  } catch (error) {
    const known = repositoryError(error);
    if (known) return known;
    if (error instanceof AnnouncementRequestTooLarge) {
      return announcementError(400, "invalid_request", "DELETE does not accept a request body.");
    }
    return announcementError(500, "delete_failed", "The public announcement could not be deleted.");
  }
}
