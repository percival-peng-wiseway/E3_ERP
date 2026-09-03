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
  region: KimiRegion;
  plannerModel?: string;
  executorModel?: string;
  updatedAt: string;
};

type LegacyStoredKimiSettings = {
  apiKey?: string;
  baseUrl: string;
  fastModel: string;
  complexModel: string;
};

export const KIMI_REGIONS = ["china", "international"] as const;
export type KimiRegion = (typeof KIMI_REGIONS)[number];
export const DEFAULT_KIMI_REGION: KimiRegion = "china";
export const KIMI_BASE_URLS: Readonly<Record<KimiRegion, string>> = {
  china: "https://api.moonshot.cn/v1",
  international: "https://api.moonshot.ai/v1",
};
export const DEFAULT_KIMI_BASE_URL = KIMI_BASE_URLS[DEFAULT_KIMI_REGION];
export const DEFAULT_KIMI_MODEL = "kimi-k2.6";
export const DEFAULT_KIMI_PLANNER_MODEL = "kimi-k3";
export const DEFAULT_KIMI_EXECUTOR_MODEL = DEFAULT_KIMI_MODEL;

export type ResolvedKimiSettings = {
  apiKey: string | null;
  region: KimiRegion;
  baseUrl: string;
  plannerModel: string;
  executorModel: string;
  /** @deprecated Use executorModel. */
  fastModel: string;
  /** @deprecated Use executorModel. */
  complexModel: string;
  source: "saved" | "environment" | "default";
};

export type PublicAgentSettings = {
  configured: boolean;
  maskedApiKey: string | null;
  region: KimiRegion;
  baseUrl: string;
  model: string;
  plannerModel: string;
  executorModel: string;
  source: "saved" | "environment" | "default";
};

export type AgentSettingsInput = {
  apiKey?: string;
  region?: KimiRegion;
  plannerModel?: string;
  executorModel?: string;
};

type AgentSettingsDependencies = {
  fetchImpl?: typeof fetch;
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
  if (Object.keys(body).some((key) => !["apiKey", "region", "plannerModel", "executorModel"].includes(key))) return null;
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") return null;
  if (body.region !== undefined && !KIMI_REGIONS.includes(body.region as KimiRegion)) return null;
  if (body.plannerModel !== undefined && typeof body.plannerModel !== "string") return null;
  if (body.executorModel !== undefined && typeof body.executorModel !== "string") return null;
  try {
    if (body.plannerModel !== undefined) normalizedKimiModel(body.plannerModel);
    if (body.executorModel !== undefined) normalizedKimiModel(body.executorModel);
  } catch {
    return null;
  }
  return {
    ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    ...(body.region !== undefined ? { region: body.region as KimiRegion } : {}),
    ...(typeof body.plannerModel === "string" ? { plannerModel: body.plannerModel.trim() } : {}),
    ...(typeof body.executorModel === "string" ? { executorModel: body.executorModel.trim() } : {}),
  };
}

function normalizedKimiRegion(value: unknown): KimiRegion {
  if (KIMI_REGIONS.includes(value as KimiRegion)) return value as KimiRegion;
  throw new AgentSettingsError("Choose either the China or International Kimi API region.");
}

function kimiRegionForBaseUrl(value: string): KimiRegion {
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new AgentSettingsError("Enter a valid Kimi API base URL."); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash
    || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new AgentSettingsError("Kimi must use an official Moonshot API endpoint.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "api.moonshot.cn") return "china";
  if (hostname === "api.moonshot.ai") return "international";
  throw new AgentSettingsError("Kimi must use an official Moonshot API endpoint.");
}

export function kimiBaseUrlForRegion(region: KimiRegion): string {
  return KIMI_BASE_URLS[normalizedKimiRegion(region)];
}

function normalizedKimiModel(value: string): string {
  const model = value.trim();
  // Model IDs are sent only to a fixed official Moonshot endpoint and are
  // verified against that account's /models response before being saved.
  // Keeping the syntax narrow prevents control characters or URL-like values
  // while allowing newly released Kimi model IDs without a code deployment.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(model)) {
    throw new AgentSettingsError("Enter a valid Kimi model ID.");
  }
  return model;
}

