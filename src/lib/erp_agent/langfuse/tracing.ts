// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { hashedSessionId, maskLangfuseData, redactSensitiveText, summarizeTracePayload } from "./privacy.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { langfuseTracingConfigured, warnLangfuseOnce } from "./runtime.ts";

export type ObservationType = "span" | "generation" | "embedding" | "agent" | "tool" | "chain" | "retriever" | "evaluator" | "guardrail";
export type ObservationLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

export type TraceObservationAttributes = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  statusMessage?: string;
  version?: string;
  environment?: string;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
};

export type TraceObservation = {
  readonly id?: string;
  readonly traceId?: string;
  update: (attributes: TraceObservationAttributes) => TraceObservation;
};

export type ObserveOptions = TraceObservationAttributes & {
  name: string;
  asType?: ObservationType;
};

export type TraceAgentRequestOptions = Omit<ObserveOptions, "asType"> & {
  userId?: string;
  sessionId?: string;
  tags?: string[];
  traceMetadata?: Record<string, string>;
};

type TracingModule = typeof import("@langfuse/tracing");
const TELEMETRY_FAILURE = Symbol("langfuse-observed-operation-failed");

function cleanName(name: string): string {
  return name.trim().slice(0, 200) || "erp-agent-request";
}

function cleanAttributes(attributes: TraceObservationAttributes): TraceObservationAttributes {
  return {
    ...attributes,
    input: summarizeTracePayload(attributes.input),
    output: summarizeTracePayload(attributes.output),
    metadata: attributes.metadata ? maskLangfuseData(attributes.metadata) as Record<string, unknown> : undefined,
    statusMessage: attributes.statusMessage
      ? redactSensitiveText(attributes.statusMessage.slice(0, 200))
      : undefined,
  };
}

function noopObservation(): TraceObservation {
  const observation: TraceObservation = {
    update: () => observation,
  };
  return observation;
}

function wrappedObservation(raw: { id?: string; traceId?: string; update: (attributes: TraceObservationAttributes) => unknown }): TraceObservation {
  const observation: TraceObservation = {
    id: raw.id,
    traceId: raw.traceId,
    update(attributes) {
      try {
        raw.update(cleanAttributes(attributes));
      } catch {
        warnLangfuseOnce("UPDATE_FAILED");
      }
      return observation;
    },
  };
  return observation;
}

async function runObserved<T>(
  tracing: TracingModule,
  options: ObserveOptions,
  work: (observation: TraceObservation) => T | Promise<T>,
  propagated?: Omit<TraceAgentRequestOptions, keyof ObserveOptions>,
): Promise<T> {
  let workInvoked = false;
  let workCompleted = false;
  let workFailed = false;
  let workFailure: unknown;
  let result!: T;

  const invoke = () => tracing.startActiveObservation(
    cleanName(options.name),
    async (raw) => {
      try {
        const { name: _name, asType: _asType, ...attributes } = options;
        raw.update(cleanAttributes(attributes));
      } catch {
        warnLangfuseOnce("UPDATE_FAILED");
      }
      workInvoked = true;
      try {
        result = await work(wrappedObservation(raw));
        workCompleted = true;
        return result;
      } catch (error) {
        workFailed = true;
        workFailure = error;
        try {
          raw.update({ level: "ERROR", statusMessage: "operation_failed" });
        } catch {
          warnLangfuseOnce("UPDATE_FAILED");
        }
        // Langfuse records rejected Error messages in the OTel span status,
        // outside the processor's input/output/metadata mask. Reject with a
        // opaque telemetry-only sentinel, then rethrow the original below so the
        // application observes exactly the same failure without exporting a
        // provider response, credential, or business value from its message.
        throw TELEMETRY_FAILURE;
      }
    },
    { asType: options.asType ?? "span" } as never,
  );

  try {
    if (!propagated) return await invoke();
    return await tracing.propagateAttributes({
      userId: propagated.userId?.slice(0, 200),
      sessionId: hashedSessionId(propagated.sessionId),
      metadata: propagated.traceMetadata
        ? Object.fromEntries(Object.entries(propagated.traceMetadata)
          .slice(0, 40)
          .map(([key, value]) => [key.slice(0, 100), redactSensitiveText(value).slice(0, 500)]))
        : undefined,
      tags: propagated.tags?.slice(0, 20)
        .map((tag) => redactSensitiveText(tag).slice(0, 200)),
      version: options.version,
      traceName: cleanName(options.name),
      environment: options.environment,
    }, invoke);
  } catch (error) {
    if (workFailed) throw workFailure;
    if (workCompleted) return result;
    if (workInvoked) throw error;
    warnLangfuseOnce("SDK_UNAVAILABLE");
    return work(noopObservation());
  }
}

export async function observe<T>(options: ObserveOptions, work: (observation: TraceObservation) => T | Promise<T>): Promise<T> {
  if (!langfuseTracingConfigured()) return work(noopObservation());
  let tracing: TracingModule;
  try {
    tracing = await import("@langfuse/tracing");
  } catch {
    warnLangfuseOnce("SDK_UNAVAILABLE");
    return work(noopObservation());
  }
  return runObserved(tracing, options, work);
}

export async function traceAgentRequest<T>(options: TraceAgentRequestOptions, work: (observation: TraceObservation) => T | Promise<T>): Promise<T> {
  if (!langfuseTracingConfigured()) return work(noopObservation());
  let tracing: TracingModule;
  try {
    tracing = await import("@langfuse/tracing");
  } catch {
    warnLangfuseOnce("SDK_UNAVAILABLE");
    return work(noopObservation());
  }
  return runObserved(tracing, { ...options, asType: "agent" }, work, options);
}
