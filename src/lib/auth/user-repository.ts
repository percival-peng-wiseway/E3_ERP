import "server-only";

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ERP_USERS, normalizeErpUsername } from "@/lib/auth/directory";
import { DUMMY_PASSWORD_VERIFIER, LEGACY_PASSWORD_VERIFIERS, type PasswordVerifier } from "@/lib/auth/legacy-credentials";
import { createScryptPasswordVerifier } from "@/lib/auth/password-crypto";
import { ERP_ASSIGNABLE_ROLES, ERP_ROLES, type ErpRole, type ErpUser, type ManagedErpUser } from "@/lib/auth/types";
import { CloudflareStorageConfigurationError, erpCloudflareBindings, type ErpD1Database } from "@/lib/server/cloudflare-storage";

const MAX_USERS = 500;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const PLACEHOLDER_VERIFIER: PasswordVerifier = {
  salt: "AAAAAAAAAAAAAAAAAAAAAA",
  passwordHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

type StoredErpUser = Omit<ManagedErpUser, "credentialsConfigured"> & PasswordVerifier;

type UserRow = {
  username: string;
  display_name: string;
  role: string;
  password_salt: string;
  password_hash: string;
  active: number;
  session_version: number;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
};

export class ErpUserRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_user") {
    super(message);
    this.name = "ErpUserRepositoryError";
    this.status = status;
    this.code = code;
  }
}

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.ERP_USER_DATA_DIR || path.join(process.cwd(), ".data", "auth"),
);
const usersPath = path.join(/* turbopackIgnore: true */ dataRoot, "users.json");
let mutationQueue: Promise<void> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function cleanDisplayName(value: unknown) {
  if (typeof value !== "string") throw new ErpUserRepositoryError("Enter an employee display name.");
  const displayName = value.trim().replace(/\s+/gu, " ");
  if (!displayName || displayName.length > 80 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new ErpUserRepositoryError("Enter a display name of up to 80 characters.");
  }
  return displayName;
}

function cleanUsername(value: unknown) {
  if (typeof value !== "string") throw new ErpUserRepositoryError("Enter a username.");
  const username = normalizeErpUsername(value);
  if (!USERNAME_PATTERN.test(username)) {
    throw new ErpUserRepositoryError("Use 3–40 lowercase letters, numbers, dots, underscores or hyphens for the username.");
  }
  return username;
}

function cleanRole(value: unknown): ErpRole {
  if (typeof value !== "string" || !ERP_ASSIGNABLE_ROLES.includes(value as (typeof ERP_ASSIGNABLE_ROLES)[number])) {
    throw new ErpUserRepositoryError("Select a valid employee role.");
  }
  return value as ErpRole;
}

function cleanPassword(value: unknown) {
  if (typeof value !== "string" || value.length < 6 || value.length > 200
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ErpUserRepositoryError("Use a temporary password between 6 and 200 characters.");
  }
  return value;
}

function cleanActor(value: string) {
  const actor = normalizeErpUsername(value);
  if (!USERNAME_PATTERN.test(actor)) throw new ErpUserRepositoryError("The administrator identity is invalid.", 403, "forbidden");
  return actor;
}

function hasConfiguredCredentials(user: PasswordVerifier) {
  return user.salt !== PLACEHOLDER_VERIFIER.salt || user.passwordHash !== PLACEHOLDER_VERIFIER.passwordHash;
}

function publicUser(user: StoredErpUser): ManagedErpUser {
  const { salt: _salt, passwordHash: _passwordHash, ...safe } = user;
  return { ...safe, credentialsConfigured: hasConfiguredCredentials(user) };
}

function storedUser(value: unknown): StoredErpUser | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<StoredErpUser>;
  if (typeof row.username !== "string" || !USERNAME_PATTERN.test(row.username)
    || typeof row.displayName !== "string" || !row.displayName || row.displayName.length > 80
    || typeof row.role !== "string" || !ERP_ROLES.includes(row.role as ErpRole)
    || typeof row.salt !== "string" || !row.salt
    || typeof row.passwordHash !== "string" || !row.passwordHash
    || typeof row.active !== "boolean"
    || !Number.isSafeInteger(row.sessionVersion) || (row.sessionVersion || 0) < 1
    || !Number.isSafeInteger(row.version) || (row.version || 0) < 1
    || typeof row.createdAt !== "string" || typeof row.createdBy !== "string"
    || typeof row.updatedAt !== "string" || typeof row.updatedBy !== "string") return null;
  return row as StoredErpUser;
}

