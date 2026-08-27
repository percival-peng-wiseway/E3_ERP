import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { permissionsForRole } from "./authz.ts";
import type { BusinessDataProvider } from "./data-provider";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { runDeepSeekAgent, type DeepSeekConfig } from "./deepseek-provider.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { BusinessToolExecutor } from "./tools.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("supports tool_call to tool_result to validated final answer and reports usage", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let request = 0;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    request += 1;
    return Response.json(request === 1 ? {
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_inventory", arguments: "{\"sku\":\"INV-1\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3 },
    } : {
      choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: "5 available", citations: [], limitations: [] }) } }], usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
  }) as typeof fetch;
  let calls = 0;
  const provider = {
    async getInventory() { calls += 1; return { ok: true, data: [{ sku: "INV-1", product_name: "Panel", warehouse_id: "MEL", warehouse_name: "Melbourne", on_hand: 5, reserved: 0, available: 5, incoming: 0, uom: "ea" }], error_code: null, source: "fake", source_record_ids: ["1"], updated_at: "2026-08-27T00:00:00Z", retryable: false } as const; },
    async searchKnowledge() { throw new Error("unused"); }, async getProject() { throw new Error("unused"); }, async getOrderFinance() { throw new Error("unused"); },
  } satisfies BusinessDataProvider;
  const config: DeepSeekConfig = { apiKey: "secret", baseUrl: "https://api.deepseek.test/beta", flashModel: "flash", complexModel: "pro" };
  const executor = new BusinessToolExecutor(provider, { principalHash: "x", tenantId: "e3", role: "admin", permissions: permissionsForRole("admin") });
  const result = await runDeepSeekAgent({ config, model: "flash", message: "INV-1", executor });
  assert.equal(result.valid, true);
  assert.equal(result.answer, "5 available");
  assert.equal(result.usage?.completion_tokens, 5);
  assert.equal(calls, 1);
  const secondMessages = bodies[1]?.messages as Array<{ role: string }>;
  assert.ok(secondMessages.some((message) => message.role === "tool"));
  assert.equal(JSON.stringify(bodies).includes("secret"), false);
});

test("reuses cached tool results without repeating a costly provider call", async () => {
  let turn = 0;
  globalThis.fetch = (async () => {
    turn += 1;
    if (turn <= 2) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c${turn}`, type: "function", function: { name: "get_inventory", arguments: "{\"sku\":\"INV-1\"}" } }] } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: "ok", citations: [], limitations: [] }) } }] });
  }) as typeof fetch;
  let calls = 0;
  const provider = {
    async getInventory() { calls += 1; return { ok: true, data: [], error_code: null, source: "fake", source_record_ids: [], updated_at: null, retryable: false } as const; },
    async searchKnowledge() { throw new Error("unused"); }, async getProject() { throw new Error("unused"); }, async getOrderFinance() { throw new Error("unused"); },
  } satisfies BusinessDataProvider;
  const config = { apiKey: "x", baseUrl: "https://example.test/beta", flashModel: "flash", complexModel: "pro" };
  const executor = new BusinessToolExecutor(provider, { principalHash: "x", tenantId: "e3", role: "admin", permissions: permissionsForRole("admin") });
  const result = await runDeepSeekAgent({ config, model: "flash", message: "INV-1", executor });
  assert.equal(calls, 1);
  assert.equal(result.toolCalls[1]?.cached, true);
});
