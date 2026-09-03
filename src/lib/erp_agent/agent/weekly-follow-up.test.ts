import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./weekly-follow-up.ts";
const { resolveWeeklyFollowUpMessage } = await import(modulePath) as typeof import("./weekly-follow-up");

const weeklyQuery = "Show completed work last week";

test("bounded verification follow-ups rerun the immediately preceding weekly query", () => {
  const history = [
    { role: "user" as const, content: weeklyQuery },
    { role: "assistant" as const, content: "There were three completed records." },
  ];
  for (const followUp of [
    "只有三个吗",
    "只有四个吗",
    "只有5条吗？",
    "只有这些吗？",
    "确定没有遗漏吗",
    "有遗漏吗？",
    "还有吗",
    "Only three?",
    "Only 4 records?",
    "Only 5?",
    "Only those jobs?",
    "Anything else?",
    "Are you sure nothing is missing?",
  ]) {
    assert.equal(resolveWeeklyFollowUpMessage(followUp, history), weeklyQuery, followUp);
  }
});

test("weekly follow-up preserves the prior user's raw query", () => {
  const rawQuery = "  上周工作情况？  ";
  assert.equal(
    resolveWeeklyFollowUpMessage("只有这些吗", [{ role: "user", content: rawQuery }]),
    rawQuery,
  );
});

test("inventory delivery weekly queries support the same verification follow-ups", () => {
  for (const previous of [
    "Show inventory deliveries completed last week",
    "显示上周库存送货",
  ]) {
    assert.equal(
      resolveWeeklyFollowUpMessage("只有三个吗", [{ role: "user", content: previous }]),
      previous,
      previous,
    );
  }
});

test("weekly follow-up never inherits assistant content", () => {
  assert.equal(
    resolveWeeklyFollowUpMessage("只有三个吗", [
      { role: "user", content: "Show inventory" },
      { role: "assistant", content: weeklyQuery },
    ]),
    "只有三个吗",
  );
  assert.equal(
    resolveWeeklyFollowUpMessage("Anything else?", [
      { role: "assistant", content: weeklyQuery },
    ]),
    "Anything else?",
  );
});

test("weekly follow-up does not cross the latest non-weekly user request", () => {
  assert.equal(
    resolveWeeklyFollowUpMessage("Are you sure nothing is missing?", [
      { role: "user", content: weeklyQuery },
      { role: "assistant", content: "Three records." },
      { role: "user", content: "Show inventory" },
      { role: "assistant", content: "Inventory answer." },
    ]),
    "Are you sure nothing is missing?",
  );
});

test("unlisted or expanded follow-ups are not rewritten", () => {
  const history = [{ role: "user" as const, content: weeklyQuery }];
  for (const message of [
    "真的吗",
    "What else?",
    "只有三个吗，请解释原因",
    "只有四个吗，再检查库存",
    "Anything else in inventory?",
    "Only 5 records from Inventory?",
  ]) {
    assert.equal(resolveWeeklyFollowUpMessage(message, history), message, message);
  }
});

test("previous requests must route exclusively to Weekly Schedule", () => {
  for (const previous of [
    "Summarize this week's site visits, deliveries, inventory and payments",
    "Compare inventory with deliveries this week",
  ]) {
    assert.equal(
      resolveWeeklyFollowUpMessage("有遗漏吗", [{ role: "user", content: previous }]),
      "有遗漏吗",
      previous,
    );
  }
});
