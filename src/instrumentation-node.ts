import "server-only";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { maskLangfuseData } from "./lib/erp_agent/langfuse/privacy";
import { setLangfuseRuntimeController, warnLangfuseOnce } from "./lib/erp_agent/langfuse/runtime";

const REGISTRATION_KEY = Symbol.for("e3-erp.langfuse.node-registration");

function registrationRecord(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

export async function registerLangfuseNodeInstrumentation(): Promise<void> {
  const existing = registrationRecord()[REGISTRATION_KEY] as Promise<void> | undefined;
  if (existing) return existing;

  const registration = (async () => {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
    const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
    if (!publicKey || !secretKey) return;

    const processor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || undefined,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || process.env.NODE_ENV,
      release: process.env.LANGFUSE_RELEASE?.trim() || undefined,
      exportMode: "immediate",
      mediaUploadEnabled: false,
      mask: ({ data }) => maskLangfuseData(data),
    });
    const sdk = new NodeSDK({
      serviceName: "e3-erp",
      // Do not export host names, process owners, executable paths, or command
      // arguments from developer machines and Cloudflare build environments.
      autoDetectResources: false,
      spanProcessors: [processor],
    });
    sdk.start();
    setLangfuseRuntimeController({
      forceFlush: () => processor.forceFlush(),
      shutdown: () => sdk.shutdown(),
    });
  })().catch(() => {
    warnLangfuseOnce("INITIALIZATION_FAILED");
  });

  registrationRecord()[REGISTRATION_KEY] = registration;
  return registration;
}
