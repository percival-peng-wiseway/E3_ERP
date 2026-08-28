import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as cloudflareStorage from "../server/cloudflare-storage.ts";
// @ts-expect-error -- explicit extension is required by the focused Node ESM tests.
import { SITE_VISIT_CREATORS, SITE_VISIT_PHOTO_TYPES, SITE_VISIT_STATUSES } from "./types.ts";
// Focused tests execute source TypeScript directly under Node ESM.
// @ts-expect-error -- explicit extension is required by that runtime.
import * as siteVisitValidation from "./validation.ts";
import type {
  SiteVisit,
  SiteVisitActionInput,
  SiteVisitActor,
  SiteVisitCancellableStatus,
  SiteVisitCreateInput,
  SiteVisitCreator,
  SiteVisitPhoto,
  SiteVisitPhotoType,
  SiteVisitPhotoUpload,
} from "./types";

const {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
} = cloudflareStorage;

const {
  initialSiteVisitChecklist,
  normalizeStoredSiteVisitChecklist,
  parseSiteVisitCreate,
  siteVisitDate,
  siteVisitTime,
} = siteVisitValidation;

type StoredSiteVisitPhoto = Omit<SiteVisitPhoto, "url"> & {
  storedName: string;
  accessToken: string;
};

type StoredSiteVisit = Omit<SiteVisit, "photos"> & {
  photos: StoredSiteVisitPhoto[];
};

export interface SiteVisitPhotoFile {
  originalName: string;
  contentType: SiteVisitPhotoType;
  size: number;
  accessToken: string;
  read(): Promise<Uint8Array>;
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
const CLOUDFLARE_DOCUMENT_KEY = "site-visits/records";
const MAXIMUM_STORAGE_RETRIES = 5;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const STORED_PHOTO_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PHOTOS_PER_VISIT = 100;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
let mutationQueue: Promise<void> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>) {
  const retryingWork = async () => {
    for (let attempt = 0; attempt < MAXIMUM_STORAGE_RETRIES; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof CloudflareDocumentConflictError)) throw error;
      }
    }
    throw new SiteVisitRepositoryError(
      "Site Visiting changed while this request was being saved. Try again.",
      409,
      "storage_conflict",
    );
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
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

function storedText(value: unknown, maximum: number, required: boolean) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized)
    || normalized.length > maximum
    || UNSAFE_CONTROLS.test(normalized)) return null;
  return normalized;
}

function optionalStoredTimestamp(value: unknown) {
  if (value === undefined || value === null) return null;
  return exactTimestamp(value) ? value : undefined;
}

