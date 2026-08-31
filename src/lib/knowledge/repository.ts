import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { erpCloudflareBindings } from "../server/cloudflare-storage.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { isSha256Hex } from "./checksum.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { isKnowledgeAccessScope } from "./config.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_DOCUMENT_STATUSES, KNOWLEDGE_TENANT_ID, type KnowledgeChunk, type KnowledgeChunkReplacement, type KnowledgeDocument, type KnowledgeDocumentCreateInput, type KnowledgeDocumentCreateResult, type KnowledgeDocumentMetadataPatch, type KnowledgeDocumentStatus, type KnowledgeIndexJob, type KnowledgeIndexedChunkDraft, type KnowledgeTenantId } from "./types.ts";

type D1Result = { success: boolean; error?: string; meta?: { changes?: number }; results?: unknown[] };
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ success: boolean; results?: T[]; error?: string }>;
  run(): Promise<D1Result>;
};
type KnowledgeD1Database = {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

type LocalState = { documents: KnowledgeDocument[]; chunks: KnowledgeChunk[]; jobs: KnowledgeIndexJob[] };
const EMPTY_STATE: LocalState = { documents: [], chunks: [], jobs: [] };
let mutationQueue: Promise<void> = Promise.resolve();
const localDataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.KNOWLEDGE_DATA_DIR || path.join(process.cwd(), ".data", "knowledge-base"),
);
const localDataFile = path.join(/* turbopackIgnore: true */ localDataRoot, "records.json");

export class KnowledgeRepositoryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "KnowledgeRepositoryError";
    this.status = status;
    this.code = code;
  }
}

function localDataPath() {
  return { root: localDataRoot, file: localDataFile };
}

async function readLocalState(): Promise<LocalState> {
  const { root, file } = localDataPath();
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LocalState>;
    return {
      documents: Array.isArray(value.documents) ? value.documents : [],
      chunks: Array.isArray(value.chunks) ? value.chunks : [],
      jobs: Array.isArray(value.jobs) ? value.jobs : [],
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
    throw new KnowledgeRepositoryError("Knowledge metadata is invalid.", 500, "invalid_storage");
  }
}

async function writeLocalState(state: LocalState) {
  const { root, file } = localDataPath();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function d1(): Promise<KnowledgeD1Database | null> {
  const bindings = await erpCloudflareBindings();
  if (!bindings) return null;
  if (!bindings.database) throw new KnowledgeRepositoryError("The ERP_DB binding is missing.", 503, "storage_unavailable");
  return bindings.database as unknown as KnowledgeD1Database;
}

function cleanRequired(value: unknown, field: string, maximum = 240) {
  const result = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new KnowledgeRepositoryError(`${field} is invalid.`, 400, "invalid_input");
  }
  return result;
}

function cleanOptional(value: unknown, field: string, maximum = 240) {
  if (value === null || value === undefined || value === "") return null;
  return cleanRequired(value, field, maximum);
}

function validIso(value: string | null, field: string) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new KnowledgeRepositoryError(`${field} is invalid.`, 400, "invalid_input");
  }
  return value;
}

function normalizedTags(tags: unknown) {
  if (!Array.isArray(tags) || tags.length > 30) throw new KnowledgeRepositoryError("Tags are invalid.", 400, "invalid_input");
  return [...new Set(tags.map((tag) => cleanRequired(tag, "Tag", 60).toLocaleLowerCase("en-AU")))];
}

function now() { return new Date().toISOString(); }

function timestampAfter(previous: string | null | undefined) {
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
}

function documentFromRow(row: Record<string, unknown>): KnowledgeDocument {
  let tags: unknown;
  try { tags = JSON.parse(String(row.tags_json)); } catch { tags = null; }
  const status = row.status;
  const accessScope = row.access_scope;
  if (!(KNOWLEDGE_DOCUMENT_STATUSES as readonly unknown[]).includes(status) || !isKnowledgeAccessScope(accessScope)
    || !Array.isArray(tags)) throw new KnowledgeRepositoryError("Knowledge metadata is invalid.", 500, "invalid_storage");
  return {
    id: String(row.id), tenantId: row.tenant_id as KnowledgeTenantId, fileId: String(row.file_id),
    fileVersion: Number(row.file_version), title: String(row.title), fileName: String(row.file_name),
    sourcePath: String(row.source_path), contentType: String(row.content_type), documentType: String(row.document_type),
    category: String(row.category), language: String(row.language), sourceChecksum: String(row.source_checksum),
    version: String(row.version), indexGeneration: Number(row.index_generation), status: status as KnowledgeDocumentStatus,
    accessScope, product: row.product === null ? null : String(row.product), region: row.region === null ? null : String(row.region),
    effectiveFrom: row.effective_from === null ? null : String(row.effective_from),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to), tags: tags.map(String),
    lastIndexedAt: row.last_indexed_at === null ? null : String(row.last_indexed_at),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    disabledAt: row.disabled_at === null ? null : String(row.disabled_at),
    disabledReason: row.disabled_reason === null ? null : String(row.disabled_reason),
    createdAt: String(row.created_at), createdBy: String(row.created_by),
    updatedAt: String(row.updated_at), updatedBy: String(row.updated_by),
  };
}

const DOCUMENT_COLUMNS = `id, tenant_id, file_id, file_version, title, file_name, source_path, content_type,
  document_type, category, language, source_checksum, version, index_generation, status, access_scope,
  product, region, effective_from, effective_to, tags_json, last_indexed_at, error_code, error_message,
  disabled_at, disabled_reason, created_at, created_by, updated_at, updated_by`;

function chunkFromRow(row: Record<string, unknown>): KnowledgeChunk {
  let headings: unknown;
  try { headings = JSON.parse(String(row.heading_path_json)); } catch { headings = null; }
  if (!Array.isArray(headings)) throw new KnowledgeRepositoryError("Knowledge chunk metadata is invalid.", 500, "invalid_storage");
  return {
    id: String(row.id), tenantId: row.tenant_id as KnowledgeTenantId, documentId: String(row.document_id),
    indexedVersion: String(row.indexed_version), indexGeneration: Number(row.index_generation),
    chunkIndex: Number(row.chunk_index), indexItemKey: String(row.index_item_key), text: String(row.text),
    indexItemId: String(row.index_item_id),
    tokenCount: Number(row.token_count), headingPath: headings.map(String),
    pageFrom: row.page_from === null ? null : Number(row.page_from), pageTo: row.page_to === null ? null : Number(row.page_to),
    contentChecksum: String(row.content_checksum), active: Number(row.active) === 1,
    createdAt: String(row.created_at), invalidatedAt: row.invalidated_at === null ? null : String(row.invalidated_at),
  };
}

