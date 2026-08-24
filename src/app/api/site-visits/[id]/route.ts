import { NextRequest } from "next/server";
import {
  deleteSiteVisit,
  getSiteVisit,
  SiteVisitRepositoryError,
  updateSiteVisit,
} from "@/lib/site-visits/repository";
import {
  declaredSiteVisitBodyTooLarge,
  readSiteVisitBody,
  readSiteVisitJson,
  siteVisitError,
  siteVisitJson,
  SiteVisitRequestBodyTooLarge,
} from "@/lib/site-visits/request";
import { parseSiteVisitPatch } from "@/lib/site-visits/validation";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 128 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function siteVisitId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return ID_PATTERN.test(id) ? id : null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const id = await siteVisitId(context);
  if (!id) return siteVisitError(400, "invalid_id", "The site visit ID is invalid.");
  if ([...request.nextUrl.searchParams.keys()].length) {
    return siteVisitError(400, "invalid_query", "Site visit details do not accept query parameters.");
  }
  try {
    const visit = await getSiteVisit(id);
    return visit
      ? siteVisitJson({ data: { visit } })
      : siteVisitError(404, "not_found", "Site visit not found.");
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    return siteVisitError(500, "storage_unavailable", "The site visit is temporarily unavailable.");
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return siteVisitError(403, "forbidden", "This request is not allowed.");
  }
  const id = await siteVisitId(context);
  if (!id) return siteVisitError(400, "invalid_id", "The site visit ID is invalid.");
  if (declaredSiteVisitBodyTooLarge(request, MAX_JSON_SIZE)) {
    return siteVisitError(413, "request_too_large", "The site visit update is too large.");
  }
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return siteVisitError(415, "unsupported_request", "Submit the site visit update as JSON.");
  }
  try {
    const patch = parseSiteVisitPatch(await readSiteVisitJson(request, MAX_JSON_SIZE));
    if (!patch) return siteVisitError(400, "invalid_visit", "The site visit update is invalid.");
    return siteVisitJson({ data: { visit: await updateSiteVisit(id, patch) } });
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    if (error instanceof SiteVisitRequestBodyTooLarge) {
      return siteVisitError(413, "request_too_large", "The site visit update is too large.");
    }
    if (error instanceof SyntaxError) {
      return siteVisitError(400, "invalid_json", "The site visit update is invalid.");
    }
    return siteVisitError(500, "update_failed", "The site visit could not be updated.");
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return siteVisitError(403, "forbidden", "This request is not allowed.");
  }
  if (!isAuthorizedActorRequest(request, "admin")) {
    return siteVisitError(403, "role_forbidden", "Only Administrators can delete site visits.");
  }
  const id = await siteVisitId(context);
  if (!id) return siteVisitError(400, "invalid_id", "The site visit ID is invalid.");
  if ([...request.nextUrl.searchParams.keys()].length) {
    return siteVisitError(400, "invalid_query", "Delete does not accept query parameters.");
  }
  try {
    const body = await readSiteVisitBody(request, 1);
    if (body.byteLength) return siteVisitError(400, "invalid_request", "Delete does not accept a request body.");
    await deleteSiteVisit(id);
    return siteVisitJson({ data: { id } });
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    if (error instanceof SiteVisitRequestBodyTooLarge) {
      return siteVisitError(400, "invalid_request", "Delete does not accept a request body.");
    }
    return siteVisitError(500, "delete_failed", "The site visit could not be deleted.");
  }
}
