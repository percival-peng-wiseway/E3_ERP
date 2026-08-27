import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import * as cloudflareStorage from "../server/cloudflare-storage.ts";
// The focused tests execute source TypeScript directly under Node ESM, which
// requires the explicit extension; Next's server bundler supports this path.
// @ts-expect-error -- the project intentionally does not enable TS emit-time extension imports.
import { paymentAgreementRequiresSolarRebatePdf } from "./pdf-parser.ts";
// @ts-expect-error -- explicit extension is required by the focused Node ESM tests.
import * as paymentTrackTypes from "./types.ts";
import type {
  PaymentTrackAction,
  PaymentTrackCustomer,
  PaymentTrackDeliverySelection,
  PaymentTrackFile,
  PaymentTrackFinalPayment,
  PaymentTrackHistoryAction,
  PaymentTrackHistoryEntry,
  PaymentTrackItem,
  PaymentTrackProject,
  PaymentTrackReceipt,
  PaymentTrackRole,
  PaymentTrackScheduleAssignee,
  PaymentTrackScheduleRequest,
  PaymentTrackSolarPanelConsumption,
  PaymentTrackSpecialist,
  PaymentTrackUploadContentType,
  PaymentTrackWorkMode,
} from "./types";

const {
  PAYMENT_TRACK_SCHEDULE_ASSIGNEES,
  PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH,
  PAYMENT_TRACK_WORK_MODES,
} = paymentTrackTypes;

const {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
} = cloudflareStorage;

type StoredFile = Omit<PaymentTrackFile, "url"> & {
  storedName: string;
  accessToken: string;
};

type StoredReceipt = Omit<PaymentTrackReceipt, "proof" | "acknowledgedAt" | "acknowledgedBy" | "reportedAmountCents"> & {
  proof: StoredFile | null;
  // Optional so proof-based receipts written by earlier versions remain readable.
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  reportedAmountCents?: number | null;
};

type StoredFinalPayment = StoredReceipt & {
  // Optional fields make the shape forward-compatible with any pre-ID records.
  id?: string;
  createdAt?: string;
};

type StoredProject = Omit<
  PaymentTrackProject,
  | "contract"
  | "deposit"
  | "collection"
  | "finalPayments"
  | "outstandingCents"
  | "overpaymentCents"
  | "solarRebateRequired"
  | "solarRebateReceivedAt"
  | "pmNotes"
  | "pmNotesUpdatedAt"
  | "pmNotesUpdatedBy"
  | "deliveryScheduledFor"
  | "deliveryScheduledTime"
  | "deliveryAssignee"
  | "deliverySelections"
  | "deliveryPreparedAt"
  | "deliveryPreparedBy"
  | "deliveryScheduleRequest"
  | "installationScheduleRequest"
  | "installationScheduledFor"
  | "installationScheduledTime"
  | "installationAssignee"
  | "solarPanelConsumption"
  | "workMode"
> & {
  contract: StoredFile | null;
  deposit: StoredReceipt;
  collection: StoredReceipt;
  // Optional so records created before final-payment tracking remain readable.
  finalPayments?: StoredFinalPayment[];
  // Optional so records created before Solar Rebate tracking migrate to no requirement.
  solarRebateRequired?: boolean;
  solarRebateReceivedAt?: string | null;
  // Internal schema marker. Missing means an imported contract has not yet
  // been evaluated with the authoritative Solar Rebate price-line rule.
  solarRebateAssessmentVersion?: number;
  // Optional so records written before PM Notes remain readable.
  pmNotes?: string;
  pmNotesUpdatedAt?: string | null;
  pmNotesUpdatedBy?: string | null;
  // Optional so records written before delivery scheduling details remain readable.
  deliveryScheduledFor?: string | null;
  deliveryScheduledTime?: string | null;
  deliveryAssignee?: PaymentTrackScheduleAssignee | null;
  // Optional so records written before warehouse item preparation remain readable.
  deliverySelections?: PaymentTrackDeliverySelection[];
  deliveryPreparedAt?: string | null;
  deliveryPreparedBy?: string | null;
  // Optional so records written before Sales scheduling requests remain readable.
  deliveryScheduleRequest?: PaymentTrackScheduleRequest | null;
  // Optional so records written before installation scheduling remain readable.
  installationScheduleRequest?: PaymentTrackScheduleRequest | null;
  installationScheduledFor?: string | null;
  installationScheduledTime?: string | null;
  installationAssignee?: PaymentTrackScheduleAssignee | null;
  // Optional so projects installed before Inventory integration remain
  // readable without retroactively deducting stock a second time.
  solarPanelConsumption?: PaymentTrackSolarPanelConsumption | null;
  workMode?: PaymentTrackWorkMode | null;
};

export type CreatePaymentTrackInput = {
  quoteNumber: string;
  specialist: PaymentTrackSpecialist;
  customer: PaymentTrackCustomer;
  items: Array<Omit<PaymentTrackItem, "id">>;
  balanceDueCents: number;
  expectedDepositCents: number | null;
  stcSolarRequired: boolean;
  stcBatteryRequired: boolean;
  solarRebateRequired?: boolean;
};

export type PaymentTrackUpload = {
  bytes: Uint8Array;
  originalName: string;
  contentType: PaymentTrackUploadContentType;
  size: number;
};

export type PaymentTrackTransitionInput = {
  actorRole: PaymentTrackRole;
  actorName?: string;
  amountCents?: number;
  paymentId?: string;
  preferredDate?: string;
  preferredTime?: string;
  deliveryDate?: string;
  deliveryTime?: string;
  deliveryAssignee?: PaymentTrackScheduleAssignee;
  deliverySelections?: PaymentTrackDeliverySelection[];
  installationDate?: string;
  installationTime?: string;
  installationAssignee?: PaymentTrackScheduleAssignee;
  workMode?: PaymentTrackWorkMode;
  reason?: string;
  expectedUpdatedAt?: string;
  notes?: string;
  expectedPmNotesUpdatedAt?: string | null;
};

export type StoredPaymentTrackFile = {
  originalName: string;
  contentType: PaymentTrackUploadContentType;
  size: number;
  accessToken: string;
  read(): Promise<Uint8Array>;
};

export class PaymentTrackRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "PaymentTrackRepositoryError";
    this.status = status;
    this.code = code;
  }
}

const MIME_EXTENSIONS: Record<PaymentTrackUploadContentType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const SOLAR_REBATE_ASSESSMENT_VERSION = 1;
const SOLAR_REBATE_ASSESSMENT_RETRY_MS = 60_000;

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.PAYMENT_TRACK_DATA_DIR || path.join(process.cwd(), ".data", "payment-track"),
);
const recordsPath = path.join(dataRoot, "records.json");
const contractsPath = path.join(dataRoot, "contracts");
const proofsPath = path.join(dataRoot, "proofs");
const CLOUDFLARE_DOCUMENT_KEY = "payment-track/records";
const MAXIMUM_STORAGE_RETRIES = 5;
let mutationQueue: Promise<void> = Promise.resolve();
const solarRebateAssessmentRetries = new Map<string, {
  fileFingerprint: string;
  retryAfter: number;
}>();

function storedFileObjectKey(file: StoredFile) {
  const expectedDirectory = file.kind === "contract" ? contractsPath : proofsPath;
  if (path.basename(file.storedName) !== file.storedName || !/^[0-9a-f-]{36}\.(?:pdf|jpg|png|webp)$/.test(file.storedName)) {
    throw new PaymentTrackRepositoryError("The stored file path is invalid.", 500, "invalid_file_path");
  }
  return `payment-track/${file.kind === "contract" ? "contracts" : "proofs"}/${file.storedName}`;
}

function resolvedStoredFilePath(file: StoredFile) {
  const expectedDirectory = file.kind === "contract" ? contractsPath : proofsPath;
  storedFileObjectKey(file);
  const filePath = path.resolve(expectedDirectory, file.storedName);
  const relative = path.relative(expectedDirectory, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PaymentTrackRepositoryError("The stored file path is invalid.", 500, "invalid_file_path");
  }
  return filePath;
}

async function readStoredFileContent(file: StoredFile) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    const buffer = await bindings.files.get(storedFileObjectKey(file), "arrayBuffer");
    if (!buffer) {
      // Workers KV is eventually consistent across locations. Project metadata
      // can become visible in D1 before a newly uploaded immutable file reaches
      // the location serving this request, so expose a retryable state instead
      // of incorrectly reporting that the logical file does not exist.
      throw new PaymentTrackRepositoryError(
        "The Project Track file is still syncing. Try again shortly.",
        503,
        "file_not_ready",
      );
    }
    return {
      bytes: new Uint8Array(buffer),
      fingerprint: `${file.storedName}:${buffer.byteLength}`,
    };
  }

  const filePath = resolvedStoredFilePath(file);
  const fileStat = await stat(filePath);
  const source = await readFile(filePath);
  return {
    bytes: new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    fingerprint: `${fileStat.size}:${fileStat.mtimeMs}`,
  };
}