function optionalStoredActor(value: unknown) {
  if (value === undefined || value === null) return null;
  return storedText(value, 120, true) || undefined;
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
  const projectName = storedText(source.projectName, 160, true);
  const createdBy = source.createdBy === undefined || source.createdBy === null
    ? null
    : typeof source.createdBy === "string"
      && SITE_VISIT_CREATORS.includes(source.createdBy as SiteVisitCreator)
      ? source.createdBy as SiteVisitCreator
      : undefined;
  const address = storedText(source.address, 300, true);
  const contact = storedText(source.contact ?? "", 240, false);
  const reason = storedText(source.reason ?? "", 2_000, false);
  const assignee = storedText(source.assignee ?? "", 120, false);
  const notes = storedText(source.notes ?? "", 10_000, false);

  const scheduledDate = source.scheduledDate === undefined || source.scheduledDate === null
    ? null
    : siteVisitDate(source.scheduledDate) ? source.scheduledDate : undefined;
  const scheduledTime = source.scheduledTime === undefined || source.scheduledTime === null
    ? null
    : siteVisitTime(source.scheduledTime) ? source.scheduledTime : undefined;
  const requestedDate = siteVisitDate(source.requestedDate)
    ? source.requestedDate
    : scheduledDate;
  const requestedTime = siteVisitTime(source.requestedTime)
    ? source.requestedTime
    : scheduledTime;

  const approvedAt = optionalStoredTimestamp(source.approvedAt);
  const approvedBy = optionalStoredActor(source.approvedBy);
  const scheduledAt = optionalStoredTimestamp(source.scheduledAt);
  const scheduledBy = optionalStoredActor(source.scheduledBy);
  const status = typeof source.status === "string"
    && SITE_VISIT_STATUSES.includes(source.status as SiteVisit["status"])
    ? source.status as SiteVisit["status"]
    : null;
  let cancelledFrom: SiteVisitCancellableStatus | null = null;
  if (status === "cancelled") {
    const candidate = source.cancelledFrom ?? "scheduled";
    if (typeof candidate !== "string"
      || candidate === "cancelled"
      || candidate === "completed"
      || !SITE_VISIT_STATUSES.includes(candidate as SiteVisit["status"])) {
      throw new SiteVisitRepositoryError("A stored site visit is invalid.", 500, "invalid_storage");
    }
    cancelledFrom = candidate as SiteVisitCancellableStatus;
  } else if (source.cancelledFrom !== undefined && source.cancelledFrom !== null) {
    throw new SiteVisitRepositoryError("A stored site visit is invalid.", 500, "invalid_storage");
  }

  const checklist = normalizeStoredSiteVisitChecklist(source.checklist);
  const scheduleIsPaired = (scheduledDate === null) === (scheduledTime === null);
  const approvalAuditIsPaired = (approvedAt === null) === (approvedBy === null);
  const schedulingAuditIsPaired = (scheduledAt === null) === (scheduledBy === null);
  const effectiveStatus = status === "cancelled" ? cancelledFrom : status;
  const statusNeedsSchedule = effectiveStatus === "scheduled"
    || effectiveStatus === "in_progress"
    || effectiveStatus === "completed";
  const statusMustBeUnscheduled = effectiveStatus === "pending_approval" || effectiveStatus === "approved";
  const statusNeedsApprovalAudit = effectiveStatus === "approved";
  const newRequestIsComplete = effectiveStatus !== "pending_approval" && effectiveStatus !== "approved"
    || Boolean(contact && reason);
  if (createdBy === undefined
    || !projectName || !address || contact === null || reason === null || assignee === null || notes === null
    || !requestedDate || !requestedTime
    || scheduledDate === undefined || scheduledTime === undefined || !scheduleIsPaired
    || approvedAt === undefined || approvedBy === undefined || !approvalAuditIsPaired
    || scheduledAt === undefined || scheduledBy === undefined || !schedulingAuditIsPaired
    || !status || !newRequestIsComplete
    || (statusNeedsSchedule && (!scheduledDate || !scheduledTime))
    || (statusMustBeUnscheduled && (scheduledDate || scheduledTime))
    || (statusNeedsApprovalAudit && (!approvedAt || !approvedBy))
    || !checklist
    || typeof source.id !== "string" || !ID_PATTERN.test(source.id)
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
    createdBy,
    projectName,
    address,
    contact,
    reason,
    requestedDate,
    requestedTime,
    scheduledDate,
    scheduledTime,
    assignee,
    status,
    approvedAt,
    approvedBy,
    scheduledAt,
    scheduledBy,
    cancelledFrom,
    checklist,
    notes,
    photos,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function normalizedStoredVisits(parsed: unknown) {
  if (!Array.isArray(parsed)) {
    throw new SiteVisitRepositoryError("Site Visiting data is invalid.", 500, "invalid_storage");
  }
  const visits = parsed.map(normalizeStoredVisit);
  if (new Set(visits.map(({ id }) => id)).size !== visits.length) {
    throw new SiteVisitRepositoryError("Stored site visit IDs are invalid.", 500, "invalid_storage");
  }
  return visits;
}

async function readStoredVisitDocument(): Promise<{ visits: StoredSiteVisit[]; version: number | null }> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    return {
      visits: normalizedStoredVisits(document.value ?? []),
      version: document.version,
    };
  }

  await ensureStorage();
  try {
    return {
      visits: normalizedStoredVisits(JSON.parse(await readFile(recordsPath, "utf8"))),
      version: null,
    };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { visits: [], version: null };
    throw error;
  }
}

