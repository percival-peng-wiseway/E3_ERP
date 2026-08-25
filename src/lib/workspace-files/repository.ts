import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { findErpUser } from "../auth/directory.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { ERP_ROLES } from "../auth/types.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as cloudflareStorage from "../server/cloudflare-storage.ts";
import type {
  WorkspaceFileActor,
  WorkspaceFileBreadcrumb,
  WorkspaceFileCapabilities,
  WorkspaceFileContent,
  WorkspaceFileFolderOption,
  WorkspaceFileItem,
  WorkspaceFilesListing,
  WorkspaceFilesView,
  WorkspaceFileUpload,
} from "./types";

const {
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
} = cloudflareStorage;
import type { ErpD1Database } from "../server/cloudflare-storage";

export const WORKSPACE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_FILE_MAX_DEPTH = 20;
export const WORKSPACE_FILE_MAX_ITEMS = 5_000;
export const WORKSPACE_FILE_WORKSPACE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const WORKSPACE_FILE_OWNER_LIMIT_BYTES = 250 * 1024 * 1024;

const WORKSPACE_ID = "company" as const;
const MAX_LIST_RESULTS = 500;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9._-]{1,64}$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STORAGE_KEY_PATTERN = /^workspace-files\/company\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_NAME = /[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

type StoredWorkspaceFile = {
  id: string;
  workspaceId: typeof WORKSPACE_ID;
  parentId: string | null;
  kind: "file" | "folder";
  name: string;
  nameKey: string;
  ownerUsername: string;
  contentType: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  storageKey: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  trashedAt: string | null;
  trashedBy: string | null;
  trashRootId: string | null;
};

type D1WorkspaceFileRow = {
  id: unknown;
  workspace_id: unknown;
  parent_id: unknown;
  parent_key: unknown;
  kind: unknown;
  name: unknown;
  name_key: unknown;
  owner_username: unknown;
  content_type: unknown;
  size_bytes: unknown;
  checksum: unknown;
  storage_key: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
  updated_by: unknown;
  trashed_at: unknown;
  trashed_by: unknown;
  trash_root_id: unknown;
};

type StoreSnapshot = {
  items: StoredWorkspaceFile[];
  database: ErpD1Database | null;
};

export class WorkspaceFilesRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "WorkspaceFilesRepositoryError";
    this.status = status;
    this.code = code;
  }
}

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.WORKSPACE_FILES_DATA_DIR || path.join(process.cwd(), ".data", "workspace-files"),
);
const recordsPath = path.join(/* turbopackIgnore: true */ dataRoot, "records.json");
const objectsPath = path.join(/* turbopackIgnore: true */ dataRoot, "objects");
let mutationQueue: Promise<void> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function isFileSystemError(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function normalizedUsername(value: unknown) {
  if (typeof value !== "string") return null;
  const username = value.trim().toLocaleLowerCase("en-AU");
  return USERNAME_PATTERN.test(username) ? username : null;
}

function assertActor(actor: WorkspaceFileActor) {
  const username = normalizedUsername(actor?.username);
  if (!username || !ERP_ROLES.includes(actor?.role)) {
    throw new WorkspaceFilesRepositoryError("A valid ERP user is required.", 403, "actor_required");
  }
  return { ...actor, username };
}

function workspaceFileName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").trim();
  if (!name || name === "." || name === ".." || name.length > 180
    || new TextEncoder().encode(name).byteLength > 255 || UNSAFE_NAME.test(name)) return null;
  return name;
}

function workspaceFileNameKey(name: string) {
  return name.normalize("NFKC").toLocaleLowerCase("en-AU");
}

function validContentType(value: unknown) {
  if (typeof value !== "string") return false;
  return value.length >= 3
    && value.length <= 160
    && /^[\x21-\x7e]+$/.test(value)
    && value.includes("/")
    && !value.includes("\"")
    && !value.includes("\\");
}

function optionalString(value: unknown) {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function normalizeStoredItem(value: unknown): StoredWorkspaceFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceFilesRepositoryError("Files metadata is invalid.", 500, "invalid_storage");
  }
  const source = value as Record<string, unknown>;
  const parentId = optionalString(source.parentId);
  const contentType = optionalString(source.contentType);
  const checksum = optionalString(source.checksum);
  const storageKey = optionalString(source.storageKey);
  const trashedAt = optionalString(source.trashedAt);
  const trashedBy = optionalString(source.trashedBy);
  const trashRootId = optionalString(source.trashRootId);
  const ownerUsername = normalizedUsername(source.ownerUsername);
  const updatedBy = normalizedUsername(source.updatedBy);
  const name = workspaceFileName(source.name);
  const kind = source.kind === "file" || source.kind === "folder" ? source.kind : null;
  const trashIsPaired = trashedAt === null && trashedBy === null && trashRootId === null
    || typeof trashedAt === "string" && typeof trashedBy === "string" && typeof trashRootId === "string";
  const fileFieldsAreValid = kind === "file"
    ? validContentType(contentType)
      && Number.isSafeInteger(source.sizeBytes)
      && (source.sizeBytes as number) >= 1
      && (source.sizeBytes as number) <= WORKSPACE_FILE_MAX_BYTES
      && typeof checksum === "string" && CHECKSUM_PATTERN.test(checksum)
      && typeof storageKey === "string" && STORAGE_KEY_PATTERN.test(storageKey)
    : kind === "folder" && contentType === null && source.sizeBytes === null && checksum === null && storageKey === null;

  if (source.workspaceId !== WORKSPACE_ID
    || typeof source.id !== "string" || !ID_PATTERN.test(source.id)
    || (parentId !== null && (typeof parentId !== "string" || !ID_PATTERN.test(parentId)))
    || !kind || !name || source.nameKey !== workspaceFileNameKey(name)
    || !ownerUsername || !updatedBy || !fileFieldsAreValid
    || !Number.isSafeInteger(source.version) || (source.version as number) < 1
    || typeof source.createdAt !== "string" || !EXACT_TIMESTAMP.test(source.createdAt)
    || typeof source.updatedAt !== "string" || !EXACT_TIMESTAMP.test(source.updatedAt)
    || !trashIsPaired
    || (typeof trashedAt === "string" && !EXACT_TIMESTAMP.test(trashedAt))
    || (typeof trashedBy === "string" && !normalizedUsername(trashedBy))
    || (typeof trashRootId === "string" && !ID_PATTERN.test(trashRootId))) {
    throw new WorkspaceFilesRepositoryError("Files metadata is invalid.", 500, "invalid_storage");
  }

  return {
    id: source.id,
    workspaceId: WORKSPACE_ID,
    parentId,
    kind,
    name,
    nameKey: source.nameKey,
    ownerUsername,
    contentType: contentType as string | null,
    sizeBytes: kind === "file" ? source.sizeBytes as number : null,
    checksum: checksum as string | null,
    storageKey: storageKey as string | null,
    version: source.version as number,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    updatedBy,
    trashedAt,
    trashedBy,
    trashRootId,
  };
}

