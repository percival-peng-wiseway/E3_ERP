import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `agent-settings-${randomUUID()}`);
const mutableProcessEnv = process.env as Record<string, string | undefined>;
const environmentKeys = [
  "AGENT_SETTINGS_DATA_DIR",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "KIMI_MODEL_NAME",
  "KIMI_MODEL_FAST",
  "KIMI_MODEL_COMPLEX",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, mutableProcessEnv[key]]));

mutableProcessEnv.AGENT_SETTINGS_DATA_DIR = testDataDirectory;
for (const key of environmentKeys.slice(1)) delete mutableProcessEnv[key];

const settingsModule = "./settings.ts";
const {
  AgentSettingsError,
  DEFAULT_KIMI_BASE_URL,
  DEFAULT_KIMI_MODEL,
  clearAgentSettings,
  parseAgentSettingsInput,
  publicAgentSettings,
  resolveEnvironmentKimiSettings,
  resolveKimiSettings,
  saveAgentSettings,
} = await import(settingsModule) as typeof import("./settings");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete mutableProcessEnv[key];
    else mutableProcessEnv[key] = value;
  }
});

test("Kimi environment resolver enforces the fixed Moonshot host and model", () => {
  assert.deepEqual(resolveEnvironmentKimiSettings(), {
    apiKey: null,
    baseUrl: DEFAULT_KIMI_BASE_URL,
    fastModel: DEFAULT_KIMI_MODEL,
    complexModel: DEFAULT_KIMI_MODEL,
    source: "default",
  });

  mutableProcessEnv.MOONSHOT_API_KEY = "environment-kimi-key";
  mutableProcessEnv.KIMI_BASE_URL = DEFAULT_KIMI_BASE_URL;
  mutableProcessEnv.KIMI_MODEL_NAME = DEFAULT_KIMI_MODEL;
  assert.deepEqual(resolveEnvironmentKimiSettings(), {
    apiKey: "environment-kimi-key",
    baseUrl: DEFAULT_KIMI_BASE_URL,
    fastModel: DEFAULT_KIMI_MODEL,
    complexModel: DEFAULT_KIMI_MODEL,
    source: "environment",
  });
  delete mutableProcessEnv.MOONSHOT_API_KEY;
  delete mutableProcessEnv.KIMI_BASE_URL;
  delete mutableProcessEnv.KIMI_MODEL_NAME;
});

test("Agent settings input accepts only an optional string API key", () => {
  assert.deepEqual(parseAgentSettingsInput({ apiKey: "moonshot-test-key" }), {
    apiKey: "moonshot-test-key",
  });
  assert.deepEqual(parseAgentSettingsInput({}), {});
  for (const value of [
    null,
    [],
    { apiKey: null },
    { apiKey: ["moonshot-test-key"] },
    { apiKey: "moonshot-test-key", baseUrl: DEFAULT_KIMI_BASE_URL },
    { apiKey: "moonshot-test-key", model: DEFAULT_KIMI_MODEL },
    { apiKey: "moonshot-test-key", provider: "kimi" },
  ]) {
    assert.equal(parseAgentSettingsInput(value), null);
  }
});

test("fixed endpoint variables do not masquerade as an environment API key", () => {
  mutableProcessEnv.KIMI_BASE_URL = DEFAULT_KIMI_BASE_URL;
  mutableProcessEnv.KIMI_MODEL_NAME = DEFAULT_KIMI_MODEL;
  try {
    assert.deepEqual(resolveEnvironmentKimiSettings(), {
      apiKey: null,
      baseUrl: DEFAULT_KIMI_BASE_URL,
      fastModel: DEFAULT_KIMI_MODEL,
      complexModel: DEFAULT_KIMI_MODEL,
      source: "default",
    });
  } finally {
    delete mutableProcessEnv.KIMI_BASE_URL;
    delete mutableProcessEnv.KIMI_MODEL_NAME;
  }
});

test("invalid endpoint and model variables can never replace the fixed Kimi values", () => {
  mutableProcessEnv.KIMI_BASE_URL = "https://evil.example/v1";
  let resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.baseUrl, DEFAULT_KIMI_BASE_URL);
  assert.equal(resolved.fastModel, DEFAULT_KIMI_MODEL);
  delete mutableProcessEnv.KIMI_BASE_URL;

  mutableProcessEnv.KIMI_MODEL_NAME = "kimi-other";
  resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.baseUrl, DEFAULT_KIMI_BASE_URL);
  assert.equal(resolved.fastModel, DEFAULT_KIMI_MODEL);
  delete mutableProcessEnv.KIMI_MODEL_NAME;
});

