import { getReportContent } from "@/lib/reports/repository";
import { listReimbursements } from "@/lib/reimbursements/repository";
import { listSiteVisits } from "@/lib/site-visits/repository";
import { listPaymentTrackProjects } from "@/lib/payment-track/repository";
import { runAgentTool } from "@/lib/erp_agent/agent/tools";
import { E3_BUSINESS_SKILLS } from "@/lib/erp_agent/agent/skills";
import { assessKnowledgeReadiness, runAgentHealthChecks } from "@/lib/erp_agent/agent/health";
import { getERPProvider } from "@/lib/erp";
import { getKnowledgeReadinessSnapshot } from "@/lib/knowledge/repository";
import { KNOWLEDGE_TENANT_ID } from "@/lib/knowledge/types";
import { erpCloudflareBindings } from "@/lib/server/cloudflare-storage";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1_000;

function melbourneWeekRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = new Date(Date.parse(`${today}T00:00:00Z`) - ((weekday + 6) % 7) * DAY_MS);
  return {
    from: monday.toISOString().slice(0, 10),
    to: new Date(monday.getTime() + 6 * DAY_MS).toISOString().slice(0, 10),
  };
}

export async function GET(request: Request) {
  const provider = getERPProvider(request);
  const checkDeliveries = async () => {
    const raw = await runAgentTool(provider, { name: "search_delivery_orders", arguments: JSON.stringify({ query: "", status: "all", limit: 1, include_contact_details: false }) });
    const payload = JSON.parse(raw) as { error?: unknown };
    if (payload.error) throw new Error("Project Management source is unavailable.");
  };
  const checkWeeklySchedule = async () => {
    const range = melbourneWeekRange();
    const raw = await runAgentTool(provider, {
      name: "search_weekly_schedule",
      arguments: JSON.stringify({
        query: "",
        source: "all",
        kind: "all",
        status: "all",
        from: range.from,
        to: range.to,
        limit: 1,
        include_assignee: false,
        include_location: false,
        include_customer_contact_details: false,
        include_notes: false,
      }),
    });
    const payload = JSON.parse(raw) as { error?: unknown; sourceWarnings?: unknown };
    if (payload.error || (Array.isArray(payload.sourceWarnings) && payload.sourceWarnings.length)) {
      throw new Error("Weekly Schedule source is unavailable or incomplete.");
    }
  };
  const checkFunctions = {
    inventory: () => provider.listInventory({ limit: 1 }),
    quotations: () => provider.listQuotations({ limit: 1 }),
    project_management: checkDeliveries,
    project_track: () => listPaymentTrackProjects(),
    weekly_schedule: checkWeeklySchedule,
    site_visits: () => listSiteVisits(),
    reimbursements: () => listReimbursements({ includeAll: true }),
    reports: () => getReportContent(),
  } as const;
  const health = await runAgentHealthChecks([...E3_BUSINESS_SKILLS.map((skill) => ({
    id: skill.id,
    source: skill.dataSource,
    check: checkFunctions[skill.id],
  })), {
    id: "knowledge_base",
    source: "Workers AI / Vectorize / Files",
    check: async () => {
      const bindings = await erpCloudflareBindings();
      if (!bindings?.database || !bindings.files || !bindings.workersAi || !bindings.knowledgeVectors
        || !bindings.knowledgeIndexWorkflow) {
        throw new Error("Knowledge vector bindings are unavailable.");
      }
      const readiness = await getKnowledgeReadinessSnapshot(KNOWLEDGE_TENANT_ID);
      const index = await bindings.knowledgeVectors.describe();
      if (!index || index.dimensions !== 1_024 || !Number.isSafeInteger(index.vectorCount)) {
        throw new Error("Knowledge vector index metadata is unavailable.");
      }
      if (readiness.sampleIndexItemKey) {
        const sample = await bindings.knowledgeVectors.getByIds([readiness.sampleIndexItemKey]);
        if (!sample.some((vector) => vector.id === readiness.sampleIndexItemKey)) {
          throw new Error("Knowledge vectors are out of sync with active ERP chunks.");
        }
      }
      return {
        readyDocuments: readiness.readyDocuments,
        activeChunks: readiness.activeChunks,
      };
    },
    assess: assessKnowledgeReadiness,
  }]);
  return Response.json({
    data: { healthy: health.healthy, skills: E3_BUSINESS_SKILLS.length, sources: health.sources },
    meta: { generatedAt: new Date().toISOString(), demoFallbackEnabled: false },
  }, { status: health.healthy ? 200 : 503, headers: { "cache-control": "no-store" } });
}
