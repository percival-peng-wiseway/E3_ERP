"use client";

import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  FilePenLine,
  LoaderCircle,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./reports-workspace.module.css";

type ReportDocument = {
  content: string;
  updatedAt: string | null;
  revision: number;
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const MAX_CONTENT_LENGTH = 100_000;
const DRAFT_STORAGE_KEY = "e3_reports_unsaved_draft";

function readDraft() {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(DRAFT_STORAGE_KEY) || "null");
    if (!value || typeof value !== "object" || !("content" in value)) return null;
    const content = (value as { content?: unknown }).content;
    return typeof content === "string" && content.length <= MAX_CONTENT_LENGTH ? content : null;
  } catch {
    return null;
  }
}

function storeDraft(content: string) {
  try {
    window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ content }));
  } catch {
    // Server auto-save remains the primary persistence path if browser draft storage is unavailable.
  }
}

function clearDraft() {
  try {
    window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing else is required when browser draft storage is unavailable.
  }
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const message = (value as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function formatSavedTime(value: string | null) {
  if (!value) return "Not saved yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved";
  return `Last saved ${new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

export function ReportsWorkspace() {
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loadError, setLoadError] = useState("");
  const [saveConflict, setSaveConflict] = useState(false);
  const contentRef = useRef("");
  const lastSavedRef = useRef("");
  const revisionRef = useRef(0);
  const loadRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const readyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const pendingContentRef = useRef<string | null>(null);
  const saveBlockedRef = useRef(false);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const loadDocument = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoadError("");
    setSaveConflict(false);
    saveBlockedRef.current = false;
    setReady(false);
    readyRef.current = false;
    try {
      const response = await fetch("/api/reports", { cache: "no-store" });
      const body = await readJsonResponse<{ data?: ReportDocument; error?: string }>(response);
      if (!response.ok || !body.data) throw new Error(apiError(body, "Unable to load your needs."));
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      const serverContent = typeof body.data.content === "string" ? body.data.content : "";
      const recoveredDraft = readDraft();
      const hasRecoveredDraft = recoveredDraft !== null && recoveredDraft !== serverContent;
      const nextContent = hasRecoveredDraft ? recoveredDraft : serverContent;
      contentRef.current = nextContent;
      lastSavedRef.current = serverContent;
      revisionRef.current = Number.isInteger(body.data.revision) ? body.data.revision : 0;
      setContent(nextContent);
      setUpdatedAt(body.data.updatedAt || null);
      if (hasRecoveredDraft) {
        saveBlockedRef.current = true;
        setSaveConflict(true);
        setSaveState("error");
        setLoadError("Unsaved text was recovered from this browser. Review it, then choose Save my version.");
      } else {
        clearDraft();
        setSaveState(body.data.updatedAt ? "saved" : "idle");
      }
      setReady(true);
      readyRef.current = true;
    } catch (error) {
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      setLoadError(error instanceof Error ? error.message : "Unable to load your needs.");
      setSaveState("idle");
      setReady(false);
      readyRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadDocument();
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, [loadDocument]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!readyRef.current || (contentRef.current === lastSavedRef.current && !saveInFlightRef.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, []);

  const drainSaveQueue = useCallback(async () => {
    if (saveInFlightRef.current || saveBlockedRef.current || !readyRef.current) return;
    saveInFlightRef.current = true;
    try {
      while (pendingContentRef.current !== null && !saveBlockedRef.current) {
        const nextContent = pendingContentRef.current;
        pendingContentRef.current = null;
        if (nextContent === lastSavedRef.current) continue;
        if (mountedRef.current) {
          setSaveState("saving");
          setLoadError("");
        }

        const response = await fetch("/api/reports", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: nextContent, revision: revisionRef.current }),
        });
        const body = await readJsonResponse<{ data?: ReportDocument; error?: string }>(response);

        if (response.status === 409 && body.data) {
          revisionRef.current = Number.isInteger(body.data.revision) ? body.data.revision : revisionRef.current;
          lastSavedRef.current = body.data.content;
          if (mountedRef.current) setUpdatedAt(body.data.updatedAt || null);
          if (contentRef.current === body.data.content) {
            pendingContentRef.current = null;
            saveBlockedRef.current = false;
            clearDraft();
            if (mountedRef.current) {
              setSaveConflict(false);
              setSaveState("saved");
              setLoadError("");
            }
            return;
          }
          pendingContentRef.current = contentRef.current;
          saveBlockedRef.current = true;
          if (mountedRef.current) {
            setSaveConflict(true);
            setSaveState("error");
            setLoadError("This document changed in another window. Review your text, then choose Save my version to replace it.");
          }
          return;
        }
        if (!response.ok || !body.data) throw new Error(apiError(body, "Unable to save your needs."));

        revisionRef.current = Number.isInteger(body.data.revision)
          ? body.data.revision
          : revisionRef.current + 1;
        lastSavedRef.current = nextContent;
        if (mountedRef.current) {
          setUpdatedAt(body.data.updatedAt || new Date().toISOString());
          setSaveConflict(false);
          setLoadError("");
          if (contentRef.current === nextContent && pendingContentRef.current === null) clearDraft();
          else storeDraft(contentRef.current);
        }
      }

      if (mountedRef.current) {
        setSaveState(contentRef.current === lastSavedRef.current ? "saved" : "dirty");
      }
    } catch (error) {
      pendingContentRef.current = contentRef.current;
      if (mountedRef.current) {
        setSaveState("error");
        setLoadError(error instanceof Error ? error.message : "Unable to save your needs.");
      }
    } finally {
      saveInFlightRef.current = false;
    }
  }, []);

  const saveDocument = useCallback((nextContent: string) => {
    if (!readyRef.current) return;
    if (nextContent === lastSavedRef.current && !saveInFlightRef.current) {
      clearDraft();
      return;
    }
    pendingContentRef.current = nextContent;
    if (saveBlockedRef.current) {
      setSaveState("error");
      return;
    }
    setSaveState("dirty");
    void drainSaveQueue();
  }, [drainSaveQueue]);

  useEffect(() => () => {
    if (!readyRef.current
      || saveBlockedRef.current
      || contentRef.current === lastSavedRef.current) return;
    pendingContentRef.current = contentRef.current;
    void drainSaveQueue();
  }, [drainSaveQueue]);

  useEffect(() => {
    if (!ready || content === lastSavedRef.current) return;
    setSaveState("dirty");
    const timer = window.setTimeout(() => void saveDocument(content), 700);
    return () => window.clearTimeout(timer);
  }, [content, ready, saveDocument]);

  const updateContent = (value: string) => {
    const nextContent = value.slice(0, MAX_CONTENT_LENGTH);
    contentRef.current = nextContent;
    if (nextContent === lastSavedRef.current && !saveInFlightRef.current) clearDraft();
    else storeDraft(nextContent);
    setContent(nextContent);
  };

  const retrySave = () => {
    saveBlockedRef.current = false;
    setSaveConflict(false);
    pendingContentRef.current = contentRef.current;
    setLoadError("");
    void drainSaveQueue();
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-AU") === "s") {
      event.preventDefault();
      void saveDocument(contentRef.current);
    }
  };

  const status = !ready
    ? loadError
      ? { icon: <AlertCircle size={15} />, label: "Unable to load", tone: styles.failed }
      : { icon: <LoaderCircle className={styles.spinning} size={15} />, label: "Loading…", tone: styles.saving }
    : saveState === "saving"
    ? { icon: <LoaderCircle className={styles.spinning} size={15} />, label: "Saving…", tone: styles.saving }
    : saveState === "error"
      ? { icon: <AlertCircle size={15} />, label: "Save failed", tone: styles.failed }
      : saveState === "dirty"
        ? { icon: <Cloud size={15} />, label: "Unsaved changes", tone: styles.dirty }
        : saveState === "saved"
          ? { icon: <CheckCircle2 size={15} />, label: "Saved", tone: styles.saved }
          : { icon: <Cloud size={15} />, label: "Auto-save ready", tone: styles.idle };

  return (
    <section className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>REPORTS · YOUR NEEDS</span>
          <h1>Needs Editor</h1>
        </div>
        <div className={`${styles.saveStatus} ${status.tone}`} role="status" aria-live="polite">
          {status.icon}
          <span><strong>{status.label}</strong><small>{formatSavedTime(updatedAt)}</small></span>
        </div>
      </header>

      {loadError && (
        <div className={styles.errorBanner} role="alert">
          <AlertCircle size={17} />
          <span>{loadError}</span>
          <button onClick={() => !ready ? void loadDocument() : retrySave()}>
            <RotateCw size={14} />{!ready ? "Retry" : saveConflict ? "Save my version" : "Retry save"}
          </button>
        </div>
      )}

      <section className={styles.editorCard} aria-label="Needs text editor">
        <div className={styles.editorToolbar}>
          <div><FilePenLine size={16} /><strong>reports.txt</strong></div>
          <span>{content.length.toLocaleString("en-AU")} / {MAX_CONTENT_LENGTH.toLocaleString("en-AU")} characters</span>
        </div>
        <div className={styles.editorSurface}>
          <div className={styles.promptLine}>
            <span>1</span>
            <p><Sparkles size={16} />Make life easier，Let me know your needs</p>
          </div>
          <div className={styles.inputLine}>
            <span>2</span>
            <textarea
              value={content}
              onChange={(event) => updateContent(event.target.value)}
              onBlur={() => void saveDocument(contentRef.current)}
              onKeyDown={handleEditorKeyDown}
              placeholder="Start writing here…\n\nFor example:\n- Add a faster stock lookup\n- Send a reminder before delivery\n- Include another field on quotations"
              aria-label="Your needs"
              maxLength={MAX_CONTENT_LENGTH}
              disabled={!ready}
              autoFocus
              spellCheck
            />
          </div>
        </div>
        <footer className={styles.editorFooter}>
          <span>Changes save automatically after you stop typing.</span>
          <span><kbd>⌘</kbd><kbd>S</kbd> or <kbd>Ctrl</kbd><kbd>S</kbd> to save now</span>
        </footer>
      </section>
    </section>
  );
}
