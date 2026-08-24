import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_AGENT_BASE_URL = "https://navigator-spongy-diagnosis.ngrok-free.dev/v1";
export const DEFAULT_AGENT_MODEL = "qwen3.5:9b";
const ALLOWED_AGENT_MODELS = new Set([
  "qwen3.5:9b",
  "qwenvl4b:latest",
  "qwen3-vl:4b",
  "qwen2.5vl:7b",
  "qwen3.6:27b",
  "qwen3.6:latest",
]);

type StoredAgentSettings = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  updatedAt: string;
};

export type ResolvedAgentSettings = {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  source: "saved" | "environment" | "default";
};

export type PublicAgentSettings = Omit<ResolvedAgentSettings, "apiKey"> & {
  configured: boolean;
  maskedApiKey: string | null;
};

export class AgentSettingsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_settings") {
    super(message);
    this.name = "AgentSettingsError";
    this.status = status;
    this.code = code;
  }
}

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.AGENT_SETTINGS_DATA_DIR || path.join(process.cwd(), ".data", "agent"),
);
const settingsPath = path.join(/* turbopackIgnore: true */ dataRoot, "settings.json");
let mutationQueue: Promise<void> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
}

function normalizedBaseUrl(value: string): string {
  const text = value.trim();
  if (!text || text.length > 500) {
    throw new AgentSettingsError("Enter a valid model API base URL.");
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AgentSettingsError("Enter a valid model API base URL.");
  }
  const allowedHosts = new Set([
    "navigator-spongy-diagnosis.ngrok-free.dev",
    ...(process.env.AGENT_ALLOWED_API_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())
    || url.port || url.username || url.password || url.search || url.hash) {
    throw new AgentSettingsError("The model API URL must use HTTPS and an approved host.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizedModel(value: string): string {
  const model = value.trim();
  if (!ALLOWED_AGENT_MODELS.has(model)) {
    throw new AgentSettingsError("Select one of the approved models exposed by the model API.");
  }
  return model;
}

function normalizedApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length < 8 || apiKey.length > 4_096 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new AgentSettingsError("Enter a valid model API key.");
  }
  return apiKey;
}

function normalizeStoredSettings(value: unknown): StoredAgentSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredAgentSettings>;
  try {
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim()
        ? { apiKey: normalizedApiKey(candidate.apiKey) }
        : {}),
      baseUrl: normalizedBaseUrl(String(candidate.baseUrl || DEFAULT_AGENT_BASE_URL)),
      model: normalizedModel(String(candidate.model || DEFAULT_AGENT_MODEL)),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

async function readStoredSettings(): Promise<StoredAgentSettings | null> {
  await ensureStorage();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ settingsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const legacy = parsed as { baseUrl?: unknown; model?: unknown };
      if (legacy.baseUrl === "https://api.deepseek.com"
        || (typeof legacy.model === "string" && legacy.model.startsWith("deepseek-"))) {
        return null;
      }
    }
    const settings = normalizeStoredSettings(parsed);
    if (!settings) throw new AgentSettingsError("The saved Agent settings are invalid.", 500, "settings_corrupt");
    await chmod(settingsPath, 0o600);
    return settings;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeStoredSettings(settings: StoredAgentSettings) {
  await ensureStorage();
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function environmentSettings() {
  let apiKey: string | null = null;
  let baseUrl = DEFAULT_AGENT_BASE_URL;
  let model = DEFAULT_AGENT_MODEL;
  let explicit = false;
  try {
    const configuredApiKey = process.env.AGENT_API_KEY;
    const configuredBaseUrl = process.env.AGENT_BASE_URL;
    const configuredModel = process.env.AGENT_MODEL;
    if (configuredApiKey?.trim()) {
      apiKey = normalizedApiKey(configuredApiKey);
      explicit = true;
    }
    if (configuredBaseUrl?.trim()) {
      baseUrl = normalizedBaseUrl(configuredBaseUrl);
      explicit = true;
    }
    if (configuredModel?.trim()) {
      model = normalizedModel(configuredModel);
      explicit = true;
    }
  } catch (error) {
    console.error("Invalid Agent model environment configuration", error instanceof Error ? error.message : error);
  }
  return { apiKey, baseUrl, model, explicit };
}

export async function resolveAgentSettings(): Promise<ResolvedAgentSettings> {
  await mutationQueue;
  const [saved, environment] = await Promise.all([
    readStoredSettings(),
    Promise.resolve(environmentSettings()),
  ]);
  const apiKey = saved?.apiKey || environment.apiKey;
  return {
    apiKey,
    baseUrl: saved?.baseUrl || environment.baseUrl,
    model: saved?.model || environment.model,
    source: saved ? "saved" : environment.explicit ? "environment" : "default",
  };
}

function maskedApiKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  const visible = apiKey.slice(-4);
  return `${"•".repeat(8)}${visible}`;
}

export async function publicAgentSettings(): Promise<PublicAgentSettings> {
  const settings = await resolveAgentSettings();
  return {
    configured: true,
    maskedApiKey: maskedApiKey(settings.apiKey),
    baseUrl: settings.baseUrl,
    model: settings.model,
    source: settings.source,
  };
}

export function saveAgentSettings(input: {
  apiKey?: string;
  baseUrl: string;
  model: string;
}): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    const current = await readStoredSettings();
    const suppliedKey = input.apiKey?.trim();
    const apiKey = suppliedKey ? normalizedApiKey(suppliedKey) : current?.apiKey;
    await writeStoredSettings({
      ...(apiKey ? { apiKey } : {}),
      baseUrl: normalizedBaseUrl(input.baseUrl),
      model: normalizedModel(input.model),
      updatedAt: new Date().toISOString(),
    });
    const environment = environmentSettings();
    const resolvedKey = apiKey || environment.apiKey;
    return {
      configured: true,
      maskedApiKey: maskedApiKey(resolvedKey),
      baseUrl: normalizedBaseUrl(input.baseUrl),
      model: normalizedModel(input.model),
      source: "saved",
    };
  });
}

export function clearAgentSettings(): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    await unlink(settingsPath).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    });
    const environment = environmentSettings();
    return {
      configured: true,
      maskedApiKey: maskedApiKey(environment.apiKey),
      baseUrl: environment.baseUrl,
      model: environment.model,
      source: environment.explicit ? "environment" : "default",
    };
  });
}
