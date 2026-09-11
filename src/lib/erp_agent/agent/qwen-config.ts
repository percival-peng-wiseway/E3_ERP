/** Server-only operator configuration. Never accept an endpoint from a chat request. */
export type ModelProvider = "kimi" | "ollama";
export const QWEN_REQUEST_TIMEOUT_MS = 120_000;

export function qwenEnabled() {
  return process.env.AGENT_MODEL_PROVIDER?.trim() === "ollama";
}

export class QwenConfigurationError extends Error {
  constructor() {
    super("Qwen configuration is incomplete or invalid. Check the server endpoint and tunnel credentials.");
    this.name = "QwenConfigurationError";
  }
}

export type QwenConnectionInput = { baseUrl: string; model: string; username: string; password: string };

export function normalizeQwenConnection(input: QwenConnectionInput, ngrokOnly = false) {
  try {
    const rawUrl = input.baseUrl.trim();
    const url = new URL(rawUrl);
    if (/\s/.test(rawUrl) || url.protocol !== "https:" || url.port
      || url.username || url.password || url.search || url.hash
      || !["/", "/v1", "/v1/"].includes(url.pathname)) throw new QwenConfigurationError();
    // Browser-saved endpoints are restricted to ngrok to prevent arbitrary
    // internal requests. Custom domains require trusted server configuration.
    if (ngrokOnly && !["ngrok-free.app", "ngrok-free.dev", "ngrok.app", "ngrok.dev", "ngrok.io"]
      .some((suffix) => url.hostname.endsWith(`.${suffix}`))) throw new QwenConfigurationError();
    const username = input.username.trim();
    const password = input.password;
    if (!username || !password || username.includes(":")
      || /[\u0000-\u001f\u007f]/.test(username + password)
      || username.length > 256 || password.length > 4096) throw new QwenConfigurationError();
    const model = input.model.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) throw new QwenConfigurationError();
    return { baseUrl: `${url.origin}/v1`, model, username, password };
  } catch {
    throw new QwenConfigurationError();
  }
}

export function resolveQwenConfig() {
  if (!qwenEnabled()) return null;
  const connection = normalizeQwenConnection({
    baseUrl: process.env.QWEN_BASE_URL || "",
    model: process.env.QWEN_MODEL_NAME?.trim() || "qwen3.5:9b",
    username: process.env.QWEN_BASIC_AUTH_USER || "",
    password: process.env.QWEN_BASIC_AUTH_PASSWORD || "",
  });
  return {
    modelProvider: "ollama" as const,
    apiKey: Buffer.from(`${connection.username}:${connection.password}`, "utf8").toString("base64"),
    baseUrl: connection.baseUrl,
    model: connection.model,
  };
}
