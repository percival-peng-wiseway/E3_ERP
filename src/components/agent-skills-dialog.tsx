"use client";

import {
  Blocks,
  Check,
  CirclePlus,
  LoaderCircle,
  LockKeyhole,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./agent-skills-dialog.module.css";

type AgentSkillSource = "built_in" | "custom";

type AgentSkill = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  enabled: boolean;
  source: AgentSkillSource;
  capabilityIds: string[];
  version: number;
  updatedAt: string | null;
  updatedBy: string;
};

type SkillEditor = Pick<
  AgentSkill,
  "id" | "name" | "description" | "trigger" | "prompt" | "enabled" | "source" | "capabilityIds" | "version"
>;

type SkillsResponse = {
  data?: { skills?: unknown; skill?: unknown; id?: unknown };
  error?: string | { message?: string };
};

const CAPABILITIES = [
  { id: "workspace", label: "Workspace overview" },
  { id: "weekly_schedule", label: "Weekly Schedule" },
  { id: "site_visits", label: "Site Visiting" },
  { id: "inventory", label: "Inventory" },
  { id: "project_track", label: "Project Track & collections" },
  { id: "project_management", label: "Delivery orders" },
  { id: "quotations", label: "Quotations" },
  { id: "reimbursements", label: "Reimbursements" },
  { id: "knowledge", label: "Knowledge base" },
  { id: "reports", label: "Reports" },
  { id: "communications", label: "Announcements" },
] as const;

const EMPTY_EDITOR: SkillEditor = {
  id: "",
  name: "",
  description: "",
  trigger: "",
  prompt: "",
  enabled: true,
  source: "custom",
  capabilityIds: [],
  version: 0,
};

function responseError(body: SkillsResponse, fallback: string) {
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (body.error && typeof body.error === "object" && typeof body.error.message === "string") {
    return body.error.message;
  }
  return fallback;
}

function safeText(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function readSkill(value: unknown): AgentSkill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = safeText(item.id, 160);
  const name = safeText(item.name, 120);
  const description = safeText(item.description, 1_000);
  const trigger = safeText(item.trigger, 240);
  const prompt = safeText(item.prompt, 4_000);
  const updatedAt = item.updatedAt === null ? null : safeText(item.updatedAt, 80);
  const updatedBy = safeText(item.updatedBy, 160);
  if (
    !id?.trim()
    || !name?.trim()
    || description === null
    || !trigger?.trim()
    || prompt === null
    || typeof item.enabled !== "boolean"
    || (item.source !== "built_in" && item.source !== "custom")
    || !Array.isArray(item.capabilityIds)
    || item.capabilityIds.length > CAPABILITIES.length
    || item.capabilityIds.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 80)
    || typeof item.version !== "number"
    || !Number.isSafeInteger(item.version)
    || item.version < 1
    || (item.updatedAt !== null && (!updatedAt || Number.isNaN(Date.parse(updatedAt))))
    || !updatedBy?.trim()
  ) {
    return null;
  }
  return {
    id,
    name,
    description,
    trigger,
    prompt,
    enabled: item.enabled,
    source: item.source,
    capabilityIds: [...new Set(item.capabilityIds as string[])],
    version: item.version,
    updatedAt,
    updatedBy,
  };
}

function readSkills(value: unknown) {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const skills: AgentSkill[] = [];
  for (const valueItem of value) {
    const skill = readSkill(valueItem);
    if (!skill || seen.has(skill.id)) return null;
    seen.add(skill.id);
    skills.push(skill);
  }
  return skills.sort((left, right) => (
    Number(left.source === "custom") - Number(right.source === "custom")
      || left.name.localeCompare(right.name, "en-AU")
  ));
}

function editorFor(skill: AgentSkill): SkillEditor {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    trigger: skill.trigger,
    prompt: skill.prompt,
    enabled: skill.enabled,
    source: skill.source,
    capabilityIds: [...skill.capabilityIds],
    version: skill.version,
  };
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Melbourne",
  }).format(date);
}

function knownCapabilityLabel(id: string) {
  return CAPABILITIES.find((capability) => capability.id === id)?.label || id.replaceAll("_", " ");
}

