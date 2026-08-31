import { getCloudflareContext } from "@opennextjs/cloudflare";

type D1RunResult = {
  success: boolean;
  error?: string;
  meta?: {
    changes?: number;
  };
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{
    success: boolean;
    results?: T[];
    error?: string;
  }>;
  run(): Promise<D1RunResult>;
};

export type ErpD1Database = {
  prepare(query: string): D1PreparedStatement;
};

export type ErpFileNamespace = {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { metadata?: Record<string, string> },
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

export type ErpKnowledgeIndexWorkflow = {
  create(options: {
    params: { jobId: string };
    locationHint?: "oc";
  }): Promise<unknown>;
};

export type ErpEmbeddingModel = "@cf/qwen/qwen3-embedding-0.6b";

export type ErpWorkersAi = {
  run(
    model: ErpEmbeddingModel,
    input: { queries?: string | string[]; documents?: string | string[]; text?: string | string[]; instruction?: string },
  ): Promise<{ data?: number[][]; shape?: number[] }>;
};

export type ErpVectorMetadataValue = string | number | boolean | string[];

export type ErpVector = {
  id: string;
  values: number[] | Float32Array | Float64Array;
  namespace?: string;
  metadata?: Record<string, ErpVectorMetadataValue>;
};

export type ErpVectorizeIndex = {
  describe(): Promise<{
    vectorCount: number;
    dimensions: number;
    processedUpToDatetime: string | number;
    processedUpToMutation: string | number;
  }>;
  upsert(vectors: ErpVector[]): Promise<{ mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
  getByIds(ids: string[]): Promise<ErpVector[]>;
  query(vector: number[] | Float32Array | Float64Array, options?: {
    topK?: number;
    namespace?: string;
    returnValues?: boolean;
    returnMetadata?: boolean | "all" | "indexed" | "none";
    filter?: Record<string, unknown>;
  }): Promise<{
    count: number;
    matches: Array<ErpVector & { score: number }>;
  }>;
};

export type ErpCloudflareBindings = {
  database: ErpD1Database | null;
  files: ErpFileNamespace | null;
  workersAi: ErpWorkersAi | null;
  knowledgeVectors: ErpVectorizeIndex | null;
  knowledgeIndexWorkflow: ErpKnowledgeIndexWorkflow | null;
};

export type VersionedDocument<T> = {
  value: T | null;
  version: number;
};

export class CloudflareStorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareStorageConfigurationError";
  }
}

export class CloudflareDocumentConflictError extends Error {
  constructor() {
    super("The stored document changed while it was being updated.");
    this.name = "CloudflareDocumentConflictError";
  }
}

const MAXIMUM_DOCUMENT_BYTES = 1_900_000;

/**
 * Returns null when running under ordinary Node (tests/local Next.js). Inside a
 * Worker it returns the request-scoped bindings, including null for a missing
 * binding so production never silently falls back to the ephemeral filesystem.
 */
export async function erpCloudflareBindings(): Promise<ErpCloudflareBindings | null> {
  if (process.env.NODE_ENV !== "production") return null;
  const context = await getCloudflareContext({ async: true });
  const env = context.env as unknown as {
    ERP_DB?: ErpD1Database;
    ERP_FILES?: ErpFileNamespace;
    AI?: ErpWorkersAi;
    KNOWLEDGE_VECTORS?: ErpVectorizeIndex;
    KNOWLEDGE_INDEX_WORKFLOW?: ErpKnowledgeIndexWorkflow;
  };
  return {
    database: env.ERP_DB || null,
    files: env.ERP_FILES || null,
    workersAi: env.AI || null,
    knowledgeVectors: env.KNOWLEDGE_VECTORS || null,
    knowledgeIndexWorkflow: env.KNOWLEDGE_INDEX_WORKFLOW || null,
  };
}

export async function readVersionedDocument<T>(
  database: ErpD1Database,
  key: string,
): Promise<VersionedDocument<T>> {
  const row = await database
    .prepare("SELECT value, version FROM erp_documents WHERE key = ?1")
    .bind(key)
    .first<{ value: string; version: number }>();
  if (!row) return { value: null, version: 0 };
  if (typeof row.value !== "string" || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new CloudflareStorageConfigurationError("The ERP database returned an invalid document.");
  }
  return { value: JSON.parse(row.value) as T, version: row.version };
}

export async function writeVersionedDocument(
  database: ErpD1Database,
  key: string,
  value: unknown,
  expectedVersion: number,
) {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAXIMUM_DOCUMENT_BYTES) {
    throw new CloudflareStorageConfigurationError(
      "The ERP document has reached its safe D1 storage limit. Archive older records before saving more data.",
    );
  }
  const timestamp = new Date().toISOString();
  const result = expectedVersion === 0
    ? await database
      .prepare(`INSERT OR IGNORE INTO erp_documents (key, value, version, updated_at)
        VALUES (?1, ?2, 1, ?3)`)
      .bind(key, serialized, timestamp)
      .run()
    : await database
      .prepare(`UPDATE erp_documents
        SET value = ?1, version = version + 1, updated_at = ?2
        WHERE key = ?3 AND version = ?4`)
      .bind(serialized, timestamp, key, expectedVersion)
      .run();

  if (!result.success) {
    throw new CloudflareStorageConfigurationError(result.error || "The ERP database write failed.");
  }
  if (result.meta?.changes !== 1) throw new CloudflareDocumentConflictError();
}
