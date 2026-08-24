import { NextResponse } from "next/server";

export class SiteVisitRequestBodyTooLarge extends Error {}

export function siteVisitJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export function siteVisitError(status: number, code: string, message: string) {
  return siteVisitJson({ error: message, code }, { status });
}

export function declaredSiteVisitBodyTooLarge(request: Request, maximum: number) {
  const value = Number(request.headers.get("content-length"));
  return Number.isFinite(value) && value > maximum;
}

export async function readSiteVisitBody(request: Request, maximum: number) {
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
      throw new SiteVisitRequestBodyTooLarge();
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

export async function readSiteVisitJson(request: Request, maximum: number) {
  const bytes = await readSiteVisitBody(request, maximum);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected an object");
  return value as Record<string, unknown>;
}
