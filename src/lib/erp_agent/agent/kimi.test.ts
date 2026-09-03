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
  answerWithPlannedKimi,
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

const quotationFixture = {
  id: "quote-1",
  number: "QTN-1",
  customer: "Test customer",
  status: "accepted" as const,
  subtotal: 100,
  tax: 10,
  total: 110,
  currency: "AUD",
  validUntil: "2026-09-30",
  createdAt: "2026-09-01T00:00:00.000Z",
  owner: "Ruihan",
  items: [{
    id: "line-1",
    sku: "H3",
    description: "H3 battery",
    quantity: 1,
    uom: "ea",
    unitPrice: 100,
    amount: 100,
  }],
};

function plannedProvider(overrides: Partial<ERPProvider> = {}): ERPProvider {
  return {
    source: "http",
    listInventory: async () => [{
      id: "inventory-1",
      sku: "H3",
      name: "H3 battery",
      category: "Battery",
      warehouse: "Sydney",
      onHand: 4,
      reserved: 1,
      available: 3,
      reorderLevel: 2,
      uom: "ea",
      status: "in_stock",
    }],
    getInventoryItem: async () => null,
    listQuotations: async () => [quotationFixture],
    getQuotation: async () => null,
    ...overrides,
  };
}

function queryPlan(steps: Array<{ id: string; toolName: string; arguments: Record<string, unknown> }>, intent = "Read ERP data") {
  return JSON.stringify({
    version: "e3-agent-query-plan.v1",
    kind: "execute",
    intent,
    responseLanguage: "auto",
    steps: steps.map((step) => ({ ...step, arguments: JSON.stringify(step.arguments) })),
    clarification: "",
  });
}

function successfulModelResponse(content: string) {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  });
}

test("planned Kimi uses K3 JSON-schema planning before K2.6 evidence synthesis", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    return requestBodies.length === 1
      ? successfulModelResponse(queryPlan([{
        id: "step_1",
        toolName: "search_quotations",
        arguments: { query: "", status: "accepted", limit: 10 },
      }], "Summarize accepted quotations"))
      : successfulModelResponse("There is one accepted quotation worth AUD 110.");
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Summarize accepted quotations.",
    conversationId: "planned-conversation",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["quotations"]),
  });

  assert.equal(answer.answer, "There is one accepted quotation worth AUD 110.");
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].model, "kimi-k3");
  assert.equal(Object.hasOwn(requestBodies[0], "thinking"), false, "K3 planning must use the provider's native reasoning mode");
  assert.equal(requestBodies[0].reasoning_effort, "high");
  assert.equal(requestBodies[0].max_completion_tokens, 4_000);
  assert.equal((requestBodies[0].response_format as { type?: string }).type, "json_schema");
  assert.equal(Object.hasOwn(requestBodies[0], "tools"), false, "the planner emits data, not executable tool calls");

  assert.equal(requestBodies[1].model, "kimi-k2.6");
  assert.deepEqual(requestBodies[1].thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(requestBodies[1], "response_format"), false);
  const synthesisMessages = requestBodies[1].messages as Array<{ role: string; content?: string; tool_calls?: unknown[] }>;
  assert.equal(synthesisMessages.some((message) => message.role === "tool" && message.content?.includes('"count":1')), true);
  assert.equal(synthesisMessages.some((message) => message.role === "assistant" && message.tool_calls?.length === 1), true);
});

test("planned knowledge questions add only explicitly required authorised ERP sources", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return successfulModelResponse(JSON.stringify({
      version: "e3-agent-query-plan.v1",
      kind: "clarify",
      intent: "Clarify the requested comparison",
      responseLanguage: "auto",
      steps: [],
      clarification: "Which policy should I compare with current inventory?",
    }));
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Search the knowledge base and compare it with current inventory stock.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["knowledge", "inventory", "quotations"]),
  });

  assert.equal(answer.answer, "Which policy should I compare with current inventory?");
  assert.equal(requestBodies.length, 1);
  const responseFormat = JSON.stringify(requestBodies[0].response_format);
  assert.match(responseFormat, /search_knowledge_base/u);
  assert.match(responseFormat, /search_inventory/u);
  assert.doesNotMatch(responseFormat, /search_quotations/u);
});