function normalizeStoredItems(values: unknown[]) {
  const items = values.map(normalizeStoredItem);
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length || items.length > WORKSPACE_FILE_MAX_ITEMS) {
    throw new WorkspaceFilesRepositoryError("Files metadata is invalid.", 500, "invalid_storage");
  }
  const activeNames = new Set<string>();
  const storageKeys = new Set<string>();
  for (const item of items) {
    if (item.trashedAt === null) {
      const siblingKey = `${item.parentId || ""}\u0000${item.nameKey}`;
      if (activeNames.has(siblingKey)) {
        throw new WorkspaceFilesRepositoryError("Files metadata contains duplicate names.", 500, "invalid_storage");
      }
      activeNames.add(siblingKey);
    }
    if (item.storageKey) {
      if (storageKeys.has(item.storageKey)) {
        throw new WorkspaceFilesRepositoryError("Files metadata contains duplicate storage keys.", 500, "invalid_storage");
      }
      storageKeys.add(item.storageKey);
    }
    if (item.parentId) {
      const parent = byId.get(item.parentId);
      if (!parent || parent.kind !== "folder" || parent.workspaceId !== item.workspaceId) {
        throw new WorkspaceFilesRepositoryError("Files metadata has an invalid parent.", 500, "invalid_storage");
      }
      if (parent.trashedAt && !item.trashedAt) {
        throw new WorkspaceFilesRepositoryError("Files trash metadata is invalid.", 500, "invalid_storage");
      }
    }
    if (item.trashRootId) {
      const root = byId.get(item.trashRootId);
      if (!root || root.trashRootId !== root.id || !root.trashedAt) {
        throw new WorkspaceFilesRepositoryError("Files trash metadata is invalid.", 500, "invalid_storage");
      }
    }
    let cursor: StoredWorkspaceFile | undefined = item;
    const seen = new Set<string>();
    let depth = 0;
    while (cursor?.parentId) {
      if (seen.has(cursor.id)) {
        throw new WorkspaceFilesRepositoryError("Files folder metadata is invalid.", 500, "invalid_storage");
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      depth += 1;
      if (depth >= WORKSPACE_FILE_MAX_DEPTH) {
        throw new WorkspaceFilesRepositoryError("Files folder metadata is invalid.", 500, "invalid_storage");
      }
    }
  }
  return items;
}

function itemFromD1Row(row: D1WorkspaceFileRow) {
  if (row.parent_key !== (row.parent_id ?? "")) {
    throw new WorkspaceFilesRepositoryError("Files metadata is invalid.", 500, "invalid_storage");
  }
  return normalizeStoredItem({
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    nameKey: row.name_key,
    ownerUsername: row.owner_username,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    storageKey: row.storage_key,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    trashedAt: row.trashed_at,
    trashedBy: row.trashed_by,
    trashRootId: row.trash_root_id,
  });
}

async function ensureLocalStorage() {
  await mkdir(objectsPath, { recursive: true, mode: 0o700 });
}

async function readStore(): Promise<StoreSnapshot> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    const result = await bindings.database
      .prepare(`SELECT id, workspace_id, parent_id, parent_key, kind, name, name_key,
        owner_username, content_type, size_bytes, checksum, storage_key, version,
        created_at, updated_at, updated_by, trashed_at, trashed_by, trash_root_id
        FROM erp_workspace_files WHERE workspace_id = ?1`)
      .bind(WORKSPACE_ID)
      .all<D1WorkspaceFileRow>();
    if (!result.success || !Array.isArray(result.results)) {
      throw new CloudflareStorageConfigurationError(result.error || "The ERP database read failed.");
    }
    return { items: normalizeStoredItems(result.results.map(itemFromD1Row)), database: bindings.database };
  }

  await ensureLocalStorage();
  try {
    const parsed: unknown = JSON.parse(await readFile(/* turbopackIgnore: true */ recordsPath, "utf8"));
    if (!Array.isArray(parsed)) throw new WorkspaceFilesRepositoryError("Files metadata is invalid.", 500, "invalid_storage");
    return { items: normalizeStoredItems(parsed), database: null };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { items: [], database: null };
    throw error;
  }
}

async function writeLocalItems(items: StoredWorkspaceFile[]) {
  await ensureLocalStorage();
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.records-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, recordsPath);
}

function databaseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/unique constraint/i.test(message)) {
    return new WorkspaceFilesRepositoryError("An item with this name already exists in that folder.", 409, "name_conflict");
  }
  if (/foreign key constraint/i.test(message)) {
    return new WorkspaceFilesRepositoryError("The destination folder changed. Refresh and try again.", 409, "parent_changed");
  }
  return new CloudflareStorageConfigurationError("The Files database write failed.");
}

