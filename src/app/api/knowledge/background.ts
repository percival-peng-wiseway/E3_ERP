import { after } from "next/server";
import { processKnowledgeIndexJob } from "@/lib/knowledge/index-service";

/** Continue queued parsing/indexing on the platform waitUntil lifecycle. */
export function continueKnowledgeIndex(jobId: string) {
  after(async () => {
    // The index service persists a safe failure state for Administrator retry.
    await processKnowledgeIndexJob(jobId).catch(() => undefined);
  });
}
