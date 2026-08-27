import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `agent-settings-${randomUUID()}`);
const originalEnvironment = new Map([
  "AGENT_SETTINGS_DATA_DIR",
  "AGENT_API_KEY",
  "AGENT_BASE_URL",
  "AGENT_MODEL",
  "AGENT_ALLOWED_API_HOSTS",
].map((key) => [key, process.env[key]]));

process.env.AGENT_SETTINGS_DATA_DIR = testDataDirectory;
delete process.env.AGENT_API_KEY;
delete process.env.AGENT_BASE_URL;
delete process.env.AGENT_MODEL;
delete process.env.AGENT_ALLOWED_API_HOSTS;

const settingsModule = "./settings.ts";
const {
  AgentSettingsError,
  DEFAULT_AGENT_BASE_URL,
  DEFAULT_AGENT_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_COMPLEX_MODEL,
  DEFAULT_DEEPSEEK_FAST_MODEL,
  clearAgentSettings,
  preferredAgentModelSettings,
  resolveDeepSeekSettings,
  resolveEnvironmentAgentSettings,
  saveAgentSettings,
} = await import(settingsModule) as typeof import("./settings");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("environment resolver uses validated configuration without reading saved settings", () => {
  assert.deepEqual(resolveEnvironmentAgentSettings(), {
    apiKey: null,
    baseUrl: DEFAULT_AGENT_BASE_URL,
    model: DEFAULT_AGENT_MODEL,
    source: "default",
  });

  process.env.AGENT_API_KEY = "environment-test-key";
  process.env.AGENT_BASE_URL = DEFAULT_AGENT_BASE_URL;
  process.env.AGENT_MODEL = "qwen3.6:latest";
  assert.deepEqual(resolveEnvironmentAgentSettings(), {
    apiKey: "environment-test-key",
    baseUrl: DEFAULT_AGENT_BASE_URL,
    model: "qwen3.6:latest",
    source: "environment",
  });
  delete process.env.AGENT_API_KEY;
  delete process.env.AGENT_BASE_URL;
  delete process.env.AGENT_MODEL;
});

test("saved DeepSeek key is masked publicly and resolves only on the server", async () => {
  const secret = "deepseek-test-secret-key";
  const saved = await saveAgentSettings({
    baseUrl: DEFAULT_AGENT_BASE_URL,
    model: DEFAULT_AGENT_MODEL,
    deepSeekApiKey: secret,
    deepSeekBaseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    deepSeekFastModel: DEFAULT_DEEPSEEK_FAST_MODEL,
    deepSeekComplexModel: DEFAULT_DEEPSEEK_COMPLEX_MODEL,
  });
  assert.equal(saved.deepSeekConfigured, true);
  assert.match(saved.maskedDeepSeekApiKey || "", /-key$/);
  assert.equal(JSON.stringify(saved).includes(secret), false);

  const resolved = await resolveDeepSeekSettings();
  assert.equal(resolved.apiKey, secret);
  assert.equal(resolved.source, "saved");
  await clearAgentSettings();
});

test("home Agent prefers configured DeepSeek and otherwise keeps the legacy endpoint", () => {
  const legacy = { apiKey: null, baseUrl: DEFAULT_AGENT_BASE_URL, model: DEFAULT_AGENT_MODEL, source: "default" as const };
  const missingDeepSeek = {
    apiKey: null, baseUrl: DEFAULT_DEEPSEEK_BASE_URL, fastModel: DEFAULT_DEEPSEEK_FAST_MODEL,
    complexModel: DEFAULT_DEEPSEEK_COMPLEX_MODEL, source: "default" as const,
  };
  assert.equal(preferredAgentModelSettings(legacy, missingDeepSeek), legacy);
  assert.deepEqual(preferredAgentModelSettings(legacy, { ...missingDeepSeek, apiKey: "deepseek-key", source: "saved" }), {
    apiKey: "deepseek-key", baseUrl: DEFAULT_DEEPSEEK_BASE_URL, model: DEFAULT_DEEPSEEK_FAST_MODEL, source: "saved",
  });
});

test("ordinary save rejects a corrupt document while Administrator clear removes it safely", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const secretMarker = "bad-secret-marker";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: secretMarker,
    baseUrl: "https://unapproved.example/v1",
    model: DEFAULT_AGENT_MODEL,
  }), { encoding: "utf8", mode: 0o600 });

  await assert.rejects(
    saveAgentSettings({ baseUrl: DEFAULT_AGENT_BASE_URL, model: DEFAULT_AGENT_MODEL }),
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
