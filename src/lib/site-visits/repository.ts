import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SiteVisit,
  SiteVisitCreateInput,
  SiteVisitPatchInput,
  SiteVisitPhoto,
  SiteVisitPhotoType,
  SiteVisitPhotoUpload,
} from "./types";
import { SITE_VISIT_PHOTO_TYPES, SITE_VISIT_STATUSES } from "./types";
import {
  initialSiteVisitChecklist,
  parseSiteVisitChecklist,
  parseSiteVisitCreate,
} from "./validation";

type StoredSiteVisitPhoto = Omit<SiteVisitPhoto, "url"> & {
  storedName: string;
  accessToken: string;
};

type StoredSiteVisit = Omit<SiteVisit, "photos"> & {
  photos: StoredSiteVisitPhoto[];
};

export interface SiteVisitPhotoFile {
  path: string;
  originalName: string;
  contentType: SiteVisitPhotoType;
  size: number;
  accessToken: string;
}

export class SiteVisitRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "SiteVisitRepositoryError";
    this.status = status;
    this.code = code;
  }
}

const MIME_EXTENSIONS: Record<SiteVisitPhotoType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.SITE_VISIT_DATA_DIR || path.join(process.cwd(), ".data", "site-visits"),
);
const recordsPath = path.join(/* turbopackIgnore: true */ dataRoot, "records.json");
const photosRoot = path.join(/* turbopackIgnore: true */ dataRoot, "photos");
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const STORED_PHOTO_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PHOTOS_PER_VISIT = 100;
let mutationQueue: Promise<void> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>) {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function isFileSystemError(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function ensureStorage() {
  await mkdir(photosRoot, { recursive: true, mode: 0o700 });
}

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !EXACT_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function safeOriginalName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  if (value.includes("/") || value.includes("\\")) return null;
  return value;
}

function normalizeStoredPhoto(value: unknown): StoredSiteVisitPhoto {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SiteVisitRepositoryError("A stored site visit photo is invalid.", 500, "invalid_storage");
  }
  const source = value as Record<string, unknown>;
  const contentType = typeof source.contentType === "string"
    && SITE_VISIT_PHOTO_TYPES.includes(source.contentType as SiteVisitPhotoType)
    ? source.contentType as SiteVisitPhotoType
    : null;
  const originalName = safeOriginalName(source.originalName);
  if (!contentType || !originalName
    || typeof source.id !== "string" || !ID_PATTERN.test(source.id)
    || typeof source.storedName !== "string" || !STORED_PHOTO_PATTERN.test(source.storedName)
    || path.extname(source.storedName).slice(1).toLowerCase() !== MIME_EXTENSIONS[contentType]
    || typeof source.accessToken !== "string" || !TOKEN_PATTERN.test(source.accessToken)
    || !Number.isSafeInteger(source.size) || (source.size as number) < 1 || (source.size as number) > 10 * 1024 * 1024
    || !exactTimestamp(source.createdAt)) {
    throw new SiteVisitRepositoryError("A stored site visit photo is invalid.", 500, "invalid_storage");
  }
  return {
    id: source.id,
    originalName,
    contentType,
    size: source.size as number,
    createdAt: source.createdAt,
    storedName: source.storedName,
    accessToken: source.accessToken,
  };
}

