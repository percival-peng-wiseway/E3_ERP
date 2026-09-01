import { AgentRequestBodyTooLarge, readLimitedAgentJson, requestHasJsonContentType } from "@/lib/erp_agent/agent/request";
import { getErpSession } from "@/lib/auth/session";
import { createManagedErpUser, ErpUserRepositoryError, listManagedErpUsers } from "@/lib/auth/user-repository";
import { isSameOriginRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 8 * 1024;

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

function error(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

function admin(request: Request) {
  const session = getErpSession(request);
  return session?.user.role === "admin" ? session : null;
}

export async function GET(request: Request) {
  const session = admin(request);
  if (!session) return error(403, "forbidden", "Administrator access is required.");
  try {
    return json({ data: { users: await listManagedErpUsers() } });
  } catch (directoryError) {
    console.error("ERP user directory read failed", directoryError instanceof Error ? directoryError.name : "UnknownError");
    return error(500, "users_unavailable", "The employee directory is temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  const session = admin(request);
  if (!session || !isSameOriginRequest(request)) return error(403, "forbidden", "Administrator access is required.");
  if (!requestHasJsonContentType(request)) return error(415, "json_required", "Employee requests accept JSON only.");
  try {
    const body = await readLimitedAgentJson(request, MAX_BODY);
    if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "invalid_request", "Enter valid employee details.");
    const input = body as Record<string, unknown>;
    const allowed = new Set(["username", "displayName", "role", "password", "active"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) return error(400, "invalid_request", "Enter valid employee details.");
    const user = await createManagedErpUser({
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      password: input.password,
      active: input.active,
    }, session.user.username);
    return json({ data: { user } }, { status: 201 });
  } catch (requestError) {
    if (requestError instanceof AgentRequestBodyTooLarge) return error(413, "request_too_large", "The employee request is too large.");
    if (requestError instanceof SyntaxError) return error(400, "invalid_json", "The request body must be valid JSON.");
    if (requestError instanceof ErpUserRepositoryError) return error(requestError.status, requestError.code, requestError.message);
    console.error("ERP user creation failed", requestError instanceof Error ? requestError.name : "UnknownError");
    return error(500, "user_create_failed", "The employee account could not be created.");
  }
}
