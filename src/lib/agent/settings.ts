import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
// Focused Node ESM tests require the explicit extension; Next's server bundler
// supports the same import path.
// @ts-expect-error -- the project intentionally does not enable emit-time extension imports.
} from "../server/cloudflare-storage.ts";

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
  deepSeek?: StoredDeepSeekSettings;
  updatedAt: string;
};

type StoredDeepSeekSettings = {
  apiKey?: string;
  baseUrl: string;
  fastModel: string;
  complexModel: string;
};

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/beta";
export const DEFAULT_DEEPSEEK_FAST_MODEL = "deepseek-v4-flash";
export const DEFAULT_DEEPSEEK_COMPLEX_MODEL = "deepseek-v4-pro";

export type ResolvedDeepSeekSettings = {
  apiKey: string | null;
  baseUrl: string;
  fastModel: string;
  complexModel: string;
  source: "saved" | "environment" | "default";
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
  deepSeekConfigured: boolean;
  maskedDeepSeekApiKey: string | null;
  deepSeekBaseUrl: string;
  deepSeekFastModel: string;
  deepSeekComplexModel: string;
  deepSeekSource: "saved" | "environment" | "default";
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
const CLOUDFLARE_DOCUMENT_KEY = "agent/settings";
const MAXIMUM_STORAGE_RETRIES = 5;
let mutationQueue: Promise<void> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const retryingWork = async () => {
    for (let attempt = 0; attempt < MAXIMUM_STORAGE_RETRIES; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof CloudflareDocumentConflictError)) throw error;
      }
    }
    throw new AgentSettingsError(
      "Agent settings changed while this request was being saved. Try again.",
      409,
      "settings_conflict",
    );
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
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

function normalizedDeepSeekBaseUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new AgentSettingsError("Enter a valid DeepSeek API base URL."); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.deepseek.com"
    || url.port || url.username || url.password || url.search || url.hash
    || !["", "/", "/beta", "/beta/"].includes(url.pathname)) {
    throw new AgentSettingsError("DeepSeek must use https://api.deepseek.com/beta for strict tool calls.");
  }
  return DEFAULT_DEEPSEEK_BASE_URL;
}

function normalizedDeepSeekModel(value: string, expected: string): string {
  if (value.trim() !== expected) throw new AgentSettingsError(`DeepSeek model must be ${expected}.`);
  return expected;
}

function normalizeStoredDeepSeek(value: unknown): StoredDeepSeekSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredDeepSeekSettings>;
  try {
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim() ? { apiKey: normalizedApiKey(candidate.apiKey) } : {}),
      baseUrl: normalizedDeepSeekBaseUrl(String(candidate.baseUrl || DEFAULT_DEEPSEEK_BASE_URL)),
      fastModel: normalizedDeepSeekModel(String(candidate.fastModel || DEFAULT_DEEPSEEK_FAST_MODEL), DEFAULT_DEEPSEEK_FAST_MODEL),
      complexModel: normalizedDeepSeekModel(String(candidate.complexModel || DEFAULT_DEEPSEEK_COMPLEX_MODEL), DEFAULT_DEEPSEEK_COMPLEX_MODEL),
    };
  } catch { return null; }
}

function normalizeStoredSettings(value: unknown): StoredAgentSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredAgentSettings>;
  try {
    const deepSeek = candidate.deepSeek === undefined ? undefined : normalizeStoredDeepSeek(candidate.deepSeek);
    if (candidate.deepSeek !== undefined && !deepSeek) return null;
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim()
        ? { apiKey: normalizedApiKey(candidate.apiKey) }
        : {}),
      baseUrl: normalizedBaseUrl(String(candidate.baseUrl || DEFAULT_AGENT_BASE_URL)),
      model: normalizedModel(String(candidate.model || DEFAULT_AGENT_MODEL)),
      ...(deepSeek ? { deepSeek } : {}),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizedStoredSettings(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const legacy = value as { baseUrl?: unknown; model?: unknown };
    if (legacy.baseUrl === "https://api.deepseek.com"
      || (typeof legacy.model === "string" && legacy.model.startsWith("deepseek-"))) {
      return null;
    }
  }
  const settings = value === null ? null : normalizeStoredSettings(value);
  if (value !== null && !settings) {
    throw new AgentSettingsError("The saved Agent settings are invalid.", 500, "settings_corrupt");
  }
  return settings;
}

async function readStoredSettingsDocument(): Promise<{
  settings: StoredAgentSettings | null;
  version: number | null;
}> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    return {
      settings: normalizedStoredSettings(document.value),
      version: document.version,
    };
  }

  await ensureStorage();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ settingsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    await chmod(settingsPath, 0o600);
    return { settings: normalizedStoredSettings(parsed), version: null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { settings: null, version: null };
    }
    throw error;
  }
}