function d1RunSucceeded(result: { success: boolean; error?: string; meta?: { changes?: number } }) {
  if (!result.success) throw databaseError(new Error(result.error || "D1 write failed"));
  return result.meta?.changes ?? 0;
}

function storageObjectPath(storageKey: string) {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new WorkspaceFilesRepositoryError("The stored file reference is invalid.", 500, "invalid_storage_key");
  }
  const filename = storageKey.slice(storageKey.lastIndexOf("/") + 1);
  const target = path.resolve(/* turbopackIgnore: true */ objectsPath, filename);
  const relative = path.relative(objectsPath, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceFilesRepositoryError("The stored file reference is invalid.", 500, "invalid_storage_key");
  }
  return target;
}

async function writeStoredObject(storageKey: string, bytes: Uint8Array) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    await bindings.files.put(storageKey, bytes);
    return;
  }
  await ensureLocalStorage();
  await writeFile(storageObjectPath(storageKey), bytes, { flag: "wx", mode: 0o600 });
}

async function deleteStoredObject(storageKey: string) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    await bindings.files.delete(storageKey);
    return;
  }
  await unlink(storageObjectPath(storageKey));
}

function verifyStoredObject(bytes: Uint8Array, expectedSize: number, expectedChecksum: string) {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== expectedSize || checksum !== expectedChecksum) {
    throw new WorkspaceFilesRepositoryError(
      "The stored file failed its integrity check.",
      500,
      "file_corrupt",
    );
  }
  return bytes;
}

async function readStoredObject(storageKey: string, expectedSize: number, expectedChecksum: string) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    const buffer = await bindings.files.get(storageKey, "arrayBuffer");
    if (!buffer) {
      throw new WorkspaceFilesRepositoryError(
        "The file is still syncing. Try again shortly.",
        503,
        "file_not_ready",
      );
    }
    return verifyStoredObject(new Uint8Array(buffer), expectedSize, expectedChecksum);
  }
  try {
    const source = await readFile(storageObjectPath(storageKey));
    return verifyStoredObject(
      new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
      expectedSize,
      expectedChecksum,
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new WorkspaceFilesRepositoryError("The file is not available yet.", 503, "file_not_ready");
    }
    throw error;
  }
}

function byId(items: StoredWorkspaceFile[]) {
  return new Map(items.map((item) => [item.id, item]));
}

function childrenByParent(items: StoredWorkspaceFile[]) {
  const children = new Map<string, StoredWorkspaceFile[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const siblings = children.get(item.parentId) || [];
    siblings.push(item);
    children.set(item.parentId, siblings);
  }
  return children;
}

function subtree(items: StoredWorkspaceFile[], root: StoredWorkspaceFile) {
  const children = childrenByParent(items);
  const result: StoredWorkspaceFile[] = [];
  const queue = [root];
  const seen = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    if (seen.has(item.id)) throw new WorkspaceFilesRepositoryError("The folder tree is invalid.", 500, "invalid_storage");
    seen.add(item.id);
    result.push(item);
    queue.push(...(children.get(item.id) || []));
  }
  return result;
}

function subtreeOwnedBy(items: StoredWorkspaceFile[], item: StoredWorkspaceFile, username: string) {
  return subtree(items, item).every((candidate) => candidate.ownerUsername === username);
}

function capabilitiesFor(items: StoredWorkspaceFile[], item: StoredWorkspaceFile, actor: WorkspaceFileActor): WorkspaceFileCapabilities {
  const admin = actor.role === "admin";
  const trashRoot = item.trashedAt !== null && item.trashRootId === item.id;
  const manages = admin || item.ownerUsername === actor.username
    && (item.kind === "file" || subtreeOwnedBy(items, item, actor.username));
  return {
    rename: manages && item.trashedAt === null,
    move: manages && item.trashedAt === null,
    trash: manages && item.trashedAt === null,
    restore: manages && trashRoot,
    purge: admin && trashRoot,
  };
}

function publicItem(items: StoredWorkspaceFile[], item: StoredWorkspaceFile, actor: WorkspaceFileActor): WorkspaceFileItem {
  return {
    id: item.id,
    workspaceId: WORKSPACE_ID,
    parentId: item.parentId,
    kind: item.kind,
    name: item.name,
    ownerUsername: item.ownerUsername,
    ownerDisplayName: findErpUser(item.ownerUsername)?.displayName || item.ownerUsername,
    contentType: item.contentType,
    size: item.sizeBytes,
    checksum: item.checksum,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    trashedAt: item.trashedAt,
    trashedBy: item.trashedBy,
    version: item.version,
    capabilities: capabilitiesFor(items, item, actor),
  };
}

function breadcrumbsFor(
  items: StoredWorkspaceFile[],
  folder: StoredWorkspaceFile | null,
  index = byId(items),
) {
  if (!folder) return [];
  const breadcrumbs: WorkspaceFileBreadcrumb[] = [];
  let cursor: StoredWorkspaceFile | undefined = folder;
  while (cursor) {
    breadcrumbs.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parentId ? index.get(cursor.parentId) : undefined;
  }
  return breadcrumbs;
}

