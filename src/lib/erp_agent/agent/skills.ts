import type { DeterministicWorkflowName } from "./workflows";

export type BusinessSkillId =
  | "workspace"
  | "knowledge"
  | "inventory"
  | "quotations"
  | "project_management"
  | "project_track"
  | "weekly_schedule"
  | "site_visits"
  | "reimbursements"
  | "reports"
  | "communications";

export type BusinessSkill = {
  id: BusinessSkillId;
  name: string;
  version: 1;
  dataSource: string;
  readOnly: true;
  approval: "source_controlled";
  deterministicWorkflows: readonly DeterministicWorkflowName[];
};

/**
 * Versioned, source-controlled business capabilities exposed to the E3 Agent.
 * The model cannot create or mutate these Skills at runtime.
 */
export const E3_BUSINESS_SKILLS: readonly BusinessSkill[] = [
  { id: "workspace", name: "Workspace overview", version: 1, dataSource: "Read-only ERP aggregates", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["workspace_overview"] },
  { id: "knowledge", name: "Knowledge base", version: 1, dataSource: "Authorised D1, KV and Vectorize knowledge index", readOnly: true, approval: "source_controlled", deterministicWorkflows: [] },
  { id: "inventory", name: "Inventory", version: 1, dataSource: "Inventory Operations API", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["inventory_query"] },
  { id: "quotations", name: "Quotations", version: 1, dataSource: "Authenticated QuoteHelp session", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["quotation_summary"] },
  { id: "project_management", name: "Project Management", version: 1, dataSource: "Inventory delivery orders", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["pending_deliveries"] },
  { id: "project_track", name: "Project Track", version: 1, dataSource: "Project Track repository", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["project_track_query", "outstanding_payments"] },
  { id: "weekly_schedule", name: "Weekly Schedule", version: 1, dataSource: "Weekly Schedule aggregate", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["weekly_schedule_query"] },
  { id: "site_visits", name: "Site Visiting", version: 1, dataSource: "Site Visit repository", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["site_visit_summary"] },
  { id: "reimbursements", name: "Reimbursements", version: 1, dataSource: "Reimbursement repository", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["reimbursement_summary"] },
  { id: "reports", name: "Reports", version: 1, dataSource: "Reports repository", readOnly: true, approval: "source_controlled", deterministicWorkflows: ["reports_status"] },
  { id: "communications", name: "Communications", version: 1, dataSource: "Announcements and legacy group discussion", readOnly: true, approval: "source_controlled", deterministicWorkflows: [] },
] as const;

const BUSINESS_SKILL_IDS = new Set<BusinessSkillId>(E3_BUSINESS_SKILLS.map((skill) => skill.id));

export type AgentSkillPolicy = {
  enabled: ReadonlySet<BusinessSkillId>;
  rejected: readonly string[];
  source: "default" | "environment";
};

/** Operators can narrow enabled Skills with E3_AGENT_ENABLED_SKILLS. */
export function resolveAgentSkillPolicy(raw = process.env.E3_AGENT_ENABLED_SKILLS): AgentSkillPolicy {
  if (raw === undefined || raw.trim() === "") {
    return {
      enabled: new Set(E3_BUSINESS_SKILLS.map((skill) => skill.id)),
      rejected: [],
      source: "default",
    };
  }
  const requested = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  return {
    enabled: new Set(requested.filter((value): value is BusinessSkillId => BUSINESS_SKILL_IDS.has(value as BusinessSkillId))),
    rejected: requested.filter((value) => !BUSINESS_SKILL_IDS.has(value as BusinessSkillId)),
    source: "environment",
  };
}

export function getBusinessSkill(id: BusinessSkillId): BusinessSkill {
  return E3_BUSINESS_SKILLS.find((skill) => skill.id === id)!;
}

export function skillForWorkflow(workflow: string): BusinessSkillId | null {
  return E3_BUSINESS_SKILLS.find((skill) => (
    skill.deterministicWorkflows.some((workflowName) => workflowName === workflow)
  ))?.id || null;
}
