import type {
  AgentAuthContext,
  KnowledgeDocument as AgentKnowledgeDocument,
  ToolEnvelope,
} from "../business-agent/contracts.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { getWorkspaceFileIndexSource, listWorkspaceFileIndexSources } from "../workspace-files/repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { canAccessKnowledgeScope, KNOWLEDGE_RETRIEVAL_CONFIG } from "./config.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { listKnowledgeChunksByKeys, listKnowledgeDocuments } from "./repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { knowledgeCandidatesHaveCurrentConflict, normalizeKnowledgeQuery, selectGroundedKnowledgeResults } from "./retrieval-policy.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_TENANT_ID, type KnowledgeAccessScope, type KnowledgeSearchCandidate } from "./types.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { knowledgeVectorBinding, type KnowledgeVectorProvider } from "./vectorize.ts";

export type KnowledgeSearchInput = {
  query: string;
  product?: string;
  region?: string;
  effective_date?: string;
  limit?: number;
};

type SearchDependencies = {
  provider?: KnowledgeVectorProvider;
  now?: Date;
  getFileSource?: typeof getWorkspaceFileIndexSource;
  getFileSources?: typeof listWorkspaceFileIndexSources;
};

function result<T>(input: Partial<ToolEnvelope<T>> & Pick<ToolEnvelope<T>, "ok" | "data" | "error_code">): ToolEnvelope<T> {
  return {
    source: "cloudflare_vectorize",
    source_record_ids: [],
    updated_at: null,
    retryable: false,
    ...input,
  };
}

function allowedScopes(role: string): KnowledgeAccessScope[] {
  return (["company", "sales", "pm", "finance", "admin"] as KnowledgeAccessScope[])
    .filter((scope) => canAccessKnowledgeScope(role, scope));
}

function cleanFilter(value: unknown, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").trim();
  return cleaned && cleaned.length <= maximum && !/[\u0000-\u001f\u007f]/.test(cleaned) ? cleaned : null;
}

function effectiveDate(value: unknown, fallback: Date) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function exactIdentifiers(query: string) {
  return [...new Set(
    query.match(/\b(?=[A-Za-z0-9./_-]*\d)[A-Za-z][A-Za-z0-9]*(?:[ ._/-][A-Za-z0-9]+)*\b/g) || [],
  )].filter((value) => value.length >= 3);
}

function candidateScore(query: string, text: string, providerScore: number) {
  const haystack = text.normalize("NFKC").toLocaleLowerCase("en-AU");
  const exact = exactIdentifiers(query).some((identifier) => haystack.includes(identifier.toLocaleLowerCase("en-AU")));
  return Math.min(1, providerScore + (exact ? 0.08 : 0));
}

function sameOptionalFilter(actual: string | null, requested: string | undefined) {
  return requested === undefined || actual?.localeCompare(requested, undefined, { sensitivity: "accent" }) === 0;
}

async function providerFromBindings() {
  try {
    return await knowledgeVectorBinding();
  } catch {
    return null;
  }
}

