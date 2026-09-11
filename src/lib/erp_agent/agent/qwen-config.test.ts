import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { resolveQwenConfig } from "./qwen-config.ts";
const keys = ["AGENT_MODEL_PROVIDER", "QWEN_BASE_URL", "QWEN_MODEL_NAME", "QWEN_BASIC_AUTH_USER", "QWEN_BASIC_AUTH_PASSWORD"];
const previous = keys.map((key) => process.env[key]);
afterEach(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
test("rejects unsafe endpoint syntax without echoing URL or credentials", () => {
  process.env.AGENT_MODEL_PROVIDER = "ollama";
  process.env.QWEN_BASIC_AUTH_USER = "erp";
  process.env.QWEN_BASIC_AUTH_PASSWORD = "private-password";
  for (const url of ["http://home.example.test", "https://erp:private-password@home.example.test", "https://home.example.test/?token=private-password", "https://home.example.test/api/chat", "https://home.example.test/#secret", "https://home.example.test/ bad"]) {
    process.env.QWEN_BASE_URL = url;
    assert.throws(resolveQwenConfig, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "QwenConfigurationError");
      assert.equal(error.message.includes("private-password"), false);
      assert.equal(error.message.includes(url), false);
      return true;
    });
  }
});
