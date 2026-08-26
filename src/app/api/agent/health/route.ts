import { getReportContent } from "@/lib/reports/repository";
import { listReimbursements } from "@/lib/reimbursements/repository";
import { listSiteVisits } from "@/lib/site-visits/repository";
import { listPaymentTrackProjects } from "@/lib/payment-track/repository";
import { runAgentTool } from "@/lib/agent/tools";
import { E3_BUSINESS_SKILLS } from "@/lib/agent/skills";
import { runAgentHealthChecks } from "@/lib/agent/health";
import { getERPProvider } from "@/lib/erp";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const provider = getERPProvider(request);
  const checkDeliveries = async () => {
    const raw = await runAgentTool(provider, { name: "search_delivery_orders", arguments: JSON.stringify({ query: "", status: "all", limit: 1, include_contact_details: false }) });
    const payload = JSON.parse(raw) as { error?: unknown };
    if (payload.error) throw new Error("Project Management source is unavailable.");
  };
  const checkFunctions = {
    inventory: () => provider.listInventory({ limit: 1 }),
    quotations: () => provider.listQuotations({ limit: 1 }),
    project_management: checkDeliveries,
    project_track: () => listPaymentTrackProjects(),
    site_visits: () => listSiteVisits(),
    reimbursements: () => listReimbursements({ includeAll: true }),
    reports: () => getReportContent(),
  } as const;
  const health = await runAgentHealthChecks(E3_BUSINESS_SKILLS.map((skill) => ({
    id: skill.id,
    source: skill.dataSource,
    check: checkFunctions[skill.id],
  })));
  return Response.json({
    data: { healthy: health.healthy, skills: E3_BUSINESS_SKILLS.length, sources: health.sources },
    meta: { generatedAt: new Date().toISOString(), demoFallbackEnabled: false },
  }, { status: health.healthy ? 200 : 503, headers: { "cache-control": "no-store" } });
}
