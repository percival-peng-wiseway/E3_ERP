"use client";

import { KeyRound, LoaderCircle, Plus, ShieldCheck, UserRoundCheck, UserRoundX, Users, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ERP_ASSIGNABLE_ROLES, ERP_ROLE_LABELS, type ErpRole, type ManagedErpUser } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./user-management-dialog.module.css";

type UsersResponse = {
  data?: { users?: ManagedErpUser[]; user?: ManagedErpUser };
  error?: { message?: string } | string;
};

type Editor = {
  username: string;
  displayName: string;
  role: ErpRole;
  password: string;
  active: boolean;
  version: number | null;
};

const EMPTY_EDITOR: Editor = {
  username: "",
  displayName: "",
  role: "sales",
  password: "",
  active: true,
  version: null,
};

function responseError(body: UsersResponse, fallback: string) {
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (body.error && typeof body.error === "object" && typeof body.error.message === "string") return body.error.message;
  return fallback;
}

function editorFor(user: ManagedErpUser): Editor {
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    password: "",
    active: user.active,
    version: user.version,
  };
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Melbourne",
  }).format(date);
}

export function UserManagementDialog({
  open,
  onClose,
  currentUsername,
}: {
  open: boolean;
  onClose: () => void;
  currentUsername: string;
}) {
  const [users, setUsers] = useState<ManagedErpUser[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(saving);

  const activeAdmins = useMemo(() => users.filter((user) => user.active && user.role === "admin").length, [users]);
  const editingUser = editor?.version === null ? null : users.find((user) => user.username === editor?.username) || null;

  useEffect(() => {
    closeRef.current = onClose;
    savingRef.current = saving;
  }, [onClose, saving]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let active = true;
    setLoading(true);
    setUsers([]);
    setError("");
    setNotice("");
    setEditor(null);
    void fetch("/api/settings/users", { cache: "no-store" })
      .then(async (response) => {
        const body = await readJsonResponse<UsersResponse>(response);
        if (!response.ok || !Array.isArray(body.data?.users)) throw new Error(responseError(body, "Unable to load employees."));
        if (active) setUsers(body.data.users);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load employees.");
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
      dialogRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])")?.focus();
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

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError("");
    setNotice("");
    const creating = editor.version === null;
    try {
      const response = await fetch(creating
        ? "/api/settings/users"
        : `/api/settings/users/${encodeURIComponent(editor.username)}`, {
        method: creating ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creating ? {
          username: editor.username,
          displayName: editor.displayName,
          role: editor.role,
          password: editor.password,
          active: editor.active,
        } : {
          expectedVersion: editor.version,
          displayName: editor.displayName,
          role: editor.role,
          active: editor.active,
          ...(editor.password ? { password: editor.password } : {}),
        }),
      });
      const body = await readJsonResponse<UsersResponse>(response);
      const user = body.data?.user;
      if (!response.ok || !user) throw new Error(responseError(body, creating ? "Unable to create employee." : "Unable to update employee."));
      setUsers((current) => creating
        ? [...current, user].sort((left, right) => Number(right.active) - Number(left.active) || left.displayName.localeCompare(right.displayName))
        : current.map((candidate) => candidate.username === user.username ? user : candidate));
      setEditor(null);
      setNotice(creating
        ? user.active ? `${user.displayName} can now sign in.` : `${user.displayName}'s inactive account was created.`
        : `${user.displayName}'s account was updated.`);
      if (!creating && user.username === currentUsername) window.location.assign("/login");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the employee account.");
    } finally {
      setSaving(false);
    }
  };

  const finalAdmin = Boolean(editingUser?.active && editingUser.role === "admin" && activeAdmins <= 1);
  const passwordRequired = editor?.version === null
    || Boolean(editor?.active && editingUser && !editingUser.credentialsConfigured);

  return (
    <div className={styles.backdrop} onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="user-management-title">
        <header>
          <span><Users size={19} /></span>
          <div><small>Settings</small><h2 id="user-management-title">User Management</h2></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close user management"><X size={18} /></button>
        </header>

        <div className={styles.toolbar}>
          <div><strong>{users.filter((user) => user.active).length} active employees</strong><span>{users.length} accounts · {activeAdmins} administrators</span></div>
          <button type="button" disabled={loading || saving} onClick={() => { setEditor({ ...EMPTY_EDITOR }); setError(""); setNotice(""); }}><Plus size={16} />Add employee</button>
        </div>

        {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}

        <div className={styles.content}>
          <div className={styles.userList} aria-busy={loading}>
            {loading ? <div className={styles.loading}><LoaderCircle className={styles.spin} size={18} />Loading employees…</div> : null}
            {!loading && !users.length ? <div className={styles.loading}>No employee accounts found.</div> : null}
            {users.map((user) => (
              <button type="button" disabled={saving} aria-pressed={editor?.username === user.username} className={`${styles.userRow} ${editor?.username === user.username ? styles.selected : ""}`} key={user.username} onClick={() => { setEditor(editorFor(user)); setError(""); setNotice(""); }}>
                <span className={styles.avatar}>{user.displayName.slice(0, 1).toLocaleUpperCase("en-AU")}</span>
                <span className={styles.identity}><strong>{user.displayName}{user.username === currentUsername ? <em>You</em> : null}</strong><small>@{user.username}</small></span>
                <span className={styles.role}>{ERP_ROLE_LABELS[user.role]}</span>
                <span className={user.active && user.credentialsConfigured ? styles.active : styles.inactive}>{user.active && user.credentialsConfigured ? <UserRoundCheck size={14} /> : <UserRoundX size={14} />}{!user.credentialsConfigured ? "Password setup" : user.active ? "Active" : "Inactive"}</span>
              </button>
            ))}
          </div>

          <div className={styles.editorPane}>
            {editor ? (
              <form onSubmit={save}>
                <div className={styles.editorHeading}>
                  <div><small>{editor.version === null ? "New account" : `@${editor.username}`}</small><h3>{editor.version === null ? "Add employee" : "Edit employee"}</h3></div>
                  <ShieldCheck size={20} />
                </div>
                <label>Username<input required disabled={editor.version !== null || saving} minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9._-]{2,39}" value={editor.username} onChange={(event) => setEditor({ ...editor, username: event.target.value.toLocaleLowerCase("en-AU") })} placeholder="employee.name" /></label>
                <label>Display name<input required disabled={saving} maxLength={80} value={editor.displayName} onChange={(event) => setEditor({ ...editor, displayName: event.target.value })} placeholder="Employee name" /></label>
                <label>Role<select disabled={saving || finalAdmin} value={editor.role} onChange={(event) => setEditor({ ...editor, role: event.target.value as ErpRole })}>{ERP_ASSIGNABLE_ROLES.map((role) => <option value={role} key={role}>{ERP_ROLE_LABELS[role]}</option>)}</select></label>
                <label>{editor.version === null ? "Temporary password" : passwordRequired ? "Temporary password required" : "Reset password (optional)"}<span className={styles.password}><KeyRound size={15} /><input required={passwordRequired} disabled={saving} type="password" minLength={6} maxLength={200} autoComplete="new-password" value={editor.password} onChange={(event) => setEditor({ ...editor, password: event.target.value })} placeholder={passwordRequired ? "Set at least 6 characters before activation" : "Leave blank to keep current password"} /></span></label>
                <label className={styles.statusToggle}><input type="checkbox" disabled={saving || finalAdmin} checked={editor.active} onChange={(event) => setEditor({ ...editor, active: event.target.checked })} /><span><strong>Active account</strong><small>Inactive employees cannot sign in.</small></span></label>
                {finalAdmin ? <p className={styles.safetyNote}>The final active Administrator cannot be deactivated or assigned another role.</p> : null}
                {editingUser && !editingUser.credentialsConfigured ? <p className={styles.safetyNote}>This seeded account has no sign-in password. Set a temporary password before activating it.</p> : null}
                {editor.version !== null ? <p className={styles.audit}>Created {formatTimestamp(editingUser?.createdAt || "")} by {editingUser?.createdBy || "unknown"}<br />Last updated {formatTimestamp(editingUser?.updatedAt || "")} by {editingUser?.updatedBy || "unknown"}</p> : null}
                <footer><button type="button" className={styles.secondary} disabled={saving} onClick={() => setEditor(null)}>Cancel</button><button type="submit" className={styles.primary} disabled={saving || (passwordRequired && editor.password.length < 6)}>{saving ? <LoaderCircle className={styles.spin} size={16} /> : <ShieldCheck size={16} />}{saving ? "Saving…" : editor.version === null ? "Create employee" : "Save changes"}</button></footer>
              </form>
            ) : (
              <div className={styles.emptyEditor}><Users size={30} /><strong>Select an employee</strong><p>Review their role, change account status or issue a new temporary password.</p></div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
