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
  "AGENT_MODEL_PROVIDER",
  "QWEN_BASE_URL",
  "QWEN_MODEL_NAME",
  "QWEN_BASIC_AUTH_USER",
  "QWEN_BASIC_AUTH_PASSWORD",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_REGION",
  "KIMI_BASE_URL",
  "KIMI_MODEL_NAME",
  "KIMI_MODEL_FAST",
  "KIMI_MODEL_COMPLEX",
  "KIMI_PLANNER_MODEL_NAME",
  "KIMI_EXECUTOR_MODEL_NAME",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, mutableProcessEnv[key]]));

mutableProcessEnv.AGENT_SETTINGS_DATA_DIR = testDataDirectory;
for (const key of environmentKeys.slice(1)) delete mutableProcessEnv[key];

const settingsModule = "./settings.ts";
const {
  AgentSettingsError,
  DEFAULT_KIMI_BASE_URL,
  DEFAULT_KIMI_REGION,
  DEFAULT_KIMI_MODEL,
  DEFAULT_KIMI_PLANNER_MODEL,
  DEFAULT_KIMI_EXECUTOR_MODEL,
  KIMI_BASE_URLS,
  clearAgentSettings,
  parseAgentSettingsInput,
  publicAgentSettings,
  resolveEnvironmentKimiSettings,
  resolveKimiSettings,
  saveAgentSettings,
} = await import(settingsModule) as typeof import("./settings");

const modelListFetch: typeof fetch = async () => Response.json({
  object: "list",
  data: [
    { id: DEFAULT_KIMI_PLANNER_MODEL, object: "model" },
    { id: DEFAULT_KIMI_EXECUTOR_MODEL, object: "model" },
  ],
});
const dualModelListFetch: typeof fetch = async () => Response.json({
  object: "list",
  data: [
    { id: "kimi-k3", object: "model" },
    { id: "kimi-k2.6", object: "model" },
  ],
});
const executorOnlyModelListFetch: typeof fetch = async () => Response.json({
  object: "list",
  data: [{ id: DEFAULT_KIMI_EXECUTOR_MODEL, object: "model" }],
});

function saveSettings(
  input: Parameters<typeof saveAgentSettings>[0],
  fetchImpl: typeof fetch = modelListFetch,
) {
  return saveAgentSettings(input, { fetchImpl });
}

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete mutableProcessEnv[key];
    else mutableProcessEnv[key] = value;
  }
});

test("Kimi environment resolver defaults to K3 planning and K2.6 execution", () => {
  assert.deepEqual(resolveEnvironmentKimiSettings(), {
    apiKey: null,
    region: DEFAULT_KIMI_REGION,
    baseUrl: DEFAULT_KIMI_BASE_URL,
    plannerModel: DEFAULT_KIMI_PLANNER_MODEL,
    executorModel: DEFAULT_KIMI_EXECUTOR_MODEL,
    fastModel: DEFAULT_KIMI_MODEL,
    complexModel: DEFAULT_KIMI_MODEL,
    source: "default",
  });

  mutableProcessEnv.MOONSHOT_API_KEY = "environment-kimi-key";
  mutableProcessEnv.KIMI_REGION = "international";
  mutableProcessEnv.KIMI_BASE_URL = KIMI_BASE_URLS.international;
  mutableProcessEnv.KIMI_MODEL_NAME = DEFAULT_KIMI_MODEL;
  assert.deepEqual(resolveEnvironmentKimiSettings(), {
    apiKey: "environment-kimi-key",
    region: "international",
    baseUrl: KIMI_BASE_URLS.international,
    plannerModel: DEFAULT_KIMI_MODEL,
    executorModel: DEFAULT_KIMI_MODEL,
    fastModel: DEFAULT_KIMI_MODEL,
    complexModel: DEFAULT_KIMI_MODEL,
    source: "environment",
  });
  delete mutableProcessEnv.MOONSHOT_API_KEY;
  delete mutableProcessEnv.KIMI_REGION;
  delete mutableProcessEnv.KIMI_BASE_URL;
  delete mutableProcessEnv.KIMI_MODEL_NAME;
});

