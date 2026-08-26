import assert from "node:assert/strict";
import test from "node:test";

const coreModule = "./live-provider-core.ts";
const { LiveERPProviderCore } = await import(coreModule) as typeof import("./live-provider-core");
import type { LiveERPProviderSources } from "./live-provider-core";
import type { Quotation } from "./types";

const quotation: Quotation = {
  id: "quote-1",
  number: "QTN-1",
  customer: "Test Customer",
  status: "draft",
  subtotal: 100,
  tax: 10,
  total: 110,
  currency: "AUD",
  validUntil: "",
  createdAt: "2026-08-26T00:00:00.000Z",
  owner: "Sales User",
  items: [],
};

function sources(overrides: Partial<LiveERPProviderSources> = {}): LiveERPProviderSources {
  return {
    inventory: {
      listInventory: async () => [],
      getInventoryItem: async () => null,
    },
    quoteHelpQuotations: async () => [quotation],
    ...overrides,
  };
}

test("LiveERPProviderCore propagates inventory source errors without demo fallback", async () => {
  const provider = new LiveERPProviderCore(sources({
    inventory: {
      listInventory: async () => { throw new Error("inventory offline"); },
      getInventoryItem: async () => { throw new Error("inventory offline"); },
    },
  }));
  await assert.rejects(provider.listInventory(), /inventory offline/);
  await assert.rejects(provider.getInventoryItem("BAT-ONE"), /inventory offline/);
  assert.equal(provider.source, "http");
});

test("LiveERPProviderCore does not fall back to QuoteHelp when an explicit quotation API fails", async () => {
  let quoteHelpCalls = 0;
  const provider = new LiveERPProviderCore(sources({
    quotationApi: {
      listQuotations: async () => { throw new Error("quotation API offline"); },
      getQuotation: async () => { throw new Error("quotation API offline"); },
    },
    quoteHelpQuotations: async () => {
      quoteHelpCalls += 1;
      return [quotation];
    },
  }));
  await assert.rejects(provider.listQuotations(), /quotation API offline/);
  await assert.rejects(provider.getQuotation("QTN-1"), /quotation API offline/);
  assert.equal(quoteHelpCalls, 0);
});

test("LiveERPProviderCore uses and filters the authenticated QuoteHelp source when no API override exists", async () => {
  const provider = new LiveERPProviderCore(sources());
  assert.deepEqual(await provider.listQuotations({ status: "draft", search: "customer", limit: 1 }), [quotation]);
  assert.equal((await provider.getQuotation("qtn-1"))?.id, "quote-1");
  assert.deepEqual(await provider.listQuotations({ status: "accepted" }), []);
});
