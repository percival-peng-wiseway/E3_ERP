export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!/^(?:1|true|yes|on)$/i.test(process.env.LANGFUSE_TRACING_ENABLED?.trim() || "")) return;

  try {
    const { registerLangfuseNodeInstrumentation } = await import("./instrumentation-node");
    await registerLangfuseNodeInstrumentation();
  } catch {
    console.warn("LANGFUSE_TRACING_INITIALIZATION_FAILED");
  }
}
