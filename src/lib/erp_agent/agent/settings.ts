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
} from "../../server/cloudflare-storage.ts";

type StoredAgentSettings = {
  apiKey?: string;
  updatedAt: string;
};

type LegacyStoredKimiSettings = {
  apiKey?: string;
  baseUrl: string;
  fastModel: string;
  complexModel: string;
};

export const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
export const DEFAULT_KIMI_MODEL = "kimi-k2.6";

export type ResolvedKimiSettings = {
  apiKey: string | null;
  baseUrl: string;
  fastModel: string;
  complexModel: string;
  source: "saved" | "environment" | "default";
};

export type PublicAgentSettings = {
  configured: boolean;
  maskedApiKey: string | null;
  baseUrl: string;
  model: string;
  source: "saved" | "environment" | "default";
};

export type AgentSettingsInput = {
  apiKey?: string;
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

function normalizedApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length < 8 || apiKey.length > 4_096 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new AgentSettingsError("Enter a valid Moonshot API key.");
  }
  return apiKey;
}

export function parseAgentSettingsInput(value: unknown): AgentSettingsInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "apiKey")) return null;
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") return null;
  return typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {};
}

function normalizedKimiBaseUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new AgentSettingsError("Enter a valid Kimi API base URL."); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.moonshot.ai"
    || url.port || url.username || url.password || url.search || url.hash
    || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new AgentSettingsError("Kimi must use https://api.moonshot.ai/v1.");
  }
  return DEFAULT_KIMI_BASE_URL;
}

function normalizedKimiModel(value: string): string {
  if (value.trim() !== DEFAULT_KIMI_MODEL) {
    throw new AgentSettingsError(`Kimi model must be ${DEFAULT_KIMI_MODEL}.`);
  }
  return DEFAULT_KIMI_MODEL;
}

function normalizeLegacyStoredKimi(value: unknown): StoredAgentSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<LegacyStoredKimiSettings>;
  const allowed = new Set(["apiKey", "baseUrl", "fastModel", "complexModel"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return null;
  if (candidate.apiKey !== undefined && typeof candidate.apiKey !== "string") return null;
  try {
    normalizedKimiBaseUrl(String(candidate.baseUrl || DEFAULT_KIMI_BASE_URL));
    normalizedKimiModel(String(candidate.fastModel || DEFAULT_KIMI_MODEL));
    normalizedKimiModel(String(candidate.complexModel || DEFAULT_KIMI_MODEL));
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim() ? { apiKey: normalizedApiKey(candidate.apiKey) } : {}),
      updatedAt: new Date(0).toISOString(),
    };
  } catch { return null; }
}

