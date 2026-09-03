import { getErpSession } from "@/lib/auth/session";
import {
  deleteManagedAgentSkill,
  ManagedSkillError,
  updateManagedAgentSkill,
} from "@/lib/erp_agent/agent/managed-skills";
import {
  AgentRequestBodyTooLarge,
  readLimitedAgentJson,
  requestHasJsonContentType,
} from "@/lib/erp_agent/agent/request";
import { isSameOriginRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 16 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "private, no-store");
  return Response.json(data, { ...init, headers });
}

function error(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

function mutationSession(request: Request) {
  const session = getErpSession(request);
  if (session?.user.role !== "admin" || !isSameOriginRequest(request)) return null;
  if (process.env.NODE_ENV !== "production" && process.env.ERP_REMOTE_DATA_READ_ONLY === "true") return null;
  return session;
}

async function skillId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return ID_PATTERN.test(id) ? id.toLocaleLowerCase("en-AU") : null;
}

function knownError(value: unknown) {
  return value instanceof ManagedSkillError
    ? error(value.status, value.code, value.message)
    : null;
}

async function readBody(request: Request) {
  if (!requestHasJsonContentType(request)) throw new ManagedSkillError("Agent Skill requests accept JSON only.", 415, "json_required");
  return readLimitedAgentJson(request, MAX_BODY);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = mutationSession(request);
  if (!session) return error(403, "forbidden", "Administrator access from the live application is required.");
  const id = await skillId(context);
  if (!id) return error(400, "invalid_id", "The custom Skill ID is invalid.");
  try {
    const skill = await updateManagedAgentSkill(id, await readBody(request), session.user.username);
    return json({ data: { skill } });
  } catch (updateError) {
    if (updateError instanceof AgentRequestBodyTooLarge) return error(413, "request_too_large", "Agent Skill requests cannot exceed 16 KiB.");
    if (updateError instanceof SyntaxError) return error(400, "invalid_json", "The request body must be valid JSON.");
    const known = knownError(updateError);
    if (known) return known;
    console.error("Unable to update Agent Skill", updateError instanceof Error ? updateError.name : "UnknownError");
    return error(500, "skill_update_failed", "The Agent Skill could not be updated.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = mutationSession(request);
  if (!session) return error(403, "forbidden", "Administrator access from the live application is required.");
  const id = await skillId(context);
  if (!id) return error(400, "invalid_id", "The custom Skill ID is invalid.");
  try {
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, "expectedVersion")) {
      return error(400, "invalid_request", "Refresh the Skill list and try again.");
    }
    await deleteManagedAgentSkill(id, (body as Record<string, unknown>).expectedVersion);
    return json({ data: { id } });
  } catch (deleteError) {
    if (deleteError instanceof AgentRequestBodyTooLarge) return error(413, "request_too_large", "Agent Skill requests cannot exceed 16 KiB.");
    if (deleteError instanceof SyntaxError) return error(400, "invalid_json", "The request body must be valid JSON.");
    const known = knownError(deleteError);
    if (known) return known;
    console.error("Unable to delete Agent Skill", deleteError instanceof Error ? deleteError.name : "UnknownError");
    return error(500, "skill_delete_failed", "The Agent Skill could not be deleted.");
  }
}
