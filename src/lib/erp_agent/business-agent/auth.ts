import { createHash } from "node:crypto";
import { getErpSession } from "../../auth/session";
import type { AgentAuthContext, AgentPermission } from "./contracts";
import { permissionsForRole } from "./authz";
export { permissionsForRole } from "./authz";

export function agentAuthContext(request: Request): AgentAuthContext | null {
  const session = getErpSession(request);
  if (!session) return null;
  const tenantId = "e3"; // Current ERP session schema is single-tenant; never accepted from request/model input.
  const principalHash = createHash("sha256")
    .update(`${tenantId}:${session.user.username}`)
    .digest("hex");
  return { principalHash, tenantId, role: session.user.role, permissions: permissionsForRole(session.user.role) };
}