function folderOptions(items: StoredWorkspaceFile[]): WorkspaceFileFolderOption[] {
  const index = byId(items);
  return items
    .filter((item) => item.kind === "folder" && item.trashedAt === null)
    .map((item) => ({
      id: item.id,
      name: item.name,
      parentId: item.parentId,
      path: ["Root", ...breadcrumbsFor(items, item, index).map(({ name }) => name)].join(" / "),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en-AU", { sensitivity: "base" }));
}

function itemSort(left: StoredWorkspaceFile, right: StoredWorkspaceFile) {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  return left.name.localeCompare(right.name, "en-AU", { sensitivity: "base", numeric: true })
    || left.id.localeCompare(right.id);
}

function findFolder(items: StoredWorkspaceFile[], parentId: string | null) {
  if (parentId === null) return null;
  if (!ID_PATTERN.test(parentId)) {
    throw new WorkspaceFilesRepositoryError("The folder ID is invalid.", 400, "invalid_parent_id");
  }
  const folder = items.find((item) => item.id === parentId);
  if (!folder || folder.kind !== "folder" || folder.trashedAt) {
    throw new WorkspaceFilesRepositoryError("The destination folder was not found.", 404, "folder_not_found");
  }
  return folder;
}

function itemDepth(items: StoredWorkspaceFile[], item: StoredWorkspaceFile | null) {
  if (!item) return 0;
  const index = byId(items);
  let depth = 1;
  let cursor = item;
  while (cursor.parentId) {
    const parent = index.get(cursor.parentId);
    if (!parent) throw new WorkspaceFilesRepositoryError("The folder tree is invalid.", 500, "invalid_storage");
    depth += 1;
    cursor = parent;
  }
  return depth;
}

function relativeSubtreeDepth(items: StoredWorkspaceFile[], root: StoredWorkspaceFile) {
  const children = childrenByParent(items);
  let maximum = 1;
  const queue: Array<{ item: StoredWorkspaceFile; depth: number }> = [{ item: root, depth: 1 }];
  while (queue.length) {
    const current = queue.shift()!;
    maximum = Math.max(maximum, current.depth);
    for (const child of children.get(current.item.id) || []) queue.push({ item: child, depth: current.depth + 1 });
  }
  return maximum;
}

function assertExpectedVersion(item: StoredWorkspaceFile, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new WorkspaceFilesRepositoryError("The expected version is invalid.", 400, "invalid_version");
  }
  if (item.version !== expectedVersion) {
    throw new WorkspaceFilesRepositoryError("This item changed. Refresh and try again.", 409, "version_conflict");
  }
}

function requireItem(items: StoredWorkspaceFile[], id: string) {
  if (!ID_PATTERN.test(id)) throw new WorkspaceFilesRepositoryError("The item ID is invalid.", 400, "invalid_id");
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new WorkspaceFilesRepositoryError("The item was not found.", 404, "not_found");
  return item;
}

function assertCanManage(items: StoredWorkspaceFile[], item: StoredWorkspaceFile, actor: WorkspaceFileActor) {
  const capabilities = capabilitiesFor(items, item, actor);
  if (item.trashedAt ? !capabilities.restore : !capabilities.rename) {
    throw new WorkspaceFilesRepositoryError(
      item.kind === "folder" && item.ownerUsername === actor.username
        ? "Only an Administrator can change a folder containing another user's items."
        : "You can only manage items that you own.",
      403,
      "forbidden",
    );
  }
}

function assertNameAvailable(items: StoredWorkspaceFile[], parentId: string | null, nameKey: string, exceptId?: string) {
  if (items.some((item) => item.id !== exceptId
    && item.parentId === parentId && item.trashedAt === null && item.nameKey === nameKey)) {
    throw new WorkspaceFilesRepositoryError("An item with this name already exists in that folder.", 409, "name_conflict");
  }
}

function usage(items: StoredWorkspaceFile[], username: string) {
  let usedBytes = 0;
  let ownerUsedBytes = 0;
  for (const item of items) {
    if (item.kind !== "file") continue;
    usedBytes += item.sizeBytes || 0;
    if (item.ownerUsername === username) ownerUsedBytes += item.sizeBytes || 0;
  }
  return {
    usedBytes,
    workspaceLimitBytes: WORKSPACE_FILE_WORKSPACE_LIMIT_BYTES,
    ownerUsedBytes,
    ownerLimitBytes: WORKSPACE_FILE_OWNER_LIMIT_BYTES,
  };
}

function assertCapacity(items: StoredWorkspaceFile[], ownerUsername: string, additionalBytes: number) {
  if (items.length >= WORKSPACE_FILE_MAX_ITEMS) {
    throw new WorkspaceFilesRepositoryError("The company Files workspace has reached its 5,000 item limit.", 409, "item_limit_reached");
  }
  if (additionalBytes === 0) return;
  const current = usage(items, ownerUsername);
  if (current.usedBytes + additionalBytes > WORKSPACE_FILE_WORKSPACE_LIMIT_BYTES) {
    throw new WorkspaceFilesRepositoryError("The company Files workspace has reached its 1 GB limit.", 409, "workspace_quota_exceeded");
  }
  if (current.ownerUsedBytes + additionalBytes > WORKSPACE_FILE_OWNER_LIMIT_BYTES) {
    throw new WorkspaceFilesRepositoryError("Your Files storage has reached its 250 MB limit.", 409, "owner_quota_exceeded");
  }
}

async function insertD1Item(database: ErpD1Database, item: StoredWorkspaceFile) {
  try {
    const result = await database.prepare(`INSERT INTO erp_workspace_files (
      id, workspace_id, parent_id, parent_key, kind, name, name_key, owner_username,
      content_type, size_bytes, checksum, storage_key, version, created_at, updated_at,
      updated_by, trashed_at, trashed_by, trash_root_id
    ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL, NULL, NULL
    WHERE (SELECT COUNT(*) FROM erp_workspace_files WHERE workspace_id = ?2) < ?17
      AND (?3 IS NULL OR EXISTS (
        SELECT 1 FROM erp_workspace_files
        WHERE id = ?3 AND workspace_id = ?2 AND kind = 'folder' AND trashed_at IS NULL
      ))
      AND (?3 IS NULL OR COALESCE((
        WITH RECURSIVE ancestors(id, parent_id, depth) AS (
          SELECT id, parent_id, 1 FROM erp_workspace_files WHERE id = ?3
          UNION ALL
          SELECT parent.id, parent.parent_id, ancestors.depth + 1
          FROM erp_workspace_files parent JOIN ancestors ON parent.id = ancestors.parent_id
        )
        SELECT MAX(depth) FROM ancestors
      ), ?20) < ?20)
      AND (?5 = 'folder' OR (
        COALESCE((SELECT SUM(size_bytes) FROM erp_workspace_files WHERE workspace_id = ?2 AND kind = 'file'), 0) + ?10 <= ?18
        AND COALESCE((SELECT SUM(size_bytes) FROM erp_workspace_files WHERE workspace_id = ?2 AND kind = 'file' AND owner_username = ?8), 0) + ?10 <= ?19
      ))`)
      .bind(
        item.id, item.workspaceId, item.parentId, item.parentId || "", item.kind, item.name,
        item.nameKey, item.ownerUsername, item.contentType, item.sizeBytes, item.checksum,
        item.storageKey, item.version, item.createdAt, item.updatedAt, item.updatedBy,
        WORKSPACE_FILE_MAX_ITEMS, WORKSPACE_FILE_WORKSPACE_LIMIT_BYTES, WORKSPACE_FILE_OWNER_LIMIT_BYTES,
        WORKSPACE_FILE_MAX_DEPTH,
      )
      .run();
    const changes = d1RunSucceeded(result);
    if (changes !== 1) {
      throw new WorkspaceFilesRepositoryError("The Files workspace changed. Refresh and try again.", 409, "storage_conflict");
    }
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError || error instanceof CloudflareStorageConfigurationError) throw error;
    throw databaseError(error);
  }
}

function newStoredItem(input: {
  actor: WorkspaceFileActor;
  parentId: string | null;
  kind: "file" | "folder";
  name: string;
  contentType?: string;
  sizeBytes?: number;
  checksum?: string;
  storageKey?: string;
}) {
  const timestamp = new Date().toISOString();
  return normalizeStoredItem({
    id: randomUUID(),
    workspaceId: WORKSPACE_ID,
    parentId: input.parentId,
    kind: input.kind,
    name: input.name,
    nameKey: workspaceFileNameKey(input.name),
    ownerUsername: input.actor.username,
    contentType: input.contentType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    checksum: input.checksum ?? null,
    storageKey: input.storageKey ?? null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedBy: input.actor.username,
    trashedAt: null,
    trashedBy: null,
    trashRootId: null,
  });
}

export async function listWorkspaceFiles(input: {
  actor: WorkspaceFileActor;
  parentId?: string | null;
  query?: string;
  view?: WorkspaceFilesView;
}): Promise<WorkspaceFilesListing> {
  const actor = assertActor(input.actor);
  const { items } = await readStore();
  const view = input.view ?? "active";
  if (view !== "active" && view !== "trash") {
    throw new WorkspaceFilesRepositoryError("The Files view is invalid.", 400, "invalid_view");
  }
  const query = typeof input.query === "string" ? input.query.normalize("NFKC").trim() : "";
  if (query.length > 120) throw new WorkspaceFilesRepositoryError("The search is too long.", 400, "invalid_query");

  let currentFolder: StoredWorkspaceFile | null = null;
  let selected: StoredWorkspaceFile[];
  if (view === "trash") {
    if (input.parentId) throw new WorkspaceFilesRepositoryError("Trash does not accept a folder.", 400, "invalid_parent");
    selected = items.filter((item) => item.trashRootId === item.id
      && (actor.role === "admin" || item.ownerUsername === actor.username));
  } else {
    currentFolder = findFolder(items, input.parentId ?? null);
    selected = query
      ? items.filter((item) => item.trashedAt === null && item.nameKey.includes(workspaceFileNameKey(query)))
      : items.filter((item) => item.trashedAt === null && item.parentId === (currentFolder?.id ?? null));
  }
  if (query) selected = selected.filter((item) => item.nameKey.includes(workspaceFileNameKey(query)));

  return {
    items: selected.sort(itemSort).slice(0, MAX_LIST_RESULTS).map((item) => publicItem(items, item, actor)),
    folders: folderOptions(items),
    breadcrumbs: view === "active" ? breadcrumbsFor(items, currentFolder) : [],
    currentFolder: currentFolder ? publicItem(items, currentFolder, actor) : null,
    usage: usage(items, actor.username),
  };
}

export function createWorkspaceFolder(input: {
  actor: WorkspaceFileActor;
  parentId?: string | null;
  name: string;
}): Promise<WorkspaceFileItem> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    const name = workspaceFileName(input.name);
    if (!name) throw new WorkspaceFilesRepositoryError("Enter a valid folder name up to 180 characters.", 400, "invalid_name");
    const snapshot = await readStore();
    const parent = findFolder(snapshot.items, input.parentId ?? null);
    if (itemDepth(snapshot.items, parent) + 1 > WORKSPACE_FILE_MAX_DEPTH) {
      throw new WorkspaceFilesRepositoryError("Folders can be nested up to 20 levels.", 409, "depth_limit_reached");
    }
    assertCapacity(snapshot.items, actor.username, 0);
    assertNameAvailable(snapshot.items, parent?.id ?? null, workspaceFileNameKey(name));
    const item = newStoredItem({ actor, parentId: parent?.id ?? null, kind: "folder", name });
    if (snapshot.database) await insertD1Item(snapshot.database, item);
    else {
      snapshot.items.push(item);
      await writeLocalItems(snapshot.items);
    }
    const currentItems = snapshot.database ? (await readStore()).items : snapshot.items;
    return publicItem(currentItems, currentItems.find(({ id }) => id === item.id) || item, actor);
  });
}

