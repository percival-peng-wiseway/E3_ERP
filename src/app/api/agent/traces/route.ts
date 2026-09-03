import { getErpSession } from "@/lib/auth/session";
import { listAgentTraces } from "@/lib/erp_agent/agent/trace-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

export async function GET(request: Request) {
  const session = getErpSession(request);
  if (session?.user.role !== "admin") {
    return json({ error: { code: "forbidden", message: "Administrator access is required." } }, { status: 403 });
  }

  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 100;
  try {
    const result = await listAgentTraces(limit);
    return json({ data: { ...result, generatedAt: new Date().toISOString() } });
  } catch (traceError) {
    console.error("Agent Trace read failed", traceError instanceof Error ? traceError.name : "UnknownError");
    return json(
      { error: { code: "traces_unavailable", message: "Agent traces are temporarily unavailable." } },
      { status: 503 },
    );
  }
}
