// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { erpCloudflareBindings, type ErpVector, type ErpVectorizeIndex, type ErpWorkersAi } from "../server/cloudflare-storage.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_INDEX_EXECUTION_CONFIG, KNOWLEDGE_VECTOR_CONFIG } from "./config.ts";
import type {
  KnowledgeChunkDraft,
  KnowledgeDocument,
  KnowledgeIndexedChunkDraft,
} from "./types";

export type KnowledgeVectorMatch = {
  id: string;
  score: number;
};

export type KnowledgeVectorProvider = {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  upsert(vectors: ErpVector[]): Promise<{ mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
  getByIds(ids: string[]): Promise<ErpVector[]>;
  query(vector: number[], options: {
    topK: number;
    namespace: string;
    filter: Record<string, unknown>;
  }): Promise<KnowledgeVectorMatch[]>;
  describe(): ReturnType<ErpVectorizeIndex["describe"]>;
};

export class KnowledgeVectorProviderError extends Error {
  readonly code: "unavailable" | "index_failed" | "index_timeout";
  readonly retryable: boolean;

  constructor(
    code: KnowledgeVectorProviderError["code"],
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = "KnowledgeVectorProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === KNOWLEDGE_VECTOR_CONFIG.dimensions
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function embeddingRunner(ai: ErpWorkersAi, mode: "documents" | "queries") {
  return async (texts: string[]) => {
    if (!texts.length) return [];
    const output = await ai.run(KNOWLEDGE_VECTOR_CONFIG.embeddingModel, {
      [mode]: texts,
      instruction: mode === "queries"
        ? "Retrieve E3 Energy internal passages that answer this support or operations question."
        : "Represent this E3 Energy internal knowledge passage for retrieval.",
    });
    if (!Array.isArray(output.data) || output.data.length !== texts.length
      || !output.data.every(validEmbedding)) {
      throw new KnowledgeVectorProviderError(
        "index_failed",
        "Workers AI returned invalid knowledge embeddings.",
      );
    }
    return output.data;
  };
}

export function createKnowledgeVectorProvider(input: {
  ai: ErpWorkersAi;
  index: ErpVectorizeIndex;
}): KnowledgeVectorProvider {
  const embedDocuments = embeddingRunner(input.ai, "documents");
  const embedQueries = embeddingRunner(input.ai, "queries");
  return {
    embedDocuments,
    async embedQuery(query) {
      const [embedding] = await embedQueries([query]);
      if (!embedding) throw new KnowledgeVectorProviderError("unavailable", "The query could not be embedded.");
      return embedding;
    },
    upsert: (vectors) => input.index.upsert(vectors),
    deleteByIds: (ids) => input.index.deleteByIds(ids),
    getByIds: (ids) => input.index.getByIds(ids),
    async query(vector, options) {
      const response = await input.index.query(vector, {
        topK: options.topK,
        namespace: options.namespace,
        filter: options.filter,
        returnMetadata: "indexed",
        returnValues: false,
      });
      if (!response || !Array.isArray(response.matches)) {
        throw new KnowledgeVectorProviderError("unavailable", "Vectorize returned an invalid search response.");
      }
      return response.matches
        .filter((match) => typeof match.id === "string" && Number.isFinite(match.score))
        .map((match) => ({ id: match.id, score: match.score }));
    },
    describe: () => input.index.describe(),
  };
}

export async function knowledgeVectorBinding(): Promise<KnowledgeVectorProvider> {
  const bindings = await erpCloudflareBindings();
  if (!bindings?.workersAi || !bindings.knowledgeVectors) {
    throw new KnowledgeVectorProviderError(
      "unavailable",
      "The Workers AI or Vectorize knowledge binding is unavailable.",
    );
  }
  return createKnowledgeVectorProvider({ ai: bindings.workersAi, index: bindings.knowledgeVectors });
}

function vectorText(document: KnowledgeDocument, chunk: KnowledgeChunkDraft) {
  return [document.title, ...chunk.headingPath, chunk.text].filter(Boolean).join("\n\n");
}

function vectorMetadata(document: KnowledgeDocument, chunkIndex: number) {
  return {
    tenant_id: document.tenantId,
    document_id: document.id,
    generation: document.indexGeneration,
    chunk_index: chunkIndex,
    access_scope: document.accessScope,
    language: document.language,
    category: document.category,
    product: document.product || "__none__",
    region: document.region || "__none__",
  };
}

type KnowledgeVectorTiming = {
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
};

const DEFAULT_TIMING: KnowledgeVectorTiming = {
  now: Date.now,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function embeddingsInBatches(
  provider: KnowledgeVectorProvider,
  texts: string[],
) {
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += KNOWLEDGE_VECTOR_CONFIG.embeddingBatchSize) {
    const batch = texts.slice(offset, offset + KNOWLEDGE_VECTOR_CONFIG.embeddingBatchSize);
    output.push(...await provider.embedDocuments(batch));
  }
  return output;
}

async function visibleVectorIds(
  provider: KnowledgeVectorProvider,
  ids: string[],
) {
  const visible = new Set<string>();
  // Keep each lookup comfortably below the binding's per-request ID limit.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const vectors = await provider.getByIds(ids.slice(offset, offset + 100));
    for (const vector of vectors) visible.add(vector.id);
  }
  return visible;
}

export async function upsertKnowledgeChunks(input: {
  provider: KnowledgeVectorProvider;
  document: KnowledgeDocument;
  chunks: KnowledgeChunkDraft[];
  providerTimeoutMs?: number;
  deadlineAt?: number;
  timing?: KnowledgeVectorTiming;
}): Promise<KnowledgeIndexedChunkDraft[]> {
  const timing = input.timing || DEFAULT_TIMING;
  const ids = input.chunks.map((chunk, index) => chunk.indexItemKey
    || `knowledge/${input.document.id}/g${input.document.indexGeneration}/${String(index).padStart(5, "0")}`);
  try {
    const embeddings = await embeddingsInBatches(
      input.provider,
      input.chunks.map((chunk) => vectorText(input.document, chunk)),
    );
    if (embeddings.length !== input.chunks.length) {
      throw new KnowledgeVectorProviderError("index_failed", "Workers AI returned an incomplete embedding batch.");
    }
    await input.provider.upsert(embeddings.map((values, index) => ({
      id: ids[index],
      values,
      namespace: input.document.tenantId,
      metadata: vectorMetadata(input.document, index),
    })));

    const timeoutMs = input.providerTimeoutMs
      ?? KNOWLEDGE_INDEX_EXECUTION_CONFIG.vectorMutationTimeoutMs;
    const deadline = Math.min(
      timing.now() + timeoutMs,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    while (true) {
      const visible = await visibleVectorIds(input.provider, ids);
      if (ids.every((id) => visible.has(id))) {
        return input.chunks.map((chunk, index) => ({
          ...chunk,
          indexItemKey: ids[index],
          indexItemId: ids[index],
        }));
      }
      const remaining = deadline - timing.now();
      if (remaining <= 0) {
        throw new KnowledgeVectorProviderError(
          "index_timeout",
          "Vectorize did not make the knowledge vectors searchable in time.",
        );
      }
      await timing.wait(Math.min(KNOWLEDGE_INDEX_EXECUTION_CONFIG.vectorMutationPollIntervalMs, remaining));
    }
  } catch (error) {
    await input.provider.deleteByIds(ids).catch(() => undefined);
    if (error instanceof KnowledgeVectorProviderError) throw error;
    throw new KnowledgeVectorProviderError(
      "index_failed",
      "The knowledge vectors could not be generated or stored.",
    );
  }
}

export async function deleteKnowledgeVectors(
  provider: KnowledgeVectorProvider,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return;
  await provider.deleteByIds(unique);
}