export function uploadWorkspaceFile(input: {
  actor: WorkspaceFileActor;
  parentId?: string | null;
  upload: WorkspaceFileUpload;
}): Promise<WorkspaceFileItem> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    const name = workspaceFileName(input.upload?.originalName);
    const bytes = input.upload?.bytes;
    if (!name || !(bytes instanceof Uint8Array)
      || !Number.isSafeInteger(input.upload?.size)
      || input.upload.size < 1 || input.upload.size > WORKSPACE_FILE_MAX_BYTES
      || bytes.byteLength !== input.upload.size || !validContentType(input.upload.contentType)) {
      throw new WorkspaceFilesRepositoryError("Choose one valid file up to 20 MB.", 400, "invalid_file");
    }
    const snapshot = await readStore();
    const parent = findFolder(snapshot.items, input.parentId ?? null);
    if (itemDepth(snapshot.items, parent) + 1 > WORKSPACE_FILE_MAX_DEPTH) {
      throw new WorkspaceFilesRepositoryError("Files can be stored up to 20 folder levels deep.", 409, "depth_limit_reached");
    }
    assertCapacity(snapshot.items, actor.username, input.upload.size);
    assertNameAvailable(snapshot.items, parent?.id ?? null, workspaceFileNameKey(name));
    const storageKey = `workspace-files/${WORKSPACE_ID}/${randomUUID()}`;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const item = newStoredItem({
      actor,
      parentId: parent?.id ?? null,
      kind: "file",
      name,
      contentType: input.upload.contentType,
      sizeBytes: input.upload.size,
      checksum,
      storageKey,
    });
    await writeStoredObject(storageKey, bytes);
    try {
      if (snapshot.database) await insertD1Item(snapshot.database, item);
      else {
        snapshot.items.push(item);
        await writeLocalItems(snapshot.items);
      }
    } catch (error) {
      await deleteStoredObject(storageKey).catch(() => undefined);
      throw error;
    }
    const currentItems = snapshot.database ? (await readStore()).items : snapshot.items;
    return publicItem(currentItems, currentItems.find(({ id }) => id === item.id) || item, actor);
  });
}