const CHUNK_COLUMNS = `id, tenant_id, document_id, indexed_version, index_generation, chunk_index,
  index_item_key, index_item_id, text, token_count, heading_path_json, page_from, page_to, content_checksum,
  active, created_at, invalidated_at`;

function jobFromRow(row: Record<string, unknown>): KnowledgeIndexJob {
  return {
    id: String(row.id), tenantId: row.tenant_id as KnowledgeTenantId, documentId: String(row.document_id),
    indexGeneration: Number(row.index_generation), status: row.status as KnowledgeIndexJob["status"], reason: String(row.reason),
    attempts: Number(row.attempts), availableAt: String(row.available_at),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    requestedAt: String(row.requested_at), requestedBy: String(row.requested_by),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at), updatedAt: String(row.updated_at),
  };
}

const JOB_COLUMNS = `id, tenant_id, document_id, index_generation, status, reason, attempts, available_at,
  lease_owner, lease_expires_at, error_code, error_message, requested_at, requested_by, started_at,
  completed_at, updated_at`;

export const CLAIM_NEXT_KNOWLEDGE_INDEX_JOB_SQL = `UPDATE erp_knowledge_index_jobs SET status='running',attempts=attempts+1,lease_owner=?1,
  lease_expires_at=?2,started_at=COALESCE(started_at,?3),updated_at=?3 WHERE id=(SELECT id FROM erp_knowledge_index_jobs
  WHERE tenant_id=?4 AND ((status='pending' AND available_at<=?3) OR (status='running' AND lease_expires_at<=?3))
  ORDER BY requested_at LIMIT 1) RETURNING ${JOB_COLUMNS}`;

export const CLAIM_KNOWLEDGE_INDEX_JOB_SQL = `UPDATE erp_knowledge_index_jobs SET status='running',attempts=attempts+1,lease_owner=?1,
  lease_expires_at=?2,started_at=COALESCE(started_at,?3),updated_at=?3 WHERE id=?4 AND tenant_id=?5
  AND ((status='pending' AND available_at<=?3) OR (status='running' AND lease_expires_at<=?3)) RETURNING ${JOB_COLUMNS}`;

function claimTime(value: Date | undefined) {
  const time = value?.getTime() ?? Date.now();
  if (!Number.isFinite(time)) throw new KnowledgeRepositoryError("Claim time is invalid.",400,"invalid_input");
  return { timestamp: new Date(time).toISOString(), time };
}

function jobIsClaimable(job: KnowledgeIndexJob, timestamp: string) {
  return job.status === "pending" && job.availableAt <= timestamp
    || job.status === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= timestamp;
}

export async function listKnowledgeDocuments(input: { tenantId: KnowledgeTenantId; includeDisabled?: boolean }) {
  const database = await d1();
  if (!database) {
    const state = await readLocalState();
    return state.documents.filter((document) => document.tenantId === input.tenantId && (input.includeDisabled || document.status !== "disabled"))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  const result = await database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM erp_knowledge_documents
    WHERE tenant_id = ?1 ${input.includeDisabled ? "" : "AND status <> 'disabled'"} ORDER BY updated_at DESC`).bind(input.tenantId).all();
  if (!result.success) throw new KnowledgeRepositoryError(result.error || "Knowledge read failed.", 503, "storage_unavailable");
  return (result.results || []).map((row) => documentFromRow(row as Record<string, unknown>));
}

export async function getKnowledgeDocument(id: string, tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID) {
  const database = await d1();
  if (!database) return (await readLocalState()).documents.find((document) => document.id === id && document.tenantId === tenantId) || null;
  const row = await database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM erp_knowledge_documents WHERE id = ?1 AND tenant_id = ?2`)
    .bind(id, tenantId).first<Record<string, unknown>>();
  return row ? documentFromRow(row) : null;
}

export const getKnowledgeDocumentById = getKnowledgeDocument;

export async function getKnowledgeDocumentByFileId(fileId: string, tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID) {
  const database = await d1();
  if (!database) return (await readLocalState()).documents.find((document) => document.fileId === fileId && document.tenantId === tenantId) || null;
  const row = await database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM erp_knowledge_documents WHERE file_id = ?1 AND tenant_id = ?2`)
    .bind(fileId, tenantId).first<Record<string, unknown>>();
  return row ? documentFromRow(row) : null;
}

export async function getActiveKnowledgeDocumentByChecksum(checksum: string, tenantId: KnowledgeTenantId) {
  const database = await d1();
  if (!database) {
    return (await readLocalState()).documents.find((document) => document.tenantId === tenantId
      && document.status !== "disabled" && document.sourceChecksum === checksum) || null;
  }
  const row = await database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM erp_knowledge_documents
    WHERE tenant_id = ?1 AND source_checksum = ?2 AND status <> 'disabled' LIMIT 1`)
    .bind(tenantId, checksum).first<Record<string, unknown>>();
  return row ? documentFromRow(row) : null;
}

function duplicateChecksumError() {
  return new KnowledgeRepositoryError(
    "An identical active file is already in the knowledge base.",
    409,
    "duplicate_checksum",
  );
}

function throwMappedWriteError(error: string | undefined, fallback: string): never {
  if (/UNIQUE constraint failed:.*(?:tenant_id.*source_checksum|source_checksum.*tenant_id)/i.test(error || "")) {
    throw duplicateChecksumError();
  }
  throw new KnowledgeRepositoryError(error || fallback, 503, "storage_unavailable");
}

function validatedCreate(input: KnowledgeDocumentCreateInput) {
  if (input.tenantId !== KNOWLEDGE_TENANT_ID || !Number.isSafeInteger(input.fileVersion) || input.fileVersion < 1 || !isSha256Hex(input.checksum)) {
    throw new KnowledgeRepositoryError("Knowledge document input is invalid.", 400, "invalid_input");
  }
  const accessScope = input.accessScope || "company";
  if (!isKnowledgeAccessScope(accessScope)) throw new KnowledgeRepositoryError("Access scope is invalid.", 400, "invalid_input");
  const effectiveFrom = validIso(cleanOptional(input.effectiveFrom, "Effective from"), "Effective from");
  const effectiveTo = validIso(cleanOptional(input.effectiveTo, "Effective to"), "Effective to");
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) throw new KnowledgeRepositoryError("Effective dates are invalid.", 400, "invalid_input");
  return {
    ...input, title: cleanRequired(input.title, "Title"), fileName: cleanRequired(input.fileName, "File name"),
    sourcePath: cleanRequired(input.sourcePath, "Source path", 1000), contentType: cleanRequired(input.contentType, "Content type"),
    documentType: cleanRequired(input.documentType, "Document type"), category: cleanRequired(input.category, "Category"),
    language: cleanRequired(input.language, "Language", 40), version: cleanRequired(input.version, "Version", 80),
    createdBy: cleanRequired(input.createdBy, "Created by", 64), accessScope,
    product: cleanOptional(input.product, "Product"), region: cleanOptional(input.region, "Region"),
    effectiveFrom, effectiveTo, tags: normalizedTags(input.tags || []), checksum: input.checksum.toLowerCase(),
  };
}

