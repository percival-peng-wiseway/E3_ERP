import assert from "node:assert/strict";
import test from "node:test";

const routingModule = "./tool-routing.ts";
const { focusedAgentToolNames, isKnowledgeConversationIntent, isKnowledgeIntent } = await import(routingModule) as typeof import("./tool-routing");

test("tool routing narrows explicit quotation, payment and inventory requests", () => {
  assert.deepEqual(focusedAgentToolNames("Show quotation QTN-2026-0001"), ["search_quotations"]);
  assert.deepEqual(focusedAgentToolNames("What is outstanding for PAY-2026-0002?"), ["search_payment_projects"]);
  assert.deepEqual(focusedAgentToolNames("Look up stock SKU BAT-ONE"), ["search_inventory"]);
});

test("Project Track references are not treated as inventory identifiers", () => {
  assert.deepEqual(focusedAgentToolNames("PAY-2026-0002"), ["search_payment_projects"]);
  assert.deepEqual(focusedAgentToolNames("What items are selected for CPEC5256?"), ["search_payment_projects"]);
  assert.deepEqual(focusedAgentToolNames("When is CPEC5256 scheduled?"), ["search_weekly_schedule"]);
});

test("unrecognised or cross-module requests retain the complete tool set", () => {
  assert.deepEqual(focusedAgentToolNames("Show deliveries pending PM review"), ["search_delivery_orders"]);
  assert.deepEqual(focusedAgentToolNames("Give me a Project Management overview"), ["search_delivery_orders"]);
  assert.deepEqual(focusedAgentToolNames("What is scheduled tomorrow?"), ["search_weekly_schedule"]);
  assert.equal(focusedAgentToolNames("Give me the workspace overview"), null);
  assert.equal(focusedAgentToolNames("Compare low inventory with pending deliveries"), null);
});

test("knowledge questions select only the authorised knowledge search tool", () => {
  assert.equal(isKnowledgeIntent("What does the battery warranty policy say?"), true);
  assert.equal(isKnowledgeIntent("电池质保流程是什么？"), true);
  assert.deepEqual(focusedAgentToolNames("What does the battery warranty policy say?"), ["search_knowledge_base"]);
  assert.deepEqual(focusedAgentToolNames("请查询知识库里的安装手册"), ["search_knowledge_base"]);
  assert.deepEqual(focusedAgentToolNames("E117 appeared twice. What should I save?"), ["search_knowledge_base"]);
  assert.deepEqual(focusedAgentToolNames("What is the 5 kW export acceptance tolerance?"), ["search_knowledge_base"]);
  assert.equal(isKnowledgeConversationIntent("What about after the second time?", ["What does E117 mean?"]), true);
  assert.equal(isKnowledgeConversationIntent("Show inventory", ["What does E117 mean?"]), false);
});