export async function searchKnowledgeBase(
  raw: KnowledgeSearchInput,
  auth: AgentAuthContext,
  dependencies: SearchDependencies = {},
): Promise<ToolEnvelope<AgentKnowledgeDocument[]>> {
  if (auth.tenantId !== KNOWLEDGE_TENANT_ID || !auth.permissions.has("knowledge.read")) {
    return result<AgentKnowledgeDocument[]>({ ok: false, data: null, error_code: "permission_denied" });
  }
  const query = typeof raw.query === "string" ? normalizeKnowledgeQuery(raw.query) : "";
  const product = cleanFilter(raw.product, 100);
  const region = cleanFilter(raw.region, 80);
  const limit = raw.limit ?? KNOWLEDGE_RETRIEVAL_CONFIG.maximumChunks;
  const at = effectiveDate(raw.effective_date, dependencies.now || new Date());
  if (!query || query.length > 500 || product === null || region === null || at === null
    || !Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_RETRIEVAL_CONFIG.maximumChunks) {
    return result<AgentKnowledgeDocument[]>({ ok: false, data: null, error_code: "invalid_input" });
  }
  const scopes = allowedScopes(auth.role);
  if (!scopes.length) return result<AgentKnowledgeDocument[]>({ ok: false, data: null, error_code: "permission_denied" });

  const provider = dependencies.provider || await providerFromBindings();
  if (!provider) {
    return result<AgentKnowledgeDocument[]>({ ok: false, data: null, error_code: "unavailable", retryable: true });
  }

  const filters: Record<string, unknown> = {
    access_scope: { $in: scopes },
  };
  let vectorMatches: Awaited<ReturnType<KnowledgeVectorProvider["query"]>>;
  try {
    const queryVector = await provider.embedQuery(query);
    vectorMatches = await provider.query(queryVector, {
      topK: 40,
      namespace: KNOWLEDGE_TENANT_ID,
      filter: filters,
    });
  } catch {
    return result<AgentKnowledgeDocument[]>({ ok: false, data: null, error_code: "unavailable", retryable: true });
  }

  const providerChunks = vectorMatches
    .filter((match) => typeof match.id === "string" && Number.isFinite(match.score))
    .slice(0, 100);
  if (!providerChunks.length) return result({ ok: true, data: [], error_code: null });

  try {
    const chunks = await listKnowledgeChunksByKeys(providerChunks.map((chunk) => chunk.id), {
      tenantId: KNOWLEDGE_TENANT_ID,
    });
    const documents = await listKnowledgeDocuments({ tenantId: KNOWLEDGE_TENANT_ID, includeDisabled: true });
    const documentById = new Map(documents.map((document) => [document.id, document]));
    const providerByKey = new Map<string, (typeof providerChunks)[number]>();
    for (const providerChunk of providerChunks) {
      const current = providerByKey.get(providerChunk.id);
      if (!current || providerChunk.score > current.score) providerByKey.set(providerChunk.id, providerChunk);
    }
    const activeFiles = new Set<string>();
    const candidateDocuments = [...new Set(chunks.map((chunk) => chunk.documentId))]
      .map((documentId) => documentById.get(documentId))
      .filter((document): document is NonNullable<typeof document> => Boolean(document));
    const fileIds = [...new Set(candidateDocuments.map((document) => document.fileId))];
    const sources = dependencies.getFileSources
      ? await dependencies.getFileSources(fileIds)
      : dependencies.getFileSource
        ? new Map(await Promise.all(fileIds.map(async (fileId) => [
          fileId,
          await dependencies.getFileSource!(fileId).catch(() => null),
        ] as const)))
        : await listWorkspaceFileIndexSources(fileIds);
    for (const document of candidateDocuments) {
      const source = sources.get(document.fileId) || null;
      if (source && source.checksum === document.sourceChecksum && source.version === document.fileVersion) {
        activeFiles.add(document.fileId);
      }
    }

    const candidates: KnowledgeSearchCandidate[] = chunks.flatMap((chunk) => {
      const document = documentById.get(chunk.documentId);
      const providerChunk = providerByKey.get(chunk.indexItemKey);
      if (!document || !providerChunk || !sameOptionalFilter(document.product, product)
        || !sameOptionalFilter(document.region, region)) return [];
      return [{
        document,
        chunk,
        score: candidateScore(query, `${document.title}\n${chunk.text}`, providerChunk.score),
      }];
    });
    const grounded = selectGroundedKnowledgeResults({
      candidates,
      role: auth.role,
      tenantId: KNOWLEDGE_TENANT_ID,
      activeFileIds: activeFiles,
      now: at,
      limit,
    });
    const policyConflict = knowledgeCandidatesHaveCurrentConflict({
      candidates,
      role: auth.role,
      tenantId: KNOWLEDGE_TENANT_ID,
      activeFileIds: activeFiles,
      now: at,
    });
    const data: AgentKnowledgeDocument[] = grounded.map(({ document, chunk }) => ({
      document_id: document.id,
      chunk_id: chunk.indexItemKey,
      file_id: document.fileId,
      title: document.title,
      version: chunk.indexedVersion,
      product: document.product,
      region: document.region,
      effective_from: document.effectiveFrom,
      effective_to: document.effectiveTo,
      access_scope: document.accessScope,
      page_number: chunk.pageFrom,
      source_path: document.sourcePath,
      heading_path: [...chunk.headingPath],
      // Keep citation freshness tied to the generation that supplied this
      // excerpt. A failed/pending update may still serve the prior generation.
      updated_at: chunk.createdAt,
      excerpt: chunk.text.slice(0, 8_000),
    }));
    return result({
      ok: true,
      data,
      error_code: null,
      source_record_ids: [...new Set(data.flatMap((item) => [item.document_id, item.chunk_id || ""]).filter(Boolean))],
      updated_at: data.reduce<string | null>((latest, item) => !latest || item.updated_at > latest ? item.updated_at : latest, null),
      ...(policyConflict ? { policy_conflict: true } : {}),
    });
  } catch {
    return result<AgentKnowledgeDocument[]>({ ok: false, data: null, error_code: "unavailable", retryable: true });
  }
}
