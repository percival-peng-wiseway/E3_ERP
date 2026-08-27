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
  configured: boolean;
  source: "saved" | "environment" | "default";
  maskedApiKey: string | null;
  baseUrl: string;
  model: string;
  deepSeekConfigured: boolean;
  maskedDeepSeekApiKey: string | null;
  deepSeekBaseUrl: string;
  deepSeekFastModel: string;
  deepSeekComplexModel: string;
  deepSeekSource: "saved" | "environment" | "default";
};

type AgentSettingsResponse = {
  data?: AgentSettings;
  error?: string | { message?: string };
};

const EMPTY_SETTINGS: AgentSettings = {
  configured: true,
  source: "default",
  maskedApiKey: null,
  baseUrl: "https://navigator-spongy-diagnosis.ngrok-free.dev/v1",
  model: "qwen3.5:9b",
  deepSeekConfigured: false,
  maskedDeepSeekApiKey: null,
  deepSeekBaseUrl: "https://api.deepseek.com/beta",
  deepSeekFastModel: "deepseek-v4-flash",
  deepSeekComplexModel: "deepseek-v4-pro",
  deepSeekSource: "default",
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
  const [baseUrl, setBaseUrl] = useState(EMPTY_SETTINGS.baseUrl);
  const [model, setModel] = useState(EMPTY_SETTINGS.model);
  const [deepSeekApiKey, setDeepSeekApiKey] = useState("");
  const [deepSeekBaseUrl, setDeepSeekBaseUrl] = useState(EMPTY_SETTINGS.deepSeekBaseUrl);
  const [deepSeekFastModel, setDeepSeekFastModel] = useState(EMPTY_SETTINGS.deepSeekFastModel);
  const [deepSeekComplexModel, setDeepSeekComplexModel] = useState(EMPTY_SETTINGS.deepSeekComplexModel);
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
    setDeepSeekApiKey("");
    void fetch("/api/settings/agent", { cache: "no-store" })
      .then(async (response) => {
        const body = await readJsonResponse<AgentSettingsResponse>(response);
        if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to load Agent settings."));
        if (!active) return;
        setSettings(body.data);
        setBaseUrl(body.data.baseUrl);
        setModel(body.data.model);
        setDeepSeekBaseUrl(body.data.deepSeekBaseUrl);
        setDeepSeekFastModel(body.data.deepSeekFastModel);
        setDeepSeekComplexModel(body.data.deepSeekComplexModel);
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
        body: JSON.stringify({
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          baseUrl: baseUrl.trim(),
          model,
          ...(deepSeekApiKey.trim() ? { deepSeekApiKey: deepSeekApiKey.trim() } : {}),
          deepSeekBaseUrl: deepSeekBaseUrl.trim(),
          deepSeekFastModel,
          deepSeekComplexModel,
        }),
      });
      const body = await readJsonResponse<AgentSettingsResponse>(response);
      if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to save Agent settings."));
      setSettings(body.data);
      setBaseUrl(body.data.baseUrl);
      setModel(body.data.model);
      setApiKey("");
      setDeepSeekApiKey("");
      setDeepSeekBaseUrl(body.data.deepSeekBaseUrl);
      setDeepSeekFastModel(body.data.deepSeekFastModel);
      setDeepSeekComplexModel(body.data.deepSeekComplexModel);
      setNotice(body.data.deepSeekConfigured
        ? "Model settings saved. DeepSeek Business Agent is ready."
        : "Model settings saved. Add a DeepSeek API key to enable the Business Agent.");
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
      setBaseUrl(body.data.baseUrl);
      setModel(body.data.model);
      setApiKey("");
      setDeepSeekApiKey("");
      setDeepSeekBaseUrl(body.data.deepSeekBaseUrl);
      setDeepSeekFastModel(body.data.deepSeekFastModel);
      setDeepSeekComplexModel(body.data.deepSeekComplexModel);
      setNotice(body.data.source === "environment"
        ? "Saved settings removed. Environment configuration is now active."
        : "Saved settings removed. The default model endpoint is now active.");
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
            <h2 id="agent-settings-title">E3 Agent Model API</h2>
          </div>
          <button type="button" aria-label="Close settings" disabled={saving} onClick={onClose}><X size={19} /></button>
        </header>

        {loading ? (
          <div className={styles.loading}><LoaderCircle className={styles.spinning} size={20} /> Loading Agent settings…</div>
        ) : (
          <form onSubmit={submit}>
            <div className={`${styles.status} ${settings.configured ? styles.ready : ""}`}>
              {settings.configured ? <CheckCircle2 size={17} /> : <KeyRound size={17} />}
              <div>
                <strong>{settings.configured ? "Model endpoint configured" : "Model endpoint unavailable"}</strong>
                <small>
                  {settings.configured
                    ? `${settings.source === "saved" ? "Saved settings" : settings.source === "environment" ? "Environment settings" : "Default settings"}${settings.maskedApiKey ? ` · ${settings.maskedApiKey}` : " · no API key required"}`
                    : "The Agent will use limited local query mode."}
                </small>
              </div>
            </div>

            {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
            {error ? <div className={styles.error} role="alert">{error}</div> : null}

            <label>
              API key (optional)
              <span className={styles.secretField}>
                <KeyRound size={15} />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={settings.maskedApiKey ? "Leave blank to keep the current key" : "No key required by the current endpoint"}
                />
              </span>
            </label>

            <div className={styles.fieldGrid}>
              <label>
                Model
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="qwen3.5:9b">Qwen 3.5 9B</option>
                  <option value="qwenvl4b:latest">Qwen VL 4B</option>
                  <option value="qwen3-vl:4b">Qwen 3 VL 4B</option>
                  <option value="qwen2.5vl:7b">Qwen 2.5 VL 7B</option>
                  <option value="qwen3.6:27b">Qwen 3.6 27B</option>
                  <option value="qwen3.6:latest">Qwen 3.6 Latest</option>
                </select>
              </label>
              <label>
                API base URL
                <input type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </label>
            </div>

            <section className={styles.providerSection} aria-labelledby="deepseek-settings-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="deepseek-settings-title">DeepSeek Business Agent</h3>
                  <p>Used by the strict read-only inventory, knowledge, project and order tools.</p>
                </div>
                <span className={settings.deepSeekConfigured ? styles.providerReady : styles.providerMissing}>
                  {settings.deepSeekConfigured ? "Configured" : "API key required"}
                </span>
              </div>

              <label>
                DeepSeek API key
                <span className={styles.secretField}>
                  <KeyRound size={15} />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={deepSeekApiKey}
                    onChange={(event) => setDeepSeekApiKey(event.target.value)}
                    placeholder={settings.maskedDeepSeekApiKey
                      ? `Leave blank to keep ${settings.maskedDeepSeekApiKey}`
                      : "Enter your DeepSeek API key"}
                  />
                </span>
              </label>

              <label>
                DeepSeek API base URL
                <input type="url" required value={deepSeekBaseUrl} onChange={(event) => setDeepSeekBaseUrl(event.target.value)} />
              </label>

              <div className={styles.fieldGrid}>
                <label>
                  Fast model
                  <select value={deepSeekFastModel} onChange={(event) => setDeepSeekFastModel(event.target.value)}>
                    <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                  </select>
                </label>
                <label>
                  Complex model
                  <select value={deepSeekComplexModel} onChange={(event) => setDeepSeekComplexModel(event.target.value)}>
                    <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                  </select>
                </label>
              </div>
              <small className={styles.providerSource}>
                Active source: {settings.deepSeekSource === "saved" ? "saved settings" : settings.deepSeekSource === "environment" ? "environment" : "not configured"}
              </small>
            </section>

            <div className={styles.securityNote}>
              <ShieldCheck size={17} />
              <p><strong>Server-side only.</strong> Keys are never returned to the browser after saving. Questions may send only the business data needed to answer them to the configured model endpoint.</p>
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
                  Save Settings
                </button>
              </div>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
