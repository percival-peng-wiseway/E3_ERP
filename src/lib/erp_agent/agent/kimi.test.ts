import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ERPProvider } from "@/lib/erp";
import type { AgentAuthContext } from "../business-agent/contracts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { kimiStrictSchemaViolations } from "./strict-tool-schema.ts";

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
const {
  answerWithKimi,
  PERSONAL_SKILL_PROPOSAL_TOOL,
  proposePersonalSkillWithKimi,
} = await import(bundledModuleUrl) as typeof import("./kimi");

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

test("the personal Skill proposal call sends only the bounded current message and one forced schema", async () => {
  const captured: { requestBody?: Record<string, unknown> } = {};
  const proposal = {
    action: "create",
    skill: {
      name: "Weekly stock brief",
      description: "A short stock summary.",
      trigger: "Prepare my weekly stock brief",
      prompt: "Summarize current inventory health.",
      enabled: true,
      capabilityIds: ["inventory"],
    },
  };
  globalThis.fetch = (async (_input, init) => {
    captured.requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "skill-proposal",
            type: "function",
            function: { name: "propose_personal_skill", arguments: JSON.stringify(proposal) },
          }],
        },
      }],
    });
  }) as typeof fetch;

  assert.deepEqual(await proposePersonalSkillWithKimi({
    message: `Create a stock Skill. ${"x".repeat(4_000)}`,
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
  }), proposal);

  const body = captured.requestBody;
  assert.ok(body);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "propose_personal_skill" },
  });
  assert.equal(Object.hasOwn(body, "prompt_cache_key"), false, "builder requests never reuse conversation state");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ role }) => role), ["system", "user"]);
  assert.ok(messages[1].content.length <= 2_000);
  assert.match(messages[0].content, /latest user message/i);
  assert.match(messages[0].content, /manually triggered and read-only/i);

  const tools = body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, "propose_personal_skill");
  const proposalBranches = tools[0].function.parameters.anyOf as Array<Record<string, unknown>>;
  assert.equal(proposalBranches.length, 2);
  assert.equal(proposalBranches.every((branch) => branch.additionalProperties === false), true);
  const schemaText = JSON.stringify(tools[0].function.parameters);
  assert.equal(schemaText.includes("admin.write"), false);
  assert.equal(schemaText.includes("permissions"), false);
  assert.equal(schemaText.includes("search_inventory"), false);
});

test("the personal Skill proposal uses Kimi's supported strict schema subset", () => {
  assert.deepEqual(kimiStrictSchemaViolations([PERSONAL_SKILL_PROPOSAL_TOOL]), []);
});

test("the personal Skill proposal call rejects any unoffered ERP or mutation tool", async () => {
  globalThis.fetch = (async () => Response.json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "unexpected-tool",
          type: "function",
          function: { name: "search_inventory", arguments: "{}" },
        }],
      },
    }],
  })) as typeof fetch;

  await assert.rejects(
    proposePersonalSkillWithKimi({
      message: "Create an inventory summary Skill.",
      apiKey: "moonshot-test-key",
      baseUrl: "https://api.moonshot.ai/v1",
      model: "kimi-k2.6",
    }),
    /unavailable tool/u,
  );
});

test("a disabled knowledge Skill fails closed without calling the model", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ choices: [] });
  }) as typeof fetch;

  const answer = await answerWithKimi({
    provider,
    auth,
    message: "What does the warranty policy say?",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    enabledSkills: new Set(["inventory"]),
  });

  assert.equal(answer.answer, "No matching information was found. Please try again.");
  assert.equal(fetchCalls, 0);
});

test("a custom Skill cannot return workspace claims before a verified tool result", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "Inventory is healthy." },
      }],
    });
  }) as typeof fetch;

  const answer = await answerWithKimi({
    provider,
    auth,
    message: "Summarize current inventory health.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    enabledSkills: new Set(["inventory"]),
    requireVerifiedTool: true,
  });

  assert.equal(answer.answer, "No matching information was found. Please try again.");
  assert.equal(fetchCalls, 1);
});

test("a custom workspace Skill fails closed when any overview source is unavailable", async () => {
  let modelRounds = 0;
  globalThis.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body || "{}")) as { messages?: unknown };
    if (!Array.isArray(requestBody.messages)) return new Response(null, { status: 503 });
    modelRounds += 1;
    if (modelRounds === 1) {
      return Response.json({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "workspace-overview",
              type: "function",
              function: { name: "get_workspace_overview", arguments: "{}" },
            }],
          },
        }],
      });
    }
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "All workspace sources are healthy." },
      }],
    });
  }) as typeof fetch;
  const unavailableProvider = {
    source: "http",
    listInventory: async () => [],
    getInventoryItem: async () => null,
    listQuotations: async () => { throw new Error("source unavailable"); },
    getQuotation: async () => null,
  } as ERPProvider;

  const answer = await answerWithKimi({
    provider: unavailableProvider,
    auth,
    message: "Summarize the workspace.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    enabledSkills: new Set(["workspace"]),
    requireVerifiedTool: true,
  });

  assert.equal(answer.answer, "No matching information was found. Please try again.");
  assert.equal(modelRounds, 1, "the unavailable overview must stop before a model-authored answer");
});

test("a Site Visiting Skill receives only its authorised dedicated read tool", async () => {
  const captured: { requestBody?: Record<string, unknown> } = {};
  globalThis.fetch = (async (_input, init) => {
    captured.requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "There are two visits." },
      }],
    });
  }) as typeof fetch;

  const answer = await answerWithKimi({
    provider,
    auth,
    message: "Summarize Site Visiting this week.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    enabledSkills: new Set(["site_visits"]),
    requireVerifiedTool: true,
  });

  assert.equal(answer.answer, "No matching information was found. Please try again.");
  const body = captured.requestBody;
  assert.ok(body);
  const offeredTools = body.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(offeredTools.map((tool) => tool.function.name), ["search_site_visits"]);
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "search_site_visits" },
  });
});

test("a multi-capability custom Skill cannot answer after checking only one data source", async () => {
  let modelRounds = 0;
  globalThis.fetch = (async () => {
    modelRounds += 1;
    if (modelRounds === 1) {
      return Response.json({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "quotation-only",
              type: "function",
              function: {
                name: "search_quotations",
                arguments: JSON.stringify({ query: "", status: "all", limit: 10 }),
              },
            }],
          },
        }],
      });
    }
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "Quotations and announcements are all healthy." },
      }],
    });
  }) as typeof fetch;
  const quotationProvider = {
    source: "http",
    listInventory: async () => [],
    getInventoryItem: async () => null,
    listQuotations: async () => [{
      id: "quote-1",
      number: "QTN-1",
      customer: "Test customer",
      status: "sent",
      subtotal: 100,
      tax: 10,
      total: 110,
      currency: "AUD",
      validUntil: "2026-09-30",
      createdAt: "2026-09-01T00:00:00.000Z",
      items: [],
    }],
    getQuotation: async () => null,
  } as ERPProvider;

  const answer = await answerWithKimi({
    provider: quotationProvider,
    auth,
    message: "Summarize quotations and announcements.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    enabledSkills: new Set(["quotations", "communications"]),
    requireVerifiedTool: true,
  });

  assert.equal(answer.answer, "No matching information was found. Please try again.");
  assert.equal(modelRounds, 2);
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