async function persistSingleItem(
  database: ErpD1Database | null,
  items: StoredWorkspaceFile[],
  item: StoredWorkspaceFile,
  expectedVersion: number,
  actor: WorkspaceFileActor,
) {
  if (!database) {
    await writeLocalItems(items);
    return;
  }
  try {
    const result = await database.prepare(`UPDATE erp_workspace_files SET
      parent_id = ?1, parent_key = ?2, name = ?3, name_key = ?4, version = version + 1,
      updated_at = ?5, updated_by = ?6
      WHERE id = ?7 AND workspace_id = ?8 AND version = ?9 AND trashed_at IS NULL
        AND (?1 IS NULL OR EXISTS (
          SELECT 1 FROM erp_workspace_files parent
          WHERE parent.id = ?1 AND parent.workspace_id = ?8 AND parent.kind = 'folder' AND parent.trashed_at IS NULL
        ))
        AND (?1 IS NULL OR NOT EXISTS (
          WITH RECURSIVE descendants(id) AS (
            SELECT id FROM erp_workspace_files WHERE id = ?7
            UNION ALL
            SELECT child.id FROM erp_workspace_files child JOIN descendants parent ON child.parent_id = parent.id
          )
          SELECT 1 FROM descendants WHERE id = ?1
        ))
        AND (?10 = 1 OR ?11 = 'file' OR NOT EXISTS (
          WITH RECURSIVE owned_subtree(id, owner_username) AS (
            SELECT id, owner_username FROM erp_workspace_files WHERE id = ?7
            UNION ALL
            SELECT child.id, child.owner_username FROM erp_workspace_files child
            JOIN owned_subtree parent ON child.parent_id = parent.id
          )
          SELECT 1 FROM owned_subtree WHERE owner_username <> ?12
        ))
        AND (
          CASE WHEN ?1 IS NULL THEN 0 ELSE COALESCE((
            WITH RECURSIVE ancestors(id, parent_id, depth) AS (
              SELECT id, parent_id, 1 FROM erp_workspace_files WHERE id = ?1
              UNION ALL
              SELECT parent.id, parent.parent_id, ancestors.depth + 1
              FROM erp_workspace_files parent JOIN ancestors ON parent.id = ancestors.parent_id
            )
            SELECT MAX(depth) FROM ancestors
          ), 0) END
          + COALESCE((
            WITH RECURSIVE descendants_depth(id, depth) AS (
              SELECT id, 1 FROM erp_workspace_files WHERE id = ?7
              UNION ALL
              SELECT child.id, descendants_depth.depth + 1 FROM erp_workspace_files child
              JOIN descendants_depth ON child.parent_id = descendants_depth.id
            )
            SELECT MAX(depth) FROM descendants_depth
          ), 1)
          <= ?13
        )`)
      .bind(item.parentId, item.parentId || "", item.name, item.nameKey, item.updatedAt, item.updatedBy,
        item.id, WORKSPACE_ID, expectedVersion, actor.role === "admin" ? 1 : 0, item.kind, actor.username,
        WORKSPACE_FILE_MAX_DEPTH)
      .run();
    if (d1RunSucceeded(result) !== 1) {
      throw new WorkspaceFilesRepositoryError("This item changed. Refresh and try again.", 409, "version_conflict");
    }
  } catch (error) {
    if (error instanceof WorkspaceFilesRepositoryError || error instanceof CloudflareStorageConfigurationError) throw error;
    throw databaseError(error);
  }
}

