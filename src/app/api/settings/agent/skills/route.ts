import { getErpSession } from "@/lib/auth/session";
import {
  createManagedAgentSkill,
  listManagedAgentSkills,
  ManagedSkillError,
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

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "private, no-store");
  return Response.json(data, { ...init, headers });
}

function error(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

function adminSession(request: Request) {
  const session = getErpSession(request);
  return session?.user.role === "admin" ? session : null;
}

function mutationAuthorizationError(request: Request) {
  const session = adminSession(request);
  if (!session) return error(403, "forbidden", "Administrator access is required to manage Agent Skills.");
  if (!isSameOriginRequest(request)) return error(403, "origin_forbidden", "Only same-origin Skill changes are allowed.");
  if (process.env.NODE_ENV !== "production" && process.env.ERP_REMOTE_DATA_READ_ONLY === "true") {
    return error(403, "remote_read_only", "Skill changes are disabled while local development uses read-only cloud data.");
  }
  return null;
}

function repositoryError(value: unknown) {
  return value instanceof ManagedSkillError
    ? error(value.status, value.code, value.message)
    : null;
}

export async function GET(request: Request) {
  if (!adminSession(request)) return error(403, "forbidden", "Administrator access is required to view Agent Skills.");
  try {
    return json({ data: { skills: await listManagedAgentSkills({ includeDisabled: true }) } });
  } catch (loadError) {
    const known = repositoryError(loadError);
    if (known) return known;
    console.error("Unable to load Agent Skills", loadError instanceof Error ? loadError.name : "UnknownError");
    return error(500, "skills_unavailable", "Agent Skills are temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  const authorizationError = mutationAuthorizationError(request);
  if (authorizationError) return authorizationError;
  if (!requestHasJsonContentType(request)) return error(415, "json_required", "Agent Skill requests accept JSON only.");
  const session = adminSession(request)!;
  try {
    const body = await readLimitedAgentJson(request, MAX_BODY);
    const skill = await createManagedAgentSkill(body, session.user.username);
    return json({ data: { skill } }, { status: 201 });
  } catch (createError) {
    if (createError instanceof AgentRequestBodyTooLarge) return error(413, "request_too_large", "Agent Skill requests cannot exceed 16 KiB.");
    if (createError instanceof SyntaxError) return error(400, "invalid_json", "The request body must be valid JSON.");
    const known = repositoryError(createError);
    if (known) return known;
    console.error("Unable to create Agent Skill", createError instanceof Error ? createError.name : "UnknownError");
    return error(500, "skill_create_failed", "The Agent Skill could not be created.");
  }
}
