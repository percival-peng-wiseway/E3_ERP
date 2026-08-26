import assert from "node:assert/strict";
import test from "node:test";

const routingModule = "./tool-routing.ts";
const { focusedAgentToolNames } = await import(routingModule) as typeof import("./tool-routing");

test("tool routing narrows explicit quotation, payment and inventory requests", () => {
  assert.deepEqual(focusedAgentToolNames("Show quotation QTN-2026-0001"), ["search_quotations"]);
  assert.deepEqual(focusedAgentToolNames("What is outstanding for PAY-2026-0002?"), ["search_payment_projects"]);
  assert.deepEqual(focusedAgentToolNames("Look up stock SKU BAT-ONE"), ["search_inventory"]);
});

test("Project Track references are not treated as inventory identifiers", () => {
  assert.deepEqual(focusedAgentToolNames("PAY-2026-0002"), ["search_payment_projects"]);
});

test("unrecognised or cross-module requests retain the complete tool set", () => {
  assert.equal(focusedAgentToolNames("Show deliveries pending PM review"), null);
  assert.equal(focusedAgentToolNames("Give me the workspace overview"), null);
  assert.equal(focusedAgentToolNames("Compare low inventory with pending deliveries"), null);
});