test("Agent settings input accepts API, region and safe planner/executor model IDs only", () => {
  assert.deepEqual(parseAgentSettingsInput({
    apiKey: "moonshot-test-key",
    region: "china",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
  }), {
    apiKey: "moonshot-test-key",
    region: "china",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
  });
  assert.deepEqual(parseAgentSettingsInput({}), {});
  for (const value of [
    null,
    [],
    { apiKey: null },
    { apiKey: ["moonshot-test-key"] },
    { apiKey: "moonshot-test-key", baseUrl: DEFAULT_KIMI_BASE_URL },
    { apiKey: "moonshot-test-key", model: DEFAULT_KIMI_MODEL },
    { apiKey: "moonshot-test-key", plannerModel: "https://evil.example/model" },
    { apiKey: "moonshot-test-key", executorModel: "kimi k2.6" },
    { apiKey: "moonshot-test-key", plannerModel: 3 },
    { apiKey: "moonshot-test-key", region: "australia" },
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
      region: DEFAULT_KIMI_REGION,
      baseUrl: DEFAULT_KIMI_BASE_URL,
      plannerModel: DEFAULT_KIMI_PLANNER_MODEL,
      executorModel: DEFAULT_KIMI_EXECUTOR_MODEL,
      fastModel: DEFAULT_KIMI_MODEL,
      complexModel: DEFAULT_KIMI_MODEL,
      source: "default",
    });
  } finally {
    delete mutableProcessEnv.KIMI_BASE_URL;
    delete mutableProcessEnv.KIMI_MODEL_NAME;
  }
});

test("invalid endpoint and unsafe model variables fail closed", () => {
  mutableProcessEnv.MOONSHOT_API_KEY = "environment-kimi-key";
  mutableProcessEnv.KIMI_BASE_URL = "https://evil.example/v1";
  let resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.apiKey, null);
  assert.equal(resolved.source, "default");
  assert.equal(resolved.baseUrl, DEFAULT_KIMI_BASE_URL);
  assert.equal(resolved.fastModel, DEFAULT_KIMI_MODEL);
  delete mutableProcessEnv.KIMI_BASE_URL;

  mutableProcessEnv.KIMI_MODEL_NAME = "https://evil.example/model";
  resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.apiKey, null);
  assert.equal(resolved.source, "default");
  assert.equal(resolved.baseUrl, DEFAULT_KIMI_BASE_URL);
  assert.equal(resolved.fastModel, DEFAULT_KIMI_MODEL);
  delete mutableProcessEnv.KIMI_MODEL_NAME;

  mutableProcessEnv.KIMI_PLANNER_MODEL_NAME = "kimi-k3";
  mutableProcessEnv.KIMI_EXECUTOR_MODEL_NAME = "kimi-k2.6";
  resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.apiKey, "environment-kimi-key");
  assert.equal(resolved.plannerModel, "kimi-k3");
  assert.equal(resolved.executorModel, "kimi-k2.6");
  assert.equal(resolved.fastModel, "kimi-k2.6");
  assert.equal(resolved.complexModel, "kimi-k2.6");
  delete mutableProcessEnv.KIMI_PLANNER_MODEL_NAME;
  delete mutableProcessEnv.KIMI_EXECUTOR_MODEL_NAME;

  mutableProcessEnv.KIMI_REGION = "invalid";
  resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.apiKey, null);
  assert.equal(resolved.source, "default");
  assert.equal(resolved.region, DEFAULT_KIMI_REGION);
  delete mutableProcessEnv.KIMI_REGION;

  mutableProcessEnv.KIMI_REGION = "china";
  mutableProcessEnv.KIMI_BASE_URL = KIMI_BASE_URLS.international;
  resolved = resolveEnvironmentKimiSettings();
  assert.equal(resolved.apiKey, null);
  assert.equal(resolved.source, "default");
  delete mutableProcessEnv.KIMI_REGION;
  delete mutableProcessEnv.KIMI_BASE_URL;
  delete mutableProcessEnv.MOONSHOT_API_KEY;
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
  let validatedUrl = "";
  const validatingFetch: typeof fetch = async (input) => {
    validatedUrl = String(input);
    return dualModelListFetch(input);
  };
  const saved = await saveSettings({
    apiKey: secret,
    region: "international",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
  }, validatingFetch);
  assert.equal(saved.configured, true);
  assert.equal(saved.region, "international");
  assert.equal(saved.baseUrl, KIMI_BASE_URLS.international);
  assert.equal(saved.plannerModel, "kimi-k3");
  assert.equal(saved.executorModel, "kimi-k2.6");
  assert.equal(validatedUrl, `${KIMI_BASE_URLS.international}/models`);
  assert.match(saved.maskedApiKey || "", /-key$/);
  assert.equal(JSON.stringify(saved).includes(secret), false);

  await saveSettings({}, dualModelListFetch);
  const resolved = await resolveKimiSettings();
  assert.equal(resolved.apiKey, secret);
  assert.equal(resolved.region, "international");
  assert.equal(resolved.baseUrl, KIMI_BASE_URLS.international);
  assert.equal(resolved.plannerModel, "kimi-k3");
  assert.equal(resolved.executorModel, "kimi-k2.6");
  assert.equal(resolved.fastModel, "kimi-k2.6");
  assert.equal(resolved.complexModel, "kimi-k2.6");
  assert.equal(resolved.source, "saved");
  assert.equal(JSON.stringify(await publicAgentSettings()).includes(secret), false);
  const canonical = JSON.parse(
    await readFile(path.join(testDataDirectory, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(canonical).sort(), ["apiKey", "executorModel", "plannerModel", "region", "updatedAt"]);
  assert.equal(canonical.apiKey, secret);
  assert.equal(canonical.region, "international");
  assert.equal(canonical.plannerModel, "kimi-k3");
  assert.equal(canonical.executorModel, "kimi-k2.6");
  assert.equal(canonical.baseUrl, undefined);
  assert.equal(canonical.model, undefined);

  const cleared = await clearAgentSettings();
  assert.equal(cleared.configured, false);
});

