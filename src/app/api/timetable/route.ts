import { getErpSession } from "@/lib/auth/session";
import { listPaymentTrackProjects } from "@/lib/payment-track/repository";
import { listProjectScheduleSourceOverrides } from "@/lib/project-schedule/repository";
import { GET as inventoryOperations } from "@/app/api/inventory/operations/route";
import type { ApiState } from "@/lib/inventory-operations/types";
import { inventoryTimetableEvents, projectTimetableEvents } from "@/lib/timetable/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!getErpSession(request)) return Response.json({ error: "Authentication required." }, { status: 401 });
  try {
    const [projects, overrides, inventory] = await Promise.all([
      listPaymentTrackProjects(), listProjectScheduleSourceOverrides(),
      inventoryOperations(new Request(new URL("/api/inventory/operations", request.url), { headers: request.headers }))
        .then(async (response) => response.ok ? await response.json() as ApiState : null).catch(() => null),
    ]);
    const inventoryReady = inventory && Array.isArray(inventory.orders) && Array.isArray(inventory.deliveryHistory);
    const data = [
      ...projectTimetableEvents(projects, overrides),
      ...(inventoryReady ? inventoryTimetableEvents([...inventory.orders, ...inventory.deliveryHistory], overrides) : []),
    ].sort((a, b) => `${a.date}:${a.time || "99:99"}:${a.id}`.localeCompare(`${b.date}:${b.time || "99:99"}:${b.id}`));
    return Response.json({ data, warnings: inventoryReady ? [] : ["Inventory deliveries could not be refreshed. Project installation and delivery schedules are shown."] }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Time Table is temporarily unavailable." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