async function writeStoredSettings(
  settings: StoredAgentSettings | null,
  expectedVersion: number | null,
) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(
      bindings.database,
      CLOUDFLARE_DOCUMENT_KEY,
      settings,
      expectedVersion,
    );
    return;
  }

  if (!settings) {
    await unlink(settingsPath).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    });
    return;
  }
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

async function clearStoredSettings() {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    // Deliberately select only the CAS version. An Administrator must be able
    // to clear a saved document whose JSON or shape is corrupt without reading
    // or exposing its value. Ordinary reads and saves remain strict.
    const row = await bindings.database
      .prepare("SELECT version FROM erp_documents WHERE key = ?1")
      .bind(CLOUDFLARE_DOCUMENT_KEY)
      .first<{ version: number }>();
    const version = row?.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0 || (row && version < 1)) {
      throw new CloudflareStorageConfigurationError("The ERP database returned an invalid document.");
    }
    await writeVersionedDocument(
      bindings.database,
      CLOUDFLARE_DOCUMENT_KEY,
      null,
      version,
    );
    return;
  }

  await unlink(settingsPath).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  });
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

function environmentDeepSeekSettings(): ResolvedDeepSeekSettings {
  let apiKey: string | null = null;
  let baseUrl = DEFAULT_DEEPSEEK_BASE_URL;
  let fastModel = DEFAULT_DEEPSEEK_FAST_MODEL;
  let complexModel = DEFAULT_DEEPSEEK_COMPLEX_MODEL;
  let explicit = false;
  try {
    if (process.env.DEEPSEEK_API_KEY?.trim()) { apiKey = normalizedApiKey(process.env.DEEPSEEK_API_KEY); explicit = true; }
    if (process.env.DEEPSEEK_BASE_URL?.trim()) { baseUrl = normalizedDeepSeekBaseUrl(process.env.DEEPSEEK_BASE_URL); explicit = true; }
    if (process.env.DEEPSEEK_MODEL_FAST?.trim()) { fastModel = normalizedDeepSeekModel(process.env.DEEPSEEK_MODEL_FAST, DEFAULT_DEEPSEEK_FAST_MODEL); explicit = true; }
    if (process.env.DEEPSEEK_MODEL_COMPLEX?.trim()) { complexModel = normalizedDeepSeekModel(process.env.DEEPSEEK_MODEL_COMPLEX, DEFAULT_DEEPSEEK_COMPLEX_MODEL); explicit = true; }
  } catch (error) {
    console.error("Invalid DeepSeek environment configuration", error instanceof Error ? error.message : error);
  }
  return { apiKey, baseUrl, fastModel, complexModel, source: explicit ? "environment" : "default" };
}

/**
 * Resolves only validated process configuration and built-in defaults. This
 * deliberately avoids persisted storage so Agent requests can still attempt a
 * model call when the saved-settings document is temporarily unavailable or
 * corrupt.
 */
export function resolveEnvironmentAgentSettings(): ResolvedAgentSettings {
  const environment = environmentSettings();
  return {
    apiKey: environment.apiKey,
    baseUrl: environment.baseUrl,
    model: environment.model,
    source: environment.explicit ? "environment" : "default",
  };
}

export async function resolveAgentSettings(): Promise<ResolvedAgentSettings> {
  await mutationQueue;
  const [document, environment] = await Promise.all([
    readStoredSettingsDocument(),
    Promise.resolve(resolveEnvironmentAgentSettings()),
  ]);
  const saved = document.settings;
  const apiKey = saved?.apiKey || environment.apiKey;
  return {
    apiKey,
    baseUrl: saved?.baseUrl || environment.baseUrl,
    model: saved?.model || environment.model,
    source: saved ? "saved" : environment.source,
  };
}

export async function resolveDeepSeekSettings(): Promise<ResolvedDeepSeekSettings> {
  await mutationQueue;
  const [document, environment] = await Promise.all([
    readStoredSettingsDocument(),
    Promise.resolve(environmentDeepSeekSettings()),
  ]);
  const saved = document.settings?.deepSeek;
  return {
    apiKey: saved?.apiKey || environment.apiKey,
    baseUrl: saved?.baseUrl || environment.baseUrl,
    fastModel: saved?.fastModel || environment.fastModel,
    complexModel: saved?.complexModel || environment.complexModel,
    source: saved ? "saved" : environment.source,
  };
}

export function preferredAgentModelSettings(
  legacy: ResolvedAgentSettings,
  deepSeek: ResolvedDeepSeekSettings,
): ResolvedAgentSettings {
  return deepSeek.apiKey ? {
    apiKey: deepSeek.apiKey,
    baseUrl: deepSeek.baseUrl,
    model: deepSeek.fastModel,
    source: deepSeek.source,
  } : legacy;
}

function maskedApiKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  const visible = apiKey.slice(-4);
  return `${"•".repeat(8)}${visible}`;
}

