import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
} from "@/lib/server/cloudflare-storage";
import type {
  ReimbursementAction,
  ReimbursementClaim,
  ReimbursementInvoice,
} from "./types";

type StoredInvoice = ReimbursementInvoice & {
  storedName: string;
  accessToken: string;
};

type StoredClaim = Omit<ReimbursementClaim, "invoice"> & {
  invoice: StoredInvoice;
  ownerTokenHash?: string;
};

export type CreateReimbursementInput = {
  claimantName: string;
  expenseDate: string;
  note: string;
  amountCents: number;
  currency: "AUD";
  ownerTokenHash: string;
};

export type ReimbursementUpload = {
  bytes: Uint8Array;
  originalName: string;
  contentType: ReimbursementInvoice["contentType"];
  size: number;
};

export type ReimbursementTransitionInput = {
  note?: string;
  paymentReference?: string;
  actor?: string;
};

export type StoredInvoiceFile = {
  originalName: string;
  contentType: ReimbursementInvoice["contentType"];
  size: number;
  accessToken: string;
  read(): Promise<Uint8Array>;
};

export class ReimbursementRepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message);
    this.name = "ReimbursementRepositoryError";
    this.status = status;
    this.code = code;
  }
}

const MIME_EXTENSIONS: Record<ReimbursementInvoice["contentType"], string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.REIMBURSEMENT_DATA_DIR || path.join(process.cwd(), ".data", "reimbursements"),
);
const recordsPath = path.join(/* turbopackIgnore: true */ dataRoot, "records.json");
const uploadsPath = path.join(/* turbopackIgnore: true */ dataRoot, "uploads");
const CLOUDFLARE_DOCUMENT_KEY = "reimbursements/records";
const MAXIMUM_STORAGE_RETRIES = 5;
const STORED_INVOICE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|jpg|png|webp)$/i;
let mutationQueue: Promise<void> = Promise.resolve();

async function ensureStorage() {
  await mkdir(uploadsPath, { recursive: true, mode: 0o700 });
}

async function readStoredClaimDocument(): Promise<{
  claims: StoredClaim[];
  version: number | null;
}> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    if (document.value !== null && !Array.isArray(document.value)) {
      throw new ReimbursementRepositoryError("Reimbursement data is invalid.", 500, "invalid_storage");
    }
    return { claims: (document.value ?? []) as StoredClaim[], version: document.version };
  }

  await ensureStorage();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ recordsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Reimbursement data is not an array");
    return { claims: parsed as StoredClaim[], version: null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { claims: [], version: null };
    }
    throw error;
  }
}

async function writeStoredClaims(claims: StoredClaim[], expectedVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(bindings.database, CLOUDFLARE_DOCUMENT_KEY, claims, expectedVersion);
    return;
  }

  await ensureStorage();
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.records-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(claims, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
    throw new ReimbursementRepositoryError(
      "Reimbursements changed while this request was being saved. Try again.",
      409,
      "storage_conflict",
    );
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function storedInvoicePath(storedName: string) {
  if (path.basename(storedName) !== storedName || !STORED_INVOICE_PATTERN.test(storedName)) {
    throw new ReimbursementRepositoryError("The stored invoice path is invalid.", 500, "invalid_invoice_path");
  }
  const invoicePath = path.resolve(/* turbopackIgnore: true */ uploadsPath, storedName);
  const relativePath = path.relative(uploadsPath, invoicePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new ReimbursementRepositoryError("The stored invoice path is invalid.", 500, "invalid_invoice_path");
  }
  return invoicePath;
}

function storedInvoiceObjectKey(storedName: string) {
  storedInvoicePath(storedName);
  return `reimbursements/invoices/${storedName}`;
}

async function writeStoredInvoice(storedName: string, bytes: Uint8Array) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    await bindings.files.put(storedInvoiceObjectKey(storedName), bytes);
    return;
  }
  await ensureStorage();
  await writeFile(storedInvoicePath(storedName), bytes, { flag: "wx", mode: 0o600 });
}

async function deleteStoredInvoice(storedName: string) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    await bindings.files.delete(storedInvoiceObjectKey(storedName));
    return;
  }
  await unlink(storedInvoicePath(storedName));
}

async function readStoredInvoice(storedName: string) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.files) {
      throw new CloudflareStorageConfigurationError("The ERP_FILES binding is missing.");
    }
    const buffer = await bindings.files.get(storedInvoiceObjectKey(storedName), "arrayBuffer");
    if (!buffer) {
      throw new ReimbursementRepositoryError("The invoice is unavailable.", 404, "invoice_not_found");
    }
    return new Uint8Array(buffer);
  }
  const source = await readFile(storedInvoicePath(storedName));
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function publicClaim(claim: StoredClaim): ReimbursementClaim {
  const { storedName: _storedName, accessToken, ...invoice } = claim.invoice;
  const { ownerTokenHash: _ownerTokenHash, ...publicFields } = claim;
  return {
    ...publicFields,
    note: claim.note ?? claim.description ?? "",
    invoice: {
      ...invoice,
      url: `/api/reimbursements/${encodeURIComponent(claim.id)}/invoice?token=${encodeURIComponent(accessToken)}`,
    },
  };
}