function normalizeLegacyStoredKimi(value: unknown): StoredAgentSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<LegacyStoredKimiSettings>;
  const allowed = new Set(["apiKey", "baseUrl", "fastModel", "complexModel"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return null;
  if (candidate.apiKey !== undefined && typeof candidate.apiKey !== "string") return null;
  if (candidate.fastModel !== undefined && typeof candidate.fastModel !== "string") return null;
  if (candidate.complexModel !== undefined && typeof candidate.complexModel !== "string") return null;
  try {
    const region = candidate.baseUrl
      ? kimiRegionForBaseUrl(String(candidate.baseUrl))
      : DEFAULT_KIMI_REGION;
    const executorModel = normalizedKimiModel(String(candidate.fastModel || DEFAULT_KIMI_EXECUTOR_MODEL));
    // Legacy settings had no planner/executor contract. Migrate them onto the
    // new supported split instead of silently keeping K2.6 as the planner.
    const plannerModel = DEFAULT_KIMI_PLANNER_MODEL;
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim() ? { apiKey: normalizedApiKey(candidate.apiKey) } : {}),
      region,
      plannerModel,
      executorModel,
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
    plannerModel?: unknown;
    executorModel?: unknown;
    region?: unknown;
  };
  if (candidate.apiKey !== undefined && typeof candidate.apiKey !== "string") return null;
  if (candidate.plannerModel !== undefined && typeof candidate.plannerModel !== "string") return null;
  if (candidate.executorModel !== undefined && typeof candidate.executorModel !== "string") return null;
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
      ? new Set(["apiKey", "baseUrl", "model", "region", "plannerModel", "executorModel", "updatedAt"])
      : new Set(["apiKey", "region", "plannerModel", "executorModel", "updatedAt"]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) return null;
    let region = candidate.region === undefined
      ? DEFAULT_KIMI_REGION
      : normalizedKimiRegion(candidate.region);
    if (legacyEndpointFieldsPresent) {
      if (typeof candidate.baseUrl !== "string" || typeof candidate.model !== "string") return null;
      const endpointRegion = kimiRegionForBaseUrl(candidate.baseUrl);
      if (candidate.region !== undefined && endpointRegion !== region) return null;
      region = endpointRegion;
      normalizedKimiModel(candidate.model);
    }
    const legacyModel = typeof candidate.model === "string"
      ? normalizedKimiModel(candidate.model)
      : null;
    const executorModel = candidate.executorModel === undefined
      ? legacyModel || undefined
      : normalizedKimiModel(candidate.executorModel);
    const plannerModel = candidate.plannerModel === undefined
      ? legacyModel ? DEFAULT_KIMI_PLANNER_MODEL : undefined
      : normalizedKimiModel(candidate.plannerModel);
    return {
      ...(typeof candidate.apiKey === "string" && candidate.apiKey.trim()
        ? { apiKey: normalizedApiKey(candidate.apiKey) }
        : {}),
      region,
      ...(plannerModel ? { plannerModel } : {}),
      ...(executorModel ? { executorModel } : {}),
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
  let region = DEFAULT_KIMI_REGION;
  let plannerModel = DEFAULT_KIMI_PLANNER_MODEL;
  let executorModel = DEFAULT_KIMI_EXECUTOR_MODEL;
  try {
    const configuredKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
    const sharedModel = process.env.KIMI_MODEL_NAME?.trim();
    const configuredPlannerModel = process.env.KIMI_PLANNER_MODEL_NAME?.trim()
      || process.env.KIMI_MODEL_COMPLEX?.trim()
      || sharedModel;
    const configuredExecutorModel = process.env.KIMI_EXECUTOR_MODEL_NAME?.trim()
      || process.env.KIMI_MODEL_FAST?.trim()
      || sharedModel;
    if (configuredKey?.trim()) apiKey = normalizedApiKey(configuredKey);
    const configuredRegion = process.env.KIMI_REGION?.trim()
      ? normalizedKimiRegion(process.env.KIMI_REGION.trim())
      : null;
    const endpointRegion = process.env.KIMI_BASE_URL?.trim()
      ? kimiRegionForBaseUrl(process.env.KIMI_BASE_URL)
      : null;
    if (configuredRegion && endpointRegion && configuredRegion !== endpointRegion) {
      throw new AgentSettingsError("KIMI_REGION and KIMI_BASE_URL select different Moonshot regions.");
    }
    region = configuredRegion || endpointRegion || DEFAULT_KIMI_REGION;
    if (apiKey && configuredPlannerModel) plannerModel = normalizedKimiModel(configuredPlannerModel);
    if (apiKey && configuredExecutorModel) executorModel = normalizedKimiModel(configuredExecutorModel);
  } catch (error) {
    // Fail closed as unconfigured. A typo must never pair a valid key with a
    // different default region or model than the operator selected.
    apiKey = null;
    region = DEFAULT_KIMI_REGION;
    plannerModel = DEFAULT_KIMI_PLANNER_MODEL;
    executorModel = DEFAULT_KIMI_EXECUTOR_MODEL;
    console.error("Invalid Kimi environment configuration", error instanceof Error ? error.name : "UnknownError");
  }
  return {
    apiKey,
    region,
    baseUrl: kimiBaseUrlForRegion(region),
    plannerModel,
    executorModel,
    fastModel: executorModel,
    complexModel: executorModel,
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
  const useSaved = Boolean(saved?.apiKey);
  const region = useSaved ? saved?.region || DEFAULT_KIMI_REGION : environment.region;
  const plannerModel = useSaved
    ? saved?.plannerModel || environment.plannerModel
    : environment.plannerModel;
  const executorModel = useSaved
    ? saved?.executorModel || environment.executorModel
    : environment.executorModel;
  return {
    apiKey: saved?.apiKey || environment.apiKey,
    region,
    baseUrl: kimiBaseUrlForRegion(region),
    plannerModel,
    executorModel,
    fastModel: executorModel,
    complexModel: executorModel,
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
    region: kimi.region,
    baseUrl: kimi.baseUrl,
    model: kimi.executorModel,
    plannerModel: kimi.plannerModel,
    executorModel: kimi.executorModel,
    source: kimi.source,
  };
}

async function limitedModelList(response: Response): Promise<unknown> {
  const maximum = 512 * 1024;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("oversized_response");
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("oversized_response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function regionLabel(region: KimiRegion) {
  return region === "china" ? "China" : "International";
}

async function validateKimiConnection(
  apiKey: string,
  region: KimiRegion,
  models: { plannerModel: string; executorModel: string },
  fetchImpl: typeof fetch,
) {
  let response: Response;
  try {
    response = await fetchImpl(`${kimiBaseUrlForRegion(region)}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new AgentSettingsError(
      `The ${regionLabel(region)} Kimi API could not be reached. Try again.`,
      502,
      "kimi_connection_failed",
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new AgentSettingsError("The Kimi API returned an unexpected redirect.", 502, "kimi_connection_failed");
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new AgentSettingsError("The Kimi API rejected the validation request.", 400, "kimi_request_rejected");
    }
    if (response.status === 401) {
      throw new AgentSettingsError(
        `The API key is not valid for the ${regionLabel(region)} Kimi platform. Check the key and selected region.`,
        401,
        "kimi_authentication_failed",
      );
    }
    if (response.status === 403) {
      throw new AgentSettingsError("The Kimi account or IP allowlist does not permit this request.", 403, "kimi_permission_denied");
    }
    if (response.status === 404) {
      throw new AgentSettingsError("The selected Kimi models are not available to this account or region.", 400, "kimi_model_unavailable");
    }
    if (response.status === 429) {
      throw new AgentSettingsError("The Kimi account has insufficient quota or is currently rate limited.", 429, "kimi_quota_or_rate_limited");
    }
    if (response.status >= 500) {
      throw new AgentSettingsError("The Kimi service is temporarily unavailable.", 503, "kimi_service_unavailable");
    }
    throw new AgentSettingsError("The Kimi connection could not be verified.", 502, "kimi_connection_failed");
  }
  let body: unknown;
  try {
    body = await limitedModelList(response);
  } catch {
    throw new AgentSettingsError("The Kimi API returned an invalid model list.", 502, "kimi_invalid_response");
  }
  const data = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { data?: unknown }).data
    : null;
  if (!Array.isArray(data)) {
    throw new AgentSettingsError("The Kimi API returned an invalid model list.", 502, "kimi_invalid_response");
  }
  const availableModels = new Set(data.flatMap((item) => (
    item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as { id?: unknown }).id === "string"
      ? [(item as { id: string }).id]
      : []
  )));
  const unavailableRoles = [
    ["planner", models.plannerModel],
    ["executor", models.executorModel],
  ].filter(([, model]) => !availableModels.has(model));
  if (unavailableRoles.length) {
    const selected = unavailableRoles.map(([role, model]) => `${role} (${model})`).join(" and ");
    throw new AgentSettingsError(
      `The selected Kimi ${selected} model${unavailableRoles.length === 1 ? " is" : "s are"} not available to this account or region.`,
      400,
      "kimi_model_unavailable",
    );
  }
}

export function saveAgentSettings(
  input: AgentSettingsInput,
  dependencies: AgentSettingsDependencies = {},
): Promise<PublicAgentSettings> {
  return withMutation(async () => {
    const document = await readStoredSettingsDocument();
    const current = document.settings;
    const suppliedKey = input.apiKey?.trim();
    const apiKey = suppliedKey ? normalizedApiKey(suppliedKey) : current?.apiKey;
    if (!apiKey) throw new AgentSettingsError("Enter a valid Moonshot API key.");
    const region = normalizedKimiRegion(input.region || current?.region || DEFAULT_KIMI_REGION);
    const environment = resolveEnvironmentKimiSettings();
    const plannerModel = normalizedKimiModel(
      input.plannerModel || current?.plannerModel || environment.plannerModel,
    );
    const executorModel = normalizedKimiModel(
      input.executorModel || current?.executorModel || environment.executorModel,
    );
    await validateKimiConnection(apiKey, region, { plannerModel, executorModel }, dependencies.fetchImpl || fetch);
    await writeStoredSettings({
      apiKey,
      region,
      plannerModel,
      executorModel,
      updatedAt: new Date().toISOString(),
    }, document.version);
    const resolvedKey = apiKey || environment.apiKey;
    return {
      configured: Boolean(resolvedKey),
      maskedApiKey: maskedApiKey(resolvedKey),
      region,
      baseUrl: kimiBaseUrlForRegion(region),
      model: executorModel,
      plannerModel,
      executorModel,
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
      region: kimi.region,
      baseUrl: kimi.baseUrl,
      model: kimi.executorModel,
      plannerModel: kimi.plannerModel,
      executorModel: kimi.executorModel,
      source: kimi.source,
    };
  });
}
