import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { BUSINESS_AGENT_TOOLS } from "../business-agent/tools.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { deepSeekStrictSchemaViolations } from "./strict-tool-schema.ts";

function loadMainAgentTools(): readonly unknown[] {
  // The main tool runtime imports Next.js path aliases, which Node's focused
  // strip-types test runner does not resolve. The definitions themselves are a
  // side-effect-free object literal, so evaluate only that declaration here.
  const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
  const marker = "export const DEEPSEEK_TOOLS = ";
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

test("both DeepSeek tool sets satisfy the supported strict JSON-schema subset", () => {
  assert.deepEqual(deepSeekStrictSchemaViolations(loadMainAgentTools()), []);
  assert.deepEqual(deepSeekStrictSchemaViolations(BUSINESS_AGENT_TOOLS), []);
});

test("strict schema lint rejects optional object properties and unsupported length keywords", () => {
  const violations = deepSeekStrictSchemaViolations([{
    type: "function",
    function: {
      name: "invalid",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1 },
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
  assert.ok(violations.some((message) => message.includes("region must be listed in required")));
  assert.ok(violations.some((message) => message.includes("maxLength is not supported")));
});