export async function createKnowledgeDocument(raw: KnowledgeDocumentCreateInput): Promise<KnowledgeDocumentCreateResult> {
  const input = validatedCreate(raw);
  return withMutation(async () => {
    const existing = await getKnowledgeDocumentByFileId(input.fileId, input.tenantId);
    if (existing && existing.sourceChecksum === input.checksum && existing.fileVersion === input.fileVersion
      && existing.fileName === input.fileName && existing.sourcePath === input.sourcePath
      && existing.title === input.title && existing.contentType === input.contentType
      && existing.documentType === input.documentType && existing.category === input.category
      && existing.language === input.language && existing.version === input.version
      && existing.accessScope === input.accessScope && existing.product === input.product
      && existing.region === input.region && existing.effectiveFrom === input.effectiveFrom
      && existing.effectiveTo === input.effectiveTo && JSON.stringify(existing.tags) === JSON.stringify(input.tags)) {
      return { document: existing, action: "unchanged" };
    }
    const duplicate = await getActiveKnowledgeDocumentByChecksum(input.checksum, input.tenantId);
    if (duplicate && duplicate.id !== existing?.id) throw duplicateChecksumError();
    const timestamp = existing ? timestampAfter(existing.updatedAt) : now();
    if (existing) {
      const next: KnowledgeDocument = {
        ...existing, fileVersion: input.fileVersion, title: input.title, fileName: input.fileName,
        sourcePath: input.sourcePath, contentType: input.contentType, documentType: input.documentType,
        category: input.category, language: input.language, sourceChecksum: input.checksum, version: input.version,
        indexGeneration: existing.indexGeneration + 1, status: "pending", accessScope: input.accessScope,
        product: input.product, region: input.region, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
        tags: input.tags, errorCode: null, errorMessage: null, disabledAt: null, disabledReason: null,
        updatedAt: timestamp, updatedBy: input.createdBy,
      };
      const database = await d1();
      if (!database) {
        const state = await readLocalState();
        state.documents = state.documents.map((document) => document.id === existing.id ? next : document);
        await writeLocalState(state);
      } else {
        const result = await database.prepare(`UPDATE erp_knowledge_documents SET file_version=?1,title=?2,file_name=?3,
          source_path=?4,content_type=?5,document_type=?6,category=?7,language=?8,source_checksum=?9,version=?10,
          index_generation=?11,status='pending',access_scope=?12,product=?13,region=?14,effective_from=?15,
          effective_to=?16,tags_json=?17,error_code=NULL,error_message=NULL,disabled_at=NULL,disabled_reason=NULL,
          updated_at=?18,updated_by=?19 WHERE id=?20 AND tenant_id=?21`)
          .bind(input.fileVersion,input.title,input.fileName,input.sourcePath,input.contentType,input.documentType,input.category,
            input.language,input.checksum,input.version,next.indexGeneration,input.accessScope,input.product,input.region,
            input.effectiveFrom,input.effectiveTo,JSON.stringify(input.tags),timestamp,input.createdBy,existing.id,input.tenantId).run();
        if (!result.success) throwMappedWriteError(result.error, "Knowledge update failed.");
      }
      return { document: next, action: "reindex_required" };
    }
    const document: KnowledgeDocument = {
      id: randomUUID(), tenantId: input.tenantId, fileId: input.fileId, fileVersion: input.fileVersion,
      title: input.title, fileName: input.fileName, sourcePath: input.sourcePath, contentType: input.contentType,
      documentType: input.documentType, category: input.category, language: input.language,
      sourceChecksum: input.checksum, version: input.version, indexGeneration: 1, status: "pending",
      accessScope: input.accessScope, product: input.product, region: input.region,
      effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, tags: input.tags,
      lastIndexedAt: null, errorCode: null, errorMessage: null, disabledAt: null, disabledReason: null,
      createdAt: timestamp, createdBy: input.createdBy, updatedAt: timestamp, updatedBy: input.createdBy,
    };
    const database = await d1();
    if (!database) { const state = await readLocalState(); state.documents.push(document); await writeLocalState(state); }
    else {
      const result = await database.prepare(`INSERT INTO erp_knowledge_documents (${DOCUMENT_COLUMNS})
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,
          ?22,?23,?24,?25,?26,?27,?28,?29,?30)`)
        .bind(document.id,document.tenantId,document.fileId,document.fileVersion,document.title,document.fileName,
          document.sourcePath,document.contentType,document.documentType,document.category,document.language,
          document.sourceChecksum,document.version,document.indexGeneration,document.status,document.accessScope,
          document.product,document.region,document.effectiveFrom,document.effectiveTo,JSON.stringify(document.tags),
          null,null,null,null,null,document.createdAt,document.createdBy,document.updatedAt,document.updatedBy).run();
      if (!result.success) throwMappedWriteError(result.error, "Knowledge create failed.");
    }
    return { document, action: "created" };
  });
}

