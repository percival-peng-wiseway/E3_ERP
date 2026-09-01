import type { WorkspaceFileActor } from "../../workspace-files/types.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { getWorkspaceFileContent } from "../../workspace-files/repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { getActiveKnowledgeDocumentByChecksum, getKnowledgeDocumentByFileId } from "../../knowledge/repository.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { canAccessKnowledgeScope } from "../../knowledge/config.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { isSupportedKnowledgeFile } from "../../knowledge/file-metadata.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_TENANT_ID, type KnowledgeDocument } from "../../knowledge/types.ts";

export const MAX_AGENT_ATTACHMENTS = 4;
export const AGENT_ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Base64 plus JSON serialization creates multiple in-memory copies in a Worker.
// Keep raw input well below the provider's 100 MB request limit so the request
// remains safe within the Cloudflare isolate memory budget.
const MAX_KIMI_IMAGE_BYTES = 12 * 1024 * 1024;
const KIMI_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type KimiImagePart = {
  type: "image_url";
  image_url: { url: string };
};

export function isKimiImageContentType(value: string) { return KIMI_IMAGE_CONTENT_TYPES.has(value.toLowerCase()); }

export type AgentAttachmentStatus = "ready" | "processing" | "unsupported" | "failed";

export type ResolvedAgentAttachment = {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  status: AgentAttachmentStatus;
  knowledgeDocumentId: string | null;
};

type AttachmentDependencies = {
  getFile: typeof getWorkspaceFileContent;
  getDocumentByFileId: typeof getKnowledgeDocumentByFileId;
  getActiveDocumentByChecksum: typeof getActiveKnowledgeDocumentByChecksum;
};

const DEFAULT_DEPENDENCIES: AttachmentDependencies = {
  getFile: getWorkspaceFileContent,
  getDocumentByFileId: getKnowledgeDocumentByFileId,
  getActiveDocumentByChecksum: getActiveKnowledgeDocumentByChecksum,
};

export class AgentAttachmentError extends Error {
  readonly status: number;
  readonly code: "invalid_attachments" | "attachment_not_found" | "attachment_forbidden";

  constructor(message: string, status: number, code: AgentAttachmentError["code"]) {
    super(message);
    this.name = "AgentAttachmentError";
    this.status = status;
    this.code = code;
  }
}

/** Parse only opaque Files identifiers. Names, types and statuses always come from server storage. */
export function cleanAgentAttachmentIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENT_ATTACHMENTS) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.file_id !== "string"
      || !AGENT_ATTACHMENT_ID_PATTERN.test(record.file_id)) return null;
    const fileId = record.file_id.toLocaleLowerCase("en-AU");
    if (seen.has(fileId)) return null;
    seen.add(fileId);
    ids.push(fileId);
  }
  return ids;
}

function attachmentStatus(document: KnowledgeDocument | null, knowledgeSupported: boolean, imageSupported: boolean): AgentAttachmentStatus {
  if (imageSupported) return "ready";
  if (!knowledgeSupported) return "unsupported";
  if (!document || document.status === "pending" || document.status === "indexing") return "processing";
  if (document.status === "ready") return "ready";
  return "failed";
}

export async function resolveAgentAttachments(
  input: { fileIds: readonly string[]; actor: WorkspaceFileActor },
  dependencyOverrides: Partial<AttachmentDependencies> = {},
): Promise<ResolvedAgentAttachment[]> {
  if (input.fileIds.length > MAX_AGENT_ATTACHMENTS
    || input.fileIds.some((fileId) => !AGENT_ATTACHMENT_ID_PATTERN.test(fileId))) {
    throw new AgentAttachmentError("The attachment list is invalid.", 400, "invalid_attachments");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  return Promise.all(input.fileIds.map(async (fileId) => {
    const content = await dependencies.getFile({ actor: input.actor, id: fileId });
    if (!content) {
      throw new AgentAttachmentError("An attached file is no longer available.", 404, "attachment_not_found");
    }
    const contentType = content.item.contentType || "application/octet-stream";
    const supported = isSupportedKnowledgeFile(content.item.name, contentType);
    const imageSupported = isKimiImageContentType(contentType);
    let document = supported
      ? await dependencies.getDocumentByFileId(fileId, KNOWLEDGE_TENANT_ID)
      : null;
    if (supported && !document && content.item.checksum) {
      // Automatic indexing de-duplicates identical content. Resolve the
      // canonical document without trusting a browser-supplied document ID.
      document = await dependencies.getActiveDocumentByChecksum(
        content.item.checksum,
        KNOWLEDGE_TENANT_ID,
      );
    }
    if (document && !canAccessKnowledgeScope(input.actor.role, document.accessScope)) {
      throw new AgentAttachmentError("An attached file is not available to this account.", 404, "attachment_forbidden");
    }
    return {
      fileId: content.item.id,
      name: content.item.name,
      contentType,
      size: content.item.size || 0,
      status: attachmentStatus(document, supported, imageSupported),
      knowledgeDocumentId: document?.status === "ready" ? document.id : null,
    };
  }));
}

/** Load only server-authorised image bytes and convert them to Kimi-supported data-URL parts. */
export async function resolveKimiImageParts(
  input: { attachments: readonly ResolvedAgentAttachment[]; actor: WorkspaceFileActor },
  dependencyOverrides: Pick<Partial<AttachmentDependencies>, "getFile"> = {},
): Promise<KimiImagePart[]> {
  const images = input.attachments.filter((attachment) => isKimiImageContentType(attachment.contentType));
  const totalBytes = images.reduce((total, image) => total + image.size, 0);
  if (totalBytes > MAX_KIMI_IMAGE_BYTES) {
    throw new AgentAttachmentError("Attached images exceed the 12 MB Agent vision limit.", 413, "invalid_attachments");
  }
  const getFile = dependencyOverrides.getFile || DEFAULT_DEPENDENCIES.getFile;
  return Promise.all(images.map(async (image) => {
    const content = await getFile({ actor: input.actor, id: image.fileId });
    const contentType = content?.item.contentType || "";
    if (!content || content.item.id !== image.fileId || content.item.size !== image.size
      || contentType !== image.contentType || !isKimiImageContentType(contentType)) {
      throw new AgentAttachmentError("An attached image is no longer available.", 404, "attachment_not_found");
    }
    const bytes = await content.read();
    if (bytes.byteLength !== image.size) {
      throw new AgentAttachmentError("An attached image could not be verified.", 404, "attachment_not_found");
    }
    return {
      type: "image_url",
      image_url: { url: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` },
    } satisfies KimiImagePart;
  }));
}
