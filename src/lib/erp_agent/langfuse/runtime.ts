// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { langfuseTracingEnabled } from "./privacy.ts";

export type LangfuseRuntimeController = {
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

const CONTROLLER_KEY = Symbol.for("e3-erp.langfuse.runtime-controller");
const warned = new Set<string>();

function globalRecord(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

export function langfuseTracingConfigured(): boolean {
  return langfuseTracingEnabled()
    && Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim())
    && Boolean(process.env.LANGFUSE_SECRET_KEY?.trim());
}

export function setLangfuseRuntimeController(controller: LangfuseRuntimeController): void {
  globalRecord()[CONTROLLER_KEY] = controller;
}

function controller(): LangfuseRuntimeController | undefined {
  return globalRecord()[CONTROLLER_KEY] as LangfuseRuntimeController | undefined;
}

export function warnLangfuseOnce(code: string): void {
  if (warned.has(code)) return;
  warned.add(code);
  console.warn(`LANGFUSE_TRACING_${code}`);
}

export async function forceFlushLangfuse(): Promise<void> {
  try {
    await controller()?.forceFlush();
  } catch {
    warnLangfuseOnce("FLUSH_FAILED");
  }
}

export async function shutdownLangfuse(): Promise<void> {
  try {
    await controller()?.shutdown();
  } catch {
    warnLangfuseOnce("SHUTDOWN_FAILED");
  }
}

export function scheduleLangfuseFlush(schedule?: (task: () => Promise<void>) => void): void {
  if (!langfuseTracingConfigured()) return;
  if (schedule) {
    try {
      schedule(forceFlushLangfuse);
      return;
    } catch {
      warnLangfuseOnce("FLUSH_SCHEDULE_FAILED");
    }
  }
  void forceFlushLangfuse();
}