function normalizeStoredSettings(value: unknown): StoredAgentSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredAgentSettings> & {
    kimi?: unknown;
    baseUrl?: unknown;
    model?: unknown;
  };
  if (candidate.apiKey !== undefined && typeof candidate.apiKey !== "string") return null;
  try {
    // Migrate the pre-Kimi-only document shape without preserving its legacy
    // endpoint or credential. The next save writes only this canonical shape.
    if (candidate.kimi !== undefined) {
      const migrated = normalizeLegacyStoredKimi(candidate.kimi);
      if (!migrated) return null;
      return {
        ...migrated,
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : migrated.updatedAt,
      };
    }
    const legacyEndpointFieldsPresent = candidate.baseUrl !== undefined || candidate.model !== undefined;
    const allowed = legacyEndpointFieldsPresent
      ? new Set(["apiKey", "baseUrl", "model", "updatedAt"])
      : new Set(["apiKey", "updatedAt"]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) return null;
    if (legacyEndpointFieldsPresent) {
      if (typeof candidate.baseUrl !== "string" || typeof candidate.model !== "string") return null;
      normalizedKimiBaseUrl(candidate.baseUrl);
      normalizedKimiModel(candidate.model);
    }
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim()
        ? { apiKey: normalizedApiKey(candidate.apiKey) }
        : {}),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizedStoredSettings(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const legacy = value as { kimi?: unknown; baseUrl?: unknown; model?: unknown };
    const legacyModel = typeof legacy.model === "string" ? legacy.model : "";
    if (legacy.kimi === undefined && (
      legacyModel.startsWith("qwen")
      || legacyModel.startsWith("deepseek-")
      || legacy.baseUrl === "https://api.deepseek.com"
      || (typeof legacy.baseUrl === "string" && legacy.baseUrl.includes("ngrok-free.dev"))
    )) {
      // A retired provider-only document is treated as absent. Its credential
      // is never returned and the next Kimi save replaces the whole document.
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

export function resolveEnvironmentKimiSettings(): ResolvedKimiSettings {
  let apiKey: string | null = null;
  let baseUrl = DEFAULT_KIMI_BASE_URL;
  let model = DEFAULT_KIMI_MODEL;
  try {
    const configuredKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
    const configuredModel = process.env.KIMI_MODEL_NAME || process.env.KIMI_MODEL_FAST || process.env.KIMI_MODEL_COMPLEX;
    if (configuredKey?.trim()) apiKey = normalizedApiKey(configuredKey);
    if (process.env.KIMI_BASE_URL?.trim()) baseUrl = normalizedKimiBaseUrl(process.env.KIMI_BASE_URL);
    if (configuredModel?.trim()) {
      model = normalizedKimiModel(configuredModel);
    }
  } catch (error) {
    console.error("Invalid Kimi environment configuration", error instanceof Error ? error.message : error);
  }
  return {
    apiKey,
    baseUrl,
    fastModel: model,
    complexModel: model,
    source: apiKey ? "environment" : "default",
  };
}

/**
 * Resolves only validated process configuration and built-in defaults. This
 * deliberately avoids persisted storage so Agent requests can still attempt a
 * model call when the saved-settings document is temporarily unavailable or
 * corrupt.
 */
export async function resolveKimiSettings(): Promise<ResolvedKimiSettings> {
  await mutationQueue;
  const [document, environment] = await Promise.all([
    readStoredSettingsDocument(),
    Promise.resolve(resolveEnvironmentKimiSettings()),
  ]);
  const saved = document.settings;
  return {
    apiKey: saved?.apiKey || environment.apiKey,
    baseUrl: environment.baseUrl,
    fastModel: environment.fastModel,
    complexModel: environment.complexModel,
    source: saved?.apiKey ? "saved" : environment.source,
  };
}

function maskedApiKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  const visible = apiKey.slice(-4);
  return `${"•".repeat(8)}${visible}`;
}

export async function publicAgentSettings(): Promise<PublicAgentSettings> {
  const kimi = await resolveKimiSettings();
  return {
    configured: Boolean(kimi.apiKey),
    maskedApiKey: maskedApiKey(kimi.apiKey),
    baseUrl: kimi.baseUrl,
    model: kimi.fastModel,
    source: kimi.source,
  };
}

export function saveAgentSettings(input: AgentSettingsInput): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    const document = await readStoredSettingsDocument();
    const current = document.settings;
    const suppliedKey = input.apiKey?.trim();
    const apiKey = suppliedKey ? normalizedApiKey(suppliedKey) : current?.apiKey;
    if (!apiKey) throw new AgentSettingsError("Enter a valid Moonshot API key.");
    await writeStoredSettings({
      apiKey,
      updatedAt: new Date().toISOString(),
    }, document.version);
    const environment = resolveEnvironmentKimiSettings();
    const resolvedKey = apiKey || environment.apiKey;
    return {
      configured: Boolean(resolvedKey),
      maskedApiKey: maskedApiKey(resolvedKey),
      baseUrl: environment.baseUrl,
      model: environment.fastModel,
      source: "saved",
    };
  });
}

export function clearAgentSettings(): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    await clearStoredSettings();
    const kimi = resolveEnvironmentKimiSettings();
    return {
      configured: Boolean(kimi.apiKey),
      maskedApiKey: maskedApiKey(kimi.apiKey),
      baseUrl: kimi.baseUrl,
      model: kimi.fastModel,
      source: kimi.source,
    };
  });
}
