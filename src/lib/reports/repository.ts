import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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

async function readStoredContent(): Promise<ReportContent> {
  try {
    const raw = await readFile(/* turbopackIgnore: true */ contentPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeReportContent(parsed);
    if (!normalized) throw new Error("Reports data has an invalid format.");
    return normalized;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ...EMPTY_REPORT };
    }
    throw error;
  }
}

async function writeStoredContent(value: ReportContent) {
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
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function getReportContent(): Promise<ReportContent> {
  return mutationQueue.then(() => readStoredContent());
}

export function saveReportContent(content: string, expectedRevision: number): Promise<ReportContent> {
  return withMutation(async () => {
    const current = await readStoredContent();
    if (current.revision !== expectedRevision) {
      throw new ReportRevisionConflictError(current);
    }
    const value: ReportContent = {
      content,
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
    };
    await writeStoredContent(value);
    return value;
  });
}