test("pure planned knowledge questions retain a knowledge-only tool catalog", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return successfulModelResponse(JSON.stringify({
      version: "e3-agent-query-plan.v1",
      kind: "clarify",
      intent: "Clarify the knowledge topic",
      responseLanguage: "auto",
      steps: [],
      clarification: "Which warranty policy should I search?",
    }));
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Search the knowledge base for our warranty policy.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["knowledge", "inventory", "quotations"]),
  });

  assert.equal(answer.answer, "Which warranty policy should I search?");
  assert.equal(requestBodies.length, 1);
  const responseFormat = JSON.stringify(requestBodies[0].response_format);
  assert.match(responseFormat, /search_knowledge_base/u);
  assert.doesNotMatch(responseFormat, /search_inventory|search_quotations/u);
});

test("planned Kimi uses K3 reasoning controls when K3 is selected as executor", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    return requestBodies.length === 1
      ? successfulModelResponse(queryPlan([{
        id: "step_1",
        toolName: "search_quotations",
        arguments: { query: "", status: "accepted", limit: 10 },
      }]))
      : successfulModelResponse("One accepted quotation was found.");
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Show accepted quotations.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k3",
    enabledSkills: new Set(["quotations"]),
  });

  assert.equal(answer.answer, "One accepted quotation was found.");
  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.equal(body.model, "kimi-k3");
    assert.equal(Object.hasOwn(body, "thinking"), false);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.max_completion_tokens, 4_000);
  }
});

test("planned Kimi abstains before planning when the required tool is not permitted", async () => {
  let inventoryReads = 0;
  let quotationReads = 0;
  let modelCalls = 0;
  globalThis.fetch = (async () => {
    modelCalls += 1;
    return successfulModelResponse(queryPlan([{
      id: "step_1",
      toolName: "search_payment_projects",
      arguments: {
        query: "",
        stage: "all",
        receipt: "all",
        receipt_status: "all",
        created_from: null,
        created_to: null,
        sales_representative: null,
        limit: 20,
        include_assignee: false,
        include_location: false,
        include_customer_contact_details: false,
        include_pm_notes: false,
      },
    }]));
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider({
      listInventory: async () => { inventoryReads += 1; return []; },
      listQuotations: async () => { quotationReads += 1; return []; },
    }),
    auth,
    message: "Show Project Track projects.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k2.6",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["inventory"]),
  });

  assert.match(answer.answer, /No matching information/u);
  assert.equal(modelCalls, 0);
  assert.equal(inventoryReads, 0);
  assert.equal(quotationReads, 0);
});

test("planned Kimi rejects incomplete tool arguments before reading ERP data", async () => {
  let quotationReads = 0;
  globalThis.fetch = (async () => successfulModelResponse(queryPlan([{
    id: "step_1",
    toolName: "search_quotations",
    arguments: { query: "", limit: 20 },
  }]))) as typeof fetch;

  await assert.rejects(answerWithPlannedKimi({
    provider: plannedProvider({
      listQuotations: async () => { quotationReads += 1; return []; },
    }),
    auth,
    message: "Show quotations.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k2.6",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["quotations"]),
  }), /invalid query plan/u);
  assert.equal(quotationReads, 0);
});

test("planned Kimi falls back to K2.6 planning when K3 is unavailable", async () => {
  const models: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    models.push(String(body.model));
    if (models.length === 1) return new Response(null, { status: 503 });
    if (models.length === 2) {
      return successfulModelResponse(JSON.stringify({
        version: "e3-agent-query-plan.v1",
        kind: "direct",
        intent: "Greeting",
        responseLanguage: "auto",
        steps: [],
        clarification: "",
      }));
    }
    return successfulModelResponse("Hello! How can I help?");
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Hello",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
  });

  assert.equal(answer.answer, "Hello! How can I help?");
  assert.deepEqual(models, ["kimi-k3", "kimi-k2.6", "kimi-k2.6"]);
});