export async function updateKnowledgeDocumentMetadata(id: string, raw: KnowledgeDocumentMetadataPatch, expectedUpdatedAt: string) {
  return withMutation(async () => {
    const existing = await getKnowledgeDocument(id);
    if (!existing) throw new KnowledgeRepositoryError("Knowledge document not found.", 404, "not_found");
    if (existing.updatedAt !== expectedUpdatedAt) throw new KnowledgeRepositoryError("Knowledge document changed.", 409, "version_conflict");
    const patch = { ...raw };
    const updatedBy = cleanRequired(patch.updatedBy, "Updated by", 64);
    delete (patch as Partial<KnowledgeDocumentMetadataPatch>).updatedBy;
    if (patch.accessScope !== undefined && !isKnowledgeAccessScope(patch.accessScope)) throw new KnowledgeRepositoryError("Access scope is invalid.", 400, "invalid_input");
    const next: KnowledgeDocument = {
      ...existing, ...patch, updatedBy, updatedAt: timestampAfter(existing.updatedAt), indexGeneration: existing.indexGeneration + 1,
      status: "pending", errorCode: null, errorMessage: null, disabledAt: null, disabledReason: null,
      title: patch.title === undefined ? existing.title : cleanRequired(patch.title, "Title"),
      documentType: patch.documentType === undefined ? existing.documentType : cleanRequired(patch.documentType, "Document type"),
      category: patch.category === undefined ? existing.category : cleanRequired(patch.category, "Category"),
      language: patch.language === undefined ? existing.language : cleanRequired(patch.language, "Language", 40),
      version: patch.version === undefined ? existing.version : cleanRequired(patch.version, "Version", 80),
      product: patch.product === undefined ? existing.product : cleanOptional(patch.product, "Product"),
      region: patch.region === undefined ? existing.region : cleanOptional(patch.region, "Region"),
      effectiveFrom: patch.effectiveFrom === undefined ? existing.effectiveFrom : validIso(cleanOptional(patch.effectiveFrom, "Effective from"), "Effective from"),
      effectiveTo: patch.effectiveTo === undefined ? existing.effectiveTo : validIso(cleanOptional(patch.effectiveTo, "Effective to"), "Effective to"),
      tags: patch.tags === undefined ? existing.tags : normalizedTags(patch.tags),
    };
    if (next.effectiveFrom && next.effectiveTo && next.effectiveFrom > next.effectiveTo) throw new KnowledgeRepositoryError("Effective dates are invalid.", 400, "invalid_input");
    const database = await d1();
    if (!database) {
      const state = await readLocalState(); state.documents = state.documents.map((document) => document.id === id ? next : document); await writeLocalState(state);
    } else {
      const result = await database.prepare(`UPDATE erp_knowledge_documents SET title=?1,document_type=?2,category=?3,
        language=?4,version=?5,index_generation=?6,status='pending',access_scope=?7,product=?8,region=?9,
        effective_from=?10,effective_to=?11,tags_json=?12,error_code=NULL,error_message=NULL,disabled_at=NULL,
        disabled_reason=NULL,updated_at=?13,updated_by=?14 WHERE id=?15 AND tenant_id=?16 AND updated_at=?17`)
        .bind(next.title,next.documentType,next.category,next.language,next.version,next.indexGeneration,next.accessScope,
          next.product,next.region,next.effectiveFrom,next.effectiveTo,JSON.stringify(next.tags),next.updatedAt,next.updatedBy,
          id,next.tenantId,expectedUpdatedAt).run();
      if (!result.success) throw new KnowledgeRepositoryError(result.error || "Knowledge update failed.", 503, "storage_unavailable");
      if (result.meta?.changes !== 1) throw new KnowledgeRepositoryError("Knowledge document changed.", 409, "version_conflict");
    }
    return next;
  });
}

export async function setKnowledgeDocumentStatus(id: string, status: KnowledgeDocumentStatus, options: {
  tenantId?: KnowledgeTenantId; updatedBy?: string; errorCode?: string | null; errorMessage?: string | null;
  expectedUpdatedAt?: string; indexedAt?: string | null;
} = {}) {
  if (!(KNOWLEDGE_DOCUMENT_STATUSES as readonly string[]).includes(status) || status === "disabled") {
    throw new KnowledgeRepositoryError("Knowledge status is invalid.", 400, "invalid_input");
  }
  return withMutation(async () => {
    const document = await getKnowledgeDocument(id, options.tenantId || KNOWLEDGE_TENANT_ID);
    if (!document) throw new KnowledgeRepositoryError("Knowledge document not found.", 404, "not_found");
    if (options.expectedUpdatedAt && document.updatedAt !== options.expectedUpdatedAt) throw new KnowledgeRepositoryError("Knowledge document changed.", 409, "version_conflict");
    const timestamp = timestampAfter(document.updatedAt);
    const next = { ...document, status, errorCode: options.errorCode || null, errorMessage: options.errorMessage || null,
      lastIndexedAt: options.indexedAt === undefined ? document.lastIndexedAt : options.indexedAt,
      updatedAt: timestamp, updatedBy: cleanRequired(options.updatedBy || "system", "Updated by", 64) };
    const database = await d1();
    if (!database) { const state = await readLocalState(); state.documents = state.documents.map((item) => item.id === id ? next : item); await writeLocalState(state); }
    else {
      const result = await database.prepare(`UPDATE erp_knowledge_documents SET status=?1,error_code=?2,error_message=?3,
        last_indexed_at=?4,updated_at=?5,updated_by=?6 WHERE id=?7 AND tenant_id=?8
        AND (?9 IS NULL OR updated_at=?9)`).bind(status,next.errorCode,next.errorMessage,
          next.lastIndexedAt,timestamp,next.updatedBy,id,next.tenantId,options.expectedUpdatedAt||null).run();
      if (!result.success) throw new KnowledgeRepositoryError(result.error || "Knowledge update failed.", 503, "storage_unavailable");
      if (result.meta?.changes !== 1) throw new KnowledgeRepositoryError("Knowledge document changed.",409,"version_conflict");
    }
    return next;
  });
}

function validatedChunks(chunks: KnowledgeIndexedChunkDraft[]) {
  if (!chunks.length || chunks.length > 20_000) throw new KnowledgeRepositoryError("Knowledge chunks are invalid.", 400, "invalid_input");
  return chunks.map((chunk) => {
    if (!chunk.text.trim() || !Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 1 || !isSha256Hex(chunk.contentChecksum)
      || !Array.isArray(chunk.headingPath) || (chunk.pageFrom === null) !== (chunk.pageTo === null)
      || (chunk.pageFrom !== null && (!Number.isSafeInteger(chunk.pageFrom) || !Number.isSafeInteger(chunk.pageTo) || chunk.pageFrom < 1 || chunk.pageTo! < chunk.pageFrom))) {
      throw new KnowledgeRepositoryError("Knowledge chunks are invalid.", 400, "invalid_input");
    }
    return { ...chunk, text: chunk.text.trim(), headingPath: chunk.headingPath.map((heading) => cleanRequired(heading, "Heading", 300)) };
  });
}

