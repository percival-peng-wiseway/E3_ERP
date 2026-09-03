import type { ERPProvider } from "@/lib/erp";
import type { AgentAuthContext, AgentPermission } from "@/lib/erp_agent/business-agent/contracts";
import { KIMI_TOOLS, runAgentTool } from "./tools";
import type { BusinessSkillId } from "./skills";

export type AgentToolDefinition = (typeof KIMI_TOOLS)[number];
export type AgentToolName = AgentToolDefinition["function"]["name"];
export type AgentToolsetId =
  | "workspace"
  | "knowledge"
  | "inventory"
  | "quotations"
  | "project_management"
  | "project_track"
  | "weekly_schedule"
  | "reimbursements"
  | "reports"
  | "communications";

export type AgentToolRegistration = {
  name: AgentToolName;
  skill: BusinessSkillId;
  toolset: AgentToolsetId;
  readOnly: true;
  dataClassification: "internal" | "confidential";
  requiredPermissions: readonly AgentPermission[];
  definition: AgentToolDefinition;
};

const TOOL_METADATA = {
  get_workspace_overview: { skill: "workspace", toolset: "workspace", dataClassification: "internal", requiredPermissions: [] },
  search_knowledge_base: { skill: "knowledge", toolset: "knowledge", dataClassification: "confidential", requiredPermissions: ["knowledge.read"] },
  search_inventory: { skill: "inventory", toolset: "inventory", dataClassification: "internal", requiredPermissions: ["inventory.read"] },
  search_inventory_usage: { skill: "inventory", toolset: "inventory", dataClassification: "confidential", requiredPermissions: ["inventory.read", "project.read"] },
  search_product_activity: { skill: "inventory", toolset: "inventory", dataClassification: "confidential", requiredPermissions: ["inventory.read", "project.read", "order.read"] },
  search_quotations: { skill: "quotations", toolset: "quotations", dataClassification: "confidential", requiredPermissions: ["order.read"] },
  search_delivery_orders: { skill: "project_management", toolset: "project_management", dataClassification: "confidential", requiredPermissions: ["order.read"] },
  search_payment_projects: { skill: "project_track", toolset: "project_track", dataClassification: "confidential", requiredPermissions: ["project.read"] },
  search_weekly_schedule: { skill: "weekly_schedule", toolset: "weekly_schedule", dataClassification: "confidential", requiredPermissions: ["project.read", "order.read"] },
  search_project_schedule: { skill: "weekly_schedule", toolset: "weekly_schedule", dataClassification: "confidential", requiredPermissions: ["project.read"] },
  search_reimbursements: { skill: "reimbursements", toolset: "reimbursements", dataClassification: "confidential", requiredPermissions: [] },
  read_reports_notes: { skill: "reports", toolset: "reports", dataClassification: "confidential", requiredPermissions: ["project.read"] },
  search_announcements: { skill: "communications", toolset: "communications", dataClassification: "internal", requiredPermissions: [] },
  search_group_messages: { skill: "communications", toolset: "communications", dataClassification: "confidential", requiredPermissions: ["project.read"] },
} as const satisfies Record<AgentToolName, {
  skill: BusinessSkillId;
  toolset: AgentToolsetId;
  dataClassification: AgentToolRegistration["dataClassification"];
  requiredPermissions: readonly AgentPermission[];
}>;

export const AGENT_TOOL_REGISTRY: readonly AgentToolRegistration[] = KIMI_TOOLS.map((definition) => {
  const name = definition.function.name;
  return {
    name,
    ...TOOL_METADATA[name],
    readOnly: true,
    definition,
  };
});

const REGISTRATION_BY_NAME = new Map(AGENT_TOOL_REGISTRY.map((registration) => [registration.name, registration]));

export function registeredAgentTool(name: string): AgentToolRegistration | null {
  return REGISTRATION_BY_NAME.get(name as AgentToolName) || null;
}

export type AgentToolSelection = {
  definitions: readonly AgentToolDefinition[];
  names: readonly AgentToolName[];
  skills: readonly BusinessSkillId[];
  toolsets: readonly AgentToolsetId[];
};

export function selectRegisteredAgentTools(options: {
  enabledSkills: ReadonlySet<BusinessSkillId>;
  focusedNames?: readonly string[] | null;
  excludeNames?: readonly AgentToolName[];
  permissions?: ReadonlySet<AgentPermission>;
}): AgentToolSelection {
  const focused = options.focusedNames ? new Set(options.focusedNames) : null;
  const excluded = new Set(options.excludeNames || []);
  const selected = AGENT_TOOL_REGISTRY.filter((registration) => (
    options.enabledSkills.has(registration.skill)
      && !excluded.has(registration.name)
      && (!options.permissions || registration.requiredPermissions.every((permission) => options.permissions?.has(permission)))
      && (!focused || focused.has(registration.name))
  ));
  return {
    definitions: selected.map((registration) => registration.definition),
    names: selected.map((registration) => registration.name),
    skills: [...new Set(selected.map((registration) => registration.skill))],
    toolsets: [...new Set(selected.map((registration) => registration.toolset))],
  };
}

export async function executeRegisteredAgentTool(
  provider: ERPProvider,
  call: { name: string; arguments: string },
  auth: AgentAuthContext,
  enabledSkills: ReadonlySet<BusinessSkillId>,
  scope: { knowledgeDocumentIds?: readonly string[] } = {},
): Promise<string> {
  const registration = registeredAgentTool(call.name);
  if (!registration || !enabledSkills.has(registration.skill)) {
    return JSON.stringify({
      error: {
        code: "tool_unavailable",
        message: "This read-only capability is not enabled for the Agent.",
      },
    });
  }
  if (!registration.requiredPermissions.every((permission) => auth.permissions.has(permission))) {
    return JSON.stringify({
      error: {
        code: "permission_denied",
        message: "You do not have permission to use this read-only capability.",
      },
    });
  }
  return runAgentTool(provider, call, auth, scope);
}
