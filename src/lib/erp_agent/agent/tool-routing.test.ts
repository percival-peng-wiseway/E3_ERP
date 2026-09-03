import assert from "node:assert/strict";
import test from "node:test";

const routingModule = "./tool-routing.ts";
const {
  focusedAgentToolNames,
  isKnowledgeConversationIntent,
  isKnowledgeIntent,
  shouldUseKnowledgeConversationIntent,
} = await import(routingModule) as typeof import("./tool-routing");

test("tool routing narrows explicit quotation, payment and inventory requests", () => {
  assert.deepEqual(focusedAgentToolNames("Show quotation QTN-2026-0001"), ["search_quotations"]);
  assert.deepEqual(focusedAgentToolNames("What is outstanding for PAY-2026-0002?"), ["search_payment_projects"]);
  assert.deepEqual(focusedAgentToolNames("Look up stock SKU BAT-ONE"), ["search_inventory"]);
});

test("product sales questions route to the cross-source activity tool", () => {
  for (const message of [
    "这个月总共卖了多少电池？",
    "本月电池销量是多少？",
    "How many batteries were sold this month?",
    "Show August KH10 units sold",
  ]) {
    assert.deepEqual(focusedAgentToolNames(message), ["search_product_activity"], message);
  }
});

test("SKU usage questions route to lineage instead of the stock balance tool", () => {
  for (const message of [
    "哪些订单用KH10？",
    "哪些客户用了kh10？",
    "Which customer used KH10?",
    "Which orders contain KH10?",
    "KH10有哪些订单还没送货？",
    "Which customer used KH10 in QN202605050003?",
    "Which orders used BAT-ONE?",
    "哪些客户用了CANOPY？",
  ]) {
    assert.deepEqual(focusedAgentToolNames(message), ["search_inventory_usage"], message);
  }
  assert.deepEqual(focusedAgentToolNames("How many KH10 are available?"), ["search_inventory"]);
  assert.deepEqual(focusedAgentToolNames("How many CANOPY are available?"), ["search_inventory"]);
  assert.deepEqual(focusedAgentToolNames("KH10"), ["search_inventory"]);
  assert.equal(focusedAgentToolNames("What is KH10 used for?"), null);
  assert.equal(focusedAgentToolNames("KH10是做什么用的？"), null);
  assert.deepEqual(
    focusedAgentToolNames("Compare KH10 stock with customers who used it"),
    ["search_inventory", "search_inventory_usage"],
  );
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
  assert.deepEqual(focusedAgentToolNames("Give me the workspace overview"), ["get_workspace_overview"]);
  assert.equal(focusedAgentToolNames("Compare low inventory with pending deliveries"), null);
  assert.equal(focusedAgentToolNames("Compare inventory with deliveries this week"), null);
  assert.equal(focusedAgentToolNames("上周有多少收款"), null);
  assert.equal(focusedAgentToolNames("上周有几单付款"), null);
  assert.equal(focusedAgentToolNames("上周有几笔回款"), null);
  assert.deepEqual(focusedAgentToolNames("上周有几项费用"), ["search_reimbursements"]);
});

test("weekly period facts select the canonical Weekly Schedule tool", () => {
  for (const message of [
    "Show completed work this week",
    "Show completed work last week",
    "上周情况",
    "上周工作情况",
    "本周完成情况",
    "上周一共有几单",
    "上周有几单",
    "上周都做了什么",
    "What did we complete last week?",
    "What did we finish last week?",
    "Show inventory deliveries completed last week",
    "显示上周库存送货",
  ]) {
    assert.deepEqual(focusedAgentToolNames(message), ["search_weekly_schedule"], message);
  }
  assert.deepEqual(
    focusedAgentToolNames("Show the current Project Track status"),
    ["search_payment_projects"],
  );
});

test("Site Visiting uses its dedicated read-only tool without hiding combined summaries", () => {
  assert.deepEqual(focusedAgentToolNames("Summarize Site Visiting this week"), ["search_site_visits"]);
  assert.deepEqual(focusedAgentToolNames("显示本周现场勘察安排"), ["search_site_visits"]);
  assert.equal(
    focusedAgentToolNames("Summarize this week's site visits, deliveries, inventory and payments"),
    null,
  );
});

test("ERP support domains receive a narrow Toolset", () => {
  assert.deepEqual(focusedAgentToolNames("Show reimbursement expenses"), ["search_reimbursements"]);
  assert.deepEqual(focusedAgentToolNames("Read the Reports needs document"), ["read_reports_notes"]);
  assert.deepEqual(focusedAgentToolNames("Show current announcements"), ["search_announcements"]);
  assert.deepEqual(focusedAgentToolNames("Search the legacy group discussion"), ["search_group_messages"]);
  assert.equal(shouldUseKnowledgeConversationIntent("Read the Reports needs document"), false);
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
  assert.equal(
    shouldUseKnowledgeConversationIntent("Which customer used KH10?", ["What does the manual say?"]),
    false,
    "an explicit live SKU query overrides a stale knowledge follow-up prefix",
  );
  assert.equal(
    shouldUseKnowledgeConversationIntent("What about after the second time?", ["What does E117 mean?"]),
    true,
  );
  assert.equal(
    shouldUseKnowledgeConversationIntent("What about KH10?", ["What does the troubleshooting manual say about KH8?"]),
    true,
    "a bare identifier can remain a knowledge follow-up without an explicit stock or usage intent",
  );
});

test("an attached screenshot is analysed visually unless company knowledge is explicitly requested", () => {
  const imageContext = { hasImages: true, hasAttachedKnowledgeDocuments: false };
  assert.equal(
    shouldUseKnowledgeConversationIntent("请读一下这个文档截图", [], imageContext),
    false,
  );
  assert.equal(
    shouldUseKnowledgeConversationIntent("What does the warranty text in this image say?", [], imageContext),
    false,
  );
  assert.equal(
    shouldUseKnowledgeConversationIntent("请把这个截图与公司质保政策对照", [], imageContext),
    true,
  );
  assert.equal(
    shouldUseKnowledgeConversationIntent("Compare this screenshot with our internal warranty policy", [], imageContext),
    true,
  );
});
