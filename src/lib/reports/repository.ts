import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
} from "@/lib/server/cloudflare-storage";

export type ReportContent = {
  content: string;
  updatedAt: string | null;
  revision: number;
};

const EMPTY_REPORT: ReportContent = {
  content: "",
  updatedAt: null,
  revision: 0,
};

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.REPORTS_DATA_DIR || path.join(process.cwd(), ".data", "reports"),
);
const contentPath = path.join(/* turbopackIgnore: true */ dataRoot, "content.json");
const CLOUDFLARE_DOCUMENT_KEY = "reports/content";
const MAXIMUM_STORAGE_RETRIES = 5;

let mutationQueue: Promise<void> = Promise.resolve();

export class ReportRevisionConflictError extends Error {
  readonly current: ReportContent;

  constructor(current: ReportContent) {
    super("The report was changed by another session.");
    this.name = "ReportRevisionConflictError";
    this.current = current;
  }
}

async function ensureStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
}

function normalizeReportContent(value: unknown): ReportContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ReportContent>;
  if (typeof candidate.content !== "string"
    || (candidate.updatedAt !== null && typeof candidate.updatedAt !== "string")) {
    return null;
  }
  const revision = candidate.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  return {
    content: candidate.content,
    updatedAt: candidate.updatedAt ?? null,
    revision,
  };
}

async function readStoredContentDocument(): Promise<{
  content: ReportContent;
  version: number | null;
}> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    const document = await readVersionedDocument<unknown>(bindings.database, CLOUDFLARE_DOCUMENT_KEY);
    if (document.value === null) return { content: { ...EMPTY_REPORT }, version: document.version };
    const normalized = normalizeReportContent(document.value);
    if (!normalized) throw new Error("Reports data has an invalid format.");
    return { content: normalized, version: document.version };
  }

  try {
    const raw = await readFile(/* turbopackIgnore: true */ contentPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeReportContent(parsed);
    if (!normalized) throw new Error("Reports data has an invalid format.");
    return { content: normalized, version: null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { content: { ...EMPTY_REPORT }, version: null };
    }
    throw error;
  }
}

async function writeStoredContent(value: ReportContent, expectedVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || expectedVersion === null) {
      throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    }
    await writeVersionedDocument(bindings.database, CLOUDFLARE_DOCUMENT_KEY, value, expectedVersion);
    return;
  }

  await ensureStorage();
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.content-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, contentPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
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
    const current = (await readStoredContentDocument()).content;
    throw new ReportRevisionConflictError(current);
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function getReportContent(): Promise<ReportContent> {
  await mutationQueue;
  return (await readStoredContentDocument()).content;
}

export function saveReportContent(content: string, expectedRevision: number): Promise<ReportContent> {
  return withMutation(async () => {
    const document = await readStoredContentDocument();
    const current = document.content;
    if (current.revision !== expectedRevision) {
      throw new ReportRevisionConflictError(current);
    }
    const value: ReportContent = {
      content,
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
    };
    await writeStoredContent(value, document.version);
    return value;
  });
}
