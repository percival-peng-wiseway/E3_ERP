import type { AgentToolName } from "./tool-registry";

export const AGENT_QUERY_PLAN_VERSION = "e3-agent-query-plan.v1" as const;
export const DEFAULT_AGENT_QUERY_PLAN_MAX_STEPS = 6;
export const ABSOLUTE_AGENT_QUERY_PLAN_MAX_STEPS = 16;
export const AGENT_QUERY_PLAN_ARGUMENT_LIMIT = 8_192;

export type AgentQueryPlanKind = "execute" | "direct" | "clarify";
export type AgentQueryResponseLanguage = "auto" | "english" | "chinese";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AgentQueryPlanStep = {
  id: string;
  order: number;
  toolName: AgentToolName;
  /** Canonical JSON object string, ready for executeRegisteredAgentTool. */
  arguments: string;
  readOnly: true;
};

export type AgentQueryPlan = {
  version: typeof AGENT_QUERY_PLAN_VERSION;
  origin: "model" | "deterministic";
  kind: AgentQueryPlanKind;
  /** Ephemeral execution intent. Never include this field in diagnostics. */
  intent: string;
  responseLanguage: AgentQueryResponseLanguage;
  steps: readonly AgentQueryPlanStep[];
  clarification: string;
  evidence: {
    expectedToolSources: readonly AgentToolName[];
    minimumVerifiedSteps: number;
    requireNonEmptyResult: boolean;
    reportUnavailableSources: true;
  };
};

export type AgentQueryPlanValidationOptions = {
  maximumSteps?: number;
  /** Set false for routes where the server requires ERP evidence. */
  allowDirect?: boolean;
  validateArguments?: (toolName: AgentToolName, args: Readonly<Record<string, JsonValue>>) => boolean;
};

export type DeterministicAgentQueryPlanInput = {
  intent: string;
  responseLanguage?: AgentQueryResponseLanguage;
  steps: readonly {
    id?: string;
    toolName: string;
    arguments: string | Readonly<Record<string, JsonValue>>;
  }[];
};

export type AgentQueryPlanDiagnostics = {
  version: typeof AGENT_QUERY_PLAN_VERSION;
  origin: AgentQueryPlan["origin"];
  kind: AgentQueryPlanKind;
  responseLanguage: AgentQueryResponseLanguage;
  stepCount: number;
  toolNames: readonly AgentToolName[];
  minimumVerifiedSteps: number;
  requireNonEmptyResult: boolean;
};

type UnknownRecord = Record<string, unknown>;

const PLAN_KEYS = new Set(["version", "kind", "intent", "responseLanguage", "steps", "clarification"]);
const STEP_KEYS = new Set(["id", "toolName", "arguments"]);
const STEP_ID = /^[a-z][a-z0-9_-]{0,47}$/u;
const FORBIDDEN_ARGUMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function hasOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 4_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((entry) => safeJsonValue(entry, depth + 1));
  }
  const object = record(value);
  if (!object) return false;
  const entries = Object.entries(object);
  return entries.length <= 64 && entries.every(([key, entry]) => (
    key.length <= 100
    && !FORBIDDEN_ARGUMENT_KEYS.has(key)
    && safeJsonValue(entry, depth + 1)
  ));
}

function parseArguments(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > AGENT_QUERY_PLAN_ARGUMENT_LIMIT) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  const args = record(parsed);
  if (!args || !safeJsonValue(args)) return null;
  return { args: args as Readonly<Record<string, JsonValue>>, canonical: JSON.stringify(args) };
}

function maximumSteps(options: AgentQueryPlanValidationOptions) {
  const value = options.maximumSteps ?? DEFAULT_AGENT_QUERY_PLAN_MAX_STEPS;
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, ABSOLUTE_AGENT_QUERY_PLAN_MAX_STEPS)
    : DEFAULT_AGENT_QUERY_PLAN_MAX_STEPS;
}

function responseLanguage(value: unknown): value is AgentQueryResponseLanguage {
  return value === "auto" || value === "english" || value === "chinese";
}

function planKind(value: unknown): value is AgentQueryPlanKind {
  return value === "execute" || value === "direct" || value === "clarify";
}

function readPlanInput(content: string | unknown): UnknownRecord | null {
  if (typeof content !== "string") return record(content);
  if (!content.length || Buffer.byteLength(content, "utf8") > 64 * 1024) return null;
  try {
    return record(JSON.parse(content) as unknown);
  } catch {
    return null;
  }
}

/**
 * Parse and validate a Kimi planning response before any tool is executed.
 * Invalid plans return null without echoing model-produced content into errors.
 */