export function renameWorkspaceItem(input: {
  actor: WorkspaceFileActor;
  id: string;
  name: string;
  expectedVersion: number;
}): Promise<WorkspaceFileItem> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    const name = workspaceFileName(input.name);
    if (!name) throw new WorkspaceFilesRepositoryError("Enter a valid name up to 180 characters.", 400, "invalid_name");
    const snapshot = await readStore();
    const item = requireItem(snapshot.items, input.id);
    if (item.trashedAt) throw new WorkspaceFilesRepositoryError("Restore this item before renaming it.", 409, "item_trashed");
    assertExpectedVersion(item, input.expectedVersion);
    assertCanManage(snapshot.items, item, actor);
    assertNameAvailable(snapshot.items, item.parentId, workspaceFileNameKey(name), item.id);
    item.name = name;
    item.nameKey = workspaceFileNameKey(name);
    item.updatedAt = new Date().toISOString();
    item.updatedBy = actor.username;
    item.version += 1;
    await persistSingleItem(snapshot.database, snapshot.items, item, input.expectedVersion, actor);
    const currentItems = snapshot.database ? (await readStore()).items : snapshot.items;
    return publicItem(currentItems, currentItems.find(({ id }) => id === item.id) || item, actor);
  });
}

export function moveWorkspaceItem(input: {
  actor: WorkspaceFileActor;
  id: string;
  parentId?: string | null;
  expectedVersion: number;
}): Promise<WorkspaceFileItem> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    const snapshot = await readStore();
    const item = requireItem(snapshot.items, input.id);
    if (item.trashedAt) throw new WorkspaceFilesRepositoryError("Restore this item before moving it.", 409, "item_trashed");
    assertExpectedVersion(item, input.expectedVersion);
    assertCanManage(snapshot.items, item, actor);
    const parent = findFolder(snapshot.items, input.parentId ?? null);
    if (parent?.id === item.id || (parent && subtree(snapshot.items, item).some(({ id }) => id === parent.id))) {
      throw new WorkspaceFilesRepositoryError("A folder cannot be moved into itself or one of its subfolders.", 409, "folder_cycle");
    }
    const resultingDepth = itemDepth(snapshot.items, parent) + relativeSubtreeDepth(snapshot.items, item);
    if (resultingDepth > WORKSPACE_FILE_MAX_DEPTH) {
      throw new WorkspaceFilesRepositoryError("This move would exceed the 20-level folder limit.", 409, "depth_limit_reached");
    }
    const nextParentId = parent?.id ?? null;
    assertNameAvailable(snapshot.items, nextParentId, item.nameKey, item.id);
    item.parentId = nextParentId;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = actor.username;
    item.version += 1;
    await persistSingleItem(snapshot.database, snapshot.items, item, input.expectedVersion, actor);
    const currentItems = snapshot.database ? (await readStore()).items : snapshot.items;
    return publicItem(currentItems, currentItems.find(({ id }) => id === item.id) || item, actor);
  });
}

export function trashWorkspaceItem(input: {
  actor: WorkspaceFileActor;
  id: string;
  expectedVersion: number;
}): Promise<WorkspaceFileItem> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    const snapshot = await readStore();
    const item = requireItem(snapshot.items, input.id);
    if (item.trashedAt) throw new WorkspaceFilesRepositoryError("This item is already in Trash.", 409, "already_trashed");
    assertExpectedVersion(item, input.expectedVersion);
    assertCanManage(snapshot.items, item, actor);
    const affected = subtree(snapshot.items, item).filter((candidate) => candidate.trashedAt === null);
    const timestamp = new Date().toISOString();
    if (snapshot.database) {
      const result = await snapshot.database.prepare(`WITH RECURSIVE subtree(id) AS (
        SELECT id FROM erp_workspace_files WHERE id = ?1 AND workspace_id = ?2
        UNION ALL
        SELECT child.id FROM erp_workspace_files child JOIN subtree parent ON child.parent_id = parent.id
        WHERE child.workspace_id = ?2
      ), allowed(ok) AS (
        SELECT 1 FROM erp_workspace_files root
        WHERE root.id = ?1 AND root.workspace_id = ?2 AND root.version = ?3 AND root.trashed_at IS NULL
          AND (?4 = 1 OR NOT EXISTS (
            SELECT 1 FROM erp_workspace_files candidate
            WHERE candidate.id IN (SELECT id FROM subtree) AND candidate.owner_username <> ?5
          ))
      )
      UPDATE erp_workspace_files SET trashed_at = ?6, trashed_by = ?5, trash_root_id = ?1,
        updated_at = ?6, updated_by = ?5, version = version + 1
      WHERE id IN (SELECT id FROM subtree) AND trashed_at IS NULL AND EXISTS (SELECT 1 FROM allowed)`)
        .bind(item.id, WORKSPACE_ID, input.expectedVersion, actor.role === "admin" ? 1 : 0, actor.username, timestamp)
        .run();
      if (d1RunSucceeded(result) < 1) {
        throw new WorkspaceFilesRepositoryError("This item changed. Refresh and try again.", 409, "version_conflict");
      }
      const currentItems = (await readStore()).items;
      return publicItem(currentItems, requireItem(currentItems, item.id), actor);
    }
    for (const candidate of affected) {
      candidate.trashedAt = timestamp;
      candidate.trashedBy = actor.username;
      candidate.trashRootId = item.id;
      candidate.updatedAt = timestamp;
      candidate.updatedBy = actor.username;
      candidate.version += 1;
    }
    await writeLocalItems(snapshot.items);
    return publicItem(snapshot.items, item, actor);
  });
}

