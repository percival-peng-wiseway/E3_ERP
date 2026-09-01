// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { observe } from "../langfuse/tracing.ts";

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
    const observationName = kind === "tool" ? "execute-deterministic-tool"
      : kind === "model" ? "run-agent-loop"
        : kind === "fallback" ? "run-agent-fallback"
          : name === "harness.route" ? "route-erp-query"
            : name === "harness.workflow" ? "run-deterministic-workflow"
              : "run-workflow-step";
    return observe({
      name: observationName,
      asType: kind === "tool" ? "tool" : "chain",
      metadata: { internalStep: name, internalKind: kind },
    }, async (observation) => {
      const startedAt = Date.now();
      try {
        const result = await work();
        const durationMs = Date.now() - startedAt;
        this.steps.push({ name, kind, status: "ok", durationMs });
        observation.update({ metadata: { internalStep: name, status: "ok", durationMs } });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        this.steps.push({ name, kind, status: "error", durationMs });
        observation.update({
          level: "ERROR",
          statusMessage: "agent_step_failed",
          metadata: { internalStep: name, status: "error", durationMs },
        });
        throw error;
      }
    });
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
