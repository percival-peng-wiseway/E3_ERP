import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { permissionsForRole } from "./authz.ts";
import type { BusinessDataProvider } from "./data-provider";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { chatWithBusinessAgent } from "./service.ts";

const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const keys = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL_FAST", "DEEPSEEK_MODEL_COMPLEX"] as const;
const originalEnv = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  for (const [key, value] of originalEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test("Flash escalates once on incomplete data and Pro reuses the cached tool result", async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_BASE_URL = "https://deepseek.test/beta";
  process.env.DEEPSEEK_MODEL_FAST = "flash";
  process.env.DEEPSEEK_MODEL_COMPLEX = "pro";
  const bodies: Array<Record<string, unknown>> = [];
  let turn = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body); turn += 1;
    if (turn === 1 || turn === 3) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c${turn}`, type: "function", function: { name: "get_inventory", arguments: "{\"sku\":\"INV-100\"}" } }] } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ answer: turn === 2 ? "Flash" : "Pro", citations: [], limitations: [] }) } }] });
  }) as typeof fetch;
  let providerCalls = 0;
  const provider = {
    async getInventory() { providerCalls += 1; return { ok: true, data: [{ sku: "INV-100", product_name: "Panel", warehouse_id: "MEL", warehouse_name: "Melbourne", on_hand: 5, reserved: 1, available: 4, incoming: null, uom: "ea" }], error_code: null, source: "fake", source_record_ids: ["1"], updated_at: "2026-08-27T00:00:00Z", retryable: false, incomplete_data: true } as const; },
    async searchKnowledge() { throw new Error("unused"); }, async getProject() { throw new Error("unused"); }, async getOrderFinance() { throw new Error("unused"); },
  } satisfies BusinessDataProvider;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const response = await chatWithBusinessAgent({
    input: { message: "Show inventory for SKU INV-100", conversation_id: "employee-alice-thread" },
    auth: { principalHash: "opaque-hash", tenantId: "e3", role: "admin", permissions: permissionsForRole("admin") },
    dataProvider: provider,
  });
  assert.equal(response.route, "pro");
  assert.equal(response.model_used, "pro");
  assert.equal(response.answer, "Pro");
  assert.equal(providerCalls, 1);
  assert.deepEqual(bodies.map((body) => body.model), ["flash", "flash", "pro", "pro"]);
  assert.equal(JSON.stringify(bodies).includes("employee-alice-thread"), false);
  assert.equal(response.tool_calls_summary[0]?.cached, false);
  assert.equal(response.tool_calls_summary[1]?.cached, true);
  assert.equal(logs.some((line) => line.includes("Show inventory")), false);
  assert.equal(logs.some((line) => line.includes("test-key")), false);
});

test("missing identifiers return clarification without contacting a model", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  let called = false;
  globalThis.fetch = (async () => { called = true; return Response.json({}); }) as typeof fetch;
  const response = await chatWithBusinessAgent({
    input: { message: "What is the project progress?" },
    auth: { principalHash: "opaque", tenantId: "e3", role: "pm", permissions: permissionsForRole("pm") },
    dataProvider: {} as BusinessDataProvider,
  });
  assert.equal(response.route, "clarification");
  assert.equal(called, false);
});
