import { NextResponse } from "next/server";

export const ANNOUNCEMENT_MAX_REQUEST_BYTES = 16 * 1024;

export class AnnouncementRequestTooLarge extends Error {
  constructor() {
    super("The announcement request is too large.");
    this.name = "AnnouncementRequestTooLarge";
  }
}

export function announcementJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export function announcementError(status: number, code: string, message: string) {
  return announcementJson({ error: message, code }, { status });
}

export function declaredAnnouncementBodyTooLarge(request: Request) {
  const rawLength = request.headers.get("content-length");
  if (!rawLength) return false;
  const declaredLength = Number(rawLength);
  return Number.isFinite(declaredLength) && declaredLength > ANNOUNCEMENT_MAX_REQUEST_BYTES;
}

export function isAnnouncementJsonRequest(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export async function readAnnouncementBody(request: Request, maxBytes = ANNOUNCEMENT_MAX_REQUEST_BYTES) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AnnouncementRequestTooLarge();
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

export async function readAnnouncementJsonObject(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readAnnouncementBody(request);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
