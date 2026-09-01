export type AgentKnowledgeReadiness = {
  status: "checking" | "ready" | "empty" | "unavailable";
  readyDocuments: number;
  activeChunks: number;
};

const UNKNOWN_COUNTS = { readyDocuments: 0, activeChunks: 0 } as const;

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readAgentKnowledgeReadiness(value: unknown): AgentKnowledgeReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  const root = value as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  const sources = (data as Record<string, unknown>).sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  const knowledge = (sources as Record<string, unknown>).knowledge_base;
  if (!knowledge || typeof knowledge !== "object" || Array.isArray(knowledge)) {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  const source = knowledge as Record<string, unknown>;
  if (source.status === "unavailable") {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  if (source.status !== "available" && source.status !== "empty") {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  const details = source.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  const readyDocuments = nonNegativeInteger((details as Record<string, unknown>).readyDocuments);
  const activeChunks = nonNegativeInteger((details as Record<string, unknown>).activeChunks);
  if (readyDocuments === null || activeChunks === null) {
    return { status: "unavailable", ...UNKNOWN_COUNTS };
  }
  return {
    status: source.status === "empty" ? "empty" : "ready",
    readyDocuments,
    activeChunks,
  };
}

export function knowledgeReadinessPresentation(readiness: AgentKnowledgeReadiness) {
  if (readiness.status === "ready") {
    return {
      label: `Knowledge ready ${readiness.readyDocuments}`,
      title: `${readiness.readyDocuments} ready knowledge document${readiness.readyDocuments === 1 ? "" : "s"} · ${readiness.activeChunks} active chunk${readiness.activeChunks === 1 ? "" : "s"}`,
      tone: "ready" as const,
    };
  }
  if (readiness.status === "empty") {
    return {
      label: "Knowledge empty",
      title: "0 ready knowledge documents · 0 active chunks",
      tone: "warning" as const,
    };
  }
  if (readiness.status === "unavailable") {
    return {
      label: "Knowledge unavailable",
      title: "Knowledge bindings or metadata could not be checked",
      tone: "error" as const,
    };
  }
  return {
    label: "Knowledge checking",
    title: "Checking Files and knowledge search readiness",
    tone: "warning" as const,
  };
}