export function AgentSkillsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [editor, setEditor] = useState<SkillEditor | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(saving);

  const selectedSkill = useMemo(
    () => editor?.id ? skills.find((skill) => skill.id === editor.id) || null : null,
    [editor?.id, skills],
  );
  const builtInCount = skills.filter((skill) => skill.source === "built_in").length;
  const customCount = skills.length - builtInCount;
  const enabledCount = skills.filter((skill) => skill.enabled).length;

  useEffect(() => {
    closeRef.current = onClose;
    savingRef.current = saving;
  }, [onClose, saving]);

  const loadSkills = async (preferredId?: string) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/settings/agent/skills", { cache: "no-store", signal: controller.signal });
      const body = await readJsonResponse<SkillsResponse>(response);
      const nextSkills = readSkills(body.data?.skills);
      if (!response.ok || !nextSkills) {
        throw new Error(responseError(body, "Unable to load Agent skills."));
      }
      setSkills(nextSkills);
      const selected = nextSkills.find((skill) => skill.id === preferredId)
        || nextSkills.find((skill) => skill.source === "built_in")
        || nextSkills[0]
        || null;
      setEditor(selected ? editorFor(selected) : null);
      setCreating(false);
      setConfirmingDelete(false);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load Agent skills.");
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSkills([]);
    setEditor(null);
    setCreating(false);
    setError("");
    setNotice("");
    setConfirmingDelete(false);
    void loadSkills();
    return () => {
      const controller = loadAbortRef.current;
      loadAbortRef.current = null;
      controller?.abort();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled])")?.focus();
    });
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]",
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

  const selectSkill = (skill: AgentSkill) => {
    if (saving) return;
    setEditor(editorFor(skill));
    setCreating(false);
    setConfirmingDelete(false);
    setError("");
    setNotice("");
  };

  const startCreating = () => {
    setEditor({ ...EMPTY_EDITOR, capabilityIds: [] });
    setCreating(true);
    setConfirmingDelete(false);
    setError("");
    setNotice("");
  };

  const saveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || editor.source !== "custom") return;
    setSaving(true);
    setError("");
    setNotice("");
    setConfirmingDelete(false);
    try {
      const endpoint = creating
        ? "/api/settings/agent/skills"
        : `/api/settings/agent/skills/${encodeURIComponent(editor.id)}`;
      const response = await fetch(endpoint, {
        method: creating ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(!creating ? { expectedVersion: editor.version } : {}),
          name: editor.name.trim(),
          description: editor.description.trim(),
          trigger: editor.trigger.trim(),
          prompt: editor.prompt.trim(),
          enabled: editor.enabled,
          capabilityIds: editor.capabilityIds,
        }),
      });
      const body = await readJsonResponse<SkillsResponse>(response);
      const savedSkill = readSkill(body.data?.skill);
      if (!response.ok || !savedSkill) {
        throw new Error(responseError(body, creating ? "Unable to create this skill." : "Unable to save this skill."));
      }
      setSkills((current) => {
        const next = creating
          ? [...current, savedSkill]
          : current.map((skill) => skill.id === savedSkill.id ? savedSkill : skill);
        return next.sort((left, right) => (
          Number(left.source === "custom") - Number(right.source === "custom")
            || left.name.localeCompare(right.name, "en-AU")
        ));
      });
      setEditor(editorFor(savedSkill));
      setCreating(false);
      setNotice(creating ? `${savedSkill.name} was created.` : `${savedSkill.name} was updated.`);
      window.dispatchEvent(new CustomEvent("erp:agent-skills-updated"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this skill.");
    } finally {
      setSaving(false);
    }
  };

  const deleteSkill = async () => {
    if (!editor || editor.source !== "custom" || creating) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/settings/agent/skills/${encodeURIComponent(editor.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: editor.version }),
      });
      const body = await readJsonResponse<SkillsResponse>(response);
      const deletedId = typeof body.data?.id === "string" ? body.data.id : "";
      if (!response.ok || deletedId !== editor.id) {
        throw new Error(responseError(body, "Unable to delete this skill."));
      }
      const remaining = skills.filter((skill) => skill.id !== deletedId);
      setSkills(remaining);
      const nextSelected = remaining.find((skill) => skill.source === "custom") || remaining[0] || null;
      setEditor(nextSelected ? editorFor(nextSelected) : null);
      setConfirmingDelete(false);
      setNotice(`${editor.name} was deleted.`);
      window.dispatchEvent(new CustomEvent("erp:agent-skills-updated"));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete this skill.");
    } finally {
      setSaving(false);
    }
  };

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !saving) onClose();
  };

  const canSave = Boolean(
    editor?.source === "custom"
    && editor.name.trim()
    && editor.trigger.trim()
    && editor.prompt.trim()
    && editor.capabilityIds.length,
  );

  return (
    <div className={styles.backdrop} onMouseDown={closeFromBackdrop}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="agent-skills-title" aria-describedby="agent-skills-description">
        <header className={styles.dialogHeader}>
          <span className={styles.headingIcon}><Blocks size={21} /></span>
          <div>
            <h2 id="agent-skills-title">My Agent Skills</h2>
            <p id="agent-skills-description">Create and manage your reusable, read-only E3 Agent workflows.</p>
          </div>
          <button type="button" aria-label="Close My Agent Skills" disabled={saving} onClick={onClose}><X size={19} /></button>
        </header>

        <div className={styles.toolbar}>
          <div>
            <strong>{enabledCount} active skills</strong>
            <span>{builtInCount} built-in · {customCount} personal</span>
          </div>
          <button type="button" disabled={loading || saving} onClick={startCreating}>
            <CirclePlus size={16} /> Add custom skill
          </button>
        </div>

        {notice ? <div className={styles.notice} role="status"><Check size={15} />{notice}</div> : null}
        {error ? (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <button type="button" disabled={loading || saving} onClick={() => void loadSkills(editor?.id)}>Reload</button>
          </div>
        ) : null}

        <div className={styles.content} aria-busy={loading}>
          <nav className={styles.skillList} aria-label="Built-in and your Agent skills">
            {loading ? <div className={styles.loading}><LoaderCircle className={styles.spinning} size={18} /> Loading skills…</div> : null}
            {!loading && !skills.length ? <div className={styles.loading}>No skills are available.</div> : null}
            {skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className={`${styles.skillRow} ${editor?.id === skill.id && !creating ? styles.selected : ""}`}
                aria-pressed={editor?.id === skill.id && !creating}
                disabled={saving}
                onClick={() => selectSkill(skill)}
              >
                <span className={`${styles.skillStatus} ${skill.enabled ? styles.enabled : ""}`} aria-hidden="true" />
                <span className={styles.skillIdentity}>
                  <strong>{skill.name}</strong>
                  <small>{skill.trigger}</small>
                  <span className={styles.capabilityPreview}>
                    {skill.enabled ? "Enabled" : "Disabled"} · {skill.capabilityIds.slice(0, 3).map(knownCapabilityLabel).join(" · ") || "No capabilities"}
                  </span>
                </span>
                <span className={skill.source === "built_in" ? styles.builtInBadge : styles.customBadge}>
                  {skill.source === "built_in" ? <LockKeyhole size={11} /> : <Blocks size={11} />}
                  {skill.source === "built_in" ? "Built-in" : "Custom"}
                </span>
              </button>
            ))}
          </nav>

          <div className={styles.editorPane}>
            {editor ? (
              <form onSubmit={saveSkill}>
                <div className={styles.editorHeading}>
                  <div>
                    <small>{creating ? "New custom skill" : editor.source === "built_in" ? "Source-controlled skill" : `Custom · v${editor.version}`}</small>
                    <h3>{creating ? "Create a skill" : editor.name}</h3>
                  </div>
                  {editor.source === "built_in" ? <LockKeyhole size={19} aria-label="Built-in skill is locked" /> : <ShieldCheck size={20} aria-hidden="true" />}
                </div>

                {editor.source === "built_in" ? (
                  <div className={styles.lockedNote}>
                    <LockKeyhole size={15} />
                    <span>Built-in skills are reviewed in source control and cannot be edited here.</span>
                  </div>
                ) : null}

                <div className={styles.fieldGrid}>
                  <label>
                    Skill name
                    <input
                      required
                      disabled={saving || editor.source === "built_in"}
                      maxLength={80}
                      value={editor.name}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                      placeholder="Weekly operations summary"
                    />
                  </label>
                  <label>
                    Trigger phrase
                    <input
                      required
                      disabled={saving || editor.source === "built_in"}
                      maxLength={120}
                      value={editor.trigger}
                      onChange={(event) => setEditor({ ...editor, trigger: event.target.value })}
                      placeholder="Summarize this week"
                    />
                    <small>Users can type this phrase to run the skill.</small>
                  </label>
                </div>

                <label>
                  Description
                  <textarea
                    disabled={saving || editor.source === "built_in"}
                    maxLength={500}
                    rows={2}
                    value={editor.description}
                    onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                    placeholder="Explain what this skill returns."
                  />
                </label>

                <label>
                  Skill instructions
                  <textarea
                    required
                    disabled={saving || editor.source === "built_in"}
                    maxLength={1_600}
                    rows={4}
                    aria-describedby="agent-skill-instructions-note"
                    value={editor.prompt}
                    onChange={(event) => setEditor({ ...editor, prompt: event.target.value })}
                    placeholder="Summarise the selected business areas for the current week."
                  />
                  <small id="agent-skill-instructions-note">Instructions cannot add permissions. The server exposes only the selected read-only capabilities.</small>
                </label>

                <fieldset className={styles.capabilities} disabled={saving || editor.source === "built_in"}>
                  <legend>Allowed capabilities</legend>
                  <p>Select the ERP data this skill may read.</p>
                  <div>
                    {CAPABILITIES.map((capability) => (
                      <label key={capability.id}>
                        <input
                          type="checkbox"
                          checked={editor.capabilityIds.includes(capability.id)}
                          onChange={(event) => setEditor({
                            ...editor,
                            capabilityIds: event.target.checked
                              ? [...editor.capabilityIds, capability.id]
                              : editor.capabilityIds.filter((id) => id !== capability.id),
                          })}
                        />
                        <span>{capability.label}</span>
                      </label>
                    ))}
                    {editor.capabilityIds.filter((id) => !CAPABILITIES.some((capability) => capability.id === id)).map((id) => (
                      <label key={id}>
                        <input type="checkbox" checked readOnly />
                        <span>{knownCapabilityLabel(id)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className={styles.enabledToggle}>
                  <input
                    type="checkbox"
                    disabled={saving || editor.source === "built_in"}
                    checked={editor.enabled}
                    aria-describedby="agent-skill-account-impact"
                    onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })}
                  />
                  <span>
                    <strong>Enabled for my E3 Agent</strong>
                    <small id="agent-skill-account-impact">Changing this setting affects only your account.</small>
                  </span>
                </label>

                {!creating && selectedSkill ? (
                  <p className={styles.auditLine}>
                    {selectedSkill.updatedAt ? `Updated ${formatTimestamp(selectedSkill.updatedAt)}` : "Maintained in source control"} by {selectedSkill.updatedBy}
                  </p>
                ) : null}

                {editor.source === "custom" ? (
                  <footer className={styles.editorFooter}>
                    {!creating ? (
                      confirmingDelete ? (
                        <div className={styles.deleteConfirmation} role="group" aria-label={`Confirm deletion of ${editor.name}`}>
                          <span>Delete this skill?</span>
                          <button type="button" disabled={saving} onClick={() => setConfirmingDelete(false)}>Keep it</button>
                          <button className={styles.confirmDelete} type="button" disabled={saving} onClick={() => void deleteSkill()}>
                            {saving ? <LoaderCircle className={styles.spinning} size={14} /> : <Trash2 size={14} />} Delete
                          </button>
                        </div>
                      ) : (
                        <button className={styles.deleteButton} type="button" disabled={saving} onClick={() => setConfirmingDelete(true)}>
                          <Trash2 size={15} /> Delete skill
                        </button>
                      )
                    ) : <span />}
                    {!confirmingDelete ? (
                      <div>
                        <button className={styles.secondaryButton} type="button" disabled={saving} onClick={() => {
                          if (creating) {
                            const fallback = skills.find((skill) => skill.source === "built_in") || skills[0] || null;
                            setEditor(fallback ? editorFor(fallback) : null);
                            setCreating(false);
                          } else if (selectedSkill) {
                            setEditor(editorFor(selectedSkill));
                          }
                          setError("");
                        }}>Cancel</button>
                        <button className={styles.primaryButton} type="submit" disabled={saving || !canSave}>
                          {saving ? <LoaderCircle className={styles.spinning} size={16} /> : <Save size={16} />}
                          {creating ? "Create skill" : "Save changes"}
                        </button>
                      </div>
                    ) : null}
                  </footer>
                ) : null}
              </form>
            ) : (
              <div className={styles.emptyEditor}>
                <Blocks size={30} />
                <strong>Select a skill</strong>
                <span>Review a built-in skill or add your own workflow.</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
