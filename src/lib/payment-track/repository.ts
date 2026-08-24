import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
// The focused tests execute source TypeScript directly under Node ESM, which
// requires the explicit extension; Next's server bundler supports this path.
// @ts-expect-error -- the project intentionally does not enable TS emit-time extension imports.
import { paymentAgreementRequiresSolarRebatePdf } from "./pdf-parser.ts";
import type {
  PaymentTrackAction,
  PaymentTrackCustomer,
  PaymentTrackFile,
  PaymentTrackFinalPayment,
  PaymentTrackHistoryAction,
  PaymentTrackHistoryEntry,
  PaymentTrackItem,
  PaymentTrackProject,
  PaymentTrackReceipt,
  PaymentTrackRole,
  PaymentTrackSpecialist,
  PaymentTrackUploadContentType,
} from "./types";

type StoredFile = Omit<PaymentTrackFile, "url"> & {
  storedName: string;
  accessToken: string;
};

type StoredReceipt = Omit<PaymentTrackReceipt, "proof" | "acknowledgedAt" | "acknowledgedBy"> & {
  proof: StoredFile | null;
  // Optional so proof-based receipts written by earlier versions remain readable.
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
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
  | "installationScheduledFor"
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
  // Optional so records written before installation scheduling remain readable.
  installationScheduledFor?: string | null;
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
  deliveryDate?: string;
  installationDate?: string;
  notes?: string;
  expectedPmNotesUpdatedAt?: string | null;
};

