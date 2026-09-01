import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ERPProvider } from "@/lib/erp";
import type { AgentAuthContext } from "../business-agent/contracts";

// Bundle the production module in memory so Node's focused test runner can
// resolve the same @/* aliases that Next handles in production.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./kimi.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const bundledModuleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { answerWithKimi } = await import(bundledModuleUrl) as typeof import("./kimi");

const originalFetch = globalThis.fetch;
const auth: AgentAuthContext = {
  principalHash: "opaque-test-principal",
  tenantId: "e3",
  role: "admin",
  permissions: new Set(["inventory.read", "knowledge.read", "project.read", "order.read", "finance.read", "subsidy.read"]),
};
const provider = {} as ERPProvider;
const imageParts = [{
  type: "image_url" as const,
  image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
}];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Kimi sends a multimodal image turn with thinking disabled and no forced KB search", async () => {
  const captured: { requestBody?: Record<string, unknown> } = {};
  globalThis.fetch = (async (_input, init) => {
    captured.requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "The screenshot shows a warranty document." },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_tokens_details: { cached_tokens: 5 } },
    });
  }) as typeof fetch;

  const answer = await answerWithKimi({
    provider,
    auth,
    message: "请读一下这个文档截图",
    conversationId: "private-browser-conversation",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    imageParts,
  });

  assert.equal(answer.mode, "kimi");
  assert.equal(answer.answer, "The screenshot shows a warranty document.");
  const requestBody = captured.requestBody;
  assert.ok(requestBody);
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal(requestBody.model, "kimi-k2.6");
  assert.equal(requestBody.tool_choice, "auto");
  assert.equal(String(requestBody.prompt_cache_key).startsWith("conv_"), true);
  assert.equal(JSON.stringify(requestBody).includes("private-browser-conversation"), false);

  const messages = requestBody.messages as Array<{ role: string; content: unknown }>;
  const userContent = messages.at(-1)?.content as Array<{ type: string; text?: string; image_url?: { url?: string } }>;
  assert.equal(userContent[0]?.type, "image_url");
  assert.equal(userContent[0]?.image_url?.url, imageParts[0].image_url.url);
  assert.deepEqual(userContent.at(-1), { type: "text", text: "请读一下这个文档截图" });

  const offeredTools = requestBody.tools as Array<{ function: { name: string } }>;
  assert.equal(offeredTools.some((tool) => tool.function.name === "search_knowledge_base"), false);
});

test("Kimi rejects a tool that was not offered for an image-only turn", async () => {
  globalThis.fetch = (async () => Response.json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-kb",
          type: "function",
          function: { name: "search_knowledge_base", arguments: "{\"query\":\"warranty\",\"limit\":4}" },
        }],
      },
    }],
  })) as typeof fetch;

  await assert.rejects(
    answerWithKimi({
      provider,
      auth,
      message: "Read this warranty screenshot",
      apiKey: "moonshot-test-key",
      baseUrl: "https://api.moonshot.ai/v1",
      model: "kimi-k2.6",
      imageParts,
    }),
    /unavailable tool/u,
  );
});

test("Kimi rejects responses without an explicit complete finish reason", async () => {
  globalThis.fetch = (async () => Response.json({
    choices: [{ message: { role: "assistant", content: "partial" } }],
  })) as typeof fetch;

  await assert.rejects(
    answerWithKimi({
      provider,
      auth,
      message: "Hello",
      apiKey: "moonshot-test-key",
      baseUrl: "https://api.moonshot.ai/v1",
      model: "kimi-k2.6",
    }),
    /incomplete response/u,
  );
});

test("Kimi classifies an authentication failure without reading or exposing its response body", async () => {
  const upstreamMarker = "raw-upstream-secret moonshot-test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { message: upstreamMarker },
  }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;

  await assert.rejects(
    answerWithKimi({
      provider,
      auth,
      message: "Hello",
      apiKey: "moonshot-test-key",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "KimiRequestError");
      assert.equal((error as Error & { kind?: string }).kind, "authentication");
      assert.equal(String(error).includes(upstreamMarker), false);
      return true;
    },
  );
});