function rowUser(row: UserRow): StoredErpUser {
  const value: StoredErpUser = {
    username: row.username,
    displayName: row.display_name,
    role: row.role as ErpRole,
    salt: row.password_salt,
    passwordHash: row.password_hash,
    active: row.active === 1,
    sessionVersion: row.session_version,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
  const parsed = storedUser(value);
  if (!parsed) throw new CloudflareStorageConfigurationError("The ERP user directory returned an invalid account.");
  return parsed;
}

function initialUsers(): StoredErpUser[] {
  const timestamp = "2026-08-25T00:00:00.000Z";
  return ERP_USERS.map((user) => {
    const verifier = LEGACY_PASSWORD_VERIFIERS[user.username] || PLACEHOLDER_VERIFIER;
    return {
      ...user,
      ...verifier,
      active: Boolean(LEGACY_PASSWORD_VERIFIERS[user.username]),
      sessionVersion: 1,
      version: 1,
      createdAt: timestamp,
      createdBy: "system",
      updatedAt: timestamp,
      updatedBy: "system",
    };
  });
}

async function ensureLocalStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
}

async function readLocalUsers(): Promise<StoredErpUser[]> {
  await ensureLocalStorage();
  try {
    const parsed: unknown = JSON.parse(await readFile(/* turbopackIgnore: true */ usersPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("ERP user data is not an array.");
    const users = parsed.map(storedUser);
    if (users.some((user) => !user)) throw new Error("ERP user data is invalid.");
    await chmod(usersPath, 0o600);
    return users as StoredErpUser[];
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    const users = initialUsers();
    await writeLocalUsers(users);
    return users;
  }
}

async function writeLocalUsers(users: StoredErpUser[]) {
  await ensureLocalStorage();
  const temporaryPath = `${usersPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(users, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, usersPath);
  await chmod(usersPath, 0o600);
}

async function database() {
  const bindings = await erpCloudflareBindings();
  if (!bindings) return null;
  if (!bindings.database) throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
  return bindings.database;
}

async function databaseUser(db: ErpD1Database, username: string) {
  const row = await db.prepare(`SELECT username, display_name, role, password_salt, password_hash,
    active, session_version, version, created_at, created_by, updated_at, updated_by
    FROM erp_users WHERE username = ?1`).bind(username).first<UserRow>();
  return row ? rowUser(row) : null;
}

export async function listManagedErpUsers(): Promise<ManagedErpUser[]> {
  const db = await database();
  const users = db
    ? (() => db.prepare(`SELECT username, display_name, role, password_salt, password_hash,
        active, session_version, version, created_at, created_by, updated_at, updated_by
        FROM erp_users ORDER BY active DESC, display_name COLLATE NOCASE, username`).all<UserRow>())()
    : null;
  const stored = users
    ? await users.then((result) => {
      if (!result.success) throw new CloudflareStorageConfigurationError(result.error || "The ERP user directory could not be read.");
      return (result.results || []).map(rowUser);
    })
    : await readLocalUsers();
  return stored.map(publicUser);
}

export async function findErpUserAccount(usernameValue: string): Promise<StoredErpUser | null> {
  const username = normalizeErpUsername(usernameValue);
  if (!USERNAME_PATTERN.test(username)) return null;
  const db = await database();
  if (db) return databaseUser(db, username);
  return (await readLocalUsers()).find((user) => user.username === username) || null;
}

export async function createManagedErpUser(input: {
  username: unknown;
  displayName: unknown;
  role: unknown;
  password: unknown;
  active?: unknown;
}, actorValue: string): Promise<ManagedErpUser> {
  const username = cleanUsername(input.username);
  const displayName = cleanDisplayName(input.displayName);
  const role = cleanRole(input.role);
  const password = cleanPassword(input.password);
  const active = input.active === undefined ? true : input.active;
  if (typeof active !== "boolean") throw new ErpUserRepositoryError("Select a valid account status.");
  const actor = cleanActor(actorValue);
  const verifier = await createScryptPasswordVerifier(password);
  const timestamp = new Date().toISOString();
  const user: StoredErpUser = {
    username, displayName, role, ...verifier, active,
    sessionVersion: 1, version: 1,
    createdAt: timestamp, createdBy: actor, updatedAt: timestamp, updatedBy: actor,
  };

  return withMutation(async () => {
    const db = await database();
    if (db) {
      const count = await db.prepare("SELECT COUNT(*) AS count FROM erp_users").first<{ count: number }>();
      if ((count?.count || 0) >= MAX_USERS) throw new ErpUserRepositoryError("The employee directory has reached its account limit.", 409, "user_limit");
      const result = await db.prepare(`INSERT OR IGNORE INTO erp_users
        (username, display_name, role, password_salt, password_hash, active, session_version, version, created_at, created_by, updated_at, updated_by)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?8, ?7, ?8)`)
        .bind(username, displayName, role, verifier.salt, verifier.passwordHash, active ? 1 : 0, timestamp, actor).run();
      if (!result.success) throw new CloudflareStorageConfigurationError(result.error || "The employee account could not be created.");
      if (result.meta?.changes !== 1) throw new ErpUserRepositoryError("That username already exists.", 409, "username_exists");
      return publicUser(user);
    }

    const users = await readLocalUsers();
    if (users.length >= MAX_USERS) throw new ErpUserRepositoryError("The employee directory has reached its account limit.", 409, "user_limit");
    if (users.some((candidate) => candidate.username === username)) {
      throw new ErpUserRepositoryError("That username already exists.", 409, "username_exists");
    }
    users.push(user);
    await writeLocalUsers(users);
    return publicUser(user);
  });
}

export async function updateManagedErpUser(usernameValue: string, input: {
  expectedVersion: unknown;
  displayName?: unknown;
  role?: unknown;
  active?: unknown;
  password?: unknown;
}, actorValue: string): Promise<ManagedErpUser> {
  const username = cleanUsername(usernameValue);
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new ErpUserRepositoryError("Refresh the employee directory and try again.", 409, "version_required");
  }
  const actor = cleanActor(actorValue);

  return withMutation(async () => {
    const current = await findErpUserAccount(username);
    if (!current) throw new ErpUserRepositoryError("The employee account was not found.", 404, "user_not_found");
    if (current.version !== input.expectedVersion) {
      throw new ErpUserRepositoryError("This employee account changed in another session. Refresh and try again.", 409, "user_conflict");
    }
    const displayName = input.displayName === undefined ? current.displayName : cleanDisplayName(input.displayName);
    const role = input.role === undefined ? current.role : cleanRole(input.role);
    const active = input.active === undefined ? current.active : input.active;
    if (typeof active !== "boolean") throw new ErpUserRepositoryError("Select a valid account status.");
    const verifier = input.password === undefined ? null : await createScryptPasswordVerifier(cleanPassword(input.password));
    if (active && !verifier && !hasConfiguredCredentials(current)) {
      throw new ErpUserRepositoryError(
        "Set a temporary password before activating this employee account.",
        409,
        "password_required",
      );
    }
    const removesActiveAdmin = current.active && current.role === "admin" && (!active || role !== "admin");
    const timestamp = new Date().toISOString();
    const next: StoredErpUser = {
      ...current,
      displayName,
      role,
      active,
      ...(verifier || {}),
      sessionVersion: current.sessionVersion + 1,
      version: current.version + 1,
      updatedAt: timestamp,
      updatedBy: actor,
    };

    const db = await database();
    if (db) {
      const result = await db.prepare(`UPDATE erp_users SET
        display_name = ?1, role = ?2, active = ?3,
        password_salt = COALESCE(?4, password_salt), password_hash = COALESCE(?5, password_hash),
        session_version = session_version + 1, version = version + 1, updated_at = ?6, updated_by = ?7
        WHERE username = ?8 AND version = ?9
          AND NOT (role = 'admin' AND active = 1 AND (?2 != 'admin' OR ?3 = 0)
            AND (SELECT COUNT(*) FROM erp_users WHERE role = 'admin' AND active = 1) <= 1)`)
        .bind(displayName, role, active ? 1 : 0, verifier?.salt || null, verifier?.passwordHash || null,
          timestamp, actor, username, current.version).run();
      if (!result.success) throw new CloudflareStorageConfigurationError(result.error || "The employee account could not be updated.");
      if (result.meta?.changes !== 1) {
        const latest = await databaseUser(db, username);
        if (!latest) throw new ErpUserRepositoryError("The employee account was not found.", 404, "user_not_found");
        if (latest.version !== current.version) throw new ErpUserRepositoryError("This employee account changed in another session. Refresh and try again.", 409, "user_conflict");
        throw new ErpUserRepositoryError("The final active Administrator cannot be deactivated or assigned another role.", 409, "last_admin");
      }
      return publicUser(next);
    }

    const users = await readLocalUsers();
    const index = users.findIndex((candidate) => candidate.username === username);
    if (index < 0 || users[index].version !== current.version) {
      throw new ErpUserRepositoryError("This employee account changed in another session. Refresh and try again.", 409, "user_conflict");
    }
    if (removesActiveAdmin && users.filter((candidate) => candidate.active && candidate.role === "admin").length <= 1) {
      throw new ErpUserRepositoryError("The final active Administrator cannot be deactivated or assigned another role.", 409, "last_admin");
    }
    users[index] = next;
    await writeLocalUsers(users);
    return publicUser(next);
  });
}

export { DUMMY_PASSWORD_VERIFIER };