export function parseAgentQueryPlan(
  content: string | unknown,
  allowedToolNames: ReadonlySet<string> | readonly string[],
  options: AgentQueryPlanValidationOptions = {},
): AgentQueryPlan | null {
  const input = readPlanInput(content);
  if (!input || !hasOnlyKeys(input, PLAN_KEYS)) return null;
  if (input.version !== AGENT_QUERY_PLAN_VERSION || !planKind(input.kind)) return null;
  if (typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > 400) return null;
  if (!responseLanguage(input.responseLanguage)) return null;
  if (typeof input.clarification !== "string" || input.clarification.length > 500) return null;
  if (!Array.isArray(input.steps)) return null;

  const limit = maximumSteps(options);
  if (input.steps.length > limit) return null;
  if (input.kind === "execute" && input.steps.length === 0) return null;
  if (input.kind !== "execute" && input.steps.length !== 0) return null;
  if (input.kind === "clarify" && !input.clarification.trim()) return null;
  if (input.kind !== "clarify" && input.clarification !== "") return null;
  if (input.kind === "direct" && options.allowDirect === false) return null;

  const allowedNames = allowedToolNames instanceof Set
    ? allowedToolNames
    : new Set(allowedToolNames);
  const ids = new Set<string>();
  const steps: AgentQueryPlanStep[] = [];

  for (const [order, rawStep] of input.steps.entries()) {
    const step = record(rawStep);
    if (!step || !hasOnlyKeys(step, STEP_KEYS)) return null;
    if (typeof step.id !== "string" || !STEP_ID.test(step.id) || ids.has(step.id)) return null;
    ids.add(step.id);
    if (typeof step.toolName !== "string" || !allowedNames.has(step.toolName)) return null;
    const toolName = step.toolName as AgentToolName;
    const parsedArguments = parseArguments(step.arguments);
    if (!parsedArguments) return null;
    if (options.validateArguments && !options.validateArguments(toolName, parsedArguments.args)) return null;
    steps.push({
      id: step.id,
      order,
      toolName,
      arguments: parsedArguments.canonical,
      readOnly: true,
    });
  }

  const expectedToolSources = [...new Set(steps.map((step) => step.toolName))];
  return {
    version: AGENT_QUERY_PLAN_VERSION,
    origin: "model",
    kind: input.kind,
    intent: input.intent.trim(),
    responseLanguage: input.responseLanguage,
    steps,
    clarification: input.clarification.trim(),
    evidence: {
      expectedToolSources,
      minimumVerifiedSteps: steps.length ? 1 : 0,
      requireNonEmptyResult: steps.length > 0,
      reportUnavailableSources: true,
    },
  };
}

/** Create a server-owned fallback that crosses the same allow-list and argument boundary. */
export function createDeterministicAgentQueryPlan(
  input: DeterministicAgentQueryPlanInput,
  allowedToolNames: ReadonlySet<string> | readonly string[],
  options: AgentQueryPlanValidationOptions = {},
): AgentQueryPlan | null {
  const draft = {
    version: AGENT_QUERY_PLAN_VERSION,
    kind: "execute",
    intent: input.intent,
    responseLanguage: input.responseLanguage ?? "auto",
    steps: input.steps.map((step, index) => ({
      id: step.id ?? `step_${index + 1}`,
      toolName: step.toolName,
      arguments: typeof step.arguments === "string" ? step.arguments : JSON.stringify(step.arguments),
    })),
    clarification: "",
  };
  const plan = parseAgentQueryPlan(draft, allowedToolNames, options);
  return plan ? { ...plan, origin: "deterministic" } : null;
}

/** Privacy-safe plan metadata for AgentTrace; omits intent, arguments and clarification. */
export function agentQueryPlanDiagnostics(plan: AgentQueryPlan): AgentQueryPlanDiagnostics {
  return {
    version: plan.version,
    origin: plan.origin,
    kind: plan.kind,
    responseLanguage: plan.responseLanguage,
    stepCount: plan.steps.length,
    toolNames: [...new Set(plan.steps.map((step) => step.toolName))],
    minimumVerifiedSteps: plan.evidence.minimumVerifiedSteps,
    requireNonEmptyResult: plan.evidence.requireNonEmptyResult,
  };
}

/**
 * JSON Schema response format for the planning model. This avoids forced
 * tool_choice, which is incompatible with Kimi thinking mode.
 */
export function buildAgentPlanResponseFormat(
  allowedToolNames: readonly AgentToolName[],
  maximumStepCount = DEFAULT_AGENT_QUERY_PLAN_MAX_STEPS,
) {
  const names = [...new Set(allowedToolNames)];
  if (!names.length) throw new Error("At least one read-only tool is required to build a query-plan schema.");
  const maximumSteps = Math.max(1, Math.min(ABSOLUTE_AGENT_QUERY_PLAN_MAX_STEPS, Math.trunc(maximumStepCount)));
  return {
    type: "json_schema",
    json_schema: {
      name: "e3_agent_query_plan",
      strict: true,
      schema: {
        type: "object",
        properties: {
          version: { type: "string", enum: [AGENT_QUERY_PLAN_VERSION] },
          kind: { type: "string", enum: ["execute", "direct", "clarify"] },
          intent: { type: "string", description: "Short execution intent. Do not include record contents or credentials." },
          responseLanguage: { type: "string", enum: ["auto", "english", "chinese"] },
          steps: {
            type: "array",
            maxItems: maximumSteps,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable non-sensitive ID such as step_1." },
                toolName: { type: "string", enum: names },
                arguments: { type: "string", description: "Complete JSON object string matching the selected tool schema." },
              },
              required: ["id", "toolName", "arguments"],
              additionalProperties: false,
            },
          },
          clarification: { type: "string", description: "One short question for kind=clarify; otherwise an empty string." },
        },
        required: ["version", "kind", "intent", "responseLanguage", "steps", "clarification"],
        additionalProperties: false,
      },
    },
  } as const;
}
