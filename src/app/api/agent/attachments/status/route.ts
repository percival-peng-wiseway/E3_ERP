import { getErpSession } from "@/lib/auth/session";
import {
  AgentAttachmentError,
  cleanAgentAttachmentIds,
  resolveAgentAttachments,
} from "@/lib/erp_agent/agent/attachments";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/erp_agent/agent/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_STATUS_BODY = 4 * 1024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  if (!isAuthorizedMutationRequest(request)) {
    return json({ error: { code: "forbidden", message: "Same-origin request required." } }, 403);
  }
  const session = getErpSession(request);
  if (!session) {
    return json({ error: { code: "authentication_required", message: "Sign in to use attachments." } }, 401);
  }
  if (!requestHasJsonContentType(request)) {
    return json({ error: { code: "json_required", message: "JSON body required." } }, 415);
  }
  let value: unknown;
  try {
    value = await readLimitedAgentJson(request, MAX_STATUS_BODY);
  } catch (error) {
    return json({
      error: {
        code: error instanceof AgentRequestBodyTooLarge ? "request_too_large" : "invalid_json",
        message: "The attachment status request is invalid.",
      },
    }, error instanceof AgentRequestBodyTooLarge ? 413 : 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).some((key) => key !== "attachments")) {
    return json({ error: { code: "invalid_request", message: "The attachment list is invalid." } }, 400);
  }
  const ids = cleanAgentAttachmentIds((value as Record<string, unknown>).attachments);
  if (!ids) return json({ error: { code: "invalid_attachments", message: "The attachment list is invalid." } }, 400);
  try {
    const attachments = await resolveAgentAttachments({ fileIds: ids, actor: session.user });
    return json({ data: { attachments } });
  } catch (error) {
    if (error instanceof AgentAttachmentError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    return json({ error: { code: "attachment_unavailable", message: "Attachment status is temporarily unavailable." } }, 503);
  }
}
