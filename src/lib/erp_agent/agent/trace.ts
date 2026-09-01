export type AgentTraceStep = {
  name: string;
  kind: "workflow" | "tool" | "model" | "fallback";
  status: "ok" | "error" | "skipped";
  durationMs: number;
};

export type AgentTraceSnapshot = {
  id: string;
  workflow: string | null;
  outcome: "ok" | "fallback" | "error";
  durationMs: number;
  steps: AgentTraceStep[];
};

export class AgentTrace {
  readonly id = crypto.randomUUID();
  private readonly startedAt = Date.now();
  private workflow: string | null = null;
  private outcome: AgentTraceSnapshot["outcome"] = "ok";
  private readonly steps: AgentTraceStep[] = [];

  selectWorkflow(name: string) {
    this.workflow = name;
  }

  markOutcome(outcome: AgentTraceSnapshot["outcome"]) {
    this.outcome = outcome;
  }

  async step<T>(name: string, kind: AgentTraceStep["kind"], work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await work();
      const durationMs = Date.now() - startedAt;
      this.steps.push({ name, kind, status: "ok", durationMs });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.steps.push({ name, kind, status: "error", durationMs });
      throw error;
    }
  }

  snapshot(): AgentTraceSnapshot {
    return {
      id: this.id,
      workflow: this.workflow,
      outcome: this.outcome,
      durationMs: Date.now() - this.startedAt,
      steps: this.steps.slice(),
    };
  }

  emit() {
    // No prompt, tool arguments, results or personal information are logged.
    console.info("E3_AGENT_TRACE", JSON.stringify(this.snapshot()));
  }
}
