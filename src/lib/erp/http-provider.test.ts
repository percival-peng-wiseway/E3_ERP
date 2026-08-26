import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

const providerModule = "./http-provider.ts";
const { HttpProvider } = await import(providerModule) as typeof import("./http-provider");

function mockFetch(
  t: TestContext,
  response: () => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response()) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("HttpProvider fails closed when a live source is not configured", async () => {
  const provider = new HttpProvider({});
  await assert.rejects(provider.listInventory(), /not configured/);
  await assert.rejects(provider.listQuotations(), /not configured/);
  assert.equal(provider.source, "http");
});

test("HttpProvider propagates live HTTP source failures instead of returning demo records", async (t) => {
  mockFetch(t, () => new Response("unavailable", { status: 503, statusText: "Unavailable" }));
  const provider = new HttpProvider({ inventoryUrl: "https://inventory.example.test/api" });
  await assert.rejects(provider.listInventory(), /503 Unavailable/);
});

test("HttpProvider rejects a successful error or malformed envelope", async (t) => {
  let call = 0;
  mockFetch(t, () => Response.json(call++ === 0
    ? { error: { code: "source_failed" } }
    : { data: [{ error: "source_failed" }] }));
  const provider = new HttpProvider({ quotationUrl: "https://quotes.example.test/api" });
  await assert.rejects(provider.listQuotations(), /invalid record list/);
  await assert.rejects(provider.listQuotations(), /invalid quotation records/);
});

test("HttpProvider accepts the unified live API envelope and applies filters", async (t) => {
  mockFetch(t, () => Response.json({
    data: [
      { id: "one", sku: "BAT-ONE", name: "Battery One", onHand: 4, reserved: 1, available: 3, status: "in_stock" },
      { id: "two", sku: "BAT-TWO", name: "Battery Two", onHand: 0, reserved: 0, available: 0, status: "out_of_stock" },
    ],
    meta: { source: "http" },
  }));
  const provider = new HttpProvider({ inventoryUrl: "https://inventory.example.test/api" });
  const items = await provider.listInventory({ status: "out_of_stock", limit: 1 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.sku, "BAT-TWO");
});
