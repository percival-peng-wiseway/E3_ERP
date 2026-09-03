import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the production module so the focused Node runner resolves Next's @/* aliases.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./tools.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const bundledModuleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { countedToolSearchJson } = await import(bundledModuleUrl) as typeof import("./tools");

test("counted tool results distinguish total matches from returned rows", () => {
  const result = JSON.parse(countedToolSearchJson({
    matches: [1, 2, 3, 4],
    limit: 2,
    collection: "items",
    project: (item) => ({ id: item }),
  })) as Record<string, unknown>;

  assert.equal(result.count, 4);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.totalAvailable, true);
  assert.equal(result.countIsLowerBound, false);
  assert.deepEqual(result.items, [{ id: 1 }, { id: 2 }]);
});

test("already-capped sources label counts as lower bounds", () => {
  const result = JSON.parse(countedToolSearchJson({
    matches: [1, 2],
    limit: 2,
    collection: "items",
    project: (item) => ({ id: item }),
    totalAvailable: false,
    sourceTruncated: true,
  })) as Record<string, unknown>;

  assert.equal(result.count, 2);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.totalAvailable, false);
  assert.equal(result.countIsLowerBound, true);
});

test("latest-item selection and projection do not expose omitted source fields", () => {
  const result = JSON.parse(countedToolSearchJson({
    matches: [
      { id: 1, public: "old", secret: "do-not-return" },
      { id: 2, public: "new", secret: "do-not-return" },
    ],
    limit: 1,
    collection: "messages",
    selection: "last",
    project: (item) => ({ id: item.id, content: item.public }),
  })) as Record<string, unknown>;

  assert.equal(result.count, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.messages, [{ id: 2, content: "new" }]);
  assert.doesNotMatch(JSON.stringify(result), /do-not-return/u);
});

test("byte-limit trimming keeps the total-count contract", () => {
  const result = JSON.parse(countedToolSearchJson({
    matches: Array.from({ length: 20 }, (_, index) => index),
    limit: 20,
    collection: "items",
    project: (item) => ({ id: item, content: "x".repeat(4_000) }),
  })) as Record<string, unknown>;

  assert.equal(result.count, 20);
  assert.ok(typeof result.returned === "number" && result.returned < 20);
  assert.equal(result.truncated, true);
  assert.equal(result.totalAvailable, true);
  assert.equal(result.countIsLowerBound, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 32 * 1024);
});