test("an environment key cannot create a keyless saved document through a blank save", async () => {
  await clearAgentSettings();
  mutableProcessEnv.MOONSHOT_API_KEY = "environment-kimi-key";
  try {
    await assert.rejects(saveAgentSettings({}), (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.code, "invalid_settings");
      return true;
    });
    assert.equal((await resolveKimiSettings()).source, "environment");
    await assert.rejects(readFile(path.join(testDataDirectory, "settings.json")), (error: unknown) => (
      Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    ));
  } finally {
    delete mutableProcessEnv.MOONSHOT_API_KEY;
  }
});

test("saved Kimi key is masked publicly, preserved by blank saves, and resolved only on the server", async () => {
  await clearAgentSettings();
  const secret = "kimi-test-secret-key";
  const saved = await saveAgentSettings({ apiKey: secret });
  assert.equal(saved.configured, true);
  assert.match(saved.maskedApiKey || "", /-key$/);
  assert.equal(JSON.stringify(saved).includes(secret), false);

  await saveAgentSettings({});
  const resolved = await resolveKimiSettings();
  assert.equal(resolved.apiKey, secret);
  assert.equal(resolved.source, "saved");
  assert.equal(JSON.stringify(await publicAgentSettings()).includes(secret), false);
  const canonical = JSON.parse(
    await readFile(path.join(testDataDirectory, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(canonical).sort(), ["apiKey", "updatedAt"]);
  assert.equal(canonical.apiKey, secret);
  assert.equal(canonical.baseUrl, undefined);
  assert.equal(canonical.model, undefined);

  const cleared = await clearAgentSettings();
  assert.equal(cleared.configured, false);
});

test("legacy nested Kimi settings migrate without retaining the retired provider credential", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const kimiSecret = "legacy-nested-kimi-key";
  const retiredSecret = "retired-provider-secret";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: retiredSecret,
    baseUrl: "https://navigator-spongy-diagnosis.ngrok-free.dev/v1",
    model: "qwen3.5:9b",
    kimi: {
      apiKey: kimiSecret,
      baseUrl: DEFAULT_KIMI_BASE_URL,
      fastModel: DEFAULT_KIMI_MODEL,
      complexModel: DEFAULT_KIMI_MODEL,
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), { encoding: "utf8", mode: 0o600 });

  assert.equal((await resolveKimiSettings()).apiKey, kimiSecret);
  await saveAgentSettings({});
  const canonical = await readFile(settingsPath, "utf8");
  assert.equal(canonical.includes(retiredSecret), false);
  assert.equal(canonical.includes("qwen"), false);
  assert.equal(canonical.includes('"kimi"'), false);
  assert.equal(canonical.includes(kimiSecret), true);
  assert.equal(canonical.includes('"baseUrl"'), false);
  assert.equal(canonical.includes('"model"'), false);
  await clearAgentSettings();
});

test("legacy top-level Kimi settings migrate to a key-only document", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const kimiSecret = "legacy-top-level-kimi-key";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: kimiSecret,
    baseUrl: DEFAULT_KIMI_BASE_URL,
    model: DEFAULT_KIMI_MODEL,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), { encoding: "utf8", mode: 0o600 });

  assert.equal((await resolveKimiSettings()).apiKey, kimiSecret);
  await saveAgentSettings({});
  const canonical = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(canonical).sort(), ["apiKey", "updatedAt"]);
  assert.equal(canonical.apiKey, kimiSecret);
  await clearAgentSettings();
});

test("retired provider-only settings are ignored and replaced on the next Kimi save", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const retiredSecret = "retired-provider-secret";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: retiredSecret,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), { encoding: "utf8", mode: 0o600 });

  const kimiSecret = "replacement-moonshot-key";
  assert.equal((await resolveKimiSettings()).apiKey, null);
  await saveAgentSettings({ apiKey: kimiSecret });
  const canonical = await readFile(settingsPath, "utf8");
  assert.equal(canonical.includes(retiredSecret), false);
  assert.equal(canonical.includes("deepseek"), false);
  assert.equal(canonical.includes(kimiSecret), true);
  await clearAgentSettings();
});

test("ordinary save rejects a corrupt Kimi document while Administrator clear removes it safely", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const secretMarker = "bad-secret-marker";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: secretMarker,
    baseUrl: "https://unapproved.example/v1",
    model: DEFAULT_KIMI_MODEL,
  }), { encoding: "utf8", mode: 0o600 });

  await assert.rejects(
    saveAgentSettings({}),
    (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.code, "settings_corrupt");
      assert.equal(error.message.includes(secretMarker), false);
      return true;
    },
  );

  const cleared = await clearAgentSettings();
  assert.equal(JSON.stringify(cleared).includes(secretMarker), false);
  await assert.rejects(readFile(settingsPath), (error: unknown) => (
    Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
  ));

  await writeFile(settingsPath, "{malformed-json", { encoding: "utf8", mode: 0o600 });
  await clearAgentSettings();
  await assert.rejects(readFile(settingsPath), (error: unknown) => (
    Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
  ));
});