export async function replaceKnowledgeChunksAtomically(
  documentId: string,
  indexGeneration: number,
  rawChunks: KnowledgeIndexedChunkDraft[],
  completion?: { jobId: string; workerId: string },
): Promise<KnowledgeChunkReplacement> {
  const drafts = validatedChunks(rawChunks);
  return withMutation(async () => {
    const document = await getKnowledgeDocument(documentId);
    if (!document) throw new KnowledgeRepositoryError("Knowledge document not found.", 404, "not_found");
    if (document.indexGeneration !== indexGeneration) throw new KnowledgeRepositoryError("stale_generation", 409, "stale_generation");
    const timestamp = timestampAfter(document.updatedAt);
    const retiredChunks = (await listActiveKnowledgeChunksForDocument(documentId, document.tenantId));
    const chunks: KnowledgeChunk[] = drafts.map((draft, chunkIndex) => ({
      ...draft, id: randomUUID(), tenantId: document.tenantId, documentId, indexedVersion: document.version,
      indexGeneration, chunkIndex, indexItemKey: draft.indexItemKey || `knowledge/${documentId}/g${indexGeneration}/${String(chunkIndex).padStart(5,"0")}`,
      indexItemId: cleanRequired(draft.indexItemId, "Index item id", 240),
      active: true, createdAt: timestamp, invalidatedAt: null,
    }));
    const database = await d1();
    if (!database) {
      const state = await readLocalState();
      const job = completion
        ? state.jobs.find((candidate) => candidate.id === completion.jobId && candidate.documentId === documentId)
        : null;
      if (completion && (!job || job.status !== "running" || job.leaseOwner !== completion.workerId
        || job.indexGeneration !== indexGeneration)) {
        throw new KnowledgeRepositoryError("Knowledge job lease is invalid.", 409, "invalid_lease");
      }
      state.chunks = state.chunks.filter((chunk) => !(chunk.documentId === documentId && chunk.indexGeneration === indexGeneration));
      state.chunks = state.chunks.map((chunk) => chunk.documentId === documentId && chunk.active ? { ...chunk, active: false, invalidatedAt: timestamp } : chunk);
      state.chunks.push(...chunks);
      state.documents = state.documents.map((item) => item.id === documentId ? { ...item, status: "ready", lastIndexedAt: timestamp,
        errorCode: null, errorMessage: null, updatedAt: timestamp, updatedBy: "indexer" } : item);
      if (job) {
        Object.assign(job, {
          status: "completed",
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          completedAt: timestamp,
          updatedAt: timestamp,
        });
      }
      await writeLocalState(state);
    } else {
      if (completion) {
        const job = await getKnowledgeIndexJob(completion.jobId, document.tenantId);
        if (!job || job.documentId !== documentId || job.indexGeneration !== indexGeneration
          || job.status !== "running" || job.leaseOwner !== completion.workerId) {
          throw new KnowledgeRepositoryError("Knowledge job lease is invalid.", 409, "invalid_lease");
        }
      }
      const jobGuard = completion
        ? " AND EXISTS (SELECT 1 FROM erp_knowledge_index_jobs j WHERE j.id=?3 AND j.document_id=?1 AND j.index_generation=?2 AND j.status='running' AND j.lease_owner=?4)"
        : "";
      const statements: D1Statement[] = [
        completion
          ? database.prepare(`DELETE FROM erp_knowledge_chunks WHERE document_id=?1 AND index_generation=?2 AND active=0${jobGuard}`)
            .bind(documentId,indexGeneration,completion.jobId,completion.workerId)
          : database.prepare("DELETE FROM erp_knowledge_chunks WHERE document_id=?1 AND index_generation=?2 AND active=0").bind(documentId,indexGeneration),
        ...chunks.map((chunk) => completion
          ? database.prepare(`INSERT INTO erp_knowledge_chunks (${CHUNK_COLUMNS})
            SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,?15,NULL
            WHERE EXISTS (SELECT 1 FROM erp_knowledge_documents d WHERE d.id=?3 AND d.index_generation=?5 AND d.status<>'disabled')
            AND EXISTS (SELECT 1 FROM erp_knowledge_index_jobs j WHERE j.id=?16 AND j.document_id=?3
              AND j.index_generation=?5 AND j.status='running' AND j.lease_owner=?17)`)
            .bind(chunk.id,chunk.tenantId,chunk.documentId,chunk.indexedVersion,chunk.indexGeneration,chunk.chunkIndex,
              chunk.indexItemKey,chunk.indexItemId,chunk.text,chunk.tokenCount,JSON.stringify(chunk.headingPath),chunk.pageFrom,chunk.pageTo,
              chunk.contentChecksum,chunk.createdAt,completion.jobId,completion.workerId)
          : database.prepare(`INSERT INTO erp_knowledge_chunks (${CHUNK_COLUMNS})
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,?15,NULL)`)
            .bind(chunk.id,chunk.tenantId,chunk.documentId,chunk.indexedVersion,chunk.indexGeneration,chunk.chunkIndex,
              chunk.indexItemKey,chunk.indexItemId,chunk.text,chunk.tokenCount,JSON.stringify(chunk.headingPath),chunk.pageFrom,chunk.pageTo,
              chunk.contentChecksum,chunk.createdAt)),
        completion
          ? database.prepare(`UPDATE erp_knowledge_chunks SET active=0,invalidated_at=?1 WHERE document_id=?2 AND active=1
            AND EXISTS (SELECT 1 FROM erp_knowledge_documents d WHERE d.id=?2 AND d.index_generation=?3 AND d.status<>'disabled')
            AND EXISTS (SELECT 1 FROM erp_knowledge_index_jobs j WHERE j.id=?4 AND j.document_id=?2
              AND j.index_generation=?3 AND j.status='running' AND j.lease_owner=?5)`)
            .bind(timestamp,documentId,indexGeneration,completion.jobId,completion.workerId)
          : database.prepare(`UPDATE erp_knowledge_chunks SET active=0,invalidated_at=?1 WHERE document_id=?2 AND active=1
            AND EXISTS (SELECT 1 FROM erp_knowledge_documents WHERE id=?2 AND index_generation=?3 AND status<>'disabled')`).bind(timestamp,documentId,indexGeneration),
        completion
          ? database.prepare(`UPDATE erp_knowledge_chunks SET active=1,invalidated_at=NULL WHERE document_id=?1 AND index_generation=?2
            AND EXISTS (SELECT 1 FROM erp_knowledge_documents d WHERE d.id=?1 AND d.index_generation=?2 AND d.status<>'disabled')
            AND EXISTS (SELECT 1 FROM erp_knowledge_index_jobs j WHERE j.id=?3 AND j.document_id=?1
              AND j.index_generation=?2 AND j.status='running' AND j.lease_owner=?4)`)
            .bind(documentId,indexGeneration,completion.jobId,completion.workerId)
          : database.prepare(`UPDATE erp_knowledge_chunks SET active=1,invalidated_at=NULL WHERE document_id=?1 AND index_generation=?2
            AND EXISTS (SELECT 1 FROM erp_knowledge_documents WHERE id=?1 AND index_generation=?2 AND status<>'disabled')`).bind(documentId,indexGeneration),
        completion
          ? database.prepare(`UPDATE erp_knowledge_documents SET status='ready',last_indexed_at=?1,error_code=NULL,
            error_message=NULL,updated_at=?1,updated_by='indexer' WHERE id=?2 AND index_generation=?3 AND status<>'disabled'
            AND EXISTS (SELECT 1 FROM erp_knowledge_index_jobs j WHERE j.id=?4 AND j.document_id=?2
              AND j.index_generation=?3 AND j.status='running' AND j.lease_owner=?5)`)
            .bind(timestamp,documentId,indexGeneration,completion.jobId,completion.workerId)
          : database.prepare(`UPDATE erp_knowledge_documents SET status='ready',last_indexed_at=?1,error_code=NULL,
            error_message=NULL,updated_at=?1,updated_by='indexer' WHERE id=?2 AND index_generation=?3`).bind(timestamp,documentId,indexGeneration),
      ];
      const documentStatementIndex = statements.length - 1;
      if (completion) {
        statements.push(database.prepare(`UPDATE erp_knowledge_index_jobs SET status='completed',lease_owner=NULL,
          lease_expires_at=NULL,error_code=NULL,error_message=NULL,completed_at=?1,updated_at=?1
          WHERE id=?2 AND document_id=?3 AND index_generation=?4 AND status='running' AND lease_owner=?5
          AND EXISTS (SELECT 1 FROM erp_knowledge_documents d WHERE d.id=?3 AND d.index_generation=?4 AND d.status='ready')`)
          .bind(timestamp,completion.jobId,documentId,indexGeneration,completion.workerId));
      }
      const results = await database.batch(statements);
      if (results.some((result) => !result.success)) throw new KnowledgeRepositoryError("Atomic knowledge index switch failed.", 503, "storage_unavailable");
      const documentChanged = results[documentStatementIndex]?.meta?.changes === 1;
      const jobCompleted = !completion || results.at(-1)?.meta?.changes === 1;
      if (!documentChanged || !jobCompleted) {
        await database.prepare("DELETE FROM erp_knowledge_chunks WHERE document_id=?1 AND index_generation=?2 AND active=0").bind(documentId,indexGeneration).run();
        throw new KnowledgeRepositoryError(
          completion && !jobCompleted ? "Knowledge job lease is invalid." : "stale_generation",
          409,
          completion && !jobCompleted ? "invalid_lease" : "stale_generation",
        );
      }
    }
    return { activeChunks: chunks, retiredChunks };
  });
}