async function deleteStoredFile(file: StoredFile) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    await bindings.files.delete(storedFileObjectKey(file));
    return;
  }
  await unlink(resolvedStoredFilePath(file));
}

async function ensureStorage() {
  await Promise.all([
    mkdir(contractsPath, { recursive: true, mode: 0o700 }),
    mkdir(proofsPath, { recursive: true, mode: 0o700 }),
  ]);
}

async function readStoredProjectDocument(): Promise<{ projects: StoredProject[]; version: number | null }> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    const parsed = document.value ?? [];
    if (!Array.isArray(parsed)) throw new Error("Project Track data is not an array");
    return { projects: parsed as StoredProject[], version: document.version };
  }

  await ensureStorage();
  try {
    const parsed: unknown = JSON.parse(await readFile(recordsPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Project Track data is not an array");
    return { projects: parsed as StoredProject[], version: null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { projects: [], version: null };
    }
    throw error;
  }
}

async function writeStoredProjects(projects: StoredProject[], expectedVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(bindings.database, CLOUDFLARE_DOCUMENT_KEY, projects, expectedVersion);
    return;
  }

  await ensureStorage();
  const temporaryPath = path.join(dataRoot, `.records-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(projects, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, recordsPath);
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
    throw new PaymentTrackRepositoryError(
      "Project Track changed while this request was being saved. Try again.",
      409,
      "storage_conflict",
    );
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function publicFile(projectId: string, file: StoredFile | null): PaymentTrackFile | null {
  if (!file) return null;
  const { storedName: _storedName, accessToken, ...publicFields } = file;
  return {
    ...publicFields,
    url: `/api/payment-track/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}?token=${encodeURIComponent(accessToken)}`,
  };
}

function publicProject(project: StoredProject): PaymentTrackProject {
  const {
    solarRebateAssessmentVersion: _solarRebateAssessmentVersion,
    ...publicFields
  } = project;
  const finalPayments = project.finalPayments || [];
  const confirmedCents = (project.deposit.confirmedAmountCents || 0)
    + (project.collection.confirmedAmountCents || 0)
    + finalPayments.reduce((total, payment) => total + (payment.confirmedAmountCents || 0), 0);
  return {
    ...publicFields,
    contract: publicFile(project.id, project.contract),
    deposit: {
      ...project.deposit,
      acknowledgedAt: project.deposit.acknowledgedAt || null,
      acknowledgedBy: project.deposit.acknowledgedBy || null,
      reportedAmountCents: project.deposit.reportedAmountCents ?? null,
      proof: publicFile(project.id, project.deposit.proof),
    },
    collection: {
      ...project.collection,
      acknowledgedAt: project.collection.acknowledgedAt || null,
      acknowledgedBy: project.collection.acknowledgedBy || null,
      reportedAmountCents: project.collection.reportedAmountCents ?? null,
      proof: publicFile(project.id, project.collection.proof),
    },
    finalPayments: finalPayments.map((payment): PaymentTrackFinalPayment => ({
      ...payment,
      id: payment.id || payment.proof?.id || "legacy-payment",
      createdAt: payment.createdAt || payment.proof?.uploadedAt || project.completedAt || project.updatedAt,
      acknowledgedAt: payment.acknowledgedAt || null,
      acknowledgedBy: payment.acknowledgedBy || null,
      reportedAmountCents: payment.reportedAmountCents ?? null,
      proof: publicFile(project.id, payment.proof),
    })),
    solarRebateRequired: project.solarRebateRequired === true,
    solarRebateReceivedAt: typeof project.solarRebateReceivedAt === "string"
      ? project.solarRebateReceivedAt
      : null,
    pmNotes: typeof project.pmNotes === "string" ? project.pmNotes : "",
    pmNotesUpdatedAt: typeof project.pmNotesUpdatedAt === "string"
      ? project.pmNotesUpdatedAt
      : null,
    pmNotesUpdatedBy: typeof project.pmNotesUpdatedBy === "string"
      ? project.pmNotesUpdatedBy
      : null,
    deliveryScheduledFor: typeof project.deliveryScheduledFor === "string"
      && validDeliveryDate(project.deliveryScheduledFor)
      ? project.deliveryScheduledFor
      : null,
    deliveryScheduledTime: validScheduleTime(project.deliveryScheduledTime)
      ? project.deliveryScheduledTime
      : null,
    deliveryAssignee: validScheduleAssignee(project.deliveryAssignee)
      ? project.deliveryAssignee
      : null,
    deliverySelections: normalizedStoredDeliverySelections(project.deliverySelections) || [],
    deliveryPreparedAt: storedPmNotesTimestamp(project.deliveryPreparedAt)
      ? project.deliveryPreparedAt
      : null,
    deliveryPreparedBy: typeof project.deliveryPreparedBy === "string"
      ? project.deliveryPreparedBy
      : null,
    deliveryScheduleRequest: normalizedStoredScheduleRequest(project.deliveryScheduleRequest),
    installationScheduleRequest: normalizedStoredScheduleRequest(project.installationScheduleRequest),
    installationScheduledFor: typeof project.installationScheduledFor === "string"
      && validDeliveryDate(project.installationScheduledFor)
      ? project.installationScheduledFor
      : null,
    installationScheduledTime: validScheduleTime(project.installationScheduledTime)
      ? project.installationScheduledTime
      : null,
    installationAssignee: validScheduleAssignee(project.installationAssignee)
      ? project.installationAssignee
      : null,
    solarPanelConsumption: normalizedStoredSolarPanelConsumption(project.solarPanelConsumption),
    workMode: validWorkMode(project.workMode) ? project.workMode : null,
    outstandingCents: Math.max(0, project.balanceDueCents - confirmedCents),
    overpaymentCents: Math.max(0, confirmedCents - project.balanceDueCents),
  };
}

function nextReference(projects: StoredProject[], now: Date) {
  const prefix = `PAY-${now.getUTCFullYear()}-`;
  const next = projects.reduce((highest, project) => {
    if (!project.reference.startsWith(prefix)) return highest;
    const value = Number(project.reference.slice(prefix.length));
    return Number.isInteger(value) ? Math.max(highest, value) : highest;
  }, 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

function actorName(role: PaymentTrackRole, supplied?: string) {
  const value = supplied?.trim();
  if (value) return value.slice(0, 120);
  if (role === "pm") return "Project Manager";
  if (role === "admin") return "Administrator";
  return role === "sales" ? "Sales" : "Specialist";
}

function historyEntry(
  action: PaymentTrackHistoryAction,
  timestamp: string,
  role: PaymentTrackRole,
  suppliedActor?: string,
  note: string | null = null,
): PaymentTrackHistoryEntry {
  return {
    id: randomUUID(),
    action,
    at: timestamp,
    actorRole: role,
    actorName: actorName(role, suppliedActor),
    note,
  };
}

function solarRebateAssessmentIsCurrent(project: StoredProject) {
  return Number.isInteger(project.solarRebateAssessmentVersion)
    && (project.solarRebateAssessmentVersion ?? 0) >= SOLAR_REBATE_ASSESSMENT_VERSION
    && typeof project.solarRebateRequired === "boolean";
}

function storedPmNotesTimestamp(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizedStoredScheduleRequest(value: unknown): PaymentTrackScheduleRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<Record<keyof PaymentTrackScheduleRequest, unknown>>;
  if (!validDeliveryDate(candidate.preferredDate)
    || !validScheduleTime(candidate.preferredTime)
    || typeof candidate.notes !== "string"
    || candidate.notes.length > 2_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(candidate.notes)
    || !storedPmNotesTimestamp(candidate.submittedAt)
    || typeof candidate.submittedBy !== "string"
    || !candidate.submittedBy.trim()
    || candidate.submittedBy.trim().length > 120
    || /[\u0000-\u001F\u007F]/.test(candidate.submittedBy)) return null;
  return {
    preferredDate: candidate.preferredDate,
    preferredTime: candidate.preferredTime,
    notes: candidate.notes.trim(),
    submittedAt: candidate.submittedAt,
    submittedBy: candidate.submittedBy.trim(),
  };
}

function normalizedStoredSolarPanelConsumption(
  value: unknown,
): PaymentTrackSolarPanelConsumption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<Record<keyof PaymentTrackSolarPanelConsumption, unknown>>;
  if (!storedPmNotesTimestamp(candidate.recordedAt)
    || typeof candidate.recordedBy !== "string"
    || !candidate.recordedBy.trim()
    || candidate.recordedBy.trim().length > 120
    || /[\u0000-\u001F\u007F]/.test(candidate.recordedBy)
    || !Array.isArray(candidate.items)
    || !candidate.items.length
    || candidate.items.length > 100) return null;

  const items = candidate.items.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as { sku?: unknown; quantity?: unknown; sourceItemIds?: unknown };
    if (typeof item.sku !== "string"
      || !item.sku.trim()
      || item.sku.trim().length > 160
      || /[\u0000-\u001F\u007F]/.test(item.sku)
      || !Number.isSafeInteger(item.quantity)
      || (item.quantity as number) < 1
      || (item.quantity as number) > 1_000_000
      || !Array.isArray(item.sourceItemIds)
      || !item.sourceItemIds.length
      || item.sourceItemIds.length > 100
      || item.sourceItemIds.some((id) => typeof id !== "string"
        || !id.trim()
        || id.length > 160
        || /[\u0000-\u001F\u007F]/.test(id))) return null;
    return {
      sku: item.sku.trim(),
      quantity: item.quantity as number,
      sourceItemIds: [...new Set(item.sourceItemIds.map((id) => (id as string).trim()))],
    };
  });
  if (items.some((item) => item === null)) return null;
  const validItems = items as PaymentTrackSolarPanelConsumption["items"];
  if (new Set(validItems.map((item) => item.sku.toLocaleLowerCase("en-AU"))).size !== validItems.length) {
    return null;
  }
  return {
    recordedAt: candidate.recordedAt,
    recordedBy: candidate.recordedBy.trim(),
    items: validItems,
  };
}

function isSolarPanelSystemItem(item: PaymentTrackItem) {
  const category = item.category.trim().toLocaleLowerCase("en-AU").replace(/\s+/g, " ");
  return category === "solar panel"
    || category === "solar panels"
    || category === "太阳能板";
}

function recordSolarPanelConsumption(
  project: StoredProject,
  timestamp: string,
  role: PaymentTrackRole,
  actor: string,
) {
  if (normalizedStoredSolarPanelConsumption(project.solarPanelConsumption)) return;
  const grouped = new Map<string, {
    sku: string;
    quantity: number;
    sourceItemIds: string[];
  }>();
  for (const item of project.items) {
    if (!isSolarPanelSystemItem(item)) continue;
    const sku = (item.model.trim() || item.description.trim()).slice(0, 160);
    if (!sku || !Number.isSafeInteger(item.quantity) || item.quantity < 1) continue;
    const key = sku.toLocaleLowerCase("en-AU");
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      existing.sourceItemIds.push(item.id);
    } else {
      grouped.set(key, { sku, quantity: item.quantity, sourceItemIds: [item.id] });
    }
  }
  const items = [...grouped.values()];
  if (!items.length) return;
  project.solarPanelConsumption = {
    recordedAt: timestamp,
    recordedBy: actor,
    items,
  };
  project.history.push(historyEntry(
    "solar_panel_consumption_recorded",
    timestamp,
    role,
    actor,
    items.map((item) => `${item.sku} × ${item.quantity}`).join("; "),
  ));
}

async function migrateLegacyProjectStages(projects: StoredProject[], fallbackTimestamp: string) {
  let changed = false;
  for (const project of projects) {
    const legacyStage = project.stage;
    if (legacyStage === "material_delivery" || legacyStage === "installing") {
      project.stage = "working_in_progress";
      project.workMode = legacyStage === "installing" ? "installation_only" : "delivery_only";
      changed = true;
    } else if (!validWorkMode(project.workMode) && project.workMode !== null) {
      project.workMode = null;
      changed = true;
    } else if (project.workMode === undefined) {
      project.workMode = project.stage === "working_in_progress"
        ? project.installationScheduledFor ? "installation_only" : project.deliveryScheduledFor ? "delivery_only" : null
        : null;
      changed = true;
    }
    const receipts: StoredReceipt[] = [
      project.deposit,
      project.collection,
      ...(project.finalPayments || []),
    ];
    for (const receipt of receipts) {
      if (receipt.reportedAmountCents !== null
        && (!Number.isSafeInteger(receipt.reportedAmountCents) || (receipt.reportedAmountCents ?? -1) < 0)) {
        receipt.reportedAmountCents = null;
        changed = true;
      } else if (receipt.reportedAmountCents === undefined) {
        receipt.reportedAmountCents = null;
        changed = true;
      }
    }
    if (typeof project.pmNotes !== "string") {
      project.pmNotes = "";
      changed = true;
    }
    if (project.pmNotesUpdatedAt !== null && !storedPmNotesTimestamp(project.pmNotesUpdatedAt)) {
      project.pmNotesUpdatedAt = null;
      changed = true;
    }
    if (project.pmNotesUpdatedBy !== null && typeof project.pmNotesUpdatedBy !== "string") {
      project.pmNotesUpdatedBy = null;
      changed = true;
    }
    if (project.installationScheduledFor !== null && !validDeliveryDate(project.installationScheduledFor)) {
      project.installationScheduledFor = null;
      changed = true;
    }
    if (project.deliveryScheduledFor !== null && !validDeliveryDate(project.deliveryScheduledFor)) {
      project.deliveryScheduledFor = null;
      changed = true;
    }
    if (project.deliveryScheduledTime !== null && !validScheduleTime(project.deliveryScheduledTime)) {
      project.deliveryScheduledTime = null;
      changed = true;
    }
    if (project.deliveryAssignee !== null && !validScheduleAssignee(project.deliveryAssignee)) {
      project.deliveryAssignee = null;
      changed = true;
    }
    const normalizedSelections = normalizedStoredDeliverySelections(project.deliverySelections);
    if (!normalizedSelections) {
      const selectionsAreCanonicalEmpty = Array.isArray(project.deliverySelections)
        && project.deliverySelections.length === 0;
      const preparationIsCanonicalEmpty = project.deliveryPreparedAt === null
        && project.deliveryPreparedBy === null;
      if (!selectionsAreCanonicalEmpty || !preparationIsCanonicalEmpty) {
        project.deliverySelections = [];
        project.deliveryPreparedAt = null;
        project.deliveryPreparedBy = null;
        changed = true;
      }
    } else if (JSON.stringify(project.deliverySelections) !== JSON.stringify(normalizedSelections)) {
      project.deliverySelections = normalizedSelections;
      changed = true;
    }
    if (!normalizedSelections
      && project.deliveryScheduleRequest !== null
      && project.deliveryScheduleRequest !== undefined) {
      project.deliveryScheduleRequest = null;
      changed = true;
    }
    if (project.deliveryPreparedAt !== null && !storedPmNotesTimestamp(project.deliveryPreparedAt)) {
      project.deliveryPreparedAt = null;
      changed = true;
    }
    if (project.deliveryPreparedBy !== null && typeof project.deliveryPreparedBy !== "string") {
      project.deliveryPreparedBy = null;
      changed = true;
    }
    const normalizedDeliveryRequest = normalizedStoredScheduleRequest(project.deliveryScheduleRequest);
    if (!normalizedDeliveryRequest) {
      if (project.deliveryScheduleRequest !== null) {
        project.deliveryScheduleRequest = null;
        changed = true;
      }
    } else if (JSON.stringify(project.deliveryScheduleRequest) !== JSON.stringify(normalizedDeliveryRequest)) {
      project.deliveryScheduleRequest = normalizedDeliveryRequest;
      changed = true;
    }
    const normalizedInstallationRequest = normalizedStoredScheduleRequest(project.installationScheduleRequest);
    if (!normalizedInstallationRequest) {
      if (project.installationScheduleRequest !== null) {
        project.installationScheduleRequest = null;
        changed = true;
      }
    } else if (JSON.stringify(project.installationScheduleRequest) !== JSON.stringify(normalizedInstallationRequest)) {
      project.installationScheduleRequest = normalizedInstallationRequest;
      changed = true;
    }
    if (project.installationScheduledTime !== null && !validScheduleTime(project.installationScheduledTime)) {
      project.installationScheduledTime = null;
      changed = true;
    }
    if (project.installationAssignee !== null && !validScheduleAssignee(project.installationAssignee)) {
      project.installationAssignee = null;
      changed = true;
    }
    const normalizedConsumption = normalizedStoredSolarPanelConsumption(project.solarPanelConsumption);
    if (!normalizedConsumption) {
      if (project.solarPanelConsumption !== null) {
        project.solarPanelConsumption = null;
        changed = true;
      }
    } else if (JSON.stringify(project.solarPanelConsumption) !== JSON.stringify(normalizedConsumption)) {
      project.solarPanelConsumption = normalizedConsumption;
      changed = true;
    }
    if (project.solarRebateReceivedAt !== null && typeof project.solarRebateReceivedAt !== "string") {
      project.solarRebateReceivedAt = null;
      changed = true;
    }

    if (!solarRebateAssessmentIsCurrent(project)) {
      if (!project.contract) {
        if (typeof project.solarRebateRequired !== "boolean") {
          project.solarRebateRequired = false;
        }
        project.solarRebateAssessmentVersion = SOLAR_REBATE_ASSESSMENT_VERSION;
        changed = true;
      } else {
        let fileFingerprint: string;
        let contractBytes: Uint8Array;
        try {
          const storedContract = await readStoredFileContent(project.contract);
          contractBytes = storedContract.bytes;
          fileFingerprint = storedContract.fingerprint;
        } catch {
          solarRebateAssessmentRetries.set(project.id, {
            fileFingerprint: `unavailable:${project.contract.storedName}`,
            retryAfter: Date.now() + SOLAR_REBATE_ASSESSMENT_RETRY_MS,
          });
          continue;
        }

        const retry = solarRebateAssessmentRetries.get(project.id);
        if (retry?.fileFingerprint === fileFingerprint && retry.retryAfter > Date.now()) continue;

        let required: boolean | null;
        try {
          required = await paymentAgreementRequiresSolarRebatePdf(contractBytes);
        } catch {
          solarRebateAssessmentRetries.set(project.id, {
            fileFingerprint,
            retryAfter: Date.now() + SOLAR_REBATE_ASSESSMENT_RETRY_MS,
          });
          continue;
        }
        if (required === null) {
          solarRebateAssessmentRetries.set(project.id, {
            fileFingerprint,
            retryAfter: Date.now() + SOLAR_REBATE_ASSESSMENT_RETRY_MS,
          });
          continue;
        }

        solarRebateAssessmentRetries.delete(project.id);
        const previouslyRequired = project.solarRebateRequired === true;
        project.solarRebateRequired = required;
        project.solarRebateAssessmentVersion = SOLAR_REBATE_ASSESSMENT_VERSION;
        changed = true;

        if (required !== previouslyRequired) {
          project.updatedAt = fallbackTimestamp;
        }
        const reopened = required
          && project.stage === "done"
          && !project.solarRebateReceivedAt;
        if (reopened) {
          project.stage = "stc_rebate";
          project.completedAt = null;
          project.updatedAt = fallbackTimestamp;
        }
        if (required && (!previouslyRequired || reopened)) {
          project.history.push(historyEntry(
            "solar_rebate_requirement_backfilled",
            fallbackTimestamp,
            "admin",
            "System",
            reopened
              ? "The contract requires Solar Rebate confirmation, so this project was reopened."
              : "The contract requires separate Solar Rebate confirmation.",
          ));
        }
      }
    }

    if (!solarRebateAssessmentIsCurrent(project)) continue;
    if (project.stage === "waiting_coes" && project.coesReceivedAt) {
      advancePastWaitingCoes(project, project.coesReceivedAt, "admin", "System");
      changed = true;
    }
    if (project.stage !== "stc_rebate" || !rebateRequirementsComplete(project)) continue;
    const completedAt = project.completedAt || project.coesReceivedAt || project.updatedAt || fallbackTimestamp;
    completeProjectIfRequirementsMet(project, completedAt, "admin", "System");
    changed = true;
  }
  return changed;
}

async function storedUpload(
  kind: StoredFile["kind"],
  role: PaymentTrackRole,
  upload: PaymentTrackUpload,
  timestamp: string,
) {
  const id = randomUUID();
  const storedName = `${randomUUID()}.${MIME_EXTENSIONS[upload.contentType]}`;
  const file = {
    id,
    kind,
    originalName: upload.originalName,
    contentType: upload.contentType,
    size: upload.size,
    uploadedAt: timestamp,
    uploadedByRole: role,
    storedName,
    accessToken: randomBytes(24).toString("base64url"),
  } satisfies StoredFile;
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    await bindings.files.put(storedFileObjectKey(file), upload.bytes);
  } else {
    const directory = kind === "contract" ? contractsPath : proofsPath;
    const filePath = path.join(/* turbopackIgnore: true */ directory, storedName);
    await writeFile(filePath, upload.bytes, { flag: "wx", mode: 0o600 });
  }
  return {
    file,
  };
}

function buildProject(
  projects: StoredProject[],
  input: CreatePaymentTrackInput,
  timestamp: string,
  contract: StoredFile | null,
): StoredProject {
  const now = new Date(timestamp);
  return {
    id: randomUUID(),
    reference: nextReference(projects, now),
    quoteNumber: input.quoteNumber,
    specialist: input.specialist,
    customer: input.customer,
    items: input.items.map((item) => ({ ...item, id: randomUUID() })),
    currency: "AUD",
    balanceDueCents: input.balanceDueCents,
    expectedDepositCents: input.expectedDepositCents,
    stage: "deposit_not_paid",
    workMode: null,
    contract,
    deposit: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      reportedAmountCents: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    deliveryScheduledFor: null,
    deliveryScheduledTime: null,
    deliveryAssignee: null,
    deliverySelections: [],
    deliveryPreparedAt: null,
    deliveryPreparedBy: null,
    deliveryScheduleRequest: null,
    deliveredAt: null,
    collection: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      reportedAmountCents: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    installationScheduleRequest: null,
    installationScheduledFor: null,
    installationScheduledTime: null,
    installationAssignee: null,
    solarPanelConsumption: null,
    finalPayments: [],
    installedAt: null,
    coesReceivedAt: null,
    stcSolarRequired: input.stcSolarRequired,
    stcBatteryRequired: input.stcBatteryRequired,
    solarRebateRequired: input.solarRebateRequired === true,
    stcSolarReceivedAt: null,
    stcBatteryReceivedAt: null,
    solarRebateReceivedAt: null,
    solarRebateAssessmentVersion: SOLAR_REBATE_ASSESSMENT_VERSION,
    pmNotes: "",
    pmNotesUpdatedAt: null,
    pmNotesUpdatedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    history: [],
  };
}

function assertProposalNumberAvailable(projects: StoredProject[], quoteNumber: string) {
  const normalizedQuoteNumber = quoteNumber.trim().toLocaleLowerCase("en-AU");
  if (projects.some((project) => (
    project.quoteNumber.trim().toLocaleLowerCase("en-AU") === normalizedQuoteNumber
  ))) {
    throw new PaymentTrackRepositoryError("A project with this Proposal Number already exists.", 409, "duplicate_quote");
  }
}

export function listPaymentTrackProjects() {
  return withMutation(async () => {
    const storedDocument = await readStoredProjectDocument();
    const projects = storedDocument.projects;
    if (await migrateLegacyProjectStages(projects, new Date().toISOString())) {
      await writeStoredProjects(projects, storedDocument.version);
    }
    return projects
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(publicProject);
  });
}

export function createManualPaymentTrackProject(input: CreatePaymentTrackInput) {
  return withMutation(async () => {
    const storedDocument = await readStoredProjectDocument();
    const projects = storedDocument.projects;
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    assertProposalNumberAvailable(projects, input.quoteNumber);
    const timestamp = new Date().toISOString();
    const project = buildProject(projects, input, timestamp, null);
    project.history.push(historyEntry("created_manually", timestamp, "sales"));
    projects.push(project);
    await writeStoredProjects(projects, storedDocument.version);
    return publicProject(project);
  });
}

export function createImportedPaymentTrackProject(
  input: CreatePaymentTrackInput,
  upload: PaymentTrackUpload,
) {
  return withMutation(async () => {
    const storedDocument = await readStoredProjectDocument();
    const projects = storedDocument.projects;
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    assertProposalNumberAvailable(projects, input.quoteNumber);
    const timestamp = new Date().toISOString();
    const stored = await storedUpload("contract", "sales", upload, timestamp);
    const project = buildProject(projects, input, timestamp, stored.file);
    project.history.push(historyEntry("contract_imported", timestamp, "sales", undefined, upload.originalName));
    try {
      projects.push(project);
      await writeStoredProjects(projects, storedDocument.version);
    } catch (error) {
      await deleteStoredFile(stored.file).catch(() => undefined);
      throw error;
    }
    return publicProject(project);
  });
}

export function deletePaymentTrackProject(id: string) {
  return withMutation(async () => {
    const storedDocument = await readStoredProjectDocument();
    const projects = storedDocument.projects;
    const index = projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new PaymentTrackRepositoryError("Project not found.", 404, "not_found");

    const [deleted] = projects.splice(index, 1);
    const finalPaymentProofs = (deleted.finalPayments || []).map((payment) => payment.proof);
    const files = [
      deleted.contract,
      deleted.deposit.proof,
      deleted.collection.proof,
      ...finalPaymentProofs,
    ].filter(Boolean) as StoredFile[];
    const uniqueFiles = new Map<string, StoredFile>();
    for (const file of files) {
      const namespace = file.kind === "contract" ? "contracts" : "proofs";
      uniqueFiles.set(`${namespace}:${file.storedName}`, file);
    }

    // Commit the record deletion first. If the D1 CAS fails, every attachment
    // remains reachable from the still-live project and the mutation can retry.
    await writeStoredProjects(projects, storedDocument.version);
    solarRebateAssessmentRetries.delete(id);
    await Promise.allSettled([...uniqueFiles.values()].map((file) => deleteStoredFile(file)));
    return publicProject(deleted);
  });
}

export function uploadPaymentTrackProof(
  id: string,
  kind: "deposit",
  role: PaymentTrackRole,
  upload: PaymentTrackUpload,
) {
  return withMutation(async () => {
    const storedDocument = await readStoredProjectDocument();
    const projects = storedDocument.projects;
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    const index = projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new PaymentTrackRepositoryError("Project not found.", 404, "not_found");
    const project = projects[index];

    if (role !== "sales") throw new PaymentTrackRepositoryError("Only Sales can upload deposit proof.", 403, "role_forbidden");
    if (project.stage !== "deposit_not_paid" || project.deposit.acknowledgedAt || project.deposit.confirmedAt) {
      throw new PaymentTrackRepositoryError("Deposit proof can no longer be changed.", 409, "invalid_transition");
    }

    const previous = project.deposit.proof;
    const timestamp = new Date().toISOString();
    const stored = await storedUpload("deposit_proof", role, upload, timestamp);
    project.deposit.proof = stored.file;
    project.updatedAt = timestamp;
    project.history.push(historyEntry("deposit_proof_uploaded", timestamp, role, undefined, upload.originalName));

    try {
      projects[index] = project;
      await writeStoredProjects(projects, storedDocument.version);
    } catch (error) {
      await deleteStoredFile(stored.file).catch(() => undefined);
      throw error;
    }
    if (previous) await deleteStoredFile(previous).catch(() => undefined);
    return publicProject(project);
  });
}

function requireRole(actual: PaymentTrackRole, allowed: PaymentTrackRole[], message: string) {
  if (!allowed.includes(actual)) throw new PaymentTrackRepositoryError(message, 403, "role_forbidden");
}

function validateNonNegativeAmount(value: number | undefined) {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0 || (value ?? 0) > 100_000_000_000) {
    throw new PaymentTrackRepositoryError("Enter a valid non-negative amount.", 400, "invalid_amount");
  }
  return value as number;
}

function validDeliveryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validScheduleTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validScheduleAssignee(value: unknown): value is PaymentTrackScheduleAssignee {
  return typeof value === "string"
    && PAYMENT_TRACK_SCHEDULE_ASSIGNEES.includes(value as PaymentTrackScheduleAssignee);
}

function validWorkMode(value: unknown): value is PaymentTrackWorkMode {
  return typeof value === "string"
    && PAYMENT_TRACK_WORK_MODES.includes(value as PaymentTrackWorkMode);
}

function deliveryScheduleIsComplete(project: StoredProject) {
  return validDeliveryDate(project.deliveryScheduledFor)
    && validScheduleTime(project.deliveryScheduledTime)
    && validScheduleAssignee(project.deliveryAssignee);
}

function normalizedStoredDeliverySelections(value: unknown): PaymentTrackDeliverySelection[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const quantities = new Map<string, number>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry as { sku?: unknown; quantity?: unknown };
    // The first picker stored null rows for order lines that were not supplied
    // from the warehouse. Ignore those rows while migrating to the independent
    // chosen-item list.
    if (candidate.sku === null && candidate.quantity === 0) {
      continue;
    }
    if (typeof candidate.sku !== "string"
      || !candidate.sku.trim()
      || candidate.sku.length > 160
      || /[\u0000-\u001F\u007F]/.test(candidate.sku)
      || typeof candidate.quantity !== "number"
      || !Number.isInteger(candidate.quantity)
      || candidate.quantity < 1
      || candidate.quantity > 100_000) return null;
    const sku = candidate.sku.trim();
    const total = (quantities.get(sku) || 0) + (candidate.quantity as number);
    if (total > 100_000) return null;
    quantities.set(sku, total);
  }
  if (!quantities.size) return null;
  return [...quantities].map(([sku, quantity]) => ({ sku, quantity }));
}

function validStoredDeliverySelections(value: unknown): value is PaymentTrackDeliverySelection[] {
  return normalizedStoredDeliverySelections(value) !== null;
}

function normalizedDeliverySelections(
  value: PaymentTrackDeliverySelection[] | undefined,
) {
  const normalized = normalizedStoredDeliverySelections(value);
  if (!normalized) {
    throw new PaymentTrackRepositoryError(
      "Choose one or more valid warehouse SKU and quantity lines.",
      400,
      "invalid_delivery_items",
    );
  }
  return normalized;
}

function normalizedScheduleRequestNotes(value: string | undefined) {
  if (value !== undefined && typeof value !== "string") {
    throw new PaymentTrackRepositoryError(
      "Scheduling preference notes must be text when provided.",
      400,
      "invalid_schedule_request_notes",
    );
  }
  const notes = value?.trim() || "";
  if (notes.length > 2_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(notes)) {
    throw new PaymentTrackRepositoryError(
      "Scheduling preference notes must be 2,000 characters or fewer.",
      400,
      "invalid_schedule_request_notes",
    );
  }
  return notes;
}

function scheduleRequest(
  preferredDate: string | undefined,
  preferredTime: string | undefined,
  notes: string | undefined,
  timestamp: string,
  submittedBy: string,
): PaymentTrackScheduleRequest {
  if (!validDeliveryDate(preferredDate) || !validScheduleTime(preferredTime)) {
    throw new PaymentTrackRepositoryError(
      "Choose a valid preferred date and time.",
      400,
      "invalid_schedule_request",
    );
  }
  return {
    preferredDate,
    preferredTime,
    notes: normalizedScheduleRequestNotes(notes),
    submittedAt: timestamp,
    submittedBy,
  };
}

function deliveryPreScheduleIsComplete(project: StoredProject) {
  return normalizedStoredScheduleRequest(project.deliveryScheduleRequest) !== null
    && validStoredDeliverySelections(project.deliverySelections);
}

function installationPreScheduleIsComplete(project: StoredProject) {
  return normalizedStoredScheduleRequest(project.installationScheduleRequest) !== null;
}

function requireCurrentProjectVersion(project: StoredProject, expectedUpdatedAt: string | undefined) {
  if (!expectedUpdatedAt || expectedUpdatedAt !== project.updatedAt) {
    throw new PaymentTrackRepositoryError(
      "This project changed after you opened it. Reload and review the latest scheduling request before saving.",
      409,
      "stale_project",
    );
  }
}

function installationScheduleIsComplete(project: StoredProject) {
  return validDeliveryDate(project.installationScheduledFor)
    && validScheduleTime(project.installationScheduledTime)
    && validScheduleAssignee(project.installationAssignee);
}

function workScheduleIsComplete(project: StoredProject) {
  if (project.workMode === "delivery_only") return deliveryScheduleIsComplete(project);
  if (project.workMode === "installation_only") return installationScheduleIsComplete(project);
  return project.workMode === "delivery_and_installation"
    && deliveryScheduleIsComplete(project)
    && installationScheduleIsComplete(project)
    && project.deliveryScheduledFor === project.installationScheduledFor
    && project.deliveryScheduledTime === project.installationScheduledTime;
}

function pendingReportedPaymentCents(project: StoredProject) {
  return (project.finalPayments || []).reduce((total, payment) => (
    payment.confirmedAt ? total : total + (payment.reportedAmountCents || 0)
  ), 0);
}

function paymentCanBeRecorded(project: StoredProject) {
  return project.stage !== "deposit_not_paid" && publicProject(project).outstandingCents > 0;
}

function nextProjectTimestamp(project: StoredProject) {
  const previous = [project.updatedAt, project.pmNotesUpdatedAt]
    .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return new Date(Math.max(Date.now(), ...previous.map((value) => value + 1))).toISOString();
}

function normalizedPmNotes(value: string | undefined) {
  if (typeof value !== "string") {
    throw new PaymentTrackRepositoryError("PM notes are required.", 400, "invalid_pm_notes");
  }
  const notes = value.trim();
  if (notes.length > 5_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(notes)) {
    throw new PaymentTrackRepositoryError("PM notes must be 5,000 characters or fewer.", 400, "invalid_pm_notes");
  }
  return notes;
}

function normalizedStageSkipReason(value: string | undefined) {
  if (typeof value !== "string") {
    throw new PaymentTrackRepositoryError(
      "A reason is required for an Administrator stage override.",
      400,
      "invalid_skip_reason",
    );
  }
  const reason = value.trim();
  if (!reason
    || reason.length > PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(reason)) {
    throw new PaymentTrackRepositoryError(
      `The stage override reason must be between 1 and ${PAYMENT_TRACK_STAGE_SKIP_REASON_MAX_LENGTH} characters.`,
      400,
      "invalid_skip_reason",
    );
  }
  return reason;
}

function rebateRequirementsComplete(project: StoredProject) {
  const solarStcComplete = !project.stcSolarRequired || Boolean(project.stcSolarReceivedAt);
  const batteryStcComplete = !project.stcBatteryRequired || Boolean(project.stcBatteryReceivedAt);
  const solarRebateComplete = !project.solarRebateRequired || Boolean(project.solarRebateReceivedAt);
  return solarStcComplete && batteryStcComplete && solarRebateComplete;
}

function completeProjectIfRequirementsMet(
  project: StoredProject,
  timestamp: string,
  actorRole: PaymentTrackRole,
  actor: string,
) {
  if (!rebateRequirementsComplete(project)) return false;
  const lastCompletedIndex = project.history.findLastIndex((entry) => entry.action === "completed");
  const lastBackfillIndex = project.history.findLastIndex(
    (entry) => entry.action === "solar_rebate_requirement_backfilled",
  );
  project.stage = "done";
  project.completedAt ||= timestamp;
  if (lastCompletedIndex < lastBackfillIndex || lastCompletedIndex < 0) {
    project.history.push(historyEntry("completed", project.completedAt, actorRole, actor));
  }
  return true;
}

function advancePastWaitingCoes(
  project: StoredProject,
  timestamp: string,
  actorRole: PaymentTrackRole,
  actor: string,
) {
  if (!completeProjectIfRequirementsMet(project, timestamp, actorRole, actor)) {
    project.stage = "stc_rebate";
  }
}

export function transitionPaymentTrackProject(
  id: string,
  action: PaymentTrackAction,
  input: PaymentTrackTransitionInput,
) {
  return withMutation(async () => {
    const storedDocument = await readStoredProjectDocument();
    const projects = storedDocument.projects;
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    const index = projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new PaymentTrackRepositoryError("Project not found.", 404, "not_found");
    const project = projects[index];
    const wasInstalled = Boolean(project.installedAt);
    if (!solarRebateAssessmentIsCurrent(project) && action !== "update_pm_notes") {
      throw new PaymentTrackRepositoryError(
        "The contract Solar Rebate requirement could not be verified. Try again before updating this project.",
        409,
        "solar_rebate_assessment_pending",
      );
    }
    // updatedAt is also the optimistic-concurrency version for high-impact
    // Administrator overrides, so every mutation must advance it even when two
    // requests are serialized within the same millisecond.
    const timestamp = nextProjectTimestamp(project);
    const actor = actorName(input.actorRole, input.actorName);

    if (action === "update_pm_notes") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can update PM notes.");
      const notes = normalizedPmNotes(input.notes);
      if (input.expectedPmNotesUpdatedAt === undefined) {
        throw new PaymentTrackRepositoryError(
          "The PM notes version is required.",
          400,
          "invalid_pm_notes_version",
        );
      }
      const currentVersion = project.pmNotesUpdatedAt || null;
      if (input.expectedPmNotesUpdatedAt !== currentVersion) {
        throw new PaymentTrackRepositoryError(
          "PM notes changed after you opened this project. Reload them before saving.",
          409,
          "pm_notes_conflict",
        );
      }
      project.pmNotes = notes;
      project.pmNotesUpdatedAt = timestamp;
      project.pmNotesUpdatedBy = actor;
      project.history.push(historyEntry("pm_notes_updated", timestamp, "pm", actor));
    } else if (action === "acknowledge_deposit") {
      requireRole(input.actorRole, ["sales"], "Only Sales can confirm that the deposit was paid.");
      if (project.stage !== "deposit_not_paid"
        || project.deposit.proof
        || project.deposit.acknowledgedAt
        || project.deposit.confirmedAt) {
        throw new PaymentTrackRepositoryError(
          "The deposit can only be confirmed without proof once while it is awaiting payment.",
          409,
          "invalid_transition",
        );
      }
      project.deposit.acknowledgedAt = timestamp;
      project.deposit.acknowledgedBy = actor;
      project.history.push(historyEntry("deposit_acknowledged", timestamp, "sales", actor, "Paid confirmed without uploaded proof"));
    } else if (action === "confirm_deposit") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can confirm a deposit.");
      const submittedForReview = Boolean(project.deposit.proof || project.deposit.acknowledgedAt);
      if (project.stage !== "deposit_not_paid" || !submittedForReview || project.deposit.confirmedAt) {
        throw new PaymentTrackRepositoryError("Sales must upload deposit proof or confirm payment before the deposit is recorded.", 409, "invalid_transition");
      }
      const amount = validateNonNegativeAmount(input.amountCents);
      project.deposit.confirmedAmountCents = amount;
      project.deposit.confirmedAt = timestamp;
      project.deposit.confirmedBy = actor;
      project.stage = "working_in_progress";
      project.workMode = null;
      project.history.push(historyEntry("deposit_confirmed", timestamp, "admin", actor, `AUD ${(amount / 100).toFixed(2)}`));
    } else if (action === "schedule_work") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can schedule work.");
      requireCurrentProjectVersion(project, input.expectedUpdatedAt);
      const mode = input.workMode;
      const includesDelivery = mode === "delivery_only" || mode === "delivery_and_installation";
      const includesInstallation = mode === "installation_only" || mode === "delivery_and_installation";
      if (project.stage !== "working_in_progress"
        || !validWorkMode(mode)
        || !validDeliveryDate(input.deliveryDate)
        || !validScheduleTime(input.deliveryTime)
        || (includesDelivery && (!validScheduleAssignee(input.deliveryAssignee) || project.deliveredAt))
        || (includesInstallation && (!validScheduleAssignee(input.installationAssignee) || project.installedAt))) {
        throw new PaymentTrackRepositoryError(
          "Choose a valid work type, date, time and required team members.",
          409,
          "invalid_transition",
        );
      }
      if (includesDelivery) {
        project.deliverySelections = normalizedDeliverySelections(input.deliverySelections);
        project.deliveryPreparedAt = timestamp;
        project.deliveryPreparedBy = actor;
        project.deliveryScheduledFor = input.deliveryDate;
        project.deliveryScheduledTime = input.deliveryTime;
        project.deliveryAssignee = input.deliveryAssignee || null;
      } else {
        if (!project.deliveredAt) {
          project.deliveryScheduledFor = null;
          project.deliveryScheduledTime = null;
          project.deliveryAssignee = null;
        }
      }
      if (includesInstallation) {
        project.installationScheduledFor = input.deliveryDate;
        project.installationScheduledTime = input.deliveryTime;
        project.installationAssignee = input.installationAssignee || null;
      } else {
        if (!project.installedAt) {
          project.installationScheduledFor = null;
          project.installationScheduledTime = null;
          project.installationAssignee = null;
        }
      }
      project.deliveryScheduleRequest = null;
      project.installationScheduleRequest = null;
      project.workMode = mode;
      project.history.push(historyEntry(
        "work_scheduled",
        timestamp,
        "pm",
        actor,
        `${mode} · ${input.deliveryDate} ${input.deliveryTime}`,
      ));
    } else if (action === "mark_work_completed") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can complete scheduled work.");
      if (project.stage !== "working_in_progress" || !workScheduleIsComplete(project)) {
        throw new PaymentTrackRepositoryError("Schedule the work before marking it complete.", 409, "invalid_transition");
      }
      const mode = project.workMode;
      if ((mode === "delivery_only" || mode === "delivery_and_installation") && project.deliveredAt) {
        throw new PaymentTrackRepositoryError("Delivery is already complete.", 409, "invalid_transition");
      }
      if ((mode === "installation_only" || mode === "delivery_and_installation") && project.installedAt) {
        throw new PaymentTrackRepositoryError("Installation is already complete.", 409, "invalid_transition");
      }
      if (mode === "delivery_only" || mode === "delivery_and_installation") project.deliveredAt = timestamp;
      if (mode === "installation_only" || mode === "delivery_and_installation") {
        project.installedAt = timestamp;
        project.stage = "waiting_coes";
      }
      project.history.push(historyEntry("work_completed", timestamp, "pm", actor, mode));
    } else if (action === "prepare_delivery") {
      requireRole(input.actorRole, ["sales"], "Only Sales can prepare delivery items.");
      if (!["material_delivery", "working_in_progress"].includes(project.stage)
        || project.deliveredAt
        || deliveryScheduleIsComplete(project)
        || normalizedStoredScheduleRequest(project.deliveryScheduleRequest)) {
        throw new PaymentTrackRepositoryError(
          "Warehouse items can only be prepared before Sales submits the delivery request.",
          409,
          "invalid_transition",
        );
      }
      requireCurrentProjectVersion(project, input.expectedUpdatedAt);
      project.deliverySelections = normalizedDeliverySelections(input.deliverySelections);
      project.deliveryPreparedAt = timestamp;
      project.deliveryPreparedBy = actor;
      const selectedCount = project.deliverySelections.length;
      project.history.push(historyEntry(
        "delivery_items_prepared",
        timestamp,
        "sales",
        actor,
        `${selectedCount} warehouse item ${selectedCount === 1 ? "line" : "lines"} prepared`,
      ));
    } else if (action === "pre_schedule_delivery") {
      requireRole(input.actorRole, ["sales"], "Only Sales can submit a delivery scheduling request.");
      if (!["material_delivery", "working_in_progress"].includes(project.stage)
        || project.deliveredAt
        || deliveryScheduleIsComplete(project)) {
        throw new PaymentTrackRepositoryError(
          "A delivery request can only be submitted before the Project Manager schedules delivery.",
          409,
          "invalid_transition",
        );
      }
      requireCurrentProjectVersion(project, input.expectedUpdatedAt);
      project.deliverySelections = normalizedDeliverySelections(input.deliverySelections);
      project.deliveryPreparedAt = timestamp;
      project.deliveryPreparedBy = actor;
      project.deliveryScheduleRequest = scheduleRequest(
        input.preferredDate,
        input.preferredTime,
        input.notes,
        timestamp,
        actor,
      );
      // Clear any incomplete legacy final schedule so it cannot be mistaken for
      // the Project Manager's confirmation of this new Sales request.
      project.deliveryScheduledFor = null;
      project.deliveryScheduledTime = null;
      project.deliveryAssignee = null;
      const selectedCount = project.deliverySelections.length;
      project.history.push(historyEntry(
        "delivery_pre_scheduled",
        timestamp,
        "sales",
        actor,
        `${input.preferredDate} ${input.preferredTime} · ${selectedCount} chosen warehouse ${selectedCount === 1 ? "line" : "lines"}`,
      ));
    } else if (action === "schedule_delivery") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can schedule delivery.");
      requireCurrentProjectVersion(project, input.expectedUpdatedAt);
      if (!["material_delivery", "working_in_progress"].includes(project.stage)
        || project.deliveredAt
        || (!deliveryPreScheduleIsComplete(project) && !deliveryScheduleIsComplete(project))
        || !validDeliveryDate(input.deliveryDate)
        || !validScheduleTime(input.deliveryTime)
        || !validScheduleAssignee(input.deliveryAssignee)) {
        throw new PaymentTrackRepositoryError("Prepare warehouse items, then choose a valid delivery date, time and assignee.", 409, "invalid_transition");
      }
      project.deliveryScheduledFor = input.deliveryDate || null;
      project.deliveryScheduledTime = input.deliveryTime;
      project.deliveryAssignee = input.deliveryAssignee;
      if (project.stage === "working_in_progress") project.workMode = "delivery_only";
      project.history.push(historyEntry(
        "delivery_scheduled",
        timestamp,
        "pm",
        actor,
        `${input.deliveryDate} ${input.deliveryTime} · ${input.deliveryAssignee}`,
      ));
    } else if (action === "mark_delivered") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can mark materials delivered.");
      if (!["material_delivery", "working_in_progress"].includes(project.stage) || project.deliveredAt || !deliveryScheduleIsComplete(project)) {
        throw new PaymentTrackRepositoryError("Schedule the delivery date, time and assignee before marking it delivered.", 409, "invalid_transition");
      }
      project.deliveredAt = timestamp;
      project.history.push(historyEntry("marked_delivered", timestamp, "pm", actor));
    } else if (action === "acknowledge_collection") {
      requireRole(input.actorRole, ["sales"], "Only Sales can acknowledge a received collection payment.");
      if (project.stage !== "working_in_progress" || !project.deliveredAt || project.collection.confirmedAt) {
        throw new PaymentTrackRepositoryError("A collection payment can only be acknowledged after delivery.", 409, "invalid_transition");
      }
      if (project.collection.acknowledgedAt) {
        throw new PaymentTrackRepositoryError("This collection payment is already awaiting Administrator review.", 409, "payment_review_pending");
      }
      project.collection.acknowledgedAt = timestamp;
      project.collection.acknowledgedBy = actor;
      project.history.push(historyEntry("collection_acknowledged", timestamp, "sales", actor));
    } else if (action === "confirm_collection") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can confirm collection.");
      const submittedForReview = Boolean(project.collection.acknowledgedAt || project.collection.proof);
      if (project.stage !== "working_in_progress" || !project.deliveredAt || !submittedForReview || project.collection.confirmedAt) {
        throw new PaymentTrackRepositoryError("Sales must acknowledge the received collection payment before confirmation.", 409, "invalid_transition");
      }
      const amount = validateNonNegativeAmount(input.amountCents);
      project.collection.confirmedAmountCents = amount;
      project.collection.confirmedAt = timestamp;
      project.collection.confirmedBy = actor;
      project.history.push(historyEntry("collection_confirmed", timestamp, "admin", actor, `AUD ${(amount / 100).toFixed(2)}`));
    } else if (action === "pre_schedule_installation") {
      requireRole(input.actorRole, ["sales"], "Only Sales can submit an installation scheduling request.");
      if (!["installing", "working_in_progress"].includes(project.stage)
        || project.installedAt
        || installationScheduleIsComplete(project)) {
        throw new PaymentTrackRepositoryError(
          "An installation request can only be submitted before the Project Manager schedules installation.",
          409,
          "invalid_transition",
        );
      }
      requireCurrentProjectVersion(project, input.expectedUpdatedAt);
      project.installationScheduleRequest = scheduleRequest(
        input.preferredDate,
        input.preferredTime,
        input.notes,
        timestamp,
        actor,
      );
      project.installationScheduledFor = null;
      project.installationScheduledTime = null;
      project.installationAssignee = null;
      project.history.push(historyEntry(
        "installation_pre_scheduled",
        timestamp,
        "sales",
        actor,
        `${input.preferredDate} ${input.preferredTime}`,
      ));
    } else if (action === "schedule_installation") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can schedule installation.");
      requireCurrentProjectVersion(project, input.expectedUpdatedAt);
      if (!["installing", "working_in_progress"].includes(project.stage)
        || project.installedAt
        || (!installationPreScheduleIsComplete(project) && !installationScheduleIsComplete(project))
        || !validDeliveryDate(input.installationDate)
        || !validScheduleTime(input.installationTime)
        || !validScheduleAssignee(input.installationAssignee)) {
        throw new PaymentTrackRepositoryError(
          "Choose a valid installation date, time and assignee while the project is in the Installment stage.",
          409,
          "invalid_transition",
        );
      }
      project.installationScheduledFor = input.installationDate || null;
      project.installationScheduledTime = input.installationTime;
      project.installationAssignee = input.installationAssignee;
      if (project.stage === "working_in_progress") project.workMode = "installation_only";
      project.history.push(historyEntry(
        "installation_scheduled",
        timestamp,
        "pm",
        actor,
        `${input.installationDate} ${input.installationTime} · ${input.installationAssignee}`,
      ));
    } else if (action === "acknowledge_payment") {
      requireRole(input.actorRole, ["sales"], "Only Sales can record a received payment.");
      if (!paymentCanBeRecorded(project)) {
        throw new PaymentTrackRepositoryError("A payment can only be recorded after the deposit while a balance remains.", 409, "invalid_transition");
      }
      const outstanding = publicProject(project).outstandingCents;
      const amount = input.amountCents === undefined
        ? Math.max(1, outstanding - pendingReportedPaymentCents(project))
        : validateNonNegativeAmount(input.amountCents);
      if (amount <= 0) {
        throw new PaymentTrackRepositoryError("Enter the amount Sales believes was received.", 400, "invalid_amount");
      }
      const finalPayments = project.finalPayments || (project.finalPayments = []);
      if (pendingReportedPaymentCents(project) + amount > outstanding) {
        throw new PaymentTrackRepositoryError(
          "The pending reported payments cannot exceed the current outstanding balance.",
          409,
          "reported_amount_exceeds_outstanding",
        );
      }
      finalPayments.push({
        id: randomUUID(),
        createdAt: timestamp,
        proof: null,
        acknowledgedAt: timestamp,
        acknowledgedBy: actor,
        reportedAmountCents: amount,
        confirmedAmountCents: null,
        confirmedAt: null,
        confirmedBy: null,
      });
      project.history.push(historyEntry("payment_acknowledged", timestamp, "sales", actor, `Reported AUD ${(amount / 100).toFixed(2)}`));
    } else if (action === "confirm_final_payment") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can confirm a received payment.");
      const finalPayments = project.finalPayments || (project.finalPayments = []);
      const pendingPayment = finalPayments.find((payment) => (
        payment.id || payment.proof?.id
      ) === input.paymentId);
      if (project.stage === "deposit_not_paid" || !pendingPayment) {
        throw new PaymentTrackRepositoryError("Choose a received payment awaiting Administrator review.", 409, "invalid_transition");
      }
      if ((!pendingPayment.acknowledgedAt && !pendingPayment.proof) || pendingPayment.confirmedAt) {
        throw new PaymentTrackRepositoryError("This payment is not awaiting confirmation.", 409, "invalid_transition");
      }
      const amount = validateNonNegativeAmount(input.amountCents);
      pendingPayment.confirmedAmountCents = amount;
      pendingPayment.confirmedAt = timestamp;
      pendingPayment.confirmedBy = actor;
      project.history.push(historyEntry("final_payment_confirmed", timestamp, "admin", actor, `AUD ${(amount / 100).toFixed(2)}`));
    } else if (action === "mark_installed") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can mark the project installed.");
      if (!["installing", "working_in_progress"].includes(project.stage) || project.installedAt || !installationScheduleIsComplete(project)) {
        throw new PaymentTrackRepositoryError("Schedule the installation date, time and assignee before marking the project installed.", 409, "invalid_transition");
      }
      project.installedAt = timestamp;
      project.stage = "waiting_coes";
      project.history.push(historyEntry("marked_installed", timestamp, "pm", actor));
    } else if (action === "mark_coes_received") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can confirm COES receipt.");
      if (project.stage !== "waiting_coes" || project.coesReceivedAt) {
        throw new PaymentTrackRepositoryError("COES can only be confirmed once for an installed project.", 409, "invalid_transition");
      }
      project.coesReceivedAt = timestamp;
      project.history.push(historyEntry("coes_received", timestamp, "pm", actor));
      advancePastWaitingCoes(project, timestamp, "pm", actor);
    } else if (action === "continue_to_stc") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can continue a project to STC Rebate.");
      if (!project.coesReceivedAt || !["waiting_coes", "stc_rebate", "done"].includes(project.stage)) {
        throw new PaymentTrackRepositoryError("Confirm COES before continuing.", 409, "invalid_transition");
      }
      // Kept for older clients which still call this action after confirming COES.
      // Current COES confirmation advances immediately, so already-advanced stages
      // are treated as an idempotent success and must never advance again.
      if (project.stage === "waiting_coes") {
        project.history.push(historyEntry("continued_to_stc", timestamp, "admin", actor));
        advancePastWaitingCoes(project, timestamp, "admin", actor);
      }
    } else if (
      action === "confirm_stc_solar"
      || action === "confirm_stc_battery"
      || action === "confirm_solar_rebate"
    ) {
      requireRole(
        input.actorRole,
        ["admin"],
        "Only an Administrator can confirm STC or Solar Rebate receipts.",
      );
      if (project.stage !== "stc_rebate") {
        throw new PaymentTrackRepositoryError(
          "STC and Solar Rebate receipts can only be confirmed at the STC Rebate stage.",
          409,
          "invalid_transition",
        );
      }
      if (action === "confirm_stc_solar") {
        if (!project.stcSolarRequired || project.stcSolarReceivedAt) {
          throw new PaymentTrackRepositoryError("Solar STC is not awaiting confirmation.", 409, "invalid_transition");
        }
        project.stcSolarReceivedAt = timestamp;
        project.history.push(historyEntry("stc_solar_confirmed", timestamp, input.actorRole, actor));
      } else if (action === "confirm_stc_battery") {
        if (!project.stcBatteryRequired || project.stcBatteryReceivedAt) {
          throw new PaymentTrackRepositoryError("Battery STC is not awaiting confirmation.", 409, "invalid_transition");
        }
        project.stcBatteryReceivedAt = timestamp;
        project.history.push(historyEntry("stc_battery_confirmed", timestamp, input.actorRole, actor));
      } else {
        if (!project.solarRebateRequired || project.solarRebateReceivedAt) {
          throw new PaymentTrackRepositoryError("Solar Rebate is not awaiting confirmation.", 409, "invalid_transition");
        }
        project.solarRebateReceivedAt = timestamp;
        project.history.push(historyEntry("solar_rebate_confirmed", timestamp, input.actorRole, actor));
      }
      completeProjectIfRequirementsMet(project, timestamp, input.actorRole, actor);
    } else if (action === "skip_stage") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can skip a Project Track stage.");
      const reason = normalizedStageSkipReason(input.reason);
      if (typeof input.expectedUpdatedAt !== "string" || input.expectedUpdatedAt !== project.updatedAt) {
        throw new PaymentTrackRepositoryError(
          "This project changed after the Administrator stage override was opened. Reload it and review the current stage before trying again.",
          409,
          "stale_project",
        );
      }
      const skippedStage = project.stage;
      let nextStage: PaymentTrackProject["stage"];
      const populatedFields: string[] = [];

      if (skippedStage === "deposit_not_paid") {
        if (project.deposit.proof || project.deposit.acknowledgedAt) {
          throw new PaymentTrackRepositoryError(
            "The deposit is awaiting Administrator payment review and cannot be skipped.",
            409,
            "payment_review_pending",
          );
        }
        nextStage = "working_in_progress";
        project.workMode = null;
        project.deliverySelections = [];
        project.deliveryPreparedAt = null;
        project.deliveryPreparedBy = null;
        project.deliveryScheduleRequest = null;
        project.deliveryScheduledFor = null;
        project.deliveryScheduledTime = null;
        project.deliveryAssignee = null;
      } else if (skippedStage === "working_in_progress") {
        if (!project.deliveredAt) {
          project.deliveredAt = timestamp;
          populatedFields.push(`deliveredAt=${timestamp}`);
        }
        if (!project.installedAt) {
          project.installedAt = timestamp;
          populatedFields.push(`installedAt=${timestamp}`);
        }
        nextStage = "waiting_coes";
      } else if (skippedStage === "material_delivery") {
        if (project.collection.proof || project.collection.acknowledgedAt) {
          throw new PaymentTrackRepositoryError(
            "The collection is awaiting Administrator payment review and cannot be skipped.",
            409,
            "payment_review_pending",
          );
        }
        if (!project.deliveredAt) {
          project.deliveredAt = timestamp;
          populatedFields.push(`deliveredAt=${timestamp}`);
        }
        nextStage = "installing";
        project.installationScheduleRequest = null;
        project.installationScheduledFor = null;
        project.installationScheduledTime = null;
        project.installationAssignee = null;
      } else if (skippedStage === "installing") {
        if (!project.installedAt) {
          project.installedAt = timestamp;
          populatedFields.push(`installedAt=${timestamp}`);
        }
        nextStage = "waiting_coes";
      } else if (skippedStage === "waiting_coes") {
        if (!project.coesReceivedAt) {
          project.coesReceivedAt = timestamp;
          populatedFields.push(`coesReceivedAt=${timestamp}`);
        }
        nextStage = rebateRequirementsComplete(project) ? "done" : "stc_rebate";
      } else if (skippedStage === "stc_rebate") {
        if (project.stcSolarRequired && !project.stcSolarReceivedAt) {
          project.stcSolarReceivedAt = timestamp;
          populatedFields.push(`stcSolarReceivedAt=${timestamp}`);
        }
        if (project.stcBatteryRequired && !project.stcBatteryReceivedAt) {
          project.stcBatteryReceivedAt = timestamp;
          populatedFields.push(`stcBatteryReceivedAt=${timestamp}`);
        }
        if (project.solarRebateRequired && !project.solarRebateReceivedAt) {
          project.solarRebateReceivedAt = timestamp;
          populatedFields.push(`solarRebateReceivedAt=${timestamp}`);
        }
        nextStage = "done";
      } else {
        throw new PaymentTrackRepositoryError("A completed project has no stage to skip.", 409, "invalid_transition");
      }

      project.stage = nextStage;
      populatedFields.unshift(`stage=${nextStage}`);
      if (nextStage === "done" && !project.completedAt) {
        project.completedAt = timestamp;
        populatedFields.push(`completedAt=${timestamp}`);
      }
      populatedFields.push(`updatedAt=${timestamp}`);
      project.history.push(historyEntry(
        "stage_skipped",
        timestamp,
        "admin",
        actor,
        `Transition: ${skippedStage} → ${nextStage}; Reason: ${reason}; Fields populated: ${populatedFields.join(", ")}`,
      ));
      if (nextStage === "done") {
        completeProjectIfRequirementsMet(project, timestamp, "admin", actor);
      }
    }

    if (!wasInstalled && project.installedAt) {
      recordSolarPanelConsumption(project, project.installedAt, input.actorRole, actor);
    }
    project.updatedAt = timestamp;
    projects[index] = project;
    await writeStoredProjects(projects, storedDocument.version);
    return publicProject(project);
  });
}

export async function getPaymentTrackFile(projectId: string, fileId: string): Promise<StoredPaymentTrackFile | null> {
  await mutationQueue;
  const projects = (await readStoredProjectDocument()).projects;
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  const finalProofs = (project.finalPayments || []).map((payment) => payment.proof);
  const candidates = [project.contract, project.deposit.proof, project.collection.proof, ...finalProofs]
    .filter(Boolean) as StoredFile[];
  const file = candidates.find((candidate) => candidate.id === fileId);
  if (!file) return null;
  return {
    originalName: file.originalName,
    contentType: file.contentType,
    size: file.size,
    accessToken: file.accessToken,
    read: async () => (await readStoredFileContent(file)).bytes,
  };
}
