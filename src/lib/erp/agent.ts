import type { ERPProvider } from "./provider";
import { buildDashboard } from "./provider";
import type {
  AgentAnswer,
  AgentHistoryMessage,
  InventoryItem,
  Quotation,
  QuotationStatus,
} from "./types";

const DEFAULT_SUGGESTIONS = [
  "Which items need replenishment?",
  "Give me an inventory overview",
  "What is the current active quotation value?",
  "Look up QTN-2026-0096",
];

const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value);
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${formatNumber(value)}`;
  }
}

function includesAny(message: string, terms: string[]): boolean {
  return terms.some((term) => message.includes(term));
}

function extractQuotationNumber(message: string): string | null {
  const match = message.match(/QTN[-\s]?(\d{4})[-\s]?(\d{3,5})/i);
  return match ? `QTN-${match[1]}-${match[2]}` : null;
}

function inventoryLine(item: InventoryItem): string {
  const warning = item.status === "out_of_stock" ? " (out of stock)" : item.status === "low_stock" ? " (low stock)" : "";
  return `- ${item.name} (${item.sku}): ${formatNumber(item.available)} ${item.uom} available, ${formatNumber(item.onHand)} on hand, reorder level ${formatNumber(item.reorderLevel)} ${item.uom}${warning}`;
}

function quotationDetails(item: Quotation): string {
  const lines = item.items
    .slice(0, 5)
    .map(
      (line) =>
        `- ${line.description}: ${formatNumber(line.quantity)} ${line.uom} × ${formatMoney(line.unitPrice, item.currency)} = ${formatMoney(line.amount, item.currency)}`,
    )
    .join("\n");
  const more = item.items.length > 5 ? `\n- ${item.items.length - 5} additional line items` : "";

  return [
    `${item.number} is a quotation for ${item.customer}. Its current status is ${QUOTATION_STATUS_LABELS[item.status]}.`,
    `The tax-inclusive total is ${formatMoney(item.total, item.currency)} (${formatMoney(item.subtotal, item.currency)} ex GST plus ${formatMoney(item.tax, item.currency)} tax). It is valid until ${item.validUntil || "not set"}.`,
    lines ? `Line items:\n${lines}${more}` : "No quotation line items were provided by the connected service.",
  ].join("\n\n");
}

async function findMentionedInventory(
  provider: ERPProvider,
  rawMessage: string,
): Promise<InventoryItem | null> {
  const message = rawMessage.toLocaleLowerCase("en-AU");
  const inventory = await provider.listInventory();
  const explicit = inventory.find((item) =>
    [item.id, item.sku, item.name].some((value) =>
      message.includes(value.toLocaleLowerCase("en-AU")),
    ),
  );
  if (explicit) return explicit;

  const possibleSku = rawMessage.match(/[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/i)?.[0];
  return possibleSku ? provider.getInventoryItem(possibleSku) : null;
}

async function findMentionedQuotation(
  provider: ERPProvider,
  rawMessage: string,
): Promise<Quotation | null> {
  const quotationNumber = extractQuotationNumber(rawMessage);
  if (quotationNumber) return provider.getQuotation(quotationNumber);

  const message = rawMessage.toLocaleLowerCase("en-AU");
  const quotations = await provider.listQuotations();
  return (
    quotations.find((item) => message.includes(item.customer.toLocaleLowerCase("en-AU"))) ?? null
  );
}

export async function answerLocally(
  provider: ERPProvider,
  rawMessage: string,
): Promise<AgentAnswer> {
  const message = rawMessage.trim().toLocaleLowerCase("en-AU");

  if (
    includesAny(message, ["help", "what can you do", "how do i use", "features"])
  ) {
    return {
      mode: "local",
      answer:
        "I can query inventory summaries, low-stock and out-of-stock items, individual SKU balances, and quotation status, value, customer and line-item details. Enter an item code such as PLC-S7-1200 or a quotation number such as QTN-2026-0096.",
      suggestions: DEFAULT_SUGGESTIONS,
    };
  }

  if (includesAny(message, ["finance", "accounting", "invoice", "profit", "project management", "project progress"])) {
    return {
      mode: "local",
      answer:
        "The Agent currently exposes read-only inventory and quotation tools. Finance and project delivery data are not yet available through the Agent interface.",
      suggestions: ["Show inventory overview", "List low-stock items", "Summarise quotation statuses"],
    };
  }

  const mentionedQuotation = await findMentionedQuotation(provider, rawMessage);
  if (mentionedQuotation) {
    return {
      mode: "local",
      answer: quotationDetails(mentionedQuotation),
      suggestions: ["Show all sent quotations", "What is the active quotation value?", "Which items need replenishment?"],
    };
  }

  const mentionedInventory = await findMentionedInventory(provider, rawMessage);
  if (mentionedInventory) {
    return {
      mode: "local",
      answer: `${mentionedInventory.name} (${mentionedInventory.sku}) is stored at ${mentionedInventory.warehouse}${mentionedInventory.location ? ` / ${mentionedInventory.location}` : ""}.\n\n${inventoryLine(mentionedInventory)}`,
      suggestions: ["Which items need replenishment?", "Show inventory overview", "Show current quotations"],
    };
  }

  if (includesAny(message, ["low stock", "out of stock", "replenish", "replenishment", "purchase", "alert"])) {
    const items = await provider.listInventory({ lowStockOnly: true });
    const outOfStock = items.filter((item) => item.available <= 0).length;
    return {
      mode: "local",
      answer: items.length
        ? `${items.length} SKUs are at or below their reorder level; ${outOfStock} currently have no available stock:\n\n${items.map(inventoryLine).join("\n")}`
        : "No items are at their reorder level. Inventory is currently healthy.",
      suggestions: ["Give me an inventory overview", "Look up PLC-S7-1200", "Show current quotations"],
    };
  }

  if (
    includesAny(message, ["inventory overview", "inventory summary", "stock overview", "stock summary", "how much stock"])
  ) {
    const [dashboard, inventory] = await Promise.all([
      buildDashboard(provider),
      provider.listInventory(),
    ]);
    const warehouseTotals = new Map<string, number>();
    for (const item of inventory) {
      warehouseTotals.set(item.warehouse, (warehouseTotals.get(item.warehouse) ?? 0) + item.available);
    }
    const warehouses = [...warehouseTotals.entries()]
      .map(([warehouse, available]) => `${warehouse}: ${formatNumber(available)} available`)
      .join("; ");

    return {
      mode: "local",
      answer: `There are ${dashboard.metrics.totalSkus} SKUs, with ${formatNumber(dashboard.metrics.totalOnHand)} units on hand and ${formatNumber(dashboard.metrics.totalAvailable)} available. ${dashboard.metrics.lowStockItems} SKUs are low on stock and ${dashboard.metrics.outOfStockItems} are out of stock.\n\nBy warehouse: ${warehouses}.`,
      suggestions: ["List low-stock items", "Look up MOTOR-2P2KW", "Summarise quotation statuses"],
    };
  }

  if (includesAny(message, ["quote", "quotation"])) {
    const quotations = await provider.listQuotations();
    const counts = quotations.reduce<Record<QuotationStatus, number>>(
      (result, quotation) => {
        result[quotation.status] += 1;
        return result;
      },
      { draft: 0, sent: 0, accepted: 0, rejected: 0, expired: 0 },
    );
    const active = quotations.filter(
      (quotation) => quotation.status === "draft" || quotation.status === "sent",
    );
    const activeTotal = active.reduce((sum, quotation) => sum + quotation.total, 0);
    const allTotal = quotations.reduce((sum, quotation) => sum + quotation.total, 0);
    const currency = quotations[0]?.currency ?? "AUD";

    return {
      mode: "local",
      answer: `There are ${quotations.length} quotations: ${counts.draft} draft, ${counts.sent} sent, ${counts.accepted} accepted, ${counts.rejected} rejected and ${counts.expired} expired.\n\nDraft and sent quotations total ${formatMoney(activeTotal, currency)}. The full quotation history totals ${formatMoney(allTotal, currency)}.`,
      suggestions: ["Look up QTN-2026-0096", "Which items need replenishment?", "Give me an inventory overview"],
    };
  }

  if (includesAny(message, ["hello", "hi", "good morning", "good afternoon"])) {
    return {
      mode: "local",
      answer: "Hello, I am your ERP Agent. Ask me about inventory, low-stock alerts, SKU availability, quotation status or quotation value.",
      suggestions: DEFAULT_SUGGESTIONS,
    };
  }

  return {
    mode: "local",
    answer:
      "I could not identify the inventory or quotation information you need. Try asking for an inventory overview, low-stock items, or provide a SKU or QTN quotation number.",
    suggestions: DEFAULT_SUGGESTIONS,
  };
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  [key: string]: unknown;
}

interface ResponseOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

interface OpenAIResponsePayload {
  id?: string;
  output?: ResponseOutputItem[];
  output_text?: string;
  error?: { message?: string };
}

const OPENAI_TOOLS = [
  {
    type: "function",
    name: "get_dashboard",
    description: "Get the ERP inventory overview, low-stock list and recent quotation summary.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "search_inventory",
    description: "Search inventory by SKU, name, warehouse or supplier, with an option to return only low-stock items.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term, or an empty string for no filter." },
        low_stock_only: { type: "boolean", description: "Return only low-stock and out-of-stock items." },
      },
      required: ["query", "low_stock_only"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_quotations",
    description: "Search quotations by number or customer and optionally filter by status.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Quotation number or customer, or an empty string for no filter." },
        status: {
          type: "string",
          enum: ["all", "draft", "sent", "accepted", "rejected", "expired"],
        },
      },
      required: ["query", "status"],
      additionalProperties: false,
    },
  },
] as const;

function isFunctionCall(item: ResponseOutputItem): item is FunctionCallItem {
  return (
    item.type === "function_call" &&
    typeof item.call_id === "string" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string"
  );
}

function responseText(response: OpenAIResponsePayload): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function runTool(
  provider: ERPProvider,
  toolCall: FunctionCallItem,
): Promise<unknown> {
  const args = parseArguments(toolCall.arguments);
  switch (toolCall.name) {
    case "get_dashboard":
      return buildDashboard(provider);
    case "search_inventory":
      return provider.listInventory({
        search: typeof args.query === "string" && args.query.trim() ? args.query : undefined,
        lowStockOnly: args.low_stock_only === true,
      });
    case "search_quotations": {
      const status = typeof args.status === "string" ? args.status : "all";
      return provider.listQuotations({
        search: typeof args.query === "string" && args.query.trim() ? args.query : undefined,
        status:
          status !== "all" &&
          ["draft", "sent", "accepted", "rejected", "expired"].includes(status)
            ? (status as QuotationStatus)
            : undefined,
      });
    }
    default:
      return { error: `Unknown tool: ${toolCall.name}` };
  }
}

async function createResponse(
  apiKey: string,
  model: string,
  instructions: string,
  input: unknown[],
): Promise<OpenAIResponsePayload> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      tools: OPENAI_TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });

  const payload = (await response.json()) as OpenAIResponsePayload;
  if (!response.ok) {
    throw new Error(payload.error?.message || `The OpenAI API returned ${response.status}`);
  }
  return payload;
}

export async function answerWithOpenAI(options: {
  provider: ERPProvider;
  message: string;
  history?: AgentHistoryMessage[];
  section?: string;
  apiKey: string;
  model: string;
}): Promise<AgentAnswer> {
  const { provider, message, history = [], section, apiKey, model } = options;
  const instructions = [
    "You are a business Agent inside an enterprise ERP workspace. Respond in concise, accurate and actionable English.",
    "Always call the provided tools before stating inventory or quotation facts. Never invent figures.",
    "Clearly distinguish available, on-hand and reserved stock. Low stock follows the standardised status and normally means available <= reorderLevel, or an explicit upstream low-stock status.",
    "Always include the currency with quotation values and use plain-English status labels.",
    "Agent tools currently cover inventory and quotations only. Explain this clearly when asked about finance or project delivery.",
    section ? `The user is currently in the ${section} section.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const input: unknown[] = [
    ...history.slice(-10).map((item) => ({ role: item.role, content: item.content })),
    { role: "user", content: message },
  ];

  let response = await createResponse(apiKey, model, instructions, input);

  for (let round = 0; round < 4; round += 1) {
    const calls = (response.output ?? []).filter(isFunctionCall);
    if (calls.length === 0) {
      const answer = responseText(response);
      if (!answer) throw new Error("The OpenAI API did not return displayable text.");
      return { mode: "openai", answer, suggestions: DEFAULT_SUGGESTIONS };
    }

    input.push(...(response.output ?? []));
    const outputs = await Promise.all(
      calls.map(async (call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(await runTool(provider, call)),
      })),
    );
    input.push(...outputs);
    response = await createResponse(apiKey, model, instructions, input);
  }

  throw new Error("The Agent exceeded the safe tool-call limit.");
}