export async function listActiveKnowledgeChunksForDocument(documentId: string, tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID) {
  const database = await d1();
  if (!database) return (await readLocalState()).chunks.filter((chunk) => chunk.documentId === documentId && chunk.tenantId === tenantId && chunk.active);
  const result = await database.prepare(`SELECT ${CHUNK_COLUMNS} FROM erp_knowledge_chunks WHERE document_id=?1 AND tenant_id=?2 AND active=1 ORDER BY chunk_index`).bind(documentId,tenantId).all();
  if (!result.success) throw new KnowledgeRepositoryError(result.error || "Knowledge chunk read failed.",503,"storage_unavailable");
  return (result.results || []).map((row)=>chunkFromRow(row as Record<string,unknown>));
}

/** Batch projection used by the Files knowledge resource inspector. */
export async function listActiveKnowledgeChunkCounts(tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID) {
  const database = await d1();
  if (!database) {
    const chunks = (await readLocalState()).chunks.filter((chunk) => chunk.tenantId === tenantId && chunk.active);
    const counts = new Map<string, number>();
    for (const chunk of chunks) counts.set(chunk.documentId, (counts.get(chunk.documentId) || 0) + 1);
    return counts;
  }
  const result = await database.prepare(`SELECT document_id, COUNT(*) AS active_chunks
    FROM erp_knowledge_chunks WHERE tenant_id=?1 AND active=1 GROUP BY document_id`)
    .bind(tenantId).all<Record<string, unknown>>();
  if (!result.success) throw new KnowledgeRepositoryError(result.error || "Knowledge vector counts are unavailable.", 503, "storage_unavailable");
  const counts = new Map<string, number>();
  for (const row of result.results || []) {
    const documentId = row.document_id;
    const count = Number(row.active_chunks);
    if (typeof documentId !== "string" || !Number.isSafeInteger(count) || count < 0) {
      throw new KnowledgeRepositoryError("Knowledge vector counts are invalid.", 503, "storage_unavailable");
    }
    counts.set(documentId, count);
  }
  return counts;
}

/**
 * Small readiness projection for health checks. It deliberately avoids loading
 * chunk text or issuing one query per document. The sample key lets the caller
 * verify that D1's active generation still exists in the bound Vectorize index.
 */
export async function getKnowledgeReadinessSnapshot(tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID) {
  const database = await d1();
  if (!database) {
    const state = await readLocalState();
    const activeChunks = state.chunks.filter((chunk) => chunk.tenantId === tenantId && chunk.active);
    return {
      readyDocuments: new Set(activeChunks.map((chunk) => chunk.documentId)).size,
      activeChunks: activeChunks.length,
      sampleIndexItemKey: activeChunks[0]?.indexItemKey || null,
    };
  }
  const row = await database.prepare(`SELECT
      COUNT(DISTINCT document_id) AS ready_documents,
      COUNT(*) AS active_chunks,
      MIN(index_item_key) AS sample_index_item_key
    FROM erp_knowledge_chunks WHERE tenant_id=?1 AND active=1`)
    .bind(tenantId)
    .first<Record<string, unknown>>();
  const readyDocuments = Number(row?.ready_documents);
  const activeChunks = Number(row?.active_chunks);
  const sampleIndexItemKey = row?.sample_index_item_key;
  if (!Number.isSafeInteger(readyDocuments) || readyDocuments < 0
    || !Number.isSafeInteger(activeChunks) || activeChunks < 0
    || !(sampleIndexItemKey === null || sampleIndexItemKey === undefined || typeof sampleIndexItemKey === "string")) {
    throw new KnowledgeRepositoryError("Knowledge readiness metadata is invalid.", 503, "storage_unavailable");
  }
  return {
    readyDocuments,
    activeChunks,
    sampleIndexItemKey: typeof sampleIndexItemKey === "string" && sampleIndexItemKey ? sampleIndexItemKey : null,
  };
}

