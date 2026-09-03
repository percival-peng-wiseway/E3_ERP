import { getErpSession } from "@/lib/auth/session";
import {
  deleteAgentConversationAudit,
  deleteAgentConversationAuditSession,
  listAgentConversationAudits,
} from "@/lib/erp_agent/agent/conversation-store";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/erp_agent/agent/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DELETE_BODY_LIMIT = 1_024;
const CONVERSATION_HASH = /^[a-f0-9]{24,64}$/i;
const RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTOR_USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "private, no-store");
  return Response.json(data, { ...init, headers });
}

function forbidden() {
  return json({ error: { code: "forbidden", message: "Administrator access is required." } }, { status: 403 });
}

function safeErrorKind(value: unknown) {
  return value instanceof Error ? value.name : "UnknownError";
}

export async function GET(request: Request) {
  const session = getErpSession(request);
  if (session?.user.role !== "admin") return forbidden();

  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  const rawUser = params.get("user");
  const rawConversation = params.get("conversation");
  if ((rawLimit && !/^\d{1,3}$/.test(rawLimit))
    || (rawUser && rawUser.length > 40)
    || (rawConversation && !CONVERSATION_HASH.test(rawConversation))) {
    return json({ error: { code: "invalid_query", message: "The conversation filters are invalid." } }, { status: 400 });
  }

  try {
    const result = await listAgentConversationAudits({
      limit: rawLimit ? Number(rawLimit) : 100,
      ...(rawUser ? { actorUsername: rawUser } : {}),
      ...(rawConversation ? { conversationKey: rawConversation } : {}),
    });
    return json({ data: { ...result, generatedAt: new Date().toISOString() } });
  } catch (readError) {
    console.error("Conversation Audit read failed", safeErrorKind(readError));
    return json(
      { error: { code: "conversations_unavailable", message: "Agent conversations are temporarily unavailable." } },
      { status: 503 },
    );
  }
}

export async function DELETE(request: Request) {
  const session = getErpSession(request);
  if (session?.user.role !== "admin" || !isAuthorizedMutationRequest(request)) return forbidden();
  if (!requestHasJsonContentType(request)) {
    return json({ error: { code: "json_required", message: "A JSON request body is required." } }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await readLimitedAgentJson(request, DELETE_BODY_LIMIT);
  } catch (requestError) {
    const code = requestError instanceof AgentRequestBodyTooLarge ? "request_too_large" : "invalid_json";
    return json({ error: { code, message: "The delete request is invalid." } }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: { code: "invalid_request", message: "A valid conversation selector is required." } }, { status: 400 });
  }
  const selector = body as Record<string, unknown>;
  const keys = Object.keys(selector).sort();
  const deletesRecord = keys.length === 1 && keys[0] === "id" && typeof selector.id === "string" && RECORD_ID.test(selector.id);
  const deletesSession = keys.length === 2
    && keys[0] === "actorUsername" && keys[1] === "conversationKey"
    && typeof selector.actorUsername === "string" && ACTOR_USERNAME.test(selector.actorUsername)
    && typeof selector.conversationKey === "string" && CONVERSATION_HASH.test(selector.conversationKey);
  if (!deletesRecord && !deletesSession) {
    return json({ error: { code: "invalid_request", message: "A valid conversation selector is required." } }, { status: 400 });
  }

  try {
    if (deletesSession) {
      const actorUsername = selector.actorUsername as string;
      const conversationKey = (selector.conversationKey as string).toLowerCase();
      const deletedCount = await deleteAgentConversationAuditSession(actorUsername, conversationKey);
      if (deletedCount === 0) {
        return json({ error: { code: "not_found", message: "The conversation was not found." } }, { status: 404 });
      }
      return json({ data: { actorUsername, conversationKey, deletedCount, deleted: true } });
    }
    const id = selector.id as string;
    if (!await deleteAgentConversationAudit(id)) {
      return json({ error: { code: "not_found", message: "The conversation record was not found." } }, { status: 404 });
    }
    return json({ data: { id, deleted: true } });
  } catch (deleteError) {
    console.error("Conversation Audit delete failed", safeErrorKind(deleteError));
    return json(
      { error: { code: "conversation_delete_unavailable", message: "The stored conversation could not be deleted right now." } },
      { status: 503 },
    );
  }
}
