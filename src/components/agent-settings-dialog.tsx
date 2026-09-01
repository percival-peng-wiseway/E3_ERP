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
};

type AgentSettingsResponse = {
  data?: AgentSettings;
  error?: string | { message?: string };
};

const EMPTY_SETTINGS: AgentSettings = {
  configured: false,
  source: "default",
  maskedApiKey: null,
  baseUrl: "https://api.moonshot.ai/v1",
  model: "kimi-k2.6",
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
    void fetch("/api/settings/agent", { cache: "no-store" })
      .then(async (response) => {
        const body = await readJsonResponse<AgentSettingsResponse>(response);
        if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to load Agent settings."));
        if (!active) return;
        setSettings(body.data);
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
        }),
      });
      const body = await readJsonResponse<AgentSettingsResponse>(response);
      if (!response.ok || !body.data) throw new Error(responseError(body, "Unable to save Agent settings."));
      setSettings(body.data);
      setApiKey("");
      setNotice(body.data.configured
        ? "Moonshot API key saved. Kimi K2.6 is ready."
        : "Add a Moonshot API key to enable Kimi K2.6.");
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
      setApiKey("");
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
            <h2 id="agent-settings-title">E3 Agent API Key</h2>
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
                    ? `${settings.model} · ${settings.source === "saved" ? "saved settings" : "environment settings"}${settings.maskedApiKey ? ` · ${settings.maskedApiKey}` : ""}`
                    : "Add a Moonshot API key to enable Kimi K2.6 answers and image understanding."}
                </small>
              </div>
            </div>

            {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
            {error ? <div className={styles.error} role="alert">{error}</div> : null}

            <section className={styles.providerSection} aria-labelledby="kimi-settings-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="kimi-settings-title">Kimi K2.6 Agent</h3>
                  <p>Primary model for E3 Agent answers, image understanding and strict read-only business tools.</p>
                </div>
                <span className={settings.configured ? styles.providerReady : styles.providerMissing}>
                  {settings.configured ? "Configured" : "API key required"}
                </span>
              </div>

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
                    placeholder={settings.maskedApiKey
                      ? `Leave blank to keep ${settings.maskedApiKey}`
                      : "Enter your Moonshot API key"}
                  />
                </span>
              </label>

              <small className={styles.providerSource}>
                Endpoint and model are managed by the server: {settings.baseUrl} · {settings.model}
                <br />
                Active key source: {settings.source === "saved" ? "saved in ERP" : settings.source === "environment" ? "environment" : "not configured"}
              </small>
            </section>

            <div className={styles.securityNote}>
              <ShieldCheck size={17} />
              <p><strong>Server-side only.</strong> The raw key is never returned after saving. The Moonshot endpoint and Kimi model cannot be changed from the browser.</p>
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
                  Save API Key
                </button>
              </div>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