export async function listKnowledgeChunksByKeys(keys: readonly string[], options: { tenantId?: KnowledgeTenantId } = {}) {
  const unique = [...new Set(keys)].slice(0, 100);
  if (!unique.length) return [];
  const tenantId = options.tenantId || KNOWLEDGE_TENANT_ID;
  const database = await d1();
  if (!database) return (await readLocalState()).chunks.filter((chunk) => chunk.tenantId === tenantId && chunk.active && unique.includes(chunk.indexItemKey));
  const placeholders = unique.map((_, index) => `?${index + 2}`).join(",");
  const result = await database.prepare(`SELECT ${CHUNK_COLUMNS.replaceAll(/\b(id|tenant_id|document_id|indexed_version|index_generation|chunk_index|index_item_key|text|token_count|heading_path_json|page_from|page_to|content_checksum|active|created_at|invalidated_at)\b/g, "c.$1")}
    FROM erp_knowledge_chunks c JOIN erp_knowledge_documents d ON d.id=c.document_id
    JOIN erp_workspace_files f ON f.id=d.file_id
    WHERE c.tenant_id=?1 AND c.active=1 AND f.trashed_at IS NULL AND c.index_item_key IN (${placeholders})`)
    .bind(tenantId,...unique).all();
  if (!result.success) throw new KnowledgeRepositoryError(result.error || "Knowledge chunk read failed.", 503, "storage_unavailable");
  return (result.results || []).map((row) => chunkFromRow(row as Record<string, unknown>));
}

export async function disableKnowledgeForFile(fileId: string, reason: string, tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID, updatedBy = "system") {
  return withMutation(async () => {
    const document = await getKnowledgeDocumentByFileId(fileId, tenantId);
    if (!document) return null;
    if (document.status === "disabled") return document;
    const timestamp = timestampAfter(document.updatedAt);
    const next = { ...document, status: "disabled" as const, disabledAt: timestamp, disabledReason: cleanRequired(reason,"Disabled reason",500),
      updatedAt: timestamp, updatedBy: cleanRequired(updatedBy,"Updated by",64) };
    const database = await d1();
    if (!database) { const state=await readLocalState(); state.documents=state.documents.map((item)=>item.id===document.id?next:item);
      state.chunks=state.chunks.map((chunk)=>chunk.documentId===document.id&&chunk.active?{...chunk,active:false,invalidatedAt:timestamp}:chunk); await writeLocalState(state); }
    else {
      const results=await database.batch([
        database.prepare("UPDATE erp_knowledge_documents SET status='disabled',disabled_at=?1,disabled_reason=?2,updated_at=?1,updated_by=?3 WHERE id=?4 AND tenant_id=?5").bind(timestamp,next.disabledReason,next.updatedBy,document.id,tenantId),
        database.prepare("UPDATE erp_knowledge_chunks SET active=0,invalidated_at=?1 WHERE document_id=?2 AND active=1").bind(timestamp,document.id),
      ]); if(results.some((result)=>!result.success)) throw new KnowledgeRepositoryError("Knowledge disable failed.",503,"storage_unavailable");
    }
    return next;
  });
}

export async function reactivateKnowledgeForFile(fileId: string, tenantId: KnowledgeTenantId = KNOWLEDGE_TENANT_ID, updatedBy = "system") {
  return withMutation(async () => {
    const document = await getKnowledgeDocumentByFileId(fileId,tenantId);
    if(!document) throw new KnowledgeRepositoryError("Knowledge document not found.",404,"not_found");
    const duplicate = await getActiveKnowledgeDocumentByChecksum(document.sourceChecksum, tenantId);
    if (duplicate && duplicate.id !== document.id) throw duplicateChecksumError();
    const timestamp=timestampAfter(document.updatedAt); const next={...document,status:"pending" as const,indexGeneration:document.indexGeneration+1,
      disabledAt:null,disabledReason:null,errorCode:null,errorMessage:null,updatedAt:timestamp,updatedBy:cleanRequired(updatedBy,"Updated by",64)};
    const database=await d1();
    if(!database){const state=await readLocalState();state.documents=state.documents.map((item)=>item.id===document.id?next:item);await writeLocalState(state);}
    else {const result=await database.prepare("UPDATE erp_knowledge_documents SET status='pending',index_generation=?1,disabled_at=NULL,disabled_reason=NULL,error_code=NULL,error_message=NULL,updated_at=?2,updated_by=?3 WHERE id=?4 AND tenant_id=?5").bind(next.indexGeneration,timestamp,next.updatedBy,document.id,tenantId).run();if(!result.success)throwMappedWriteError(result.error,"Knowledge reactivation failed.");}
    return next;
  });
}

export async function enqueueKnowledgeIndexJob(input:{documentId:string;tenantId:KnowledgeTenantId;requestedBy:string;reason:string}) {
  return withMutation(async()=>{
    let document=await getKnowledgeDocument(input.documentId,input.tenantId);
    if(!document)throw new KnowledgeRepositoryError("Knowledge document not found.",404,"not_found");
    if(document.status==="disabled")throw new KnowledgeRepositoryError("Knowledge document is disabled.",409,"document_disabled");
    const database=await d1();
    const state=database?null:await readLocalState();
    const active=database
      ? await database.prepare(`SELECT ${JOB_COLUMNS} FROM erp_knowledge_index_jobs WHERE tenant_id=?1 AND document_id=?2 AND status IN ('pending','running') LIMIT 1`).bind(input.tenantId,input.documentId).first<Record<string,unknown>>()
      : state!.jobs.find((job)=>job.tenantId===input.tenantId&&job.documentId===input.documentId&&(job.status==="pending"||job.status==="running"));
    if(active)return database?jobFromRow(active as Record<string,unknown>):active as KnowledgeIndexJob;
    const timestamp=timestampAfter(document.updatedAt);
    const generation=document.status==="ready"?document.indexGeneration+1:document.indexGeneration;
    document={...document,indexGeneration:generation,status:"indexing",updatedAt:timestamp,updatedBy:cleanRequired(input.requestedBy,"Requested by",64)};
    const job:KnowledgeIndexJob={id:randomUUID(),tenantId:input.tenantId,documentId:input.documentId,indexGeneration:generation,
      status:"pending",reason:cleanRequired(input.reason,"Reason",100),attempts:0,availableAt:timestamp,leaseOwner:null,
      leaseExpiresAt:null,errorCode:null,errorMessage:null,requestedAt:timestamp,requestedBy:document.updatedBy,startedAt:null,
      completedAt:null,updatedAt:timestamp};
    if(!database){state!.documents=state!.documents.map((item)=>item.id===document.id?document:item);state!.jobs.push(job);await writeLocalState(state!);}
    else {const results=await database.batch([
      database.prepare("UPDATE erp_knowledge_documents SET status='indexing',index_generation=?1,updated_at=?2,updated_by=?3 WHERE id=?4 AND tenant_id=?5").bind(generation,timestamp,document.updatedBy,document.id,input.tenantId),
      database.prepare(`INSERT INTO erp_knowledge_index_jobs (${JOB_COLUMNS}) VALUES (?1,?2,?3,?4,'pending',?5,0,?6,NULL,NULL,NULL,NULL,?6,?7,NULL,NULL,?6)`).bind(job.id,job.tenantId,job.documentId,job.indexGeneration,job.reason,timestamp,job.requestedBy),
    ]);if(results.some((result)=>!result.success))throw new KnowledgeRepositoryError("Knowledge job enqueue failed.",503,"storage_unavailable");}
    return job;
  });
}

