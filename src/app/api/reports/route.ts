import { NextResponse } from "next/server";
import {
  getReportContent,
  ReportRevisionConflictError,
  saveReportContent,
} from "@/lib/reports/repository";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_SIZE = 1024 * 1024;
const MAX_CONTENT_LENGTH = 100_000;

class RequestBodyTooLarge extends Error {}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function errorResponse(status: number, code: string, message: string) {
  return noStoreJson({ error: message, code }, { status });
}

async function readLimitedBody(request: Request, maximum: number) {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonObject(request: Request) {
  const bytes = await readLimitedBody(request, MAX_BODY_SIZE);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

export async function GET() {
  try {
    return noStoreJson({ data: await getReportContent() });
  } catch {
    return errorResponse(500, "storage_unavailable", "The report could not be loaded.");
  }
}

export async function PUT(request: Request) {
  if (!isAuthorizedMutationRequest(request)) {
    return errorResponse(403, "forbidden", "This request is not allowed.");
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE) {
    return errorResponse(413, "request_too_large", "The report is too large.");
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(415, "unsupported_request", "Submit the report as JSON.");
  }

  try {
    const body = await readJsonObject(request);
    if (Object.keys(body).length !== 2
      || typeof body.content !== "string"
      || !Number.isSafeInteger(body.revision)
      || (body.revision as number) < 0) {
      return errorResponse(400, "invalid_content", "The request must contain report content and its revision.");
    }
    if (body.content.length > MAX_CONTENT_LENGTH) {
      return errorResponse(413, "content_too_long", "The report must be 100,000 characters or fewer.");
    }

    return noStoreJson({ data: await saveReportContent(body.content, body.revision as number) });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      return errorResponse(413, "request_too_large", "The report is too large.");
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return errorResponse(400, "invalid_json", "The request body is invalid.");
    }
    if (error instanceof ReportRevisionConflictError) {
      return noStoreJson({
        error: error.message,
        code: "revision_conflict",
        data: error.current,
      }, { status: 409 });
    }
    return errorResponse(500, "save_failed", "The report could not be saved.");
  }
}