test("planned Kimi synthesizes verified sources while labelling unavailable evidence as partial", async () => {
  const modelBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    if (!String(input).includes("api.moonshot.ai")) return new Response(null, { status: 503 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    modelBodies.push(body);
    return modelBodies.length === 1
      ? successfulModelResponse(queryPlan([{
        id: "step_product",
        toolName: "search_product_activity",
        arguments: {
          query: "H3",
          from: "2026-08-31",
          to: "2026-09-06",
          include_customer_names: false,
          limit: 20,
        },
      }, {
        id: "step_quotes",
        toolName: "search_quotations",
        arguments: { query: "H3", status: "all", limit: 20 },
      }], "Summarize H3 activity and quotations"))
      : successfulModelResponse("Partial result: quotation data is available, but Inventory Orders is unavailable.");
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Summarize H3 activity and quotations this week.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["inventory", "quotations"]),
  });

  assert.equal(answer.incompleteData, true);
  assert.match(answer.answer, /^Partial result:/u);
  assert.equal(modelBodies.length, 2);
  const synthesisMessages = modelBodies[1].messages as Array<{ role: string; content?: string }>;
  assert.match(synthesisMessages[0].content || "", /label the answer as partial/i);
  assert.equal(synthesisMessages.filter((message) => message.role === "tool").length, 2);
  assert.equal(synthesisMessages.some((message) => message.role === "tool" && message.content?.includes('"complete":false')), true);
  assert.equal(synthesisMessages.some((message) => message.role === "tool" && message.content?.includes('"count":1')), true);
});

test("planned Kimi reports a zero-match source alongside another verified source", async () => {
  const modelBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    modelBodies.push(body);
    return modelBodies.length === 1
      ? successfulModelResponse(queryPlan([{
        id: "step_inventory",
        toolName: "search_inventory",
        arguments: { query: "H3", status: "all", limit: 20 },
      }, {
        id: "step_quotes",
        toolName: "search_quotations",
        arguments: { query: "H3", status: "all", limit: 20 },
      }], "Compare H3 inventory with quotations"))
      : successfulModelResponse("Inventory has one match; Quotations has zero matches.");
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider({ listQuotations: async () => [] }),
    auth,
    message: "Compare H3 inventory stock with quotations.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["inventory", "quotations"]),
  });

  assert.equal(answer.answer, "Inventory has one match; Quotations has zero matches.");
  assert.equal(answer.incompleteData, undefined);
  const synthesis = modelBodies[1].messages as Array<{ role: string; content?: string }>;
  assert.match(synthesis[0].content || "", /verified zero-match result/i);
  assert.match(synthesis[0].content || "", /not a whole-answer abstention/i);
});

test("planned Project Track queries carry Sales and created-date filters through to evidence synthesis", async () => {
  const modelBodies: Array<Record<string, unknown>> = [];
  const projectArguments = {
    query: "",
    stage: "all",
    receipt: "all",
    receipt_status: "all",
    created_from: "2026-08-31",
    created_to: "2026-09-06",
    sales_representative: "Ruihan",
    limit: 20,
    include_assignee: false,
    include_location: false,
    include_customer_contact_details: false,
    include_pm_notes: false,
  };
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    modelBodies.push(body);
    return modelBodies.length === 1
      ? successfulModelResponse(queryPlan([{
        id: "step_projects",
        toolName: "search_payment_projects",
        arguments: projectArguments,
      }, {
        id: "step_quotes",
        toolName: "search_quotations",
        arguments: { query: "Ruihan", status: "all", limit: 20 },
      }], "Compare Ruihan's new projects with quotations"))
      : successfulModelResponse("Project Track and quotation evidence checked.");
  }) as typeof fetch;

  const answer = await answerWithPlannedKimi({
    provider: plannedProvider(),
    auth,
    message: "Compare Project Track projects added by Sales Ruihan this week with Ruihan's quotations.",
    apiKey: "moonshot-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
    enabledSkills: new Set(["project_track", "quotations"]),
  });

  assert.equal(answer.answer, "Project Track and quotation evidence checked.");
  assert.equal(modelBodies.length, 2);
  const synthesisMessages = modelBodies[1].messages as Array<{
    role: string;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  }>;
  const plannedCalls = synthesisMessages.flatMap((message) => message.tool_calls || []);
  const projectCall = plannedCalls.find((call) => call.function.name === "search_payment_projects");
  assert.ok(projectCall);
  assert.deepEqual(JSON.parse(projectCall.function.arguments), projectArguments);
});
