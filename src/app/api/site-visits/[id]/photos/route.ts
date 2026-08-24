import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import {
  addSiteVisitPhotos,
  SiteVisitRepositoryError,
} from "@/lib/site-visits/repository";
import {
  declaredSiteVisitBodyTooLarge,
  readSiteVisitBody,
  siteVisitError,
  siteVisitJson,
  SiteVisitRequestBodyTooLarge,
} from "@/lib/site-visits/request";
import {
  SITE_VISIT_PHOTO_TYPES,
  type SiteVisitPhotoType,
  type SiteVisitPhotoUpload,
} from "@/lib/site-visits/types";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const MAX_PHOTO_COUNT = 10;
const MAX_MULTIPART_SIZE = 50 * 1024 * 1024 + 512 * 1024;

async function siteVisitId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return ID_PATTERN.test(id) ? id : null;
}

function safeOriginalName(value: string) {
  const name = value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim() || "site-photo";
  return name.slice(0, 180);
}

function photoSignatureMatches(type: SiteVisitPhotoType, bytes: Uint8Array) {
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/png") {
    const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes.length >= signature.length
      && timingSafeEqual(Buffer.from(bytes.subarray(0, signature.length)), Buffer.from(signature));
  }
  return bytes.length >= 12
    && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMutationRequest(request)) {
    return siteVisitError(403, "forbidden", "This request is not allowed.");
  }
  const id = await siteVisitId(context);
  if (!id) return siteVisitError(400, "invalid_id", "The site visit ID is invalid.");
  if (declaredSiteVisitBodyTooLarge(request, MAX_MULTIPART_SIZE)) {
    return siteVisitError(413, "request_too_large", "Upload up to 50 MB of site photos at a time.");
  }
  const contentTypeHeader = request.headers.get("content-type") || "";
  if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data;")) {
    return siteVisitError(415, "unsupported_request", "Submit site photos as multipart form data.");
  }

  try {
    const rawBody = await readSiteVisitBody(request, MAX_MULTIPART_SIZE);
    const form = await new Response(rawBody, { headers: { "content-type": contentTypeHeader } }).formData();
    const entries = [...form.entries()];
    if (!entries.length || entries.some(([name, value]) => name !== "photos" || !(value instanceof File))) {
      return siteVisitError(400, "invalid_form", "Attach photos using the photos field.");
    }
    const files = entries.map(([, value]) => value as File);
    if (files.length > MAX_PHOTO_COUNT) {
      return siteVisitError(400, "too_many_photos", "Upload no more than 10 photos at a time.");
    }

    const uploads: SiteVisitPhotoUpload[] = [];
    for (const file of files) {
      if (file.size < 1 || file.size > MAX_PHOTO_SIZE) {
        return siteVisitError(400, "invalid_photo", "Each site photo must be between 1 byte and 10 MB.");
      }
      if (!SITE_VISIT_PHOTO_TYPES.includes(file.type as SiteVisitPhotoType)) {
        return siteVisitError(415, "unsupported_photo", "Use JPG, PNG or WebP site photos.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const contentType = file.type as SiteVisitPhotoType;
      if (bytes.byteLength !== file.size || !photoSignatureMatches(contentType, bytes)) {
        return siteVisitError(415, "invalid_photo_content", "A photo does not match its declared file type.");
      }
      uploads.push({
        bytes,
        originalName: safeOriginalName(file.name),
        contentType,
        size: file.size,
      });
    }

    const result = await addSiteVisitPhotos(id, uploads);
    return siteVisitJson({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    if (error instanceof SiteVisitRequestBodyTooLarge) {
      return siteVisitError(413, "request_too_large", "Upload up to 50 MB of site photos at a time.");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return siteVisitError(400, "invalid_form", "The site photo form is invalid.");
    }
    return siteVisitError(500, "upload_failed", "The site photos could not be uploaded.");
  }
}