function normalizeStoredVisit(value: unknown): StoredSiteVisit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SiteVisitRepositoryError("Site Visiting data is invalid.", 500, "invalid_storage");
  }
  const source = value as Record<string, unknown>;
  const input = parseSiteVisitCreate({
    projectName: source.projectName,
    address: source.address,
    contact: source.contact,
    scheduledDate: source.scheduledDate,
    scheduledTime: source.scheduledTime,
    assignee: source.assignee,
    notes: source.notes,
  });
  const checklist = parseSiteVisitChecklist(source.checklist);
  if (!input || !checklist
    || typeof source.id !== "string" || !ID_PATTERN.test(source.id)
    || typeof source.status !== "string" || !SITE_VISIT_STATUSES.includes(source.status as SiteVisit["status"])
    || !Array.isArray(source.photos) || source.photos.length > MAX_PHOTOS_PER_VISIT
    || !exactTimestamp(source.createdAt) || !exactTimestamp(source.updatedAt)) {
    throw new SiteVisitRepositoryError("A stored site visit is invalid.", 500, "invalid_storage");
  }
  const photos = source.photos.map(normalizeStoredPhoto);
  if (new Set(photos.map(({ id }) => id)).size !== photos.length) {
    throw new SiteVisitRepositoryError("Stored site visit photo IDs are invalid.", 500, "invalid_storage");
  }
  return {
    id: source.id,
    ...input,
    status: source.status as SiteVisit["status"],
    checklist,
    photos,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

async function readStoredVisits(): Promise<StoredSiteVisit[]> {
  await ensureStorage();
  try {
    const parsed: unknown = JSON.parse(await readFile(recordsPath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new SiteVisitRepositoryError("Site Visiting data is invalid.", 500, "invalid_storage");
    }
    const visits = parsed.map(normalizeStoredVisit);
    if (new Set(visits.map(({ id }) => id)).size !== visits.length) {
      throw new SiteVisitRepositoryError("Stored site visit IDs are invalid.", 500, "invalid_storage");
    }
    return visits;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }
}

async function writeStoredVisits(visits: StoredSiteVisit[]) {
  await ensureStorage();
  const temporaryPath = path.join(dataRoot, `.records-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(visits, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, recordsPath);
}

function publicPhoto(visitId: string, photo: StoredSiteVisitPhoto): SiteVisitPhoto {
  const { storedName: _storedName, accessToken, ...fields } = photo;
  return {
    ...fields,
    url: `/api/site-visits/${encodeURIComponent(visitId)}/photos/${encodeURIComponent(photo.id)}?token=${encodeURIComponent(accessToken)}`,
  };
}

function publicVisit(visit: StoredSiteVisit): SiteVisit {
  return {
    ...visit,
    checklist: visit.checklist.map((item) => ({ ...item })),
    photos: visit.photos.map((photo) => publicPhoto(visit.id, photo)),
  };
}

function nextTimestamp(previous: string) {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
}

function siteVisitSort(left: StoredSiteVisit, right: StoredSiteVisit) {
  return left.scheduledDate.localeCompare(right.scheduledDate)
    || left.scheduledTime.localeCompare(right.scheduledTime)
    || left.projectName.localeCompare(right.projectName)
    || left.id.localeCompare(right.id);
}

function visitPhotosDirectory(visitId: string) {
  if (!ID_PATTERN.test(visitId)) {
    throw new SiteVisitRepositoryError("The site visit ID is invalid.", 400, "invalid_id");
  }
  const directory = path.resolve(photosRoot, visitId);
  const relative = path.relative(photosRoot, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SiteVisitRepositoryError("The site visit photo path is invalid.", 500, "invalid_photo_path");
  }
  return directory;
}

function storedPhotoPath(visitId: string, storedName: string) {
  if (path.basename(storedName) !== storedName || !STORED_PHOTO_PATTERN.test(storedName)) {
    throw new SiteVisitRepositoryError("The site visit photo path is invalid.", 500, "invalid_photo_path");
  }
  const directory = visitPhotosDirectory(visitId);
  const filePath = path.resolve(directory, storedName);
  const relative = path.relative(directory, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SiteVisitRepositoryError("The site visit photo path is invalid.", 500, "invalid_photo_path");
  }
  return filePath;
}

export async function listSiteVisits(): Promise<SiteVisit[]> {
  const visits = await readStoredVisits();
  return visits.slice().sort(siteVisitSort).map(publicVisit);
}

export async function getSiteVisit(id: string): Promise<SiteVisit | null> {
  if (!ID_PATTERN.test(id)) return null;
  const visits = await readStoredVisits();
  const visit = visits.find((candidate) => candidate.id === id);
  return visit ? publicVisit(visit) : null;
}

export function createSiteVisit(input: SiteVisitCreateInput): Promise<SiteVisit> {
  return withMutation(async () => {
    const normalized = parseSiteVisitCreate(input as unknown as Record<string, unknown>);
    if (!normalized) throw new SiteVisitRepositoryError("The site visit is invalid.", 400, "invalid_visit");
    const visits = await readStoredVisits();
    const timestamp = new Date().toISOString();
    const visit: StoredSiteVisit = {
      id: randomUUID(),
      ...normalized,
      status: "scheduled",
      checklist: initialSiteVisitChecklist(),
      photos: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    visits.push(visit);
    await writeStoredVisits(visits);
    return publicVisit(visit);
  });
}

export function updateSiteVisit(id: string, patch: SiteVisitPatchInput): Promise<SiteVisit> {
  return withMutation(async () => {
    if (!ID_PATTERN.test(id)) throw new SiteVisitRepositoryError("The site visit ID is invalid.", 400, "invalid_id");
    const visits = await readStoredVisits();
    const index = visits.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const current = visits[index];
    const updated: StoredSiteVisit = {
      ...current,
      ...patch,
      checklist: patch.checklist?.map((item) => ({ ...item })) ?? current.checklist,
      updatedAt: nextTimestamp(current.updatedAt),
    };
    visits[index] = normalizeStoredVisit(updated);
    await writeStoredVisits(visits);
    return publicVisit(visits[index]);
  });
}

export function deleteSiteVisit(id: string): Promise<SiteVisit> {
  return withMutation(async () => {
    if (!ID_PATTERN.test(id)) throw new SiteVisitRepositoryError("The site visit ID is invalid.", 400, "invalid_id");
    const visits = await readStoredVisits();
    const index = visits.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const [deleted] = visits.splice(index, 1);
    await writeStoredVisits(visits);
    for (const photo of deleted.photos) {
      await unlink(storedPhotoPath(id, photo.storedName)).catch(() => undefined);
    }
    await rmdir(visitPhotosDirectory(id)).catch(() => undefined);
    return publicVisit(deleted);
  });
}

export function addSiteVisitPhotos(
  id: string,
  uploads: SiteVisitPhotoUpload[],
): Promise<{ visit: SiteVisit; photos: SiteVisitPhoto[] }> {
  return withMutation(async () => {
    if (!ID_PATTERN.test(id)) throw new SiteVisitRepositoryError("The site visit ID is invalid.", 400, "invalid_id");
    if (!uploads.length) throw new SiteVisitRepositoryError("Choose at least one photo.", 400, "photos_required");
    const visits = await readStoredVisits();
    const index = visits.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const visit = visits[index];
    if (visit.photos.length + uploads.length > MAX_PHOTOS_PER_VISIT) {
      throw new SiteVisitRepositoryError("A site visit can store up to 100 photos.", 409, "photo_limit_reached");
    }

    const directory = visitPhotosDirectory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const timestamp = nextTimestamp(visit.updatedAt);
    const storedPhotos: StoredSiteVisitPhoto[] = uploads.map((upload) => ({
      id: randomUUID(),
      originalName: upload.originalName,
      contentType: upload.contentType,
      size: upload.size,
      createdAt: timestamp,
      storedName: `${randomUUID()}.${MIME_EXTENSIONS[upload.contentType]}`,
      accessToken: randomBytes(24).toString("base64url"),
    }));
    const writtenPaths: string[] = [];
    try {
      for (let index = 0; index < uploads.length; index += 1) {
        const filePath = storedPhotoPath(id, storedPhotos[index].storedName);
        await writeFile(filePath, uploads[index].bytes, { flag: "wx", mode: 0o600 });
        writtenPaths.push(filePath);
      }
      visit.photos.push(...storedPhotos);
      visit.updatedAt = timestamp;
      await writeStoredVisits(visits);
    } catch (error) {
      await Promise.all(writtenPaths.map((filePath) => unlink(filePath).catch(() => undefined)));
      throw error;
    }
    return {
      visit: publicVisit(visit),
      photos: storedPhotos.map((photo) => publicPhoto(id, photo)),
    };
  });
}

export function deleteSiteVisitPhoto(id: string, photoId: string): Promise<SiteVisit> {
  return withMutation(async () => {
    if (!ID_PATTERN.test(id) || !ID_PATTERN.test(photoId)) {
      throw new SiteVisitRepositoryError("The site visit photo ID is invalid.", 400, "invalid_id");
    }
    const visits = await readStoredVisits();
    const visitIndex = visits.findIndex((candidate) => candidate.id === id);
    if (visitIndex < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const visit = visits[visitIndex];
    const photoIndex = visit.photos.findIndex((candidate) => candidate.id === photoId);
    if (photoIndex < 0) throw new SiteVisitRepositoryError("Site visit photo not found.", 404, "photo_not_found");
    const [deleted] = visit.photos.splice(photoIndex, 1);
    visit.updatedAt = nextTimestamp(visit.updatedAt);
    await writeStoredVisits(visits);
    await unlink(storedPhotoPath(id, deleted.storedName)).catch(() => undefined);
    return publicVisit(visit);
  });
}

export async function getSiteVisitPhotoFile(id: string, photoId: string): Promise<SiteVisitPhotoFile | null> {
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(photoId)) return null;
  const visits = await readStoredVisits();
  const visit = visits.find((candidate) => candidate.id === id);
  const photo = visit?.photos.find((candidate) => candidate.id === photoId);
  if (!photo) return null;
  return {
    path: storedPhotoPath(id, photo.storedName),
    originalName: photo.originalName,
    contentType: photo.contentType,
    size: photo.size,
    accessToken: photo.accessToken,
  };
}
