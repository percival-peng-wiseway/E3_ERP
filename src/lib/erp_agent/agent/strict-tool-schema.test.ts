import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { BUSINESS_AGENT_TOOLS } from "../business-agent/tools.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { kimiStrictSchemaViolations } from "./strict-tool-schema.ts";

function loadMainAgentTools(): readonly unknown[] {
  // The main tool runtime imports Next.js path aliases, which Node's focused
  // strip-types test runner does not resolve. The definitions themselves are a
  // side-effect-free object literal, so evaluate only that declaration here.
  const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
  const marker = "export const KIMI_TOOLS = ";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const expressionStart = start + marker.length;
  const expressionEnd = source.indexOf("] as const;", expressionStart);
  assert.notEqual(expressionEnd, -1);
  const expression = source.slice(expressionStart, expressionEnd + 1);
  const loaded: unknown = Function(`"use strict"; return (${expression});`)();
  assert.ok(Array.isArray(loaded));
  return loaded;
}

test("both Kimi tool sets satisfy the supported strict JSON-schema subset", () => {
  assert.deepEqual(kimiStrictSchemaViolations(loadMainAgentTools()), []);
  assert.deepEqual(kimiStrictSchemaViolations(BUSINESS_AGENT_TOOLS), []);
});

test("strict schema lint rejects optional properties and keywords outside Kimi MFJS", () => {
  const violations = kimiStrictSchemaViolations([{
    type: "function",
    function: {
      name: "invalid",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, pattern: "^x" },
          count: { type: "integer", minimum: 1 },
          choice: { oneOf: [{ type: "string" }, { type: "integer" }] },
          filters: {
            type: "object",
            additionalProperties: false,
            properties: { region: { type: "string", maxLength: 80 } },
            required: [],
          },
        },
        required: ["query"],
      },
    },
  }]);
  assert.ok(violations.some((message) => message.includes("filters must be listed in required")));
  assert.ok(violations.some((message) => message.includes("minLength is not supported")));
  assert.ok(violations.some((message) => message.includes("pattern is not supported")));
  assert.ok(violations.some((message) => message.includes("minimum is not supported")));
  assert.ok(violations.some((message) => message.includes("oneOf is not supported")));
  assert.ok(violations.some((message) => message.includes("region must be listed in required")));
  assert.ok(violations.some((message) => message.includes("maxLength is not supported")));
});
