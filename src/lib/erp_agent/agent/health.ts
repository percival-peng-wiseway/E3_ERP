export type AgentHealthCheck = {
  id: string;
  source: string;
  check: () => Promise<unknown>;
  assess?: (value: unknown) => AgentHealthAssessment;
};

export type AgentHealthSourceStatus = "available" | "empty" | "unavailable";

export type AgentHealthSourceDetails = Record<string, string | number | boolean | null>;

export type AgentHealthAssessment = {
  status: Exclude<AgentHealthSourceStatus, "unavailable">;
  details?: AgentHealthSourceDetails;
};

export type AgentHealthResult = {
  healthy: boolean;
  sources: Record<string, {
    status: AgentHealthSourceStatus;
    source: string;
    details?: AgentHealthSourceDetails;
  }>;
};

export function assessKnowledgeReadiness(value: unknown): AgentHealthAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Knowledge readiness is invalid.");
  }
  const result = value as Record<string, unknown>;
  const readyDocuments = result.readyDocuments;
  const activeChunks = result.activeChunks;
  if (
    !Number.isSafeInteger(readyDocuments)
    || Number(readyDocuments) < 0
    || !Number.isSafeInteger(activeChunks)
    || Number(activeChunks) < 0
  ) {
    throw new TypeError("Knowledge readiness counts are invalid.");
  }
  return {
    status: readyDocuments === 0 && activeChunks === 0 ? "empty" : "available",
    details: {
      readyDocuments: Number(readyDocuments),
      activeChunks: Number(activeChunks),
    },
  };
}

export async function runAgentHealthChecks(
  checks: readonly AgentHealthCheck[],
): Promise<AgentHealthResult> {
  const settled = await Promise.allSettled(checks.map((entry) => entry.check()));
  const sources: AgentHealthResult["sources"] = Object.fromEntries(checks.map((entry, index) => {
    const result = settled[index];
    if (!result || result.status === "rejected") {
      return [entry.id, { status: "unavailable" as const, source: entry.source }];
    }
    try {
      const assessment = entry.assess?.(result.value);
      return [entry.id, {
        status: assessment?.status || "available",
        source: entry.source,
        ...(assessment?.details ? { details: assessment.details } : {}),
      }];
    } catch {
      return [entry.id, { status: "unavailable" as const, source: entry.source }];
    }
  }));
  return {
    healthy: Object.values(sources).every((source) => source.status !== "unavailable"),
    sources,
  };
}