function nextReference(claims: StoredClaim[], now: Date) {
  const year = now.getUTCFullYear();
  const prefix = `EXP-${year}-`;
  const next = claims.reduce((highest, claim) => {
    if (!claim.reference.startsWith(prefix)) return highest;
    const value = Number(claim.reference.slice(prefix.length));
    return Number.isInteger(value) ? Math.max(highest, value) : highest;
  }, 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

export async function listReimbursements(options: {
  includeAll?: boolean;
  ownerTokenHash?: string;
} = {}): Promise<ReimbursementClaim[]> {
  await mutationQueue;
  const claims = (await readStoredClaimDocument()).claims;
  return claims
    .filter((claim) => options.includeAll || (
      Boolean(options.ownerTokenHash)
      && claim.ownerTokenHash === options.ownerTokenHash
    ))
    .slice()
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
    .map(publicClaim);
}

export function createReimbursement(
  input: CreateReimbursementInput,
  upload: ReimbursementUpload,
): Promise<ReimbursementClaim> {
  return withMutation(async () => {
    const document = await readStoredClaimDocument();
    const claims = document.claims;
    const now = new Date();
    const timestamp = now.toISOString();
    const id = randomUUID();
    const storedName = `${randomUUID()}.${MIME_EXTENSIONS[upload.contentType]}`;
    const accessToken = randomBytes(24).toString("base64url");

    await writeStoredInvoice(storedName, upload.bytes);
    const claim: StoredClaim = {
      id,
      reference: nextReference(claims, now),
      ...input,
      invoice: {
        originalName: upload.originalName,
        contentType: upload.contentType,
        size: upload.size,
        url: "",
        storedName,
        accessToken,
      },
      status: "submitted",
      submittedAt: timestamp,
      updatedAt: timestamp,
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
      paidAt: null,
      paidBy: null,
      paymentReference: null,
      history: [{
        id: randomUUID(),
        action: "submitted",
        at: timestamp,
        actor: "claimant",
        note: null,
      }],
    };

    try {
      claims.push(claim);
      await writeStoredClaims(claims, document.version);
    } catch (error) {
      await deleteStoredInvoice(storedName).catch(() => undefined);
      throw error;
    }
    return publicClaim(claim);
  });
}

export function transitionReimbursement(
  id: string,
  action: ReimbursementAction,
  input: ReimbursementTransitionInput,
): Promise<ReimbursementClaim> {
  return withMutation(async () => {
    const document = await readStoredClaimDocument();
    const claims = document.claims;
    const index = claims.findIndex((claim) => claim.id === id);
    if (index < 0) throw new ReimbursementRepositoryError("Reimbursement not found.", 404, "not_found");

    const claim = claims[index];
    const timestamp = new Date().toISOString();
    const actor = input.actor?.trim() || "Administrator";
    const note = input.note?.trim() || null;

    if (action === "approve") {
      if (claim.status !== "submitted") {
        throw new ReimbursementRepositoryError("Only submitted claims can be approved.", 409, "invalid_transition");
      }
      claim.status = "pending_payment";
      claim.reviewedAt = timestamp;
      claim.reviewedBy = actor;
      claim.reviewNote = note;
      claim.history.push({ id: randomUUID(), action: "approved", at: timestamp, actor: "admin", note });
    } else if (action === "reject") {
      if (claim.status !== "submitted") {
        throw new ReimbursementRepositoryError("Only submitted claims can be rejected.", 409, "invalid_transition");
      }
      claim.status = "rejected";
      claim.reviewedAt = timestamp;
      claim.reviewedBy = actor;
      claim.reviewNote = note;
      claim.history.push({ id: randomUUID(), action: "rejected", at: timestamp, actor: "admin", note });
    } else {
      if (claim.status !== "pending_payment") {
        throw new ReimbursementRepositoryError("Only approved claims can be marked as paid.", 409, "invalid_transition");
      }
      claim.status = "reimbursed";
      claim.paidAt = timestamp;
      claim.paidBy = actor;
      claim.paymentReference = input.paymentReference?.trim() || null;
      claim.history.push({
        id: randomUUID(),
        action: "marked_paid",
        at: timestamp,
        actor: "admin",
        note: [note, claim.paymentReference ? `Payment reference: ${claim.paymentReference}` : ""]
          .filter(Boolean)
          .join(" · ") || null,
      });
    }

    claim.updatedAt = timestamp;
    claims[index] = claim;
    await writeStoredClaims(claims, document.version);
    return publicClaim(claim);
  });
}

export async function getReimbursementInvoice(id: string): Promise<StoredInvoiceFile | null> {
  await mutationQueue;
  const claims = (await readStoredClaimDocument()).claims;
  const claim = claims.find((candidate) => candidate.id === id);
  if (!claim) return null;
  const storedName = claim.invoice.storedName;
  storedInvoicePath(storedName);
  return {
    originalName: claim.invoice.originalName,
    contentType: claim.invoice.contentType,
    size: claim.invoice.size,
    accessToken: claim.invoice.accessToken,
    read: () => readStoredInvoice(storedName),
  };
}