async function writeStoredVisits(visits: StoredSiteVisit[], expectedVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(bindings.database, CLOUDFLARE_DOCUMENT_KEY, visits, expectedVersion);
    return;
  }

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
  const leftDate = left.scheduledDate ?? left.requestedDate;
  const rightDate = right.scheduledDate ?? right.requestedDate;
  const leftTime = left.scheduledTime ?? left.requestedTime;
  const rightTime = right.scheduledTime ?? right.requestedTime;
  return leftDate.localeCompare(rightDate)
    || leftTime.localeCompare(rightTime)
    || left.projectName.localeCompare(right.projectName)
    || left.id.localeCompare(right.id);
}

function pmOrAdmin(actor: SiteVisitActor) {
  return actor.role === "pm" || actor.role === "admin";
}

function assertSiteVisitActionRole(input: SiteVisitActionInput, actor: SiteVisitActor) {
  if ((input.action === "approve"
      || input.action === "schedule"
      || input.action === "reopen"
      || input.action === "cancel"
      || input.action === "restore")
    && !pmOrAdmin(actor)) {
    throw new SiteVisitRepositoryError(
      "Only a Project Manager or Administrator can perform this site visit action.",
      403,
      "role_forbidden",
    );
  }
}

function invalidTransition(message: string): never {
  throw new SiteVisitRepositoryError(message, 409, "invalid_transition");
}

function assertSiteWorkCanChange(visit: StoredSiteVisit) {
  if (visit.status !== "scheduled" && visit.status !== "in_progress") {
    invalidTransition("Site visit work can only be changed after the visit is scheduled and before it is completed.");
  }
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

function storedPhotoObjectKey(visitId: string, storedName: string) {
  storedPhotoPath(visitId, storedName);
  return `site-visits/photos/${visitId}/${storedName}`;
}

async function writeStoredPhoto(visitId: string, photo: StoredSiteVisitPhoto, bytes: Uint8Array) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    await bindings.files.put(storedPhotoObjectKey(visitId, photo.storedName), bytes);
    return;
  }

  const directory = visitPhotosDirectory(visitId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(storedPhotoPath(visitId, photo.storedName), bytes, { flag: "wx", mode: 0o600 });
}

async function deleteStoredPhoto(visitId: string, photo: StoredSiteVisitPhoto) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    await bindings.files.delete(storedPhotoObjectKey(visitId, photo.storedName));
    return;
  }
  await unlink(storedPhotoPath(visitId, photo.storedName));
}

async function readStoredPhoto(visitId: string, photo: StoredSiteVisitPhoto) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    const buffer = await bindings.files.get(storedPhotoObjectKey(visitId, photo.storedName), "arrayBuffer");
    if (!buffer) {
      // Workers KV is eventually consistent across locations. The D1 photo
      // metadata can therefore become visible before a newly-created KV key
      // reaches the location serving this read. Treat that state as retryable
      // rather than incorrectly reporting that the logical photo is missing.
      throw new SiteVisitRepositoryError(
        "The site visit photo is still syncing. Try again shortly.",
        503,
        "photo_not_ready",
      );
    }
    return new Uint8Array(buffer);
  }
  const source = await readFile(storedPhotoPath(visitId, photo.storedName));
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

export async function listSiteVisits(): Promise<SiteVisit[]> {
  const visits = (await readStoredVisitDocument()).visits;
  return visits.slice().sort(siteVisitSort).map(publicVisit);
}

