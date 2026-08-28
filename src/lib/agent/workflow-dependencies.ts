import { getReportContent } from "@/lib/reports/repository";
import { listReimbursements } from "@/lib/reimbursements/repository";
import { listSiteVisits } from "@/lib/site-visits/repository";
import {
  fastInventoryAnswer,
  fastPaymentTrackAnswer,
  fastWeeklyScheduleAnswer,
  runAgentTool,
} from "./tools";
import type { DeterministicWorkflowDependencies } from "./workflows";

export const deterministicWorkflowDependencies = {
  fastInventoryAnswer,
  fastPaymentTrackAnswer,
  fastWeeklyScheduleAnswer,
  runAgentTool,
  getReportContent,
  listReimbursements,
  listSiteVisits,
} satisfies DeterministicWorkflowDependencies;
