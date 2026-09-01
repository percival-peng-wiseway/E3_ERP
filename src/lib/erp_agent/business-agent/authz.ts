import type { AgentAuthContext, AgentPermission } from "./contracts";

const ROLE_PERMISSIONS: Record<string, readonly AgentPermission[]> = {
  admin: ["inventory.read", "knowledge.read", "project.read", "order.read", "finance.read", "subsidy.read"],
  pm: ["inventory.read", "knowledge.read", "project.read", "order.read", "subsidy.read"],
  sales: ["inventory.read", "knowledge.read", "project.read", "order.read"],
  specialist: ["inventory.read", "knowledge.read", "project.read", "order.read"],
};

export function permissionsForRole(role: string): ReadonlySet<AgentPermission> {
  return new Set(ROLE_PERMISSIONS[role] || []);
}

export function hasPermissions(context: AgentAuthContext, required: readonly AgentPermission[]) {
  return required.every((permission) => context.permissions.has(permission));
}
