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

export type ErpAiSearchItemStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "skipped"
  | "outdated";

export type ErpAiSearchItem = {
  id: string;
  key: string;
  status: ErpAiSearchItemStatus;
  chunks_count?: number;
  file_size?: number;
  metadata?: Record<string, unknown>;
  source_id?: string;
  created_at?: string;
  last_seen_at?: string;
};

export type ErpAiSearchListItemsParams = {
  page?: number;
  per_page?: number;
  /** Search item keys by name. */
  search?: string;
  sort_by?: "status" | "modified_at";
  status?: ErpAiSearchItemStatus;
  source?: string;
  metadata_filter?: string;
  item_id?: string;
  key?: string;
};

export type ErpAiSearchListItemsResponse = {
  result: ErpAiSearchItem[];
  result_info?: {
    count: number;
    page: number;
    per_page: number;
    total_count: number;
  };
};

export type ErpAiSearch = {
  items: {
    list(params?: ErpAiSearchListItemsParams): Promise<ErpAiSearchListItemsResponse>;
    upload(
      name: string,
      content: ReadableStream | ArrayBuffer | string,
      options?: { metadata?: Record<string, unknown> },
    ): Promise<ErpAiSearchItem>;
    uploadAndPoll(
      name: string,
      content: ReadableStream | Blob | string,
      options?: {
        metadata?: Record<string, unknown>;
        pollIntervalMs?: number;
        timeoutMs?: number;
      },
    ): Promise<ErpAiSearchItem>;
    delete(itemId: string): Promise<void>;
    get(itemId: string): { info(): Promise<ErpAiSearchItem> };
  };
  search(input: {
    query: string;
    ai_search_options?: {
      retrieval?: {
        retrieval_type?: "vector" | "keyword" | "hybrid";
        match_threshold?: number;
        max_num_results?: number;
        filters?: Record<string, unknown>;
        fusion_method?: "rrf" | "max";
        keyword_match_mode?: "and" | "or";
        return_on_failure?: boolean;
      };
      reranking?: {
        enabled: boolean;
        model?: "@cf/baai/bge-reranker-base";
        match_threshold?: number;
      };
    };
  }): Promise<{
    search_query?: string;
    chunks?: Array<{
      id: string;
      type?: string;
      score: number;
      text: string;
      item: {
        key: string;
        timestamp?: number;
        metadata?: Record<string, unknown>;
      };
      scoring_details?: {
        vector_score?: number;
        keyword_score?: number;
        vector_rank?: number;
        keyword_rank?: number;
        reranking_score?: number;
        fusion_method?: "rrf" | "max";
      };
    }>;
  }>;
};

export type ErpCloudflareBindings = {
  database: ErpD1Database | null;
  files: ErpFileNamespace | null;
  knowledgeSearch: ErpAiSearch | null;
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
    KNOWLEDGE_SEARCH?: ErpAiSearch;
  };
  return {
    database: env.ERP_DB || null,
    files: env.ERP_FILES || null,
    knowledgeSearch: env.KNOWLEDGE_SEARCH || null,
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
