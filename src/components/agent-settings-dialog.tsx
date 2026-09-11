"use client";

import {
  Bot,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./agent-settings-dialog.module.css";

type AgentSettings = {
  modelProvider?: "kimi" | "ollama";
  basicAuthUsername?: string;
  hasSavedPassword?: boolean;
  configured: boolean;
  source: "saved" | "environment" | "default";
  maskedApiKey: string | null;
  region: "china" | "international";
  baseUrl: string;
  model: string;
  plannerModel: string;
  executorModel: string;
};

type AgentSettingsResponse = {
  data?: AgentSettings;
  error?: string | { message?: string };
};

const EMPTY_SETTINGS: AgentSettings = {
  configured: false,
  source: "default",
  maskedApiKey: null,
  region: "china",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k2.6",
  plannerModel: "kimi-k3",
  executorModel: "kimi-k2.6",
};

function responseError(body: AgentSettingsResponse, fallback: string) {
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (body.error && typeof body.error === "object" && typeof body.error.message === "string") {
    return body.error.message;
  }
  return fallback;
}

export function AgentSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [apiKey, setApiKey] = useState("");
  const [modelProvider, setModelProvider] = useState<"kimi" | "ollama">("ollama");
  const [qwenUrl, setQwenUrl] = useState("");
  const [qwenModel, setQwenModel] = useState("qwen3.5:9b");
  const [qwenUsername, setQwenUsername] = useState("erp");
  const [qwenPassword, setQwenPassword] = useState("");
  const [region, setRegion] = useState<AgentSettings["region"]>("china");
  const [plannerModel, setPlannerModel] = useState(EMPTY_SETTINGS.plannerModel);
  const [executorModel, setExecutorModel] = useState(EMPTY_SETTINGS.executorModel);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(saving);

  useEffect(() => {
    closeRef.current = onClose;
    savingRef.current = saving;
  }, [onClose, saving]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let active = true;
    setLoading(true);
    setError("");
    setNotice("");
    setApiKey("");
    setQwenPassword("");
    void fetch("/api/settings/agent", { cache: "no-store" })
      .then(async (response) => {
        const body = await readJsonResponse<AgentSettingsResponse>(response);
        if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to load Agent settings."));
        if (!active) return;
        setSettings(body.data);
        setModelProvider(body.data.modelProvider || (body.data.configured ? "kimi" : "ollama"));
        setQwenUrl(body.data.modelProvider === "ollama" ? body.data.baseUrl : "");
        setQwenModel(body.data.modelProvider === "ollama" ? body.data.model : "qwen3.5:9b");
        setQwenUsername(body.data.basicAuthUsername || "erp");
        setRegion(body.data.region);
        setPlannerModel(body.data.plannerModel || body.data.model);
        setExecutorModel(body.data.executorModel || body.data.model);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load Agent settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), button:not([disabled])")?.focus();
    });
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]",
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeys);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleKeys);
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [open]);

  if (!open) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelProvider === "ollama" ? {
          modelProvider: "ollama", baseUrl: qwenUrl.trim(), model: qwenModel.trim(),
          basicAuthUsername: qwenUsername.trim(),
          ...(qwenPassword ? { basicAuthPassword: qwenPassword } : {}),
        } : {
          modelProvider: "kimi",
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          region,
          plannerModel: plannerModel.trim(),
          executorModel: executorModel.trim(),
        }),
      });
      const body = await readJsonResponse<AgentSettingsResponse>(response);
      if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to save Agent settings."));
      setSettings(body.data);
      setRegion(body.data.region);
      setPlannerModel(body.data.plannerModel);
      setExecutorModel(body.data.executorModel);
      setApiKey("");
      setQwenPassword("");
      setNotice(body.data.modelProvider === "ollama"
        ? "Qwen connection verified and model found. Your Agent now uses this model."
        : body.data.configured
        ? `Moonshot API key and both models verified for the ${body.data.region === "china" ? "China" : "International"} platform.`
        : "Add a Moonshot API key to enable the E3 Agent models.");
      window.dispatchEvent(new CustomEvent("erp:agent-settings-updated"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save Agent settings.");
    } finally {
      setSaving(false);
    }
  };

  const clearSaved = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/settings/agent", { method: "DELETE" });
      const body = await readJsonResponse<AgentSettingsResponse>(response);
      if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to clear saved Agent settings."));
      setSettings(body.data);
      setRegion(body.data.region);
      setPlannerModel(body.data.plannerModel);
      setExecutorModel(body.data.executorModel);
      setApiKey("");
      setQwenPassword("");
      setModelProvider(body.data.modelProvider || (body.data.configured ? "kimi" : "ollama"));
      setQwenUrl(body.data.modelProvider === "ollama" ? body.data.baseUrl : "");
      setNotice(body.data.source === "environment"
        ? "Saved settings removed. The environment Kimi configuration is now active."
        : "Saved settings removed. Add a Moonshot API key to enable Kimi again.");
      window.dispatchEvent(new CustomEvent("erp:agent-settings-updated"));
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "Unable to clear saved Agent settings.");
    } finally {
      setSaving(false);
    }
  };

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !saving) onClose();
  };

  return (
    <div className={styles.backdrop} onMouseDown={closeFromBackdrop}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
        <header>
          <div className={styles.headingIcon}><Bot size={21} /></div>
          <div>
            <h2 id="agent-settings-title">E3 Agent Model Settings</h2>
          </div>
          <button type="button" aria-label="Close settings" disabled={saving} onClick={onClose}><X size={19} /></button>
        </header>

        {loading ? (
          <div className={styles.loading}><LoaderCircle className={styles.spinning} size={20} /> Loading Agent settings…</div>
        ) : settings.modelProvider === "ollama" && settings.source === "environment" ? (
          <div className={styles.loading}>
            <Bot size={20} />
            <div>
              <strong>Qwen · {settings.model}</strong>
              <p>Text and image requests use your home model service.</p>
              <p>Keep the home computer, Ollama and tunnel running. Connection settings are managed by the server administrator.</p>
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className={`${styles.status} ${settings.configured ? styles.ready : ""}`}>
              {settings.configured ? <CheckCircle2 size={17} /> : <KeyRound size={17} />}
              <div>
                <strong>{settings.configured ? "Model endpoint configured" : "Model endpoint unavailable"}</strong>
                <small>
                  {settings.configured
                    ? settings.modelProvider === "ollama" ? `Qwen · ${settings.model} · Saved connection` : `Planner ${settings.plannerModel} · Executor ${settings.executorModel} · ${settings.region === "china" ? "China" : "International"} · ${settings.source === "saved" ? "saved settings" : "environment settings"}${settings.maskedApiKey ? ` · ${settings.maskedApiKey}` : ""}`
                    : modelProvider === "ollama" ? "Connect your home Qwen model for text, images and ERP analysis." : "Add a Moonshot API key to enable planning, answers and image understanding."}
                </small>
              </div>
            </div>

            {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
            {error ? <div className={styles.error} role="alert">{error}</div> : null}

            <div className={styles.fieldGrid}>
              <label>
                Model provider
                <select value={modelProvider} disabled={saving} onChange={(event) => {
                  const selected = event.target.value as "kimi" | "ollama";
                  setModelProvider(selected);
                  setError(""); setNotice(""); setQwenPassword("");
                  if (selected === "kimi" && settings.modelProvider === "ollama") {
                    setPlannerModel("kimi-k3"); setExecutorModel("kimi-k2.6");
                  }
                }}>
                  <option value="ollama">Qwen · Home computer</option>
                  <option value="kimi">Kimi · Moonshot</option>
                </select>
              </label>
            </div>

            {modelProvider === "ollama" ? (
              <section className={styles.providerSection} aria-labelledby="qwen-settings-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h3 id="qwen-settings-title">Qwen on your home computer</h3>
                    <p>Keep Ollama and ngrok running on your Windows computer.</p>
                  </div>
                </div>
                <div className={styles.fieldGrid}>
                  <label>
                    ngrok HTTPS address
                    <input type="url" required value={qwenUrl} disabled={saving}
                      onChange={(event) => { setQwenUrl(event.target.value); setQwenPassword(""); }}
                      placeholder="https://your-address.ngrok-free.app" spellCheck={false} />
                    <small>Paste the HTTPS address from ngrok. /v1 is added automatically.</small>
                  </label>
                  <label>
                    Model name
                    <input required value={qwenModel} disabled={saving}
                      onChange={(event) => setQwenModel(event.target.value)} placeholder="qwen3.5:9b" spellCheck={false} />
                    <small>Use the exact model name shown by Ollama.</small>
                  </label>
                  <label>
                    ngrok username
                    <input required value={qwenUsername} disabled={saving} autoComplete="off"
                      onChange={(event) => { setQwenUsername(event.target.value); setQwenPassword(""); }} />
                  </label>
                  <label>
                    ngrok password
                    <input type="password" value={qwenPassword} disabled={saving} autoComplete="new-password"
                      required={!settings.hasSavedPassword || settings.modelProvider !== "ollama"}
                      onChange={(event) => setQwenPassword(event.target.value)}
                      placeholder={settings.hasSavedPassword ? "Leave blank to keep saved password" : "Enter your tunnel password"} />
                    <small>The Basic Auth password you set, not your ngrok account token.</small>
                  </label>
                </div>
              </section>
            ) : (
            <section className={styles.providerSection} aria-labelledby="kimi-settings-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="kimi-settings-title">Kimi Agent Models</h3>
                  <p>Use one model to decompose questions and another to compose answers from verified read-only tool results.</p>
                </div>
                <span className={settings.configured ? styles.providerReady : styles.providerMissing}>
                  {settings.configured ? "Configured" : "API key required"}
                </span>
              </div>

              <div className={styles.fieldGrid}>
                <label>
                  API region
                  <select
                    value={region}
                    onChange={(event) => setRegion(event.target.value as AgentSettings["region"])}
                  >
                    <option value="china">China · platform.kimi.com</option>
                    <option value="international">International · platform.kimi.ai</option>
                  </select>
                </label>

                <label>
                  Moonshot API key
                  <span className={styles.secretField}>
                    <KeyRound size={15} />
                    <input
                      type="password"
                      autoComplete="new-password"
                      required={settings.source !== "saved"}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={settings.source === "saved" && settings.maskedApiKey
                        ? `Leave blank to keep ${settings.maskedApiKey}`
                        : settings.source === "environment"
                          ? "Enter the key to create an ERP-saved override"
                          : "Enter your Moonshot API key"}
                    />
                  </span>
                </label>
              </div>

              <div className={styles.fieldGrid}>
                <label>
                  Planner model
                  <input
                    list="kimi-planner-model-options"
                    required
                    value={plannerModel}
                    onChange={(event) => setPlannerModel(event.target.value)}
                    placeholder="kimi-k3"
                    spellCheck={false}
                  />
                  <small>Decomposes natural-language requests into a structured query plan.</small>
                </label>

                <label>
                  Executor model
                  <input
                    list="kimi-executor-model-options"
                    required
                    value={executorModel}
                    onChange={(event) => setExecutorModel(event.target.value)}
                    placeholder="kimi-k2.6"
                    spellCheck={false}
                  />
                  <small>Organizes the final answer from validated evidence.</small>
                </label>
                <datalist id="kimi-planner-model-options">
                  <option value="kimi-k3" />
                  <option value="kimi-k2.6" />
                </datalist>
                <datalist id="kimi-executor-model-options">
                  <option value="kimi-k2.6" />
                  <option value="kimi-k3" />
                </datalist>
              </div>

              <small className={styles.providerSource}>
                Select the platform where the key was created. The server maps it to the fixed official endpoint: {region === settings.region ? settings.baseUrl : region === "china" ? "https://api.moonshot.cn/v1" : "https://api.moonshot.ai/v1"}
                <br />
                Active key source: {settings.source === "saved" ? "saved in ERP" : settings.source === "environment" ? "environment" : "not configured"}
              </small>
            </section>
            )}

            <div className={styles.securityNote}>
              <ShieldCheck size={17} />
              <p><strong>Server-side only.</strong> {modelProvider === "ollama"
                ? "Your password is never returned after saving. We verify the tunnel connection and model name before activating Qwen."
                : "The raw key is never returned after saving. Region choices map only to official Moonshot endpoints, and each selected model must be advertised by that API account."}</p>
            </div>

            <footer>
              {settings.source === "saved" ? (
                <button className={styles.deleteButton} type="button" disabled={saving} onClick={() => void clearSaved()}>
                  <Trash2 size={15} /> Remove saved settings
                </button>
              ) : <span />}
              <div>
                <button className={styles.secondaryButton} type="button" disabled={saving} onClick={onClose}>Cancel</button>
                <button className={styles.primaryButton} type="submit" disabled={saving}>
                  {saving ? <LoaderCircle className={styles.spinning} size={16} /> : <Save size={16} />}
                  {modelProvider === "ollama" ? "Verify & Save Qwen" : "Save Agent Settings"}
                </button>
              </div>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
