import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { loadInventoryItems, loadQuotations } from "./data-source.js";

function configureSource(t: TestContext, fetchResponse?: () => Response | Promise<Response>) {
  const originalUrl = process.env.ERP_WORKSPACE_API_URL;
  const originalToken = process.env.ERP_WORKSPACE_API_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.ERP_WORKSPACE_API_URL = "https://workspace.example.test";
  process.env.ERP_WORKSPACE_API_TOKEN = "test-token";
  if (fetchResponse) globalThis.fetch = (async () => fetchResponse()) as typeof fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ERP_WORKSPACE_API_URL;
    else process.env.ERP_WORKSPACE_API_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ERP_WORKSPACE_API_TOKEN;
    else process.env.ERP_WORKSPACE_API_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
}

test("MCP data sources require an explicit live workspace URL", async (t) => {
  const originalUrl = process.env.ERP_WORKSPACE_API_URL;
  delete process.env.ERP_WORKSPACE_API_URL;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ERP_WORKSPACE_API_URL;
    else process.env.ERP_WORKSPACE_API_URL = originalUrl;
  });
  await assert.rejects(loadInventoryItems(), /required/);
  await assert.rejects(loadQuotations(), /required/);
});

test("MCP data sources propagate live HTTP errors", async (t) => {
  configureSource(t, () => new Response("unavailable", { status: 503 }));
  await assert.rejects(loadInventoryItems(), /returned 503/);
});

test("MCP data sources reject a successful error envelope instead of reporting zero records", async (t) => {
  let call = 0;
  configureSource(t, () => Response.json(call++ === 0
    ? { error: { code: "source_failed" } }
    : { data: [{ error: "source_failed" }] }));
  await assert.rejects(loadQuotations(), /invalid record list/);
  await assert.rejects(loadQuotations(), /invalid quotation records/);
});

test("MCP data sources map the unified workspace envelopes", async (t) => {
  configureSource(t, () => Response.json({
    data: [{
      id: "item-1",
      sku: "BAT-ONE",
      name: "Battery One",
      onHand: 3,
      reserved: 1,
      available: 2,
      reorderLevel: 1,
      uom: "unit"
    }]
  }));
  const items = await loadInventoryItems();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.sku, "BAT-ONE");
  assert.equal(items[0]?.quantityAvailable, 2);
});
