import { NextResponse } from "next/server";
import {
  createGroupChatMessage,
  GROUP_CHAT_MAX_CONTENT_LENGTH,
  GROUP_CHAT_MAX_DISPLAY_NAME_LENGTH,
  listGroupChatMessages,
} from "@/lib/group-chat/repository";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_SIZE = 16 * 1024;

class RequestBodyTooLarge extends Error {}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function errorResponse(status: number, code: string, message: string) {
  return noStoreJson({ error: message, code }, { status });
}

function declaredBodyTooLarge(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE;
}

async function readLimitedBody(request: Request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_SIZE) {
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
  const bytes = await readLimitedBody(request);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredDisplayName(value: unknown) {
  if (typeof value !== "string") return null;
  const displayName = value.trim();
  if (!displayName
    || displayName.length > GROUP_CHAT_MAX_DISPLAY_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/.test(displayName)) {
    return null;
  }
  return displayName;
}

function requiredContent(value: unknown) {
  if (typeof value !== "string") return null;
  const content = value.trim();
  if (!content
    || content.length > GROUP_CHAT_MAX_CONTENT_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    return null;
  }
  return content;
}

function messageFields(body: Record<string, unknown>) {
  const keys = Object.keys(body).sort();
  const canonical = keys.length === 2 && keys[0] === "content" && keys[1] === "displayName";
  const compatible = keys.length === 2 && keys[0] === "message" && keys[1] === "name";
  if (!canonical && !compatible) return null;

  const displayName = requiredDisplayName(canonical ? body.displayName : body.name);
  const content = requiredContent(canonical ? body.content : body.message);
  return displayName && content ? { displayName, content } : null;
}

export async function GET() {
  try {
    return noStoreJson({ data: await listGroupChatMessages() });
  } catch {
    return errorResponse(500, "storage_unavailable", "Group messages could not be loaded.");
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedMutationRequest(request)) {
    return errorResponse(403, "forbidden", "This request is not allowed.");
  }
  if (declaredBodyTooLarge(request)) {
    return errorResponse(413, "request_too_large", "The message request is too large.");
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(415, "unsupported_request", "Submit the message as JSON.");
  }

  try {
    const fields = messageFields(await readJsonObject(request));
    if (!fields) {
      return errorResponse(400, "invalid_message", "Enter a display name and a message using only the supported fields.");
    }
    return noStoreJson({ data: await createGroupChatMessage(fields.displayName, fields.content) }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      return errorResponse(413, "request_too_large", "The message request is too large.");
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return errorResponse(400, "invalid_json", "The request body is invalid.");
    }
    return errorResponse(500, "save_failed", "The message could not be saved.");
  }
}