export async function getSiteVisit(id: string): Promise<SiteVisit | null> {
  if (!ID_PATTERN.test(id)) return null;
  const visits = (await readStoredVisitDocument()).visits;
  const visit = visits.find((candidate) => candidate.id === id);
  return visit ? publicVisit(visit) : null;
}

export function createSiteVisit(input: SiteVisitCreateInput): Promise<SiteVisit> {
  return withMutation(async () => {
    const normalized = parseSiteVisitCreate(input as unknown as Record<string, unknown>);
    if (!normalized) throw new SiteVisitRepositoryError("The site visit is invalid.", 400, "invalid_visit");
    const storedDocument = await readStoredVisitDocument();
    const visits = storedDocument.visits;
    const timestamp = new Date().toISOString();
    const visit: StoredSiteVisit = {
      id: randomUUID(),
      ...normalized,
      scheduledDate: null,
      scheduledTime: null,
      assignee: "",
      status: "pending_approval",
      approvedAt: null,
      approvedBy: null,
      scheduledAt: null,
      scheduledBy: null,
      cancelledFrom: null,
      checklist: initialSiteVisitChecklist(),
      notes: "",
      photos: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    visits.push(visit);
    await writeStoredVisits(visits, storedDocument.version);
    return publicVisit(visit);
  });
}

export function transitionSiteVisit(
  id: string,
  input: SiteVisitActionInput,
  actor: SiteVisitActor,
): Promise<SiteVisit> {
  return withMutation(async () => {
    if (!ID_PATTERN.test(id)) throw new SiteVisitRepositoryError("The site visit ID is invalid.", 400, "invalid_id");
    const actorName = storedText(actor.name, 120, true);
    if (!actorName || !["admin", "pm", "sales", "specialist"].includes(actor.role)) {
      throw new SiteVisitRepositoryError("The site visit actor is invalid.", 400, "invalid_actor");
    }
    assertSiteVisitActionRole(input, actor);
    const storedDocument = await readStoredVisitDocument();
    const visits = storedDocument.visits;
    const index = visits.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const current = visits[index];
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new SiteVisitRepositoryError(
        "This site visit changed after you opened it. Refresh and try again.",
        409,
        "stale_visit",
      );
    }
    const timestamp = nextTimestamp(current.updatedAt);
    const updated: StoredSiteVisit = {
      ...current,
      updatedAt: timestamp,
    };

    switch (input.action) {
      case "update_request":
        if (current.status !== "pending_approval") {
          invalidTransition("The request can only be changed while it is awaiting approval.");
        }
        Object.assign(updated, {
          projectName: input.projectName,
          address: input.address,
          contact: input.contact,
          reason: input.reason,
          requestedDate: input.requestedDate,
          requestedTime: input.requestedTime,
        });
        break;
      case "approve":
        if (current.status !== "pending_approval") {
          invalidTransition("Only a pending site visit request can be approved.");
        }
        updated.status = "approved";
        updated.approvedAt = timestamp;
        updated.approvedBy = actorName;
        break;
      case "schedule":
        if (current.status !== "approved" && current.status !== "scheduled") {
          invalidTransition("Approve the site visit request before scheduling it.");
        }
        updated.status = "scheduled";
        updated.scheduledDate = input.scheduledDate;
        updated.scheduledTime = input.scheduledTime;
        updated.assignee = input.assignee;
        updated.scheduledAt = timestamp;
        updated.scheduledBy = actorName;
        break;
      case "start":
        if (current.status !== "scheduled") {
          invalidTransition("Only a scheduled site visit can be started.");
        }
        updated.status = "in_progress";
        break;
      case "save_visit":
        assertSiteWorkCanChange(current);
        updated.projectName = input.projectName;
        updated.address = input.address;
        updated.contact = input.contact;
        updated.checklist = input.checklist.map((item) => ({ ...item }));
        updated.notes = input.notes;
        break;
      case "complete":
        if (current.status !== "in_progress") {
          invalidTransition("Only a site visit in progress can be completed.");
        }
        updated.status = "completed";
        break;
      case "reopen":
        if (current.status !== "completed") {
          invalidTransition("Only a completed site visit can be reopened.");
        }
        updated.status = "in_progress";
        break;
      case "cancel":
        if (current.status === "cancelled" || current.status === "completed") {
          invalidTransition("This site visit cannot be cancelled from its current stage.");
        }
        updated.cancelledFrom = current.status;
        updated.status = "cancelled";
        break;
      case "restore":
        if (current.status !== "cancelled" || !current.cancelledFrom) {
          invalidTransition("Only a cancelled site visit can be restored.");
        }
        updated.status = current.cancelledFrom;
        updated.cancelledFrom = null;
        break;
    }

    visits[index] = normalizeStoredVisit(updated);
    await writeStoredVisits(visits, storedDocument.version);
    return publicVisit(visits[index]);
  });
}

