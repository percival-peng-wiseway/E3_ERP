import type { ErpRole } from "@/lib/auth/types";

export const WORKSPACE_FILE_KINDS = ["file", "folder"] as const;
export type WorkspaceFileKind = (typeof WORKSPACE_FILE_KINDS)[number];

export const WORKSPACE_FILES_VIEWS = ["active", "trash"] as const;
export type WorkspaceFilesView = (typeof WORKSPACE_FILES_VIEWS)[number];

export type WorkspaceFileActor = {
  username: string;
  displayName: string;
  role: ErpRole;
};

export type WorkspaceFileCapabilities = {
  rename: boolean;
  move: boolean;
  trash: boolean;
  restore: boolean;
  purge: boolean;
};

export const WORKSPACE_KNOWLEDGE_STATUSES = [
  "pending",
  "indexing",
  "ready",
  "failed",
  "disabled",
] as const;
export type WorkspaceKnowledgeStatus = (typeof WORKSPACE_KNOWLEDGE_STATUSES)[number];

export const WORKSPACE_KNOWLEDGE_ACCESS_SCOPES = [
  "company",
  "sales",
  "pm",
  "finance",
  "admin",
] as const;
export type WorkspaceKnowledgeAccessScope = (typeof WORKSPACE_KNOWLEDGE_ACCESS_SCOPES)[number];

/** Admin-only projection returned by the Files list route. */
export type WorkspaceKnowledgeSummary = {
  id: string;
  fileId: string;
  title: string;
  documentType: string;
  category: string | null;
  product: string | null;
  region: string | null;
  language: string;
  accessScope: WorkspaceKnowledgeAccessScope;
  documentVersion: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: WorkspaceKnowledgeStatus;
  lastIndexedAt: string | null;
  updatedAt: string;
  errorMessage: string | null;
};

export type WorkspaceFileItem = {
  id: string;
  workspaceId: "company";
  parentId: string | null;
  kind: WorkspaceFileKind;
  name: string;
  ownerUsername: string;
  ownerDisplayName: string;
  contentType: string | null;
  size: number | null;
  checksum: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  trashedAt: string | null;
  trashedBy: string | null;
  version: number;
  capabilities: WorkspaceFileCapabilities;
  /** Present only for Administrators; ordinary users never receive index controls. */
  knowledge?: WorkspaceKnowledgeSummary | null;
};

export type WorkspaceFileBreadcrumb = {
  id: string;
  name: string;
};

export type WorkspaceFileFolderOption = {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
};

export type WorkspaceFilesUsage = {
  usedBytes: number;
  workspaceLimitBytes: number;
  ownerUsedBytes: number;
  ownerLimitBytes: number;
};

export type WorkspaceFilesListing = {
  items: WorkspaceFileItem[];
  folders: WorkspaceFileFolderOption[];
  breadcrumbs: WorkspaceFileBreadcrumb[];
  currentFolder: WorkspaceFileItem | null;
  usage: WorkspaceFilesUsage;
};

export type WorkspaceFileUpload = {
  bytes: Uint8Array;
  originalName: string;
  contentType: string;
  size: number;
};

export type WorkspaceFileContent = {
  item: WorkspaceFileItem;
  read(): Promise<Uint8Array>;
};

/** Server-only source used by the knowledge indexer; never serialize this object. */
export type WorkspaceFileIndexSource = {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  checksum: string;
  version: number;
  updatedAt: string;
  sourcePath: string;
  read(): Promise<Uint8Array>;
};
