import { timingSafeEqual } from "node:crypto";

export const WORKSPACE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_FILE_MAX_MULTIPART_BYTES = WORKSPACE_FILE_MAX_BYTES + 256 * 1024;
export const WORKSPACE_FILE_MAX_NAME_CHARACTERS = 180;
export const WORKSPACE_FILE_MAX_NAME_BYTES = 255;

export const WORKSPACE_FILE_UPLOAD_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type WorkspaceFileUploadContentType = (typeof WORKSPACE_FILE_UPLOAD_TYPES)[number];

export type WorkspaceFilesListQuery = {
  parentId: string | null;
  query?: string;
  view: "active" | "knowledge" | "trash";
};

export type WorkspaceFileItemActionRequest =
  | { action: "rename"; name: string; expectedVersion: number }
  | { action: "move"; parentId: string | null; expectedVersion: number }
  | { action: "trash" | "restore"; expectedVersion: number };

const TYPE_EXTENSIONS: Record<WorkspaceFileUploadContentType, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "text/plain": ["txt", "md", "log"],
  "text/csv": ["csv"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
};

const EXTENSION_TYPES = new Map<string, WorkspaceFileUploadContentType>();
for (const [contentType, extensions] of Object.entries(TYPE_EXTENSIONS)) {
  for (const extension of extensions) {
    EXTENSION_TYPES.set(extension, contentType as WorkspaceFileUploadContentType);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\\u202a-\u202e\u2066-\u2069]/u;

export class WorkspaceFilesRequestBodyTooLarge extends Error {
  constructor() {
    super("The request body is too large.");
    this.name = "WorkspaceFilesRequestBodyTooLarge";
  }
}

export function workspaceFilesJson(body: unknown, init?: ResponseInit) {
  const response = Response.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

export function workspaceFilesError(status: number, code: string, message: string) {
  return workspaceFilesJson({ error: message, code }, { status });
}

export function workspaceFilesRequestIsJson(request: Request) {
  return /^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") || "");
}

export function workspaceFilesRequestIsMultipart(request: Request) {
  return /^multipart\/form-data\s*;/i.test(request.headers.get("content-type") || "");
}

export function declaredWorkspaceFilesBodyTooLarge(request: Request, maximum: number) {
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) return false;
  const value = Number(header);
  return Number.isSafeInteger(value) && value > maximum;
}

export async function readWorkspaceFilesBody(request: Request, maximum: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new WorkspaceFilesRequestBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readWorkspaceFilesJson(request: Request, maximum: number) {
  const bytes = await readWorkspaceFilesBody(request, maximum);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected an object");
  return value as Record<string, unknown>;
}

export async function readWorkspaceFilesForm(request: Request, maximum: number) {
  const contentType = request.headers.get("content-type") || "";
  if (!workspaceFilesRequestIsMultipart(request)) throw new TypeError("Expected multipart form data");
  const bytes = await readWorkspaceFilesBody(request, maximum);
  return new Response(bytes, { headers: { "content-type": contentType } }).formData();
}

export function objectHasExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

export function formHasExactFields(form: FormData, required: readonly string[], optional: readonly string[] = []) {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  const seen = new Set<string>();
  for (const [name] of form.entries()) {
    if (!allowed.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return required.every((name) => seen.has(name))
    && [...seen].every((name) => requiredSet.has(name) || optional.includes(name));
}

export function workspaceFileId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLocaleLowerCase("en-AU") : null;
}

export function workspaceFileParentId(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return workspaceFileId(value) || undefined;
}

export function workspaceFileExpectedVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647
    ? value
    : null;
}

export function parseWorkspaceFilesListQuery(parameters: URLSearchParams): WorkspaceFilesListQuery | null {
  const allowed = new Set(["parentId", "query", "view"]);
  if ([...parameters.keys()].some((key) => !allowed.has(key))
    || [...allowed].some((key) => parameters.getAll(key).length > 1)) return null;

  const suppliedParentId = parameters.get("parentId");
  const parentId = suppliedParentId === null || suppliedParentId === ""
    ? null
    : workspaceFileId(suppliedParentId);
  if (suppliedParentId !== null && suppliedParentId !== "" && !parentId) return null;

  const suppliedQuery = parameters.get("query");
  const query = suppliedQuery === null ? undefined : suppliedQuery.trim();
  if (query !== undefined && (!query || query.length > 120)) return null;

  const suppliedView = parameters.get("view");
  const view = suppliedView === null || suppliedView === "active"
    ? "active"
    : suppliedView === "knowledge" ? "knowledge"
      : suppliedView === "trash" ? "trash" : null;
  if (!view
    || (query !== undefined && suppliedParentId !== null)
    || (view !== "active" && suppliedParentId !== null)
    || (view === "trash" && query !== undefined)) return null;
  return { parentId, query, view };
}

export function parseWorkspaceFileContentMode(parameters: URLSearchParams): "preview" | "download" | null {
  if ([...parameters.keys()].some((key) => key !== "mode") || parameters.getAll("mode").length > 1) return null;
  const mode = parameters.get("mode");
  if (mode === null || mode === "download") return "download";
  return mode === "preview" ? "preview" : null;
}

export function parseWorkspaceFileItemAction(body: Record<string, unknown>): WorkspaceFileItemActionRequest | null {
  const expectedVersion = workspaceFileExpectedVersion(body.expectedVersion);
  if (!expectedVersion || typeof body.action !== "string") return null;
  if (body.action === "rename") {
    if (!objectHasExactFields(body, ["action", "name", "expectedVersion"])) return null;
    const name = normalizeWorkspaceFileName(body.name);
    return name ? { action: "rename", name, expectedVersion } : null;
  }
  if (body.action === "move") {
    if (!objectHasExactFields(body, ["action", "parentId", "expectedVersion"])) return null;
    const parentId = workspaceFileParentId(body.parentId);
    return parentId === undefined ? null : { action: "move", parentId, expectedVersion };
  }
  if (body.action === "trash" || body.action === "restore") {
    return objectHasExactFields(body, ["action", "expectedVersion"])
      ? { action: body.action, expectedVersion }
      : null;
  }
  return null;
}

export function parseWorkspaceFileDelete(body: Record<string, unknown>): number | null {
  return objectHasExactFields(body, ["expectedVersion"])
    ? workspaceFileExpectedVersion(body.expectedVersion)
    : null;
}

export function normalizeWorkspaceFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized === "." || normalized === ".." || UNSAFE_NAME_CHARACTERS.test(normalized)) return null;
  if (normalized.length > WORKSPACE_FILE_MAX_NAME_CHARACTERS) return null;
  if (new TextEncoder().encode(normalized).byteLength > WORKSPACE_FILE_MAX_NAME_BYTES) return null;
  return normalized;
}

