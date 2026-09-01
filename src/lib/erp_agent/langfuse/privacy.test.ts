import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { hashedSessionId, langfuseCaptureContent, langfuseTracingEnabled, maskLangfuseData, summarizeText, summarizeToolInput, summarizeToolOutput } from "./privacy.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { observe } from "./tracing.ts";

const tracingEnvironmentKeys = [
  "LANGFUSE_TRACING_ENABLED",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
] as const;
const originalTracingEnvironment = new Map(tracingEnvironmentKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originalTracingEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Langfuse tracing and content capture are explicit opt-ins", () => {
  assert.equal(langfuseTracingEnabled({}), false);
  assert.equal(langfuseTracingEnabled({ LANGFUSE_TRACING_ENABLED: "1" }), true);
  assert.equal(langfuseCaptureContent({}), false);
  assert.equal(langfuseCaptureContent({ LANGFUSE_CAPTURE_CONTENT: "true" }), true);
});

test("text summaries omit content by default", () => {
  assert.deepEqual(summarizeText("customer@example.com", { captureContent: false }), {
    kind: "text",
    characterCount: 20,
  });
});

test("opted-in text capture is bounded and redacted", () => {
  const summary = summarizeText("Bearer abc.def customer@example.com trailing", { captureContent: true, maxChars: 35 });
  assert.equal(summary.characterCount, 44);
  assert.equal(summary.truncated, true);
  assert.doesNotMatch(String(summary.content), /abc\.def|customer@example\.com/);
});

test("tool summaries preserve shape but not customer values", () => {
  const input = summarizeToolInput({ customer: "Alice", password: "secret", limit: 10 }, { captureContent: false });
  assert.deepEqual(input.argumentKeys, ["customer", "limit", "password"]);
  assert.equal("arguments" in input, false);

  const output = summarizeToolOutput({ ok: true, records: [{ customer: "Alice" }] }, { captureContent: false });
  assert.equal(output.ok, true);
  assert.equal(output.itemCount, 1);
  assert.equal("output" in output, false);
});

test("processor masking recursively redacts sensitive fields and text", () => {
  const masked = maskLangfuseData({ apiKey: "do-not-export", nested: { note: "Bearer token-value", email: "customer@example.com" } });
  assert.deepEqual(masked, {
    apiKey: "[REDACTED]",
    nested: { note: "Bearer [REDACTED]", email: "[REDACTED_EMAIL]" },
  });
});

test("session IDs are deterministic salted hashes", () => {
  const first = hashedSessionId("conversation-123", "salt-a");
  assert.equal(first, hashedSessionId("conversation-123", "salt-a"));
  assert.notEqual(first, hashedSessionId("conversation-123", "salt-b"));
  assert.doesNotMatch(first || "", /conversation-123/);
});

test("application work is never retried when an observed operation fails", async () => {
  process.env.LANGFUSE_TRACING_ENABLED = "1";
  process.env.LANGFUSE_PUBLIC_KEY = "test-public";
  process.env.LANGFUSE_SECRET_KEY = "test-secret";
  let calls = 0;
  await assert.rejects(observe({ name: "execute-test-tool", asType: "tool" }, async () => {
    calls += 1;
    throw new TypeError("business_failure");
  }), TypeError);
  assert.equal(calls, 1);
});
