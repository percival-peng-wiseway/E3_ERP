export type BusinessSkillId =
  | "inventory"
  | "quotations"
  | "project_management"
  | "project_track"
  | "site_visits"
  | "reimbursements"
  | "reports";

export type BusinessSkill = {
  id: BusinessSkillId;
  name: string;
  dataSource: string;
  readOnly: true;
  deterministicWorkflows: readonly DeterministicWorkflowName[];
};

/** The seven bounded business capabilities exposed by the E3 Agent Harness. */
export const E3_BUSINESS_SKILLS: readonly BusinessSkill[] = [
  { id: "inventory", name: "Inventory", dataSource: "Inventory Operations API", readOnly: true, deterministicWorkflows: ["inventory_query"] },
  { id: "quotations", name: "Quotations", dataSource: "Authenticated QuoteHelp session", readOnly: true, deterministicWorkflows: ["quotation_summary"] },
  { id: "project_management", name: "Project Management", dataSource: "Inventory delivery orders", readOnly: true, deterministicWorkflows: ["pending_deliveries"] },
  { id: "project_track", name: "Project Track", dataSource: "Project Track repository", readOnly: true, deterministicWorkflows: ["outstanding_payments"] },
  { id: "site_visits", name: "Site Visiting", dataSource: "Site Visit repository", readOnly: true, deterministicWorkflows: ["site_visit_summary"] },
  { id: "reimbursements", name: "Reimbursements", dataSource: "Reimbursement repository", readOnly: true, deterministicWorkflows: ["reimbursement_summary"] },
  { id: "reports", name: "Reports", dataSource: "Reports repository", readOnly: true, deterministicWorkflows: ["reports_status"] },
] as const;

export function getBusinessSkill(id: BusinessSkillId): BusinessSkill {
  return E3_BUSINESS_SKILLS.find((skill) => skill.id === id)!;
}
import type { DeterministicWorkflowName } from "./workflows";