export function restoreWorkspaceItem(input: {
  actor: WorkspaceFileActor;
  id: string;
  expectedVersion: number;
}): Promise<WorkspaceFileItem> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    const snapshot = await readStore();
    const item = requireItem(snapshot.items, input.id);
    if (!item.trashedAt || item.trashRootId !== item.id) {
      throw new WorkspaceFilesRepositoryError("Only a top-level Trash item can be restored.", 409, "not_trash_root");
    }
    assertExpectedVersion(item, input.expectedVersion);
    assertCanManage(snapshot.items, item, actor);
    if (item.parentId) findFolder(snapshot.items, item.parentId);
    assertNameAvailable(snapshot.items, item.parentId, item.nameKey, item.id);
    const affected = snapshot.items.filter((candidate) => candidate.trashRootId === item.id);
    const timestamp = new Date().toISOString();
    if (snapshot.database) {
      const result = await snapshot.database.prepare(`UPDATE erp_workspace_files SET
        trashed_at = NULL, trashed_by = NULL, trash_root_id = NULL,
        updated_at = ?1, updated_by = ?2, version = version + 1
        WHERE workspace_id = ?3 AND trash_root_id = ?4
          AND EXISTS (
            SELECT 1 FROM erp_workspace_files root
            WHERE root.id = ?4 AND root.version = ?5 AND root.trash_root_id = root.id
              AND (?6 = 1 OR (
                root.owner_username = ?2
                AND NOT EXISTS (
                  SELECT 1 FROM erp_workspace_files candidate
                  WHERE candidate.trash_root_id = ?4 AND candidate.owner_username <> ?2
                )
              ))
              AND (root.parent_id IS NULL OR EXISTS (
                SELECT 1 FROM erp_workspace_files parent
                WHERE parent.id = root.parent_id AND parent.kind = 'folder' AND parent.trashed_at IS NULL
              ))
              AND NOT EXISTS (
                SELECT 1 FROM erp_workspace_files conflict
                WHERE conflict.workspace_id = root.workspace_id AND conflict.parent_key = root.parent_key
                  AND conflict.name_key = root.name_key AND conflict.trashed_at IS NULL AND conflict.id <> root.id
              )
          )`)
        .bind(timestamp, actor.username, WORKSPACE_ID, item.id, input.expectedVersion, actor.role === "admin" ? 1 : 0)
        .run();
      if (d1RunSucceeded(result) < 1) {
        throw new WorkspaceFilesRepositoryError("This item could not be restored because it changed or its name is in use.", 409, "restore_conflict");
      }
      const currentItems = (await readStore()).items;
      return publicItem(currentItems, requireItem(currentItems, item.id), actor);
    }
    for (const candidate of affected) {
      candidate.trashedAt = null;
      candidate.trashedBy = null;
      candidate.trashRootId = null;
      candidate.updatedAt = timestamp;
      candidate.updatedBy = actor.username;
      candidate.version += 1;
    }
    await writeLocalItems(snapshot.items);
    return publicItem(snapshot.items, item, actor);
  });
}

export function purgeWorkspaceItem(input: {
  actor: WorkspaceFileActor;
  id: string;
  expectedVersion: number;
}): Promise<{ id: string }> {
  return withMutation(async () => {
    const actor = assertActor(input.actor);
    if (actor.role !== "admin") {
      throw new WorkspaceFilesRepositoryError("Only an Administrator can permanently delete files.", 403, "admin_required");
    }
    const snapshot = await readStore();
    const item = requireItem(snapshot.items, input.id);
    if (!item.trashedAt || item.trashRootId !== item.id) {
      throw new WorkspaceFilesRepositoryError("Move this item to Trash before permanently deleting it.", 409, "not_trash_root");
    }
    assertExpectedVersion(item, input.expectedVersion);
    let storageKeys: string[];
    if (snapshot.database) {
      const result = await snapshot.database.prepare(`WITH RECURSIVE subtree(id) AS (
        SELECT id FROM erp_workspace_files
        WHERE id = ?1 AND workspace_id = ?2 AND version = ?3 AND trash_root_id = id
        UNION ALL
        SELECT child.id FROM erp_workspace_files child JOIN subtree parent ON child.parent_id = parent.id
        WHERE child.workspace_id = ?2
      )
      DELETE FROM erp_workspace_files WHERE id IN (SELECT id FROM subtree)
      RETURNING storage_key`)
        .bind(item.id, WORKSPACE_ID, input.expectedVersion)
        .all<{ storage_key: string | null }>();
      if (!result.success || !Array.isArray(result.results)) {
        throw databaseError(new Error(result.error || "D1 delete failed"));
      }
      if (!result.results.length) {
        throw new WorkspaceFilesRepositoryError("This item changed. Refresh and try again.", 409, "version_conflict");
      }
      storageKeys = result.results.map((row) => row.storage_key).filter((key): key is string => typeof key === "string");
    } else {
      const deleting = new Set(subtree(snapshot.items, item).map(({ id }) => id));
      storageKeys = snapshot.items
        .filter((candidate) => deleting.has(candidate.id) && candidate.storageKey)
        .map((candidate) => candidate.storageKey!);
      snapshot.items = snapshot.items.filter((candidate) => !deleting.has(candidate.id));
      await writeLocalItems(snapshot.items);
    }
    await Promise.allSettled(storageKeys.map((storageKey) => deleteStoredObject(storageKey)));
    return { id: item.id };
  });
}

export async function getWorkspaceFileContent(input: {
  actor: WorkspaceFileActor;
  id: string;
}): Promise<WorkspaceFileContent | null> {
  const actor = assertActor(input.actor);
  if (!ID_PATTERN.test(input.id)) throw new WorkspaceFilesRepositoryError("The file ID is invalid.", 400, "invalid_id");
  const { items } = await readStore();
  const item = items.find((candidate) => candidate.id === input.id);
  if (!item || item.kind !== "file" || item.trashedAt) return null;
  const storageKey = item.storageKey!;
  return {
    item: publicItem(items, item, actor),
    read: () => readStoredObject(storageKey, item.sizeBytes!, item.checksum!),
  };
}
