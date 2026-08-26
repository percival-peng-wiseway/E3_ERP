import { AgentRequestBodyTooLarge, readLimitedAgentJson, requestHasJsonContentType } from "@/lib/agent/request";
import { getErpSession } from "@/lib/auth/session";
import { ErpUserRepositoryError, updateManagedErpUser } from "@/lib/auth/user-repository";
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

export async function PATCH(request: Request, context: { params: Promise<{ username: string }> }) {
  const session = getErpSession(request);
  if (session?.user.role !== "admin" || !isSameOriginRequest(request)) {
    return error(403, "forbidden", "Administrator access is required.");
  }
  if (!requestHasJsonContentType(request)) return error(415, "json_required", "Employee requests accept JSON only.");
  try {
    const body = await readLimitedAgentJson(request, MAX_BODY);
    if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "invalid_request", "Enter valid employee changes.");
    const input = body as Record<string, unknown>;
    const allowed = new Set(["expectedVersion", "displayName", "role", "active", "password"]);
    const keys = Object.keys(input);
    if (keys.some((key) => !allowed.has(key)) || !keys.some((key) => key !== "expectedVersion")) {
      return error(400, "invalid_request", "Enter valid employee changes.");
    }
    const { username } = await context.params;
    const user = await updateManagedErpUser(username, {
      expectedVersion: input.expectedVersion,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.password !== undefined ? { password: input.password } : {}),
    }, session.user.username);
    return json({ data: { user } });
  } catch (requestError) {
    if (requestError instanceof AgentRequestBodyTooLarge) return error(413, "request_too_large", "The employee request is too large.");
    if (requestError instanceof SyntaxError) return error(400, "invalid_request", "The employee request is invalid.");
    if (requestError instanceof ErpUserRepositoryError) return error(requestError.status, requestError.code, requestError.message);
    console.error("ERP user update failed", requestError instanceof Error ? requestError.name : "UnknownError");
    return error(500, "user_update_failed", "The employee account could not be updated.");
  }
}
