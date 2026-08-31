import { after } from "next/server";
import { processKnowledgeIndexJob } from "@/lib/knowledge/index-service";
import { erpCloudflareBindings } from "@/lib/server/cloudflare-storage";

/**
 * Start durable production indexing. Local Node development retains the short
 * after()/waitUntil() path because it uses an injected/local provider.
 */
export async function continueKnowledgeIndex(jobId: string) {
  const bindings = await erpCloudflareBindings();
  if (bindings?.knowledgeIndexWorkflow) {
    await bindings.knowledgeIndexWorkflow.create({
      params: { jobId },
      locationHint: "oc",
    });
    return;
  }

  // Local Node and preview environments have no Workflow binding.
  after(async () => {
    await processKnowledgeIndexJob(jobId).catch(() => undefined);
  });
}
