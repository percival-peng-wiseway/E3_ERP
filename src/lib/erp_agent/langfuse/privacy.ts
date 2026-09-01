import { createHash, createHmac } from "node:crypto";

const DEFAULT_MAX_CONTENT_CHARS = 2_000;
const MAX_SUMMARY_KEYS = 40;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|api[-_]?key|password|passwd|secret|session[-_]?token|access[-_]?token|refresh[-_]?token)/i;

export type LangfuseEnvironment = Readonly<Record<string, string | undefined>>;

export type TraceSummaryOptions = {
  captureContent?: boolean;
  maxChars?: number;
};

export function langfuseTracingEnabled(env: LangfuseEnvironment = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.LANGFUSE_TRACING_ENABLED?.trim() || "");
}

export function langfuseCaptureContent(env: LangfuseEnvironment = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.LANGFUSE_CAPTURE_CONTENT?.trim() || "");
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_KEY]")
    .replace(/(["']?(?:api[-_]?key|password|passwd|secret|token|authorization|cookie)["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?:\+?61|0)4(?:[ -]?\d){8}\b/g, "[REDACTED_PHONE]");
}

function boundedMaxChars(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, Math.floor(value!))) : DEFAULT_MAX_CONTENT_CHARS;
}

export function summarizeText(value: unknown, options: TraceSummaryOptions = {}): Record<string, unknown> {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const captureContent = options.captureContent ?? langfuseCaptureContent();
  const summary: Record<string, unknown> = {
    kind: "text",
    characterCount: text.length,
  };
  if (!captureContent) return summary;

  const maxChars = boundedMaxChars(options.maxChars);
  summary.content = redactSensitiveText(text.slice(0, maxChars));
  summary.truncated = text.length > maxChars;
  return summary;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort().slice(0, MAX_SUMMARY_KEYS);
}

function sanitizeCapturedValue(value: unknown, maxChars: number, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSensitiveText(value.slice(0, maxChars));
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= 6) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[BINARY_REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeCapturedValue(item, maxChars, depth + 1, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeCapturedValue(item, maxChars, depth + 1, seen);
  }
  return output;
}

export function summarizeToolInput(value: unknown, options: TraceSummaryOptions = {}): Record<string, unknown> {
  const captureContent = options.captureContent ?? langfuseCaptureContent();
  const summary: Record<string, unknown> = {
    kind: "tool-input",
    valueKind: valueKind(value),
    argumentKeys: objectKeys(value),
  };
  if (Array.isArray(value)) summary.itemCount = value.length;
  if (captureContent) summary.arguments = sanitizeCapturedValue(value, boundedMaxChars(options.maxChars));
  return summary;
}

export function summarizeToolOutput(value: unknown, options: TraceSummaryOptions = {}): Record<string, unknown> {
  const captureContent = options.captureContent ?? langfuseCaptureContent();
  const summary: Record<string, unknown> = {
    kind: "tool-output",
    valueKind: valueKind(value),
    outputKeys: objectKeys(value),
  };
  if (Array.isArray(value)) summary.itemCount = value.length;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.ok === "boolean") summary.ok = record.ok;
    for (const key of ["data", "items", "records", "results"]) {
      if (Array.isArray(record[key])) {
        summary.itemCount = record[key].length;
        break;
      }
    }
  }
  if (captureContent) summary.output = sanitizeCapturedValue(value, boundedMaxChars(options.maxChars));
  return summary;
}

export function summarizeTracePayload(value: unknown, options: TraceSummaryOptions = {}): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return summarizeText(value, options);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const kind = (value as Record<string, unknown>).kind;
    if (kind === "text" || kind === "tool-input" || kind === "tool-output") {
      return maskLangfuseData(value);
    }
  }
  if (options.captureContent ?? langfuseCaptureContent()) {
    return sanitizeCapturedValue(value, boundedMaxChars(options.maxChars));
  }
  return {
    kind: valueKind(value),
    ...(Array.isArray(value) ? { itemCount: value.length } : {}),
    ...(!Array.isArray(value) && value && typeof value === "object" ? { keys: objectKeys(value) } : {}),
  };
}

export function maskLangfuseData(data: unknown): unknown {
  return sanitizeCapturedValue(data, 10_000);
}

export function hashedSessionId(rawSessionId: string | null | undefined, salt?: string): string | undefined {
  const normalized = rawSessionId?.trim();
  if (!normalized) return undefined;
  if (/^lf-session-[a-f0-9]{32,64}$/i.test(normalized)) return normalized.toLowerCase();
  const effectiveSalt = salt ?? process.env.LANGFUSE_SESSION_HASH_SALT?.trim();
  const digest = effectiveSalt
    ? createHmac("sha256", effectiveSalt).update(normalized).digest("hex")
    : createHash("sha256").update(`e3-erp-langfuse-session\0${normalized}`).digest("hex");
  return `lf-session-${digest}`;
}