export type StoredPaymentTrackFile = {
  path: string;
  originalName: string;
  contentType: PaymentTrackUploadContentType;
  size: number;
  accessToken: string;
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
let mutationQueue: Promise<void> = Promise.resolve();
const solarRebateAssessmentRetries = new Map<string, {
  fileFingerprint: string;
  retryAfter: number;
}>();

function resolvedStoredFilePath(file: StoredFile) {
  const expectedDirectory = file.kind === "contract" ? contractsPath : proofsPath;
  if (path.basename(file.storedName) !== file.storedName || !/^[0-9a-f-]{36}\.(?:pdf|jpg|png|webp)$/.test(file.storedName)) {
    throw new PaymentTrackRepositoryError("The stored file path is invalid.", 500, "invalid_file_path");
  }
  const filePath = path.resolve(expectedDirectory, file.storedName);
  const relative = path.relative(expectedDirectory, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PaymentTrackRepositoryError("The stored file path is invalid.", 500, "invalid_file_path");
  }
  return filePath;
}

async function ensureStorage() {
  await Promise.all([
    mkdir(contractsPath, { recursive: true, mode: 0o700 }),
    mkdir(proofsPath, { recursive: true, mode: 0o700 }),
  ]);
}

async function readStoredProjects(): Promise<StoredProject[]> {
  await ensureStorage();
  try {
    const raw = await readFile(recordsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Payment Track data is not an array");
    return parsed as StoredProject[];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStoredProjects(projects: StoredProject[]) {
  await ensureStorage();
  const temporaryPath = path.join(dataRoot, `.records-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(projects, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, recordsPath);
}

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work, work);
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
      proof: publicFile(project.id, project.deposit.proof),
    },
    collection: {
      ...project.collection,
      acknowledgedAt: project.collection.acknowledgedAt || null,
      acknowledgedBy: project.collection.acknowledgedBy || null,
      proof: publicFile(project.id, project.collection.proof),
    },
    finalPayments: finalPayments.map((payment): PaymentTrackFinalPayment => ({
      ...payment,
      id: payment.id || payment.proof?.id || "legacy-payment",
      createdAt: payment.createdAt || payment.proof?.uploadedAt || project.completedAt || project.updatedAt,
      acknowledgedAt: payment.acknowledgedAt || null,
      acknowledgedBy: payment.acknowledgedBy || null,
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
    installationScheduledFor: typeof project.installationScheduledFor === "string"
      && validDeliveryDate(project.installationScheduledFor)
      ? project.installationScheduledFor
      : null,
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

async function migrateLegacyProjectStages(projects: StoredProject[], fallbackTimestamp: string) {
  let changed = false;
  for (const project of projects) {
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
        let contractPath: string;
        let fileFingerprint: string;
        try {
          contractPath = resolvedStoredFilePath(project.contract);
          const contractStat = await stat(contractPath);
          fileFingerprint = `${contractStat.size}:${contractStat.mtimeMs}`;
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
          const contractBytes = await readFile(contractPath);
          required = await paymentAgreementRequiresSolarRebatePdf(new Uint8Array(contractBytes));
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
  const directory = kind === "contract" ? contractsPath : proofsPath;
  const filePath = path.join(/* turbopackIgnore: true */ directory, storedName);
  await writeFile(filePath, upload.bytes, { flag: "wx", mode: 0o600 });
  return {
    filePath,
    file: {
      id,
      kind,
      originalName: upload.originalName,
      contentType: upload.contentType,
      size: upload.size,
      uploadedAt: timestamp,
      uploadedByRole: role,
      storedName,
      accessToken: randomBytes(24).toString("base64url"),
    } satisfies StoredFile,
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
    contract,
    deposit: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    deliveryScheduledFor: null,
    deliveredAt: null,
    collection: {
      proof: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      confirmedAmountCents: null,
      confirmedAt: null,
      confirmedBy: null,
    },
    installationScheduledFor: null,
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
  if (process.env.PAYMENT_TRACK_ENFORCE_UNIQUE_PROPOSAL !== "true") return;
  if (projects.some((project) => project.quoteNumber.toLowerCase() === quoteNumber.toLowerCase())) {
    throw new PaymentTrackRepositoryError("A project with this Proposal Number already exists.", 409, "duplicate_quote");
  }
}

export function listPaymentTrackProjects() {
  return withMutation(async () => {
    const projects = await readStoredProjects();
    if (await migrateLegacyProjectStages(projects, new Date().toISOString())) {
      await writeStoredProjects(projects);
    }
    return projects
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(publicProject);
  });
}

export function createManualPaymentTrackProject(input: CreatePaymentTrackInput) {
  return withMutation(async () => {
    const projects = await readStoredProjects();
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    assertProposalNumberAvailable(projects, input.quoteNumber);
    const timestamp = new Date().toISOString();
    const project = buildProject(projects, input, timestamp, null);
    project.history.push(historyEntry("created_manually", timestamp, "sales"));
    projects.push(project);
    await writeStoredProjects(projects);
    return publicProject(project);
  });
}

export function createImportedPaymentTrackProject(
  input: CreatePaymentTrackInput,
  upload: PaymentTrackUpload,
) {
  return withMutation(async () => {
    const projects = await readStoredProjects();
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    assertProposalNumberAvailable(projects, input.quoteNumber);
    const timestamp = new Date().toISOString();
    const stored = await storedUpload("contract", "sales", upload, timestamp);
    const project = buildProject(projects, input, timestamp, stored.file);
    project.history.push(historyEntry("contract_imported", timestamp, "sales", undefined, upload.originalName));
    try {
      projects.push(project);
      await writeStoredProjects(projects);
      return publicProject(project);
    } catch (error) {
      await unlink(stored.filePath).catch(() => undefined);
      throw error;
    }
  });
}

export function uploadPaymentTrackProof(
  id: string,
  kind: "deposit",
  role: PaymentTrackRole,
  upload: PaymentTrackUpload,
) {
  return withMutation(async () => {
    const projects = await readStoredProjects();
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    const index = projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new PaymentTrackRepositoryError("Payment project not found.", 404, "not_found");
    const project = projects[index];

    if (role !== "specialist") throw new PaymentTrackRepositoryError("Only the Specialist can upload deposit proof.", 403, "role_forbidden");
    if (project.stage !== "deposit_not_paid" || project.deposit.confirmedAt) {
      throw new PaymentTrackRepositoryError("Deposit proof can no longer be changed.", 409, "invalid_transition");
    }

    const previous = project.deposit.proof;
    const previousPath = previous ? resolvedStoredFilePath(previous) : null;
    const timestamp = new Date().toISOString();
    const stored = await storedUpload("deposit_proof", role, upload, timestamp);
    project.deposit.proof = stored.file;
    project.updatedAt = timestamp;
    project.history.push(historyEntry("deposit_proof_uploaded", timestamp, role, undefined, upload.originalName));

    try {
      projects[index] = project;
      await writeStoredProjects(projects);
      if (previousPath) await unlink(previousPath).catch(() => undefined);
      return publicProject(project);
    } catch (error) {
      await unlink(stored.filePath).catch(() => undefined);
      throw error;
    }
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

function validDeliveryDate(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nextPmNotesTimestamp(project: StoredProject) {
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
    const projects = await readStoredProjects();
    await migrateLegacyProjectStages(projects, new Date().toISOString());
    const index = projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new PaymentTrackRepositoryError("Payment project not found.", 404, "not_found");
    const project = projects[index];
    if (!solarRebateAssessmentIsCurrent(project) && action !== "update_pm_notes") {
      throw new PaymentTrackRepositoryError(
        "The contract Solar Rebate requirement could not be verified. Try again before updating this project.",
        409,
        "solar_rebate_assessment_pending",
      );
    }
    const timestamp = action === "update_pm_notes"
      ? nextPmNotesTimestamp(project)
      : new Date().toISOString();
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
    } else if (action === "confirm_deposit") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can confirm a deposit.");
      if (project.stage !== "deposit_not_paid" || !project.deposit.proof || project.deposit.confirmedAt) {
        throw new PaymentTrackRepositoryError("Upload deposit proof before confirming the deposit.", 409, "invalid_transition");
      }
      const amount = validateNonNegativeAmount(input.amountCents);
      project.deposit.confirmedAmountCents = amount;
      project.deposit.confirmedAt = timestamp;
      project.deposit.confirmedBy = actor;
      project.stage = "material_delivery";
      project.history.push(historyEntry("deposit_confirmed", timestamp, "admin", actor, `AUD ${(amount / 100).toFixed(2)}`));
    } else if (action === "schedule_delivery") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can schedule delivery.");
      if (project.stage !== "material_delivery" || project.deliveredAt || !validDeliveryDate(input.deliveryDate)) {
        throw new PaymentTrackRepositoryError("Choose a valid delivery date before delivery is completed.", 409, "invalid_transition");
      }
      project.deliveryScheduledFor = input.deliveryDate || null;
      project.history.push(historyEntry("delivery_scheduled", timestamp, "pm", actor, input.deliveryDate || null));
    } else if (action === "mark_delivered") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can mark materials delivered.");
      if (project.stage !== "material_delivery" || project.deliveredAt || !project.deliveryScheduledFor) {
        throw new PaymentTrackRepositoryError("Schedule the delivery before marking it delivered.", 409, "invalid_transition");
      }
      project.deliveredAt = timestamp;
      project.history.push(historyEntry("marked_delivered", timestamp, "pm", actor));
    } else if (action === "acknowledge_collection") {
      requireRole(input.actorRole, ["sales"], "Only Sales can acknowledge a received collection payment.");
      if (project.stage !== "material_delivery" || !project.deliveredAt || project.collection.confirmedAt) {
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
      if (project.stage !== "material_delivery" || !project.deliveredAt || !submittedForReview || project.collection.confirmedAt) {
        throw new PaymentTrackRepositoryError("Sales must acknowledge the received collection payment before confirmation.", 409, "invalid_transition");
      }
      const amount = validateNonNegativeAmount(input.amountCents);
      project.collection.confirmedAmountCents = amount;
      project.collection.confirmedAt = timestamp;
      project.collection.confirmedBy = actor;
      project.stage = "installing";
      project.installationScheduledFor = null;
      project.history.push(historyEntry("collection_confirmed", timestamp, "admin", actor, `AUD ${(amount / 100).toFixed(2)}`));
    } else if (action === "schedule_installation") {
      requireRole(input.actorRole, ["pm"], "Only the Project Manager can schedule installation.");
      if (project.stage !== "installing" || project.installedAt || !validDeliveryDate(input.installationDate)) {
        throw new PaymentTrackRepositoryError(
          "Choose a valid installation date while the project is installing.",
          409,
          "invalid_transition",
        );
      }
      project.installationScheduledFor = input.installationDate || null;
      project.history.push(historyEntry(
        "installation_scheduled",
        timestamp,
        "pm",
        actor,
        input.installationDate || null,
      ));
    } else if (action === "acknowledge_payment") {
      requireRole(input.actorRole, ["sales"], "Only Sales can acknowledge a received payment.");
      const paymentStage = project.stage === "waiting_coes"
        || project.stage === "stc_rebate"
        || project.stage === "done";
      if (!paymentStage || publicProject(project).outstandingCents <= 0) {
        throw new PaymentTrackRepositoryError("A payment can only be acknowledged for an outstanding installed project.", 409, "invalid_transition");
      }
      const finalPayments = project.finalPayments || (project.finalPayments = []);
      if (finalPayments.some((payment) => !payment.confirmedAt)) {
        throw new PaymentTrackRepositoryError("A payment is already awaiting Administrator review.", 409, "payment_review_pending");
      }
      finalPayments.push({
        id: randomUUID(),
        createdAt: timestamp,
        proof: null,
        acknowledgedAt: timestamp,
        acknowledgedBy: actor,
        confirmedAmountCents: null,
        confirmedAt: null,
        confirmedBy: null,
      });
      project.history.push(historyEntry("payment_acknowledged", timestamp, "sales", actor));
    } else if (action === "confirm_final_payment") {
      requireRole(input.actorRole, ["admin"], "Only an Administrator can confirm a received payment.");
      const finalPayments = project.finalPayments || (project.finalPayments = []);
      const pendingPayment = finalPayments.find((payment) => (
        payment.id || payment.proof?.id
      ) === input.paymentId);
      const paymentStage = project.stage === "waiting_coes"
        || project.stage === "stc_rebate"
        || project.stage === "done";
      if (!paymentStage || publicProject(project).outstandingCents <= 0 || !pendingPayment) {
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
      if (project.stage !== "installing" || project.installedAt) {
        throw new PaymentTrackRepositoryError("Only an installing project can be marked installed.", 409, "invalid_transition");
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
        ["specialist", "admin"],
        "Only the Specialist or Administrator can confirm STC or Solar Rebate receipts.",
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
    }

    project.updatedAt = timestamp;
    projects[index] = project;
    await writeStoredProjects(projects);
    return publicProject(project);
  });
}

export async function getPaymentTrackFile(projectId: string, fileId: string): Promise<StoredPaymentTrackFile | null> {
  await mutationQueue;
  const projects = await readStoredProjects();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  const finalProofs = (project.finalPayments || []).map((payment) => payment.proof);
  const candidates = [project.contract, project.deposit.proof, project.collection.proof, ...finalProofs]
    .filter(Boolean) as StoredFile[];
  const file = candidates.find((candidate) => candidate.id === fileId);
  if (!file) return null;
  const filePath = resolvedStoredFilePath(file);
  return {
    path: filePath,
    originalName: file.originalName,
    contentType: file.contentType,
    size: file.size,
    accessToken: file.accessToken,
  };
}
