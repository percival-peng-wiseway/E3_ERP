import assert from "node:assert/strict";
import test from "node:test";

const healthModule = "./health.ts";
const { assessKnowledgeReadiness, runAgentHealthChecks } = await import(healthModule) as typeof import("./health");

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

test("agent health distinguishes an empty knowledge base from unavailable bindings", async () => {
  const empty = await runAgentHealthChecks([{
    id: "knowledge_base",
    source: "Cloudflare AI Search / Files",
    check: async () => ({ readyDocuments: 0, activeChunks: 0 }),
    assess: assessKnowledgeReadiness,
  }]);
  assert.deepEqual(empty, {
    healthy: true,
    sources: {
      knowledge_base: {
        status: "empty",
        source: "Cloudflare AI Search / Files",
        details: { readyDocuments: 0, activeChunks: 0 },
      },
    },
  });

  const unavailable = await runAgentHealthChecks([{
    id: "knowledge_base",
    source: "Cloudflare AI Search / Files",
    check: async () => { throw new Error("binding missing"); },
    assess: assessKnowledgeReadiness,
  }]);
  assert.equal(unavailable.healthy, false);
  assert.deepEqual(unavailable.sources.knowledge_base, {
    status: "unavailable",
    source: "Cloudflare AI Search / Files",
  });
});

test("knowledge readiness reports searchable counts and rejects invalid health data", async () => {
  assert.deepEqual(assessKnowledgeReadiness({ readyDocuments: 2, activeChunks: 19 }), {
    status: "available",
    details: { readyDocuments: 2, activeChunks: 19 },
  });

  const invalid = await runAgentHealthChecks([{
    id: "knowledge_base",
    source: "Cloudflare AI Search / Files",
    check: async () => ({ readyDocuments: 1, activeChunks: -1 }),
    assess: assessKnowledgeReadiness,
  }]);
  assert.equal(invalid.healthy, false);
  assert.equal(invalid.sources.knowledge_base.status, "unavailable");
});
