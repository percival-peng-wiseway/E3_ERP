import assert from "node:assert/strict";
import test from "node:test";

const healthModule = "./health.ts";
const { runAgentHealthChecks } = await import(healthModule) as typeof import("./health");

test("agent health reports every source available only when every check succeeds", async () => {
  const result = await runAgentHealthChecks([
    { id: "inventory", source: "Inventory API", check: async () => [] },
    { id: "quotations", source: "QuoteHelp", check: async () => ({}) },
  ]);
  assert.deepEqual(result, {
    healthy: true,
    sources: {
      inventory: { status: "available", source: "Inventory API" },
      quotations: { status: "available", source: "QuoteHelp" },
    },
  });
});

test("agent health fails closed without returning a source exception", async () => {
  const result = await runAgentHealthChecks([
    { id: "inventory", source: "Inventory API", check: async () => [] },
    { id: "quotations", source: "QuoteHelp", check: async () => {
      throw new Error("sensitive upstream response");
    } },
  ]);
  assert.equal(result.healthy, false);
  assert.deepEqual(result.sources.quotations, { status: "unavailable", source: "QuoteHelp" });
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream response/);
});
