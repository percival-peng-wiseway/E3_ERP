import { getErpSession } from "@/lib/auth/session";
import { agentAuthContext } from "@/lib/erp_agent/business-agent/auth";
import {
  createManagedAgentSkill,
  listManagedAgentSkills,
  ManagedSkillError,
  type ManagedSkillOwner,
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

function skillOwner(request: Request): ManagedSkillOwner | null {
  const session = getErpSession(request);
  const auth = agentAuthContext(request);
  return session && auth
    ? { principalHash: auth.principalHash, username: session.user.username }
    : null;
}

function mutationAuthorizationError(request: Request, owner: ManagedSkillOwner | null) {
  if (!owner) return error(401, "authentication_required", "Sign in to manage your Agent Skills.");
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
  const owner = skillOwner(request);
  if (!owner) return error(401, "authentication_required", "Sign in to view your Agent Skills.");
  try {
    return json({ data: { skills: await listManagedAgentSkills(owner, { includeDisabled: true }) } });
  } catch (loadError) {
    const known = repositoryError(loadError);
    if (known) return known;
    console.error("Unable to load Agent Skills", loadError instanceof Error ? loadError.name : "UnknownError");
    return error(500, "skills_unavailable", "Agent Skills are temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  const owner = skillOwner(request);
  const authorizationError = mutationAuthorizationError(request, owner);
  if (authorizationError) return authorizationError;
  if (!requestHasJsonContentType(request)) return error(415, "json_required", "Agent Skill requests accept JSON only.");
  try {
    const body = await readLimitedAgentJson(request, MAX_BODY);
    const skill = await createManagedAgentSkill(body, owner!);
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
