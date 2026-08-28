import { KNOWLEDGE_ACCESS_SCOPES, type KnowledgeAccessScope } from "@/lib/knowledge/types";
export { isSupportedKnowledgeFile } from "@/lib/knowledge/file-metadata";
import { objectHasExactFields, workspaceFileId } from "@/lib/workspace-files/request";

export const KNOWLEDGE_ROUTE_BODY_BYTES = 8 * 1024;
export const KNOWLEDGE_DOCUMENT_TYPES = [
  "reference",
  "manual",
  "troubleshooting",
  "sop",
  "policy",
  "faq",
  "delivery_process",
] as const;
export const KNOWLEDGE_LANGUAGES = ["en", "zh", "multilingual"] as const;

type KnowledgeMetadataRequest = {
  title: string;
  documentType: (typeof KNOWLEDGE_DOCUMENT_TYPES)[number];
  category: string | null;
  product: string | null;
  region: string | null;
  language: (typeof KNOWLEDGE_LANGUAGES)[number];
  accessScope: KnowledgeAccessScope;
  version: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

function normalizedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function nullableText(value: unknown, maximum: number): string | null | undefined {
  if (value === null) return null;
  return normalizedText(value, maximum) || undefined;
}

function isoDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
}

function exactTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}

export function parseKnowledgeMetadata(body: Record<string, unknown>): KnowledgeMetadataRequest | null {
  const title = normalizedText(body.title, 180);
  const category = nullableText(body.category, 80);
  const product = nullableText(body.product, 100);
  const region = nullableText(body.region, 80);
  const version = normalizedText(body.version, 40);
  const effectiveFrom = isoDate(body.effectiveFrom);
  const effectiveTo = isoDate(body.effectiveTo);
  if (!title || !version
    || !KNOWLEDGE_DOCUMENT_TYPES.includes(body.documentType as never)
    || !KNOWLEDGE_LANGUAGES.includes(body.language as never)
    || !KNOWLEDGE_ACCESS_SCOPES.includes(body.accessScope as never)
    || category === undefined || product === undefined || region === undefined
    || effectiveFrom === undefined || effectiveTo === undefined
    || (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom)) return null;
  return {
    title,
    documentType: body.documentType as KnowledgeMetadataRequest["documentType"],
    category,
    product,
    region,
    language: body.language as KnowledgeMetadataRequest["language"],
    accessScope: body.accessScope as KnowledgeAccessScope,
    version,
    effectiveFrom,
    effectiveTo,
  };
}

const METADATA_FIELDS = [
  "title", "documentType", "category", "product", "region", "language",
  "accessScope", "version", "effectiveFrom", "effectiveTo",
] as const;

export function parseKnowledgeCreate(body: Record<string, unknown>) {
  if (!objectHasExactFields(body, ["fileId", ...METADATA_FIELDS])) return null;
  const fileId = workspaceFileId(body.fileId);
  const metadata = parseKnowledgeMetadata(body);
  return fileId && metadata ? { fileId, ...metadata } : null;
}

export function parseKnowledgeUpdate(body: Record<string, unknown>) {
  if (!objectHasExactFields(body, ["expectedUpdatedAt", ...METADATA_FIELDS])) return null;
  const expectedUpdatedAt = exactTimestamp(body.expectedUpdatedAt);
  const metadata = parseKnowledgeMetadata(body);
  return expectedUpdatedAt && metadata ? { expectedUpdatedAt, ...metadata } : null;
}

export function parseKnowledgeStateChange(body: Record<string, unknown>) {
  if (!objectHasExactFields(body, ["action", "expectedUpdatedAt"])
    || (body.action !== "disable" && body.action !== "enable")) return null;
  const expectedUpdatedAt = exactTimestamp(body.expectedUpdatedAt);
  return expectedUpdatedAt ? { action: body.action, expectedUpdatedAt } as const : null;
}

export function parseKnowledgeReindex(body: Record<string, unknown>) {
  if (!objectHasExactFields(body, ["expectedUpdatedAt"])) return null;
  const expectedUpdatedAt = exactTimestamp(body.expectedUpdatedAt);
  return expectedUpdatedAt ? { expectedUpdatedAt } : null;
}

export function knowledgeJson(body: unknown, init?: ResponseInit) {
  const response = Response.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export function knowledgeError(status: number, code: string, message: string) {
  return knowledgeJson({ error: message, code }, { status });
}