export async function publicAgentSettings(): Promise<PublicAgentSettings> {
  const [settings, deepSeek] = await Promise.all([resolveAgentSettings(), resolveDeepSeekSettings()]);
  return {
    configured: true,
    maskedApiKey: maskedApiKey(settings.apiKey),
    baseUrl: settings.baseUrl,
    model: settings.model,
    source: settings.source,
    deepSeekConfigured: Boolean(deepSeek.apiKey),
    maskedDeepSeekApiKey: maskedApiKey(deepSeek.apiKey),
    deepSeekBaseUrl: deepSeek.baseUrl,
    deepSeekFastModel: deepSeek.fastModel,
    deepSeekComplexModel: deepSeek.complexModel,
    deepSeekSource: deepSeek.source,
  };
}

export function saveAgentSettings(input: {
  apiKey?: string;
  baseUrl: string;
  model: string;
  deepSeekApiKey?: string;
  deepSeekBaseUrl?: string;
  deepSeekFastModel?: string;
  deepSeekComplexModel?: string;
}): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    const document = await readStoredSettingsDocument();
    const current = document.settings;
    const suppliedKey = input.apiKey?.trim();
    const apiKey = suppliedKey ? normalizedApiKey(suppliedKey) : current?.apiKey;
    const suppliedDeepSeekKey = input.deepSeekApiKey?.trim();
    const deepSeekApiKey = suppliedDeepSeekKey ? normalizedApiKey(suppliedDeepSeekKey) : current?.deepSeek?.apiKey;
    const saveDeepSeek = input.deepSeekBaseUrl !== undefined || input.deepSeekFastModel !== undefined
      || input.deepSeekComplexModel !== undefined || suppliedDeepSeekKey !== undefined || current?.deepSeek !== undefined;
    const deepSeek = saveDeepSeek ? {
      ...(deepSeekApiKey ? { apiKey: deepSeekApiKey } : {}),
      baseUrl: normalizedDeepSeekBaseUrl(input.deepSeekBaseUrl || current?.deepSeek?.baseUrl || DEFAULT_DEEPSEEK_BASE_URL),
      fastModel: normalizedDeepSeekModel(input.deepSeekFastModel || current?.deepSeek?.fastModel || DEFAULT_DEEPSEEK_FAST_MODEL, DEFAULT_DEEPSEEK_FAST_MODEL),
      complexModel: normalizedDeepSeekModel(input.deepSeekComplexModel || current?.deepSeek?.complexModel || DEFAULT_DEEPSEEK_COMPLEX_MODEL, DEFAULT_DEEPSEEK_COMPLEX_MODEL),
    } : undefined;
    await writeStoredSettings({
      ...(apiKey ? { apiKey } : {}),
      baseUrl: normalizedBaseUrl(input.baseUrl),
      model: normalizedModel(input.model),
      ...(deepSeek ? { deepSeek } : {}),
      updatedAt: new Date().toISOString(),
    }, document.version);
    const environment = environmentSettings();
    const resolvedKey = apiKey || environment.apiKey;
    const environmentDeepSeek = environmentDeepSeekSettings();
    const resolvedDeepSeekKey = deepSeek?.apiKey || environmentDeepSeek.apiKey;
    return {
      configured: true,
      maskedApiKey: maskedApiKey(resolvedKey),
      baseUrl: normalizedBaseUrl(input.baseUrl),
      model: normalizedModel(input.model),
      source: "saved",
      deepSeekConfigured: Boolean(resolvedDeepSeekKey),
      maskedDeepSeekApiKey: maskedApiKey(resolvedDeepSeekKey),
      deepSeekBaseUrl: deepSeek?.baseUrl || environmentDeepSeek.baseUrl,
      deepSeekFastModel: deepSeek?.fastModel || environmentDeepSeek.fastModel,
      deepSeekComplexModel: deepSeek?.complexModel || environmentDeepSeek.complexModel,
      deepSeekSource: deepSeek ? "saved" : environmentDeepSeek.source,
    };
  });
}

export function clearAgentSettings(): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    await clearStoredSettings();
    const environment = environmentSettings();
    const deepSeek = environmentDeepSeekSettings();
    return {
      configured: true,
      maskedApiKey: maskedApiKey(environment.apiKey),
      baseUrl: environment.baseUrl,
      model: environment.model,
      source: environment.explicit ? "environment" : "default",
      deepSeekConfigured: Boolean(deepSeek.apiKey),
      maskedDeepSeekApiKey: maskedApiKey(deepSeek.apiKey),
      deepSeekBaseUrl: deepSeek.baseUrl,
      deepSeekFastModel: deepSeek.fastModel,
      deepSeekComplexModel: deepSeek.complexModel,
      deepSeekSource: deepSeek.source,
    };
  });
}
