import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import * as XLSX from "xlsx";

const bundle = await build({
  stdin: { contents: 'export * from "./calculate"; export * from "./defaults"; export * from "./quote-transfer"; export * from "./quote-excel"; export * from "./quote-inputs";', resolveDir: new URL(".", import.meta.url).pathname, loader: "ts" },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
});
const loaded = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { calculateQuote, defaultQuote, defaultSettings, extractImportedQuotePayloads, createQuotesWorkbook, parseQuotesWorkbook, normalizeQuoteConfiguration } = loaded.exports as typeof import("./calculate") & typeof import("./defaults") & typeof import("./quote-transfer") & typeof import("./quote-excel") & typeof import("./quote-inputs");

test("item names and per-quote margins recalculate every mode and brand without changing costs or defaults", () => {
  for (const mode of ["residential", "ci"] as const) for (const equipmentBrand of ["fox", "sig"] as const) {
    const original = normalizeQuoteConfiguration({ ...structuredClone(defaultQuote), mode, equipmentBrand, manualCosts: { ...defaultQuote.manualCosts, delivery: 200 } }, defaultSettings);
    const baseline = calculateQuote(original, defaultSettings);
    const edited = { ...original, itemNames: { delivery: "Site delivery", inverter: "Selected inverter" }, manualMargins: { delivery: 0.5, inverter: 0 } };
    const result = calculateQuote(edited, defaultSettings);
    const delivery = result.lineItems.find((r) => r.key === "delivery")!;
    const inverter = result.lineItems.find((r) => r.key === "inverter")!;
    assert.equal(delivery.label, "Site delivery");
    assert.equal(delivery.salesPrice, 300);
    assert.equal(inverter.salesPrice, inverter.cost);
    assert.equal(inverter.margin, 0);
    assert.equal(inverter.label, "Selected inverter");
    assert.deepEqual(result.lineItems.map((r) => r.cost), baseline.lineItems.map((r) => r.cost));
    const delta = result.totalSalesPriceExGst - baseline.totalSalesPriceExGst;
    assert.ok(Math.abs(result.quoteRequiredBalance - baseline.quoteRequiredBalance - delta * (1 + defaultSettings.gstRate)) < 0.00001);
    assert.deepEqual(calculateQuote(original, defaultSettings), baseline);
  }
});

test("renaming commission preserves its GST treatment and names never select cost or margin rules", () => {
  const original = { ...structuredClone(defaultQuote), manualCosts: { ...defaultQuote.manualCosts, externalCommission: 100 }, manualMargins: { externalCommission: 0.25 } };
  const before = calculateQuote(original, defaultSettings);
  const after = calculateQuote({ ...original, itemNames: { externalCommission: "Referral fee", delivery: "External Commission incl. GST" }, manualMargins: { externalCommission: 0.5 } }, defaultSettings);
  assert.equal(after.quoteRequiredBalance - before.quoteRequiredBalance, 25);
  assert.equal(after.totalCostExGst, before.totalCostExGst);
  assert.equal(after.lineItems.find((r) => r.key === "externalCommission")?.label, "Referral fee");
});

test("legacy names and margins retain defaults; empty names and invalid margins use safe values", () => {
  const baseline = calculateQuote(defaultQuote, defaultSettings);
  const result = calculateQuote({ ...defaultQuote, itemNames: { inverter: "  " }, manualMargins: { inverter: NaN, delivery: -1 } }, defaultSettings);
  assert.equal(result.lineItems.find((r) => r.key === "inverter")?.label, "Inverter");
  assert.equal(result.lineItems.find((r) => r.key === "inverter")?.margin, baseline.lineItems.find((r) => r.key === "inverter")?.margin);
  assert.equal(result.lineItems.find((r) => r.key === "delivery")?.margin, 0);
});

test("saved payload and Excel exports preserve renamed items and decimal margins", () => {
  const payload = { ...structuredClone(defaultQuote), customerName: "Quote editing fixture", itemNames: { delivery: "Site delivery", externalCommission: "Referral fee" }, manualMargins: { delivery: 0.125, externalCommission: 0 }, customItems: [{ id: "custom-1", name: "Special work", cost: 80, margin: 0.3 }] };
  const saved = JSON.parse(JSON.stringify(payload));
  const expected = calculateQuote(payload, defaultSettings);
  assert.deepEqual(calculateQuote(saved, defaultSettings), expected);
  const bytes = createQuotesWorkbook([{ id: "quote-1", projectName: payload.customerName, ownerName: "Test", status: "drafting", payload, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z" }], defaultSettings);
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames.find((name) => !["Summary", "Quotes", "Instructions"].includes(name))!];
  const row = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }).find((row) => row[0] === "Site delivery")!;
  assert.equal(row[2], 0.125);
  assert.equal(row[3], expected.lineItems.find((r) => r.key === "delivery")?.salesPrice);
  const imported = extractImportedQuotePayloads(parseQuotesWorkbook(bytes))[0];
  assert.deepEqual(imported.itemNames, payload.itemNames);
  assert.deepEqual(imported.manualMargins, payload.manualMargins);
  assert.deepEqual(calculateQuote(imported, defaultSettings).lineItems, expected.lineItems);
});