function fileExtension(name: string) {
  const separator = name.lastIndexOf(".");
  return separator > 0 && separator < name.length - 1
    ? name.slice(separator + 1).toLocaleLowerCase("en-AU")
    : "";
}

export function workspaceFileUploadType(name: string, declaredType: string): WorkspaceFileUploadContentType | null {
  const extension = fileExtension(name);
  const extensionType = EXTENSION_TYPES.get(extension);
  if (!extensionType) return null;
  const normalizedDeclaredType = declaredType.split(";", 1)[0].trim().toLocaleLowerCase("en-AU");
  if (!normalizedDeclaredType || normalizedDeclaredType === "application/octet-stream") return extensionType;
  // Browsers commonly label Markdown as text/markdown or text/x-markdown.
  // Files stores UTF-8 Markdown under the existing canonical text/plain type.
  if (extension === "md" && (normalizedDeclaredType === "text/markdown" || normalizedDeclaredType === "text/x-markdown")) {
    return "text/plain";
  }
  return normalizedDeclaredType === extensionType ? extensionType : null;
}

function bytesStartWith(bytes: Uint8Array, expected: readonly number[]) {
  return bytes.length >= expected.length
    && timingSafeEqual(Buffer.from(bytes.subarray(0, expected.length)), Buffer.from(expected));
}

function validUtf8Text(bytes: Uint8Array) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function openXmlSignatureMatches(type: WorkspaceFileUploadContentType, bytes: Uint8Array) {
  if (!bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return false;
  // OpenXML ZIP directory names are stored as ASCII in ordinary Office files.
  // Checking both the package manifest and application directory prevents a
  // generic ZIP renamed to .docx/.xlsx/.pptx from passing the upload gate.
  const binary = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (binary.indexOf("[Content_Types].xml") < 0) return false;
  if (type.endsWith("wordprocessingml.document")) return binary.indexOf("word/") >= 0;
  if (type.endsWith("spreadsheetml.sheet")) return binary.indexOf("xl/") >= 0;
  return binary.indexOf("ppt/") >= 0;
}

export function workspaceFileSignatureMatches(type: WorkspaceFileUploadContentType, bytes: Uint8Array) {
  if (type === "application/pdf") {
    return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  }
  if (type === "image/jpeg") return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
  if (type === "image/png") return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "image/webp") {
    return bytes.length >= 12
      && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
      && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  }
  if (type === "text/plain" || type === "text/csv") return validUtf8Text(bytes);
  return openXmlSignatureMatches(type, bytes);
}

export function safeWorkspaceFileContentDisposition(mode: "attachment" | "inline", name: string) {
  const safeName = normalizeWorkspaceFileName(name) || "download";
  const asciiName = safeName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "download";
  const encodedName = encodeURIComponent(safeName)
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
  return `${mode}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
