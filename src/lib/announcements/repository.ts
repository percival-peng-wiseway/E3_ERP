import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
// Focused Node ESM tests require the explicit extension; Next's server bundler
// supports the same import path.
// @ts-expect-error -- the project intentionally does not enable emit-time extension imports.
} from "../server/cloudflare-storage.ts";
import type { Announcement, AnnouncementCreateInput, AnnouncementPatchInput } from "./types";
import {
  ANNOUNCEMENT_MAX_CONTENT_LENGTH,
  ANNOUNCEMENT_MAX_TITLE_LENGTH,
  validAnnouncementCreator,
// The focused tests execute source TypeScript directly under Node ESM, which
// requires the explicit extension; Next's server bundler supports this path.
// @ts-expect-error -- the project intentionally does not enable TS emit-time extension imports.
} from "./validation.ts";

export const ANNOUNCEMENT_MAX_RECORDS = 200;

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.ANNOUNCEMENTS_DATA_DIR || path.join(process.cwd(), ".data", "announcements"),
);
const recordsPath = path.join(/* turbopackIgnore: true */ dataRoot, "records.json");
const CLOUDFLARE_DOCUMENT_KEY = "announcements/records";
const MAXIMUM_STORAGE_RETRIES = 5;
let mutationQueue: Promise<void> = Promise.resolve();

export class AnnouncementRepositoryError extends Error {
  readonly status: number;
  readonly code: "not_found" | "storage_conflict";

  constructor(message: string, status: number, code: "not_found" | "storage_conflict") {
    super(message);
    this.name = "AnnouncementRepositoryError";
    this.status = status;
    this.code = code;
  }
}

async function ensureStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isStoredAnnouncement(value: unknown): value is Announcement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Announcement>;
  const exactFields = Object.keys(value).sort().join(",") === "content,createdAt,createdBy,id,title";
  return exactFields
    && typeof candidate.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id)
    && typeof candidate.title === "string"
    && candidate.title.length <= ANNOUNCEMENT_MAX_TITLE_LENGTH
    && candidate.title === candidate.title.trim()
    && !/[\u0000-\u001f\u007f]/.test(candidate.title)
    && typeof candidate.content === "string"
    && candidate.content.length > 0
    && candidate.content.length <= ANNOUNCEMENT_MAX_CONTENT_LENGTH
    && candidate.content === candidate.content.trim()
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.content)
    && isIsoTimestamp(candidate.createdAt)
    && validAnnouncementCreator(candidate.createdBy);
}

function normalizedAnnouncements(parsed: unknown) {
  if (!Array.isArray(parsed)
    || !parsed.every(isStoredAnnouncement)
    || new Set(parsed.map((announcement) => announcement.id)).size !== parsed.length) {
    throw new Error("Announcement data has an invalid format.");
  }
  return parsed.slice(-ANNOUNCEMENT_MAX_RECORDS);
}

async function readStoredAnnouncementDocument(): Promise<{
  announcements: Announcement[];
  version: number | null;
}> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    return {
      announcements: normalizedAnnouncements(document.value ?? []),
      version: document.version,
    };
  }

  await ensureStorage();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ recordsPath, "utf8");
    return { announcements: normalizedAnnouncements(JSON.parse(raw)), version: null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { announcements: [], version: null };
    }
    throw error;
  }
}

async function writeStoredAnnouncements(announcements: Announcement[], expectedVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(
      bindings.database,
      CLOUDFLARE_DOCUMENT_KEY,
      announcements,
      expectedVersion,
    );
    return;
  }

  await ensureStorage();
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.records-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(announcements, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, recordsPath);
    await chmod(recordsPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const retryingWork = async () => {
    for (let attempt = 0; attempt < MAXIMUM_STORAGE_RETRIES; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof CloudflareDocumentConflictError)) throw error;
      }
    }
    throw new AnnouncementRepositoryError(
      "Announcements changed while this request was being saved. Try again.",
      409,
      "storage_conflict",
    );
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function listAnnouncements(): Promise<Announcement[]> {
  await mutationQueue;
  return (await readStoredAnnouncementDocument()).announcements.reverse();
}

export function createAnnouncement(
  input: AnnouncementCreateInput,
  createdBy: string,
): Promise<Announcement> {
  return withMutation(async () => {
    const document = await readStoredAnnouncementDocument();
    const announcements = document.announcements;
    const announcement: Announcement = {
      id: randomUUID(),
      title: input.title,
      content: input.content,
      createdAt: new Date().toISOString(),
      createdBy,
    };
    announcements.push(announcement);
    await writeStoredAnnouncements(
      announcements.slice(-ANNOUNCEMENT_MAX_RECORDS),
      document.version,
    );
    return announcement;
  });
}

export function updateAnnouncement(
  id: string,
  patch: AnnouncementPatchInput,
): Promise<Announcement> {
  return withMutation(async () => {
    const document = await readStoredAnnouncementDocument();
    const announcements = document.announcements;
    const index = announcements.findIndex((announcement) => announcement.id === id);
    if (index < 0) {
      throw new AnnouncementRepositoryError("The announcement does not exist.", 404, "not_found");
    }
    const updated: Announcement = { ...announcements[index], ...patch };
    announcements[index] = updated;
    await writeStoredAnnouncements(announcements, document.version);
    return updated;
  });
}

export function deleteAnnouncement(id: string): Promise<string> {
  return withMutation(async () => {
    const document = await readStoredAnnouncementDocument();
    const announcements = document.announcements;
    const index = announcements.findIndex((announcement) => announcement.id === id);
    if (index < 0) {
      throw new AnnouncementRepositoryError("The announcement does not exist.", 404, "not_found");
    }
    announcements.splice(index, 1);
    await writeStoredAnnouncements(announcements, document.version);
    return id;
  });
}
