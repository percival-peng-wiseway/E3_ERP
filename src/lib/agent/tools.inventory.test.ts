import assert from "node:assert/strict";
import test from "node:test";

const inputModule = "./tool-input.ts";
const { normalizedInventoryArgs } = await import(inputModule) as typeof import("./tool-input");

test("normalizes common model variants for inventory status", () => {
  assert.deepEqual(
    normalizedInventoryArgs({ query: "", status: "low-stock", limit: 10 }),
    { query: "", status: "low_stock", limit: 10 },
  );
  assert.deepEqual(
    normalizedInventoryArgs({ query: "", status: "out of stock", limit: "50" }),
    { query: "", status: "out_of_stock", limit: 20 },
  );
  assert.deepEqual(
    normalizedInventoryArgs({ status: "needs-attention" }),
    { query: "", status: "attention", limit: 10 },
  );
});