test("saving model roles verifies both IDs against the selected Moonshot account", async () => {
  await clearAgentSettings();
  await assert.rejects(
    saveSettings({
      apiKey: "model-access-test-key",
      region: "china",
      plannerModel: "kimi-k3",
      executorModel: "kimi-k2.6",
    }, executorOnlyModelListFetch),
    (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.code, "kimi_model_unavailable");
      assert.match(error.message, /planner \(kimi-k3\)/u);
      assert.equal(error.message.includes("model-access-test-key"), false);
      return true;
    },
  );

  const saved = await saveSettings({
    apiKey: "model-access-test-key",
    region: "china",
    plannerModel: "kimi-k3",
    executorModel: "kimi-k2.6",
  }, dualModelListFetch);
  assert.equal(saved.plannerModel, "kimi-k3");
  assert.equal(saved.executorModel, "kimi-k2.6");
  await clearAgentSettings();
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
      baseUrl: KIMI_BASE_URLS.international,
      fastModel: DEFAULT_KIMI_MODEL,
      complexModel: DEFAULT_KIMI_MODEL,
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), { encoding: "utf8", mode: 0o600 });

  const legacyResolved = await resolveKimiSettings();
  assert.equal(legacyResolved.apiKey, kimiSecret);
  assert.equal(legacyResolved.region, "international");
  await saveSettings({});
  const canonical = await readFile(settingsPath, "utf8");
  assert.equal(canonical.includes(retiredSecret), false);
  assert.equal(canonical.includes("qwen"), false);
  assert.equal(canonical.includes('"kimi"'), false);
  assert.equal(canonical.includes(kimiSecret), true);
  assert.equal(canonical.includes('"baseUrl"'), false);
  assert.equal(canonical.includes('"model"'), false);
  await clearAgentSettings();
});

test("legacy top-level Kimi endpoint migrates to its trusted region", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const kimiSecret = "legacy-top-level-kimi-key";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: kimiSecret,
    baseUrl: KIMI_BASE_URLS.international,
    model: DEFAULT_KIMI_MODEL,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), { encoding: "utf8", mode: 0o600 });

  const legacyResolved = await resolveKimiSettings();
  assert.equal(legacyResolved.apiKey, kimiSecret);
  assert.equal(legacyResolved.region, "international");
  await saveSettings({});
  const canonical = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(canonical).sort(), ["apiKey", "executorModel", "plannerModel", "region", "updatedAt"]);
  assert.equal(canonical.apiKey, kimiSecret);
  assert.equal(canonical.region, "international");
  assert.equal(canonical.plannerModel, DEFAULT_KIMI_PLANNER_MODEL);
  assert.equal(canonical.executorModel, DEFAULT_KIMI_MODEL);
  await clearAgentSettings();
});

