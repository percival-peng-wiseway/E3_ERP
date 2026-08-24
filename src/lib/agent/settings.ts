import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const ALLOWED_DEEPSEEK_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

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
  source: "saved" | "environment" | "none";
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
    throw new AgentSettingsError("Enter a valid DeepSeek base URL.");
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AgentSettingsError("Enter a valid DeepSeek base URL.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.deepseek.com"
    || url.port || url.username || url.password || url.search || url.hash) {
    throw new AgentSettingsError("The DeepSeek base URL must use https://api.deepseek.com.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizedModel(value: string): string {
  const model = value.trim();
  if (!ALLOWED_DEEPSEEK_MODELS.has(model)) {
    throw new AgentSettingsError("Select deepseek-v4-flash or deepseek-v4-pro.");
  }
  return model;
}

function normalizedApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length < 8 || apiKey.length > 4_096 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new AgentSettingsError("Enter a valid DeepSeek API key.");
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
      baseUrl: normalizedBaseUrl(String(candidate.baseUrl || DEFAULT_DEEPSEEK_BASE_URL)),
      model: normalizedModel(String(candidate.model || DEFAULT_DEEPSEEK_MODEL)),
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
    const settings = normalizeStoredSettings(JSON.parse(raw));
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
  let baseUrl = DEFAULT_DEEPSEEK_BASE_URL;
  let model = DEFAULT_DEEPSEEK_MODEL;
  try {
    if (process.env.DEEPSEEK_API_KEY?.trim()) {
      apiKey = normalizedApiKey(process.env.DEEPSEEK_API_KEY);
    }
    if (process.env.DEEPSEEK_BASE_URL?.trim()) {
      baseUrl = normalizedBaseUrl(process.env.DEEPSEEK_BASE_URL);
    }
    if (process.env.DEEPSEEK_MODEL?.trim()) {
      model = normalizedModel(process.env.DEEPSEEK_MODEL);
    }
  } catch (error) {
    console.error("Invalid DeepSeek environment configuration", error instanceof Error ? error.message : error);
  }
  return { apiKey, baseUrl, model };
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
    source: saved?.apiKey ? "saved" : environment.apiKey ? "environment" : "none",
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
    configured: Boolean(settings.apiKey),
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
      configured: Boolean(resolvedKey),
      maskedApiKey: maskedApiKey(resolvedKey),
      baseUrl: normalizedBaseUrl(input.baseUrl),
      model: normalizedModel(input.model),
      source: apiKey ? "saved" : environment.apiKey ? "environment" : "none",
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
      configured: Boolean(environment.apiKey),
      maskedApiKey: maskedApiKey(environment.apiKey),
      baseUrl: environment.baseUrl,
      model: environment.model,
      source: environment.apiKey ? "environment" : "none",
    };
  });
}