export function deleteSiteVisit(id: string): Promise<SiteVisit> {
  return withMutation(async () => {
    if (!ID_PATTERN.test(id)) throw new SiteVisitRepositoryError("The site visit ID is invalid.", 400, "invalid_id");
    const storedDocument = await readStoredVisitDocument();
    const visits = storedDocument.visits;
    const index = visits.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const [deleted] = visits.splice(index, 1);
    await writeStoredVisits(visits, storedDocument.version);
    for (const photo of deleted.photos) {
      await deleteStoredPhoto(id, photo).catch(() => undefined);
    }
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
    const storedDocument = await readStoredVisitDocument();
    const visits = storedDocument.visits;
    const index = visits.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const visit = visits[index];
    assertSiteWorkCanChange(visit);
    if (visit.photos.length + uploads.length > MAX_PHOTOS_PER_VISIT) {
      throw new SiteVisitRepositoryError("A site visit can store up to 100 photos.", 409, "photo_limit_reached");
    }

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
    const writtenPhotos: StoredSiteVisitPhoto[] = [];
    try {
      for (let index = 0; index < uploads.length; index += 1) {
        await writeStoredPhoto(id, storedPhotos[index], uploads[index].bytes);
        writtenPhotos.push(storedPhotos[index]);
      }
      visit.photos.push(...storedPhotos);
      visit.updatedAt = timestamp;
      await writeStoredVisits(visits, storedDocument.version);
    } catch (error) {
      await Promise.all(writtenPhotos.map((photo) => deleteStoredPhoto(id, photo).catch(() => undefined)));
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
    const storedDocument = await readStoredVisitDocument();
    const visits = storedDocument.visits;
    const visitIndex = visits.findIndex((candidate) => candidate.id === id);
    if (visitIndex < 0) throw new SiteVisitRepositoryError("Site visit not found.", 404, "not_found");
    const visit = visits[visitIndex];
    assertSiteWorkCanChange(visit);
    const photoIndex = visit.photos.findIndex((candidate) => candidate.id === photoId);
    if (photoIndex < 0) throw new SiteVisitRepositoryError("Site visit photo not found.", 404, "photo_not_found");
    const [deleted] = visit.photos.splice(photoIndex, 1);
    visit.updatedAt = nextTimestamp(visit.updatedAt);
    await writeStoredVisits(visits, storedDocument.version);
    await deleteStoredPhoto(id, deleted).catch(() => undefined);
    return publicVisit(visit);
  });
}

export async function getSiteVisitPhotoFile(id: string, photoId: string): Promise<SiteVisitPhotoFile | null> {
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(photoId)) return null;
  const visits = (await readStoredVisitDocument()).visits;
  const visit = visits.find((candidate) => candidate.id === id);
  const photo = visit?.photos.find((candidate) => candidate.id === photoId);
  if (!photo) return null;
  return {
    originalName: photo.originalName,
    contentType: photo.contentType,
    size: photo.size,
    accessToken: photo.accessToken,
    read: () => readStoredPhoto(id, photo),
  };
}
