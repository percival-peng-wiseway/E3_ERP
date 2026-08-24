import { NextRequest } from "next/server";
import {
  createSiteVisit,
  listSiteVisits,
  SiteVisitRepositoryError,
} from "@/lib/site-visits/repository";
import {
  declaredSiteVisitBodyTooLarge,
  readSiteVisitJson,
  siteVisitError,
  siteVisitJson,
  SiteVisitRequestBodyTooLarge,
} from "@/lib/site-visits/request";
import { parseSiteVisitCreate } from "@/lib/site-visits/validation";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 32 * 1024;

export async function GET(request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].length) {
    return siteVisitError(400, "invalid_query", "Site visit listing does not accept query parameters.");
  }
  try {
    return siteVisitJson({ data: { visits: await listSiteVisits() } });
  } catch (error) {
    console.error("Site visit storage unavailable; returning an empty initial list", error instanceof Error ? error.message : error);
    return siteVisitJson({
      data: { visits: [] },
      meta: {
        degraded: true,
        warning: "Site visit storage is not connected. Starting with an empty list.",
      },
    });
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) {
    return siteVisitError(403, "forbidden", "This request is not allowed.");
  }
  if (declaredSiteVisitBodyTooLarge(request, MAX_JSON_SIZE)) {
    return siteVisitError(413, "request_too_large", "The site visit is too large.");
  }
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return siteVisitError(415, "unsupported_request", "Submit the site visit as JSON.");
  }
  try {
    const input = parseSiteVisitCreate(await readSiteVisitJson(request, MAX_JSON_SIZE));
    if (!input) {
      return siteVisitError(400, "invalid_visit", "Complete the site visit with valid information.");
    }
    const visit = await createSiteVisit(input);
    return siteVisitJson({ data: { visit } }, { status: 201 });
  } catch (error) {
    if (error instanceof SiteVisitRepositoryError) {
      return siteVisitError(error.status, error.code, error.message);
    }
    if (error instanceof SiteVisitRequestBodyTooLarge) {
      return siteVisitError(413, "request_too_large", "The site visit is too large.");
    }
    if (error instanceof SyntaxError) {
      return siteVisitError(400, "invalid_json", "The site visit request is invalid.");
    }
    return siteVisitError(500, "create_failed", "The site visit could not be created.");
  }
}
