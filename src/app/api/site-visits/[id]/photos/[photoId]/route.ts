import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import {
  deleteSiteVisitPhoto,
  getSiteVisitPhotoFile,
  SiteVisitRepositoryError,
} from "@/lib/site-visits/repository";
import {
  readSiteVisitBody,
  siteVisitError,
  siteVisitJson,
  SiteVisitRequestBodyTooLarge,
} from "@/lib/site-visits/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function identifiers(context: { params: Promise<{ id: string; photoId: string }> }) {
  const { id, photoId } = await context.params;
  return ID_PATTERN.test(id) && ID_PATTERN.test(photoId) ? { id, photoId } : null;
}

function equalToken(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; photoId: string }> },
) {
  const ids = await identifiers(context);
  if (!ids) return siteVisitError(400, "invalid_id", "The site visit photo ID is invalid.");
  const parameters = request.nextUrl.searchParams;
  if ([...parameters.keys()].some((key) => key !== "token") || parameters.getAll("token").length !== 1) {
    return siteVisitError(403, "forbidden", "A valid photo access token is required.");
  }
  try {
    const photo = await getSiteVisitPhotoFile(ids.id, ids.photoId);
    if (!photo) return siteVisitError(404, "photo_not_found", "Site visit photo not found.");
    if (!equalToken(parameters.get("token") || "", photo.accessToken)) {
      return siteVisitError(403, "forbidden", "You do not have access to this photo.");
    }

    const source = await readFile(/* turbopackIgnore: true */ photo.path);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const encodedName = encodeURIComponent(photo.originalName).replaceAll("'", "%27");
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
        "content-length": String(bytes.byteLength),
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": photo.contentType,
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    return siteVisitError(500, "photo_unavailable", "The site visit photo is temporarily unavailable.");
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; photoId: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return siteVisitError(403, "forbidden", "This request is not allowed.");
  }
  const ids = await identifiers(context);
  if (!ids) return siteVisitError(400, "invalid_id", "The site visit photo ID is invalid.");
  if ([...request.nextUrl.searchParams.keys()].length) {
    return siteVisitError(400, "invalid_query", "Delete does not accept query parameters.");
  }
  try {
    const body = await readSiteVisitBody(request, 1);
    if (body.byteLength) return siteVisitError(400, "invalid_request", "Delete does not accept a request body.");
    const visit = await deleteSiteVisitPhoto(ids.id, ids.photoId);
    return siteVisitJson({ data: { visit, photoId: ids.photoId } });
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    if (error instanceof SiteVisitRequestBodyTooLarge) {
      return siteVisitError(400, "invalid_request", "Delete does not accept a request body.");
    }
    return siteVisitError(500, "delete_failed", "The site visit photo could not be deleted.");
  }
}
