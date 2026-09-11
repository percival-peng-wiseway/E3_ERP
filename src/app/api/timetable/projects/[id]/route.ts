import { getErpSession } from "@/lib/auth/session";
import { listPaymentTrackProjects } from "@/lib/payment-track/repository";
import { installationDetails } from "@/lib/timetable/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!getErpSession(request)) return Response.json({ error: "Authentication required." }, { status: 401 });
  try {
    const { id } = await context.params;
    const project = (await listPaymentTrackProjects()).find((p) => p.id === id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    return Response.json({ data: installationDetails(project) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Project details are temporarily unavailable." }, { status: 503 });
  }
}
