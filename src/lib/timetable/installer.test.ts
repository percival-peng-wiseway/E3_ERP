import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import path from "node:path";

async function bundle(file: string) {
  const result = await build({ entryPoints: [path.resolve(file)], bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { installerRequestAllowed } = await bundle("src/lib/auth/installer-access.ts");
const { projectTimetableEvents, inventoryTimetableEvents } = await bundle("src/lib/timetable/events.ts");
const { installationDetails, melbourneDate, weekStart } = await bundle("src/lib/timetable/types.ts");
const id = "11111111-1111-4111-8111-111111111111";
const project = {
  id, reference: "TEST", quoteNumber: "Q-TEST", stage: "working_in_progress", workMode: "delivery_only",
  customer: { firstName: "Test", lastName: "Customer", phone: "0400000000", email: "test@example.com", addressLine1: "1 Test St", suburb: "Melbourne", state: "VIC", postcode: "3000" },
  specialist: { name: "Sales", phone: "0400000001" },
  items: [{ id: "item-1", category: "Solar Panel", model: "TEST-PANEL", description: "Panel", quantity: 18, capacity: "440 W" }],
  deliverySelections: [{ sku: "CHOSEN-PANEL", quantity: 18 }], projectNotes: "Shared installation notes", pmNotes: "PM site notes",
  deliveryScheduledFor: "2026-09-08", deliveryScheduledTime: "09:00", deliveryAssignee: "Other", deliveredAt: null,
  installationScheduledFor: null, installationScheduledTime: null, installationAssignee: null, installedAt: null, completedAt: null,
  balanceDueCents: 999999, outstandingCents: 888888, contract: { url: "private-contract" }, deposit: { proof: "private-proof" }, history: [{ note: "financial data" }],
};

test("installer allowlist permits only Home, Time Table reads and authentication", () => {
  for (const url of ["/", "/api/auth/session", "/api/timetable", `/api/timetable/projects/${id}`]) assert.equal(installerRequestAllowed("GET", url), true, url);
  for (const url of ["/api/payment-track", "/api/payment-track/abc/files/def", "/api/settings/users", "/api/inventory/operations", "/api/agent", "/api/agent/chat", "/api/files", "/api/notifications", "/api/reimbursements", "/api/reports", "/api/site-visits", "/api/timetable/anything", "/api/timetable/projects/a/notes"]) assert.equal(installerRequestAllowed("GET", url), false, url);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) for (const url of ["/api/timetable", `/api/timetable/projects/${id}`, "/api/project-schedule", "/api/payment-track"]) assert.equal(installerRequestAllowed(method, url), false);
  assert.equal(installerRequestAllowed("POST", "/api/auth/logout"), true);
});

test("installation projection includes requested details without financial or file data", () => {
  const details = installationDetails(project);
  assert.deepEqual(details.items, project.items);
  assert.deepEqual(details.deliverySelections, project.deliverySelections);
  assert.equal(details.projectNotes, "Shared installation notes");
  assert.equal(details.customer.phone, "0400000000");
  for (const forbidden of ["balanceDueCents", "outstandingCents", "contract", "deposit", "history"]) assert.equal(forbidden in details, false);
});

test("all three final schedules include Other, but preferences and partial schedules do not", () => {
  assert.equal(projectTimetableEvents([project], [])[0].kind, "delivery");
  const installation = { ...project, workMode: "installation_only", installationScheduledFor: "2026-09-09", installationScheduledTime: "10:00", installationAssignee: "Other" };
  assert.equal(projectTimetableEvents([installation], [])[0].kind, "installation");
  const combined = { ...installation, workMode: "delivery_and_installation", installationScheduledFor: "2026-09-08", installationScheduledTime: "09:00" };
  assert.equal(projectTimetableEvents([combined], []).length, 1);
  assert.equal(projectTimetableEvents([combined], [])[0].kind, "combined");
  assert.equal(projectTimetableEvents([{ ...project, deliveryScheduledTime: null }], []).length, 0);
  assert.equal(projectTimetableEvents([{ ...project, deliveryScheduledFor: null, deliveryScheduleRequest: { preferredDate: "2026-09-08", preferredTime: "09:00" } }], []).length, 0);
});

test("cancelled and completed entries are excluded from reminders, deleted entries are hidden", () => {
  const cancelled = projectTimetableEvents([project], [{ entryId: `payment-delivery:${id}`, state: "cancelled" }]);
  assert.equal(cancelled[0].cancelled, true);
  assert.equal(cancelled.filter((e: { cancelled: boolean; completed: boolean }) => !e.completed && !e.cancelled).length, 0);
  assert.equal(projectTimetableEvents([project], [{ entryId: `payment-delivery:${id}`, state: "deleted" }]).length, 0);
  const completed = projectTimetableEvents([{ ...project, deliveredAt: "2026-09-08T02:00:00Z" }], []);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].completed, true);
});

test("inventory rows group with stable override IDs and preserve items and notes", () => {
  const order = { id: 2, order_group: "one", status: "scheduled", customer: "Test", phone: "0400000000", planned_date: "2026-09-08", delivery_time: "09:00", sku: "PANEL", quantity: 18, note: "Gate code provided on arrival", driver: "Leo", address: "1 Test St" };
  const rows = [order, { ...order, id: 1, sku: "BATTERY", quantity: 1 }, order];
  const events = inventoryTimetableEvents(rows, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "inventory:orders:1,2");
  assert.equal(events[0].details.items.length, 2);
  assert.match(events[0].details.projectNotes, /Gate code/);
  assert.equal(inventoryTimetableEvents(rows, [{ entryId: "inventory:orders:1,2", state: "deleted" }]).length, 0);
});

test("dates use Melbourne across midnight and daylight saving", () => {
  assert.equal(melbourneDate(new Date("2026-09-07T15:00:00Z")), "2026-09-08");
  assert.equal(melbourneDate(new Date("2026-12-01T13:30:00Z")), "2026-12-02");
  assert.equal(weekStart("2026-09-13"), "2026-09-07");
});