export async function claimNextKnowledgeIndexJob(input:{tenantId:KnowledgeTenantId;workerId:string;leaseSeconds?:number;now?:Date}) {
  return withMutation(async()=>{
    const claim=claimTime(input.now);const timestamp=claim.timestamp;
    const leaseExpiresAt=new Date(claim.time+Math.min(Math.max(input.leaseSeconds||120,30),900)*1000).toISOString();
    const database=await d1();
    if(!database){const state=await readLocalState();const job=state.jobs.filter((item)=>item.tenantId===input.tenantId&&jobIsClaimable(item,timestamp)).sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt))[0];if(!job)return null;
      Object.assign(job,{status:"running",attempts:job.attempts+1,leaseOwner:cleanRequired(input.workerId,"Worker",100),leaseExpiresAt,startedAt:job.startedAt||timestamp,updatedAt:timestamp});await writeLocalState(state);return job;}
    const row=await database.prepare(CLAIM_NEXT_KNOWLEDGE_INDEX_JOB_SQL)
      .bind(cleanRequired(input.workerId,"Worker",100),leaseExpiresAt,timestamp,input.tenantId).first<Record<string,unknown>>();return row?jobFromRow(row):null;
  });
}

export async function claimKnowledgeIndexJob(input:{jobId:string;tenantId:KnowledgeTenantId;workerId:string;leaseSeconds?:number;now?:Date}) {
  return withMutation(async()=>{
    const claim=claimTime(input.now);const timestamp=claim.timestamp;
    const workerId=cleanRequired(input.workerId,"Worker",100);
    const leaseExpiresAt=new Date(claim.time+Math.min(Math.max(input.leaseSeconds||120,30),900)*1000).toISOString();
    const database=await d1();
    if(!database){
      const state=await readLocalState();const job=state.jobs.find((item)=>item.id===input.jobId&&item.tenantId===input.tenantId);
      if(!job||job.status==="completed"||job.status==="failed")return null;
      if(job.status==="running"&&!jobIsClaimable(job,timestamp))return job.leaseOwner===workerId?job:null;
      if(!jobIsClaimable(job,timestamp))return null;
      Object.assign(job,{status:"running",attempts:job.attempts+1,leaseOwner:workerId,leaseExpiresAt,
        startedAt:job.startedAt||timestamp,updatedAt:timestamp});await writeLocalState(state);return job;
    }
    const row=await database.prepare(CLAIM_KNOWLEDGE_INDEX_JOB_SQL).bind(workerId,leaseExpiresAt,timestamp,input.jobId,input.tenantId)
      .first<Record<string,unknown>>();
    if(row)return jobFromRow(row);
    const existing=await getKnowledgeIndexJob(input.jobId,input.tenantId);
    return existing?.status==="running"&&existing.leaseOwner===workerId?existing:null;
  });
}

export async function getKnowledgeIndexJob(jobId:string,tenantId:KnowledgeTenantId=KNOWLEDGE_TENANT_ID) {
  const database=await d1();
  if(!database)return (await readLocalState()).jobs.find((job)=>job.id===jobId&&job.tenantId===tenantId)||null;
  const row=await database.prepare(`SELECT ${JOB_COLUMNS} FROM erp_knowledge_index_jobs WHERE id=?1 AND tenant_id=?2`).bind(jobId,tenantId).first<Record<string,unknown>>();
  return row?jobFromRow(row):null;
}

export async function completeKnowledgeIndexJob(jobId:string,workerId:string) {
  return finishJob(jobId,workerId,{status:"completed",errorCode:null,errorMessage:null});
}

export async function failKnowledgeIndexJob(jobId:string,workerId:string,error:{code:string;message:string;retryAt?:string|null}) {
  return finishJob(jobId,workerId,{status:error.retryAt?"pending":"failed",errorCode:cleanRequired(error.code,"Error code",100),
    errorMessage:cleanRequired(error.message,"Error message",1000),retryAt:error.retryAt||null});
}

async function finishJob(jobId:string,workerId:string,outcome:{status:"completed"|"failed"|"pending";errorCode:string|null;errorMessage:string|null;retryAt?:string|null}) {
  return withMutation(async()=>{const timestamp=now();const database=await d1();
    if(!database){const state=await readLocalState();const job=state.jobs.find((item)=>item.id===jobId);if(!job||job.status!=="running"||job.leaseOwner!==workerId)throw new KnowledgeRepositoryError("Knowledge job lease is invalid.",409,"invalid_lease");
      Object.assign(job,{status:outcome.status,availableAt:outcome.retryAt||job.availableAt,leaseOwner:null,leaseExpiresAt:null,errorCode:outcome.errorCode,
        errorMessage:outcome.errorMessage,completedAt:outcome.status==="pending"?null:timestamp,updatedAt:timestamp});await writeLocalState(state);return job;}
    const row=await database.prepare(`UPDATE erp_knowledge_index_jobs SET status=?1,available_at=COALESCE(?2,available_at),
      lease_owner=NULL,lease_expires_at=NULL,error_code=?3,error_message=?4,completed_at=CASE WHEN ?1='pending' THEN NULL ELSE ?5 END,
      updated_at=?5 WHERE id=?6 AND status='running' AND lease_owner=?7 RETURNING ${JOB_COLUMNS}`)
      .bind(outcome.status,outcome.retryAt||null,outcome.errorCode,outcome.errorMessage,timestamp,jobId,workerId).first<Record<string,unknown>>();
    if(!row)throw new KnowledgeRepositoryError("Knowledge job lease is invalid.",409,"invalid_lease");return jobFromRow(row);});
}
