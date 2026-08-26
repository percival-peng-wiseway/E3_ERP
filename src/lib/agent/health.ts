export type AgentHealthCheck = {
  id: string;
  source: string;
  check: () => Promise<unknown>;
};

export type AgentHealthResult = {
  healthy: boolean;
  sources: Record<string, {
    status: "available" | "unavailable";
    source: string;
  }>;
};

export async function runAgentHealthChecks(
  checks: readonly AgentHealthCheck[],
): Promise<AgentHealthResult> {
  const settled = await Promise.allSettled(checks.map((entry) => entry.check()));
  return {
    healthy: settled.every((result) => result.status === "fulfilled"),
    sources: Object.fromEntries(checks.map((entry, index) => [entry.id, {
      status: settled[index]?.status === "fulfilled" ? "available" : "unavailable",
      source: entry.source,
    }])),
  };
}
