import type { PaymentTrackProject } from "../payment-track/types";
import type { ProjectScheduleSourceOverride } from "../project-schedule/types";
import { scheduledIncompletePaymentTrackProject } from "../payment-track/scheduled-work";
import { installationDetails, melbourneDate, type TimetableEvent } from "./types";

export function projectTimetableEvents(projects: PaymentTrackProject[], overrides: ProjectScheduleSourceOverride[]): TimetableEvent[] {
  const states = new Map(overrides.map((o) => [o.entryId, o.state]));
  return projects.flatMap((project) => {
    const details = installationDetails(project);
    const events: TimetableEvent[] = [];
    const add = (kind: TimetableEvent["kind"], date: string | null, time: string | null, assignee: string, completed: boolean) => {
      const id = `payment-${kind}:${project.id.toLowerCase()}`;
      if (!date || states.get(id) === "deleted") return;
      events.push({ id, kind, date, time, assignee, completed, cancelled: states.get(id) === "cancelled", details });
    };
    const active = scheduledIncompletePaymentTrackProject(project);
    if (active) add(active.source === "material_delivery" ? "delivery" : active.source === "installing" ? "installation" : "combined",
      active.scheduledDate, active.scheduledTime, active.assigneeLabel, false);
    if (project.workMode === "delivery_and_installation") {
      if (project.installedAt) add("combined", project.deliveryScheduledFor || project.installationScheduledFor || melbourneDate(new Date(project.installedAt)),
        project.deliveryScheduledTime || project.installationScheduledTime, [project.deliveryAssignee, project.installationAssignee].filter(Boolean).join(" / "), true);
    } else {
      if (project.deliveredAt) add("delivery", project.deliveryScheduledFor || melbourneDate(new Date(project.deliveredAt)), project.deliveryScheduledTime, project.deliveryAssignee || "Unassigned", true);
      if (project.installedAt) add("installation", project.installationScheduledFor || melbourneDate(new Date(project.installedAt)), project.installationScheduledTime, project.installationAssignee || "Unassigned", true);
    }
    return events;
  }).sort((a, b) => `${a.date}:${a.time || "99:99"}:${a.id}`.localeCompare(`${b.date}:${b.time || "99:99"}:${b.id}`));
}

/** Inventory dispatches use the same stable sorted order IDs as the main calendar. */
export function inventoryTimetableEvents(orders: Array<Omit<import("../inventory-operations/types").Order, "address" | "note"> & { address: string | null; note: string | null }>, overrides: ProjectScheduleSourceOverride[]): TimetableEvent[] {
  const states = new Map(overrides.map((o) => [o.entryId, o.state]));
  const groups = new Map<string, typeof orders>();
  const seen = new Set<number>();
  for (const order of orders) {
    if (seen.has(order.id) || !["scheduled", "delivered"].includes(order.status)) continue;
    seen.add(order.id);
    const key = `${order.status}:${order.order_group || ["legacy", order.sales_rep, order.customer, order.phone || "", order.address || "", order.created_at, order.note || ""].join(":")}`;
    groups.set(key, [...(groups.get(key) || []), order]);
  }
  return [...groups.values()].flatMap((rows) => {
    const sorted = [...rows].sort((a, b) => a.id - b.id);
    const order = sorted[0];
    const id = `inventory:orders:${sorted.map((o) => o.id).join(",")}`;
    const date = order.planned_date || (order.delivered_at ? melbourneDate(new Date(order.delivered_at)) : null);
    if (!date || states.get(id) === "deleted") return [];
    return [{ id, kind: "delivery", date, time: order.delivery_time, assignee: order.driver || "Unassigned",
      completed: order.status === "delivered", cancelled: states.get(id) === "cancelled",
      details: { id, reference: `Inventory delivery #${order.id}`, quoteNumber: "",
        customer: { firstName: order.customer, lastName: "", phone: order.phone || "", email: "", addressLine1: order.address || "", suburb: "", state: "", postcode: "" },
        specialist: { name: order.sales_rep || "", phone: "" },
        items: sorted.map((o) => ({ id: String(o.id), category: "Inventory", model: o.sku, description: o.sku, quantity: o.quantity, capacity: "" })),
        deliverySelections: sorted.map((o) => ({ sku: o.sku, quantity: o.quantity })),
        projectNotes: [...new Set(sorted.map((o) => o.note).filter(Boolean))].join("\n"), pmNotes: "",
        deliveryScheduledFor: date, deliveryScheduledTime: order.delivery_time, deliveryAssignee: null,
        installationScheduledFor: null, installationScheduledTime: null, installationAssignee: null,
      },
    } satisfies TimetableEvent];
  });
}