test("legacy key-only Kimi documents default safely to the China region", async () => {
  const settingsPath = path.join(testDataDirectory, "settings.json");
  const kimiSecret = "legacy-key-only-kimi-key";
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, JSON.stringify({
    apiKey: kimiSecret,
    updatedAt: "2026-08-31T00:00:00.000Z",
  }), { encoding: "utf8", mode: 0o600 });

  const resolved = await resolveKimiSettings();
  assert.equal(resolved.apiKey, kimiSecret);
  assert.equal(resolved.region, "china");
  assert.equal(resolved.baseUrl, KIMI_BASE_URLS.china);
  await saveSettings({});
  const canonical = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  assert.equal(canonical.region, "china");
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
  await saveSettings({ apiKey: kimiSecret, region: "china" });
  const canonical = await readFile(settingsPath, "utf8");
  assert.equal(canonical.includes(retiredSecret), false);
  assert.equal(canonical.includes("deepseek"), false);
  assert.equal(canonical.includes(kimiSecret), true);
  await clearAgentSettings();
});

test("save-time Kimi validation classifies failures without exposing provider bodies or keys", async () => {
  await clearAgentSettings();
  const secret = "classified-secret-key";
  const scenarios = [
    { status: 400, code: "kimi_request_rejected" },
    { status: 401, code: "kimi_authentication_failed" },
    { status: 403, code: "kimi_permission_denied" },
    { status: 404, code: "kimi_model_unavailable" },
    { status: 429, code: "kimi_quota_or_rate_limited" },
    { status: 503, code: "kimi_service_unavailable" },
  ] as const;
  for (const scenario of scenarios) {
    const providerMarker = `provider-secret-${scenario.status}`;
    const failingFetch: typeof fetch = async () => Response.json({
      error: { message: providerMarker },
    }, { status: scenario.status });
    await assert.rejects(
      saveSettings({ apiKey: secret, region: "china" }, failingFetch),
      (error: unknown) => {
        assert.ok(error instanceof AgentSettingsError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.message.includes(providerMarker), false);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
  await assert.rejects(
    saveSettings({ apiKey: secret, region: "china" }, async () => { throw new Error("network-secret-marker"); }),
    (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.code, "kimi_connection_failed");
      assert.equal(error.message.includes("network-secret-marker"), false);
      return true;
    },
  );
  await assert.rejects(
    saveSettings({ apiKey: secret, region: "china" }, async () => new Response(null, { status: 302 })),
    (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.code, "kimi_connection_failed");
      return true;
    },
  );
  await assert.rejects(
    saveSettings({ apiKey: secret, region: "china" }, async () => new Response("not-json", { status: 200 })),
    (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.code, "kimi_invalid_response");
      return true;
    },
  );
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


test("Qwen overrides saved Kimi without exposing or reusing its credentials", async () => {
  await saveSettings({ apiKey: "saved-moonshot-secret", region: "china" });
  mutableProcessEnv.AGENT_MODEL_PROVIDER = "ollama";
  mutableProcessEnv.QWEN_BASE_URL = "https://home.example.test/";
  mutableProcessEnv.QWEN_MODEL_NAME = "qwen3.5:9b";
  mutableProcessEnv.QWEN_BASIC_AUTH_USER = "erp";
  mutableProcessEnv.QWEN_BASIC_AUTH_PASSWORD = "tunnel-test-password";
  try {
    const resolved = await resolveKimiSettings();
    assert.equal(resolved.modelProvider, "ollama");
    assert.equal(resolved.baseUrl, "https://home.example.test/v1");
    assert.equal(resolved.plannerModel, "qwen3.5:9b");
    assert.equal(resolved.executorModel, "qwen3.5:9b");
    assert.equal(Buffer.from(resolved.apiKey!, "base64").toString(), "erp:tunnel-test-password");
    const visible = await publicAgentSettings();
    assert.equal(visible.maskedApiKey, null);
    assert.equal(visible.modelProvider, "ollama");
    assert.equal(JSON.stringify(visible).includes(resolved.apiKey!), false);
    assert.equal(JSON.stringify(visible).includes("password"), false);
    assert.throws(() => clearAgentSettings(), /server configuration/);
    assert.throws(() => saveAgentSettings({ apiKey: "new-moonshot-secret" }), /server configuration/);
    delete mutableProcessEnv.QWEN_BASIC_AUTH_PASSWORD;
    await assert.rejects(resolveKimiSettings(), { name: "QwenConfigurationError" });
  } finally {
    for (const key of ["AGENT_MODEL_PROVIDER", "QWEN_BASE_URL", "QWEN_MODEL_NAME", "QWEN_BASIC_AUTH_USER", "QWEN_BASIC_AUTH_PASSWORD"]) delete mutableProcessEnv[key];
  }
  assert.equal((await resolveKimiSettings()).apiKey, "saved-moonshot-secret");
});

// This suite redirects storage to its random testDataDirectory under tmpdir()
// before importing settings.ts. All network requests below are injected fakes.
test("saved Qwen settings verify Basic Auth and never return the password", async () => {
  const input = { modelProvider: "ollama" as const, baseUrl: "https://e3-test.ngrok-free.app", model: "qwen3.5:9b", basicAuthUsername: "erp", basicAuthPassword: "private-tunnel-password" };
  assert.deepEqual(parseAgentSettingsInput(input), input);
  assert.equal(parseAgentSettingsInput({ ...input, apiKey: "moonshot-secret" }), null);
  let requests = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), "https://e3-test.ngrok-free.app/v1/models");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from("erp:private-tunnel-password").toString("base64")}`);
    return Response.json({ data: [{ id: "qwen3.5:9b" }] });
  };
  const saved = await saveAgentSettings(input, { fetchImpl });
  assert.equal(saved.modelProvider, "ollama");
  assert.equal(saved.hasSavedPassword, true);
  const resolved = await resolveKimiSettings();
  assert.equal(resolved.modelProvider, "ollama");
  assert.equal(resolved.plannerModel, input.model);
  assert.equal(resolved.executorModel, input.model);
  const visible = await publicAgentSettings();
  assert.deepEqual(visible, saved);
  assert.equal(JSON.stringify(visible).includes(input.basicAuthPassword), false);
  assert.equal(JSON.stringify(visible).includes(resolved.apiKey!), false);
  await saveAgentSettings({ ...input, basicAuthPassword: "", baseUrl: `${input.baseUrl}/v1/` }, { fetchImpl });
  assert.equal(requests, 2);
});

test("Qwen rejects unsafe endpoints and cross-origin password reuse before fetch", async () => {
  const input = { modelProvider: "ollama" as const, baseUrl: "https://e3-test.ngrok-free.app", model: "qwen3.5:9b", basicAuthUsername: "erp" };
  const before = await resolveKimiSettings();
  const fetchImpl: typeof fetch = async () => { assert.fail("no outbound request should occur"); };
  for (const baseUrl of ["https://127.0.0.1", "https://localhost", "https://ngrok-free.app.evil.test", "https://e3-test.ngrok-free.app@evil.test", "http://e3-test.ngrok-free.app", "https://other.ngrok-free.app"]) {
    await assert.rejects(saveAgentSettings({ ...input, baseUrl }, { fetchImpl }));
  }
  await assert.rejects(saveAgentSettings({ ...input, basicAuthUsername: "another-user" }, { fetchImpl }));
  assert.deepEqual(await resolveKimiSettings(), before);
});

test("Qwen failed verification preserves active settings and hides upstream errors", async () => {
  const input = { modelProvider: "ollama" as const, baseUrl: "https://replacement.ngrok-free.dev", model: "qwen3.5:9b", basicAuthUsername: "erp", basicAuthPassword: "replacement-password" };
  const before = await resolveKimiSettings();
  const responses = [new Response("private-upstream-error", { status: 401 }),
    new Response("private-upstream-error", { status: 302, headers: { Location: "https://other.ngrok-free.app" } }),
    Response.json({ data: [{ id: "different-model" }] }), new Response("private-upstream-error")];
  for (const response of responses) {
    await assert.rejects(saveAgentSettings(input, { fetchImpl: async () => response }), (error: unknown) => {
      assert.ok(error instanceof AgentSettingsError);
      assert.equal(error.message.includes("private-upstream-error"), false);
      assert.equal(error.message.includes(input.basicAuthPassword), false);
      return true;
    });
    assert.deepEqual(await resolveKimiSettings(), before);
  }
});
