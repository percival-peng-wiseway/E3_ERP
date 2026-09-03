export type AgentTraceStep = {
  name: string;
  kind: "workflow" | "tool" | "model" | "fallback";
  status: "ok" | "error" | "skipped";
  durationMs: number;
};

export type AgentTraceToolCall = {
  name: string;
  status: "verified" | "empty" | "unavailable" | "error";
  durationMs: number;
};

export type AgentTraceModelRound = {
  model: string;
  status: "ok" | "error";
  durationMs: number;
  toolCallCount: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type AgentTraceSnapshot = {
  id: string;
  createdAt: string;
  workflow: string | null;
  outcome: "ok" | "fallback" | "error";
  durationMs: number;
  steps: AgentTraceStep[];
  promptVersion: string | null;
  skills: string[];
  toolsets: string[];
  memoryKeys: string[];
  tools: AgentTraceToolCall[];
  modelRounds: AgentTraceModelRound[];
  abstained: boolean;
};

export class AgentTrace {
  readonly id = crypto.randomUUID();
  private readonly startedAt = Date.now();
  private readonly createdAt = new Date(this.startedAt).toISOString();
  private workflow: string | null = null;
  private outcome: AgentTraceSnapshot["outcome"] = "ok";
  private readonly steps: AgentTraceStep[] = [];
  private promptVersion: string | null = null;
  private skills: string[] = [];
  private toolsets: string[] = [];
  private memoryKeys: string[] = [];
  private readonly tools: AgentTraceToolCall[] = [];
  private readonly modelRounds: AgentTraceModelRound[] = [];
  private abstained = false;

  selectWorkflow(name: string) {
    this.workflow = name;
  }

  markOutcome(outcome: AgentTraceSnapshot["outcome"]) {
    this.outcome = outcome;
  }

  selectRoute(value: {
    promptVersion?: string;
    skills: readonly string[];
    toolsets: readonly string[];
    memoryKeys?: readonly string[];
  }) {
    if (value.promptVersion) this.promptVersion = value.promptVersion;
    this.skills = [...new Set(value.skills)];
    this.toolsets = [...new Set(value.toolsets)];
    this.memoryKeys = [...new Set(value.memoryKeys || [])];
  }

  recordTool(call: AgentTraceToolCall) {
    this.tools.push({ ...call });
  }

  recordModelRound(round: AgentTraceModelRound) {
    this.modelRounds.push({ ...round });
  }

  markAbstained() {
    this.abstained = true;
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
      createdAt: this.createdAt,
      workflow: this.workflow,
      outcome: this.outcome,
      durationMs: Date.now() - this.startedAt,
      steps: this.steps.slice(),
      promptVersion: this.promptVersion,
      skills: this.skills.slice(),
      toolsets: this.toolsets.slice(),
      memoryKeys: this.memoryKeys.slice(),
      tools: this.tools.slice(),
      modelRounds: this.modelRounds.slice(),
      abstained: this.abstained,
    };
  }

  emit() {
    // No prompt, tool arguments, results or personal information are logged.
    console.info("E3_AGENT_TRACE", JSON.stringify(this.snapshot()));
  }
}
