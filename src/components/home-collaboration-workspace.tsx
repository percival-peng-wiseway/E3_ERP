"use client";

import {
  AlertCircle,
  BellRing,
  Blocks,
  Bot,
  Download,
  Eye,
  FileImage,
  FileText,
  LoaderCircle,
  Megaphone,
  Paperclip,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  ClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ERP_ROLE_LABELS, type ErpUser } from "@/lib/auth/types";
import {
  knowledgeReadinessPresentation,
  readAgentKnowledgeReadiness,
  type AgentKnowledgeReadiness,
} from "@/lib/erp_agent/agent/knowledge-readiness";
import { readJsonResponse } from "@/lib/client/http";
import type { AgentCitation } from "@/lib/erp/types";
import styles from "./home-collaboration-workspace.module.css";

type AgentRole = "user" | "assistant";

type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  citations?: AgentCitation[];
  attachments?: AgentMessageAttachment[];
};

type AgentAttachmentStatus = "uploading" | "processing" | "ready" | "unsupported" | "failed";

type AgentMessageAttachment = {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
};

type AgentComposerAttachment = AgentMessageAttachment & {
  localId: string;
  status: AgentAttachmentStatus;
  error?: string;
};

type NotificationRole = "all" | "sales" | "specialist" | "pm" | "admin";
type NotificationOwnerRole = Exclude<NotificationRole, "all">;
type NotificationPriority = "urgent" | "high" | "normal";
type NotificationModule = "payments" | "projects" | "reimbursements" | "inventory" | "quotations";

type WorkspaceNotification = {
  id: string;
  role: NotificationOwnerRole;
  priority: NotificationPriority;
  badgeLabel?: string;
  projectCreatedAt?: string;
  ownerName?: string;
  title: string;
  description: string;
  module: NotificationModule;
  entityId?: string;
  actionLabel: string;
};

type Announcement = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  createdBy: string;
};

type HomeCollaborationWorkspaceProps = {
  currentUser: ErpUser;
  onOpenSkills?: () => void;
  onOpenSettings?: () => void;
  onNavigate?: (module: NotificationModule, entityId?: string) => void;
};

const DEFAULT_SUGGESTIONS = [
  "Summarize this week",
  "Which inventory items need attention?",
  "Show unscheduled Weekly Schedule work",
];
const LEGACY_AGENT_CONVERSATION_STORAGE_KEY = "e3-agent-conversation:v1";
const AGENT_CONVERSATION_STORAGE_VERSION = 1;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_AGENT_ATTACHMENTS = 4;
const MAX_AGENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_AGENT_HISTORY_MESSAGES = 100;
const MAX_AGENT_HISTORY_CHARACTERS = 200_000;
const MAX_AGENT_HISTORY_MESSAGE_CHARACTERS = 50_000;
const MAX_AGENT_CITATIONS = 8;
const WORKSPACE_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTIFICATION_REFRESH_INTERVAL_MS = 30_000;
const ANNOUNCEMENT_REFRESH_INTERVAL_MS = 60_000;

const EMPTY_NOTIFICATION_COUNTS: Record<NotificationRole, number> = {
  all: 0,
  sales: 0,
  specialist: 0,
  pm: 0,
  admin: 0,
};

const NOTIFICATION_PRIORITY_LABELS: Record<NotificationPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
};

const NOTIFICATION_PRIORITY_ORDER: Record<NotificationPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

function citationText(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

function readAgentCitation(value: unknown): AgentCitation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const documentId = citationText(item.documentId, 100);
  const title = citationText(item.title, 300);
  const version = citationText(item.version, 80);
  const source = citationText(item.source, 100);
  if (!documentId || !title || !version || !source) return null;
  const chunkId = citationText(item.chunkId, 160);
  const fileId = citationText(item.fileId, 100);
  const effectiveFrom = item.effectiveFrom === null ? null : citationText(item.effectiveFrom, 50);
  const pageNumber = item.pageNumber === null ? null
    : typeof item.pageNumber === "number" && Number.isSafeInteger(item.pageNumber)
      && item.pageNumber >= 1 && item.pageNumber <= 100_000 ? item.pageNumber : undefined;
  const sourcePath = item.sourcePath === null ? null : citationText(item.sourcePath, 1_000);
  const headingPath = Array.isArray(item.headingPath)
    ? item.headingPath.map((entry) => citationText(entry, 300)).filter((entry): entry is string => Boolean(entry)).slice(0, 12)
    : undefined;
  const updatedAt = citationText(item.updatedAt, 50);
  return {
    documentId, title, version, source, effectiveFrom,
    ...(chunkId ? { chunkId } : {}),
    ...(fileId && WORKSPACE_FILE_ID_PATTERN.test(fileId) ? { fileId: fileId.toLocaleLowerCase("en-AU") } : {}),
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(headingPath?.length ? { headingPath } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function readAgentCitations(value: unknown): AgentCitation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.map(readAgentCitation).filter((citation): citation is AgentCitation => {
    if (!citation) return false;
    const key = `${citation.documentId}:${citation.chunkId || "document"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_AGENT_CITATIONS);
}

function readAgentMessageAttachment(value: unknown): AgentMessageAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.fileId !== "string" || !WORKSPACE_FILE_ID_PATTERN.test(item.fileId)
    || typeof item.name !== "string" || !item.name.trim() || item.name.length > 180
    || typeof item.contentType !== "string" || !item.contentType.trim() || item.contentType.length > 150
    || typeof item.size !== "number" || !Number.isSafeInteger(item.size)
    || item.size < 1 || item.size > MAX_AGENT_ATTACHMENT_BYTES) return null;
  return {
    fileId: item.fileId.toLocaleLowerCase("en-AU"),
    name: item.name.trim(),
    contentType: item.contentType,
    size: item.size,
  };
}

function readAgentMessageAttachments(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENT_ATTACHMENTS) return [];
  const seen = new Set<string>();
  return value.map(readAgentMessageAttachment).filter((attachment): attachment is AgentMessageAttachment => {
    if (!attachment || seen.has(attachment.fileId)) return false;
    seen.add(attachment.fileId);
    return true;
  });
}

function readAgentMessage(value: unknown): AgentMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string"
    || !item.id.trim()
    || item.id.length > 200
    || (item.role !== "user" && item.role !== "assistant")
    || typeof item.content !== "string"
    || !item.content.trim()
    || item.content.length > MAX_AGENT_HISTORY_MESSAGE_CHARACTERS
  ) {
    return null;
  }
  const citations = item.role === "assistant" ? readAgentCitations(item.citations) : [];
  const attachments = item.role === "user" ? readAgentMessageAttachments(item.attachments) : [];
  return {
    id: item.id, role: item.role, content: item.content,
    ...(citations.length ? { citations } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

function limitAgentContent(content: string) {
  if (content.length <= MAX_AGENT_HISTORY_MESSAGE_CHARACTERS) return content;
  const suffix = "\n\n_Response shortened to keep this saved conversation responsive._";
  return `${content.slice(0, MAX_AGENT_HISTORY_MESSAGE_CHARACTERS - suffix.length).trimEnd()}${suffix}`;
}

function limitAgentMessages(messages: readonly unknown[]) {
  const limited: AgentMessage[] = [];
  const ids = new Set<string>();
  let characterCount = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = readAgentMessage(messages[index]);
    if (!message || ids.has(message.id)) continue;
    const citationCharacters = message.citations ? JSON.stringify(message.citations).length : 0;
    const attachmentCharacters = message.attachments ? JSON.stringify(message.attachments).length : 0;
    const nextCharacterCount = characterCount + message.id.length + message.content.length
      + citationCharacters + attachmentCharacters;
    if (limited.length >= MAX_AGENT_HISTORY_MESSAGES || nextCharacterCount > MAX_AGENT_HISTORY_CHARACTERS) break;
    limited.push(message);
    ids.add(message.id);
    characterCount = nextCharacterCount;
  }

  return limited.reverse();
}

function readAgentConversation(rawValue: string | null): { messages: AgentMessage[]; conversationId: string | null } {
  if (!rawValue) return { messages: [], conversationId: null };
  try {
    const value: unknown = JSON.parse(rawValue);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { messages: [], conversationId: null };
    const record = value as Record<string, unknown>;
    if (record.version !== AGENT_CONVERSATION_STORAGE_VERSION || !Array.isArray(record.messages)) {
      return { messages: [], conversationId: null };
    }
    const conversationId = typeof record.conversationId === "string"
      && /^[a-zA-Z0-9_-]{1,128}$/.test(record.conversationId)
      ? record.conversationId : null;
    return { messages: limitAgentMessages(record.messages), conversationId };
  } catch {
    return { messages: [], conversationId: null };
  }
}

function safeMarkdownUrl(value: string) {
  // Model-authored links are never navigable. Trusted file actions are rendered
  // separately from server-verified citation fields below.
  void value;
  return "";
}

const AGENT_MARKDOWN_COMPONENTS: Components = {
  table({ children }) {
    return (
      <div className={styles.markdownTable} role="region" aria-label="Scrollable data table" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children, title }) {
    const safeHref = typeof href === "string" ? safeMarkdownUrl(href) : "";
    if (!safeHref) return <span className={styles.removedLink}>{children}</span>;
    const opensNewTab = /^https?:/i.test(safeHref);
    return (
      <a
        href={safeHref}
        title={title}
        target={opensNewTab ? "_blank" : undefined}
        rel={opensNewTab ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    return alt ? <span className={styles.removedImage}>[Image: {alt}]</span> : null;
  },
};

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatAnnouncementDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatCitationDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function workspaceFileCitationHref(fileId: string, mode: "preview" | "download") {
  return `/api/files/items/${encodeURIComponent(fileId)}/content?mode=${mode}`;
}

function formatAgentAttachmentBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function agentAttachmentIsImage(contentType: string) {
  return contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp";
}

function agentAttachmentContentMode(contentType: string): "preview" | "download" {
  return contentType === "application/pdf" || agentAttachmentIsImage(contentType)
    || contentType === "text/plain" || contentType === "text/markdown" || contentType === "text/x-markdown"
    ? "preview"
    : "download";
}

function formatProjectCreatedAt(value?: string) {
  if (!value) return "date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date unavailable";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function normalizeAnnouncement(value: unknown): Announcement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string"
    || !item.id.trim()
    || item.id.length > 200
    || typeof item.title !== "string"
    || item.title.length > 140
    || typeof item.content !== "string"
    || !item.content.trim()
    || item.content.length > 4_000
    || typeof item.createdAt !== "string"
    || Number.isNaN(Date.parse(item.createdAt))
    || typeof item.createdBy !== "string"
    || !item.createdBy.trim()
    || item.createdBy.length > 160
  ) {
    return null;
  }
  return {
    id: item.id,
    title: item.title.trim(),
    content: item.content.trim(),
    createdAt: item.createdAt,
    createdBy: item.createdBy.trim(),
  };
}

function readAnnouncementList(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const seen = new Set<string>();
  return data
    .map(normalizeAnnouncement)
    .filter((announcement): announcement is Announcement => {
      if (!announcement || seen.has(announcement.id)) return false;
      seen.add(announcement.id);
      return true;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

function readAnnouncementItem(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeAnnouncement((value as Record<string, unknown>).data);
}

function normalizeNotification(value: unknown): WorkspaceNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const roles: NotificationOwnerRole[] = ["sales", "specialist", "pm", "admin"];
  const priorities: NotificationPriority[] = ["urgent", "high", "normal"];
  const modules: NotificationModule[] = ["payments", "projects", "reimbursements", "inventory", "quotations"];
  if (
    typeof item.id !== "string"
    || !item.id.trim()
    || !roles.includes(item.role as NotificationOwnerRole)
    || !priorities.includes(item.priority as NotificationPriority)
    || typeof item.title !== "string"
    || !item.title.trim()
    || typeof item.description !== "string"
    || !item.description.trim()
    || !modules.includes(item.module as NotificationModule)
    || typeof item.actionLabel !== "string"
    || !item.actionLabel.trim()
    || (item.entityId !== undefined && typeof item.entityId !== "string")
  ) {
    return null;
  }
  return {
    id: item.id.slice(0, 240),
    role: item.role as NotificationOwnerRole,
    priority: item.priority as NotificationPriority,
    ...(typeof item.badgeLabel === "string" && item.badgeLabel.trim()
      ? { badgeLabel: item.badgeLabel.trim().slice(0, 80) }
      : {}),
    ...(typeof item.projectCreatedAt === "string" && !Number.isNaN(Date.parse(item.projectCreatedAt))
      ? { projectCreatedAt: item.projectCreatedAt }
      : {}),
    ...(typeof item.ownerName === "string" && item.ownerName.trim()
      ? { ownerName: item.ownerName.trim().slice(0, 160) }
      : {}),
    title: item.title.trim().slice(0, 180),
    description: item.description.trim().slice(0, 800),
    module: item.module as NotificationModule,
    ...(typeof item.entityId === "string" && item.entityId.trim()
      ? { entityId: item.entityId.trim().slice(0, 240) }
      : {}),
    actionLabel: item.actionLabel.trim().slice(0, 160),
  };
}

function readNotificationResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (!root.data || typeof root.data !== "object" || Array.isArray(root.data)) return null;
  const data = root.data as Record<string, unknown>;
  if (!Array.isArray(data.notifications) || !data.counts || typeof data.counts !== "object" || Array.isArray(data.counts)) {
    return null;
  }
  const rawCounts = data.counts as Record<string, unknown>;
  const counts = { ...EMPTY_NOTIFICATION_COUNTS };
  for (const role of ["all", "sales", "specialist", "pm", "admin"] as const) {
    const count = rawCounts[role];
    counts[role] = typeof count === "number" && Number.isFinite(count) && count >= 0
      ? Math.floor(count)
      : 0;
  }
  const seen = new Set<string>();
  const notifications = data.notifications
    .map(normalizeNotification)
    .filter((notification): notification is WorkspaceNotification => {
      if (!notification || seen.has(notification.id)) return false;
      seen.add(notification.id);
      return true;
    })
    .sort((a, b) => NOTIFICATION_PRIORITY_ORDER[a.priority] - NOTIFICATION_PRIORITY_ORDER[b.priority]);
  const meta = root.meta && typeof root.meta === "object" && !Array.isArray(root.meta)
    ? root.meta as Record<string, unknown>
    : null;
  const warnings = Array.isArray(meta?.warnings)
    ? meta.warnings
      .filter((warning): warning is string => typeof warning === "string" && Boolean(warning.trim()))
      .slice(0, 3)
      .map((warning) => warning.trim().slice(0, 300))
    : [];
  return {
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : new Date().toISOString(),
    notifications,
    counts,
    warnings,
  };
}

export function HomeCollaborationWorkspace({ currentUser, onOpenSkills, onOpenSettings, onNavigate }: HomeCollaborationWorkspaceProps) {
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentHistoryHydrated, setAgentHistoryHydrated] = useState(false);
  const [agentHydratedStorageKey, setAgentHydratedStorageKey] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [agentAttachments, setAgentAttachments] = useState<AgentComposerAttachment[]>([]);
  const [agentSuggestions, setAgentSuggestions] = useState(DEFAULT_SUGGESTIONS);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentNotice, setAgentNotice] = useState("");
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null);
  const [agentModelStatus, setAgentModelStatus] = useState<"available" | "unavailable" | "not_checked">("not_checked");
  const [agentKnowledgeReadiness, setAgentKnowledgeReadiness] = useState<AgentKnowledgeReadiness>({
    status: "checking",
    readyDocuments: 0,
    activeChunks: 0,
  });
  const agentAbortRef = useRef<AbortController | null>(null);
  const agentHealthAbortRef = useRef<AbortController | null>(null);
  const agentConversationRevisionRef = useRef(0);
  const agentConversationIdRef = useRef("");
  const agentStorageClearGuardRef = useRef(false);
  const agentFeedRef = useRef<HTMLDivElement>(null);
  const agentFileInputRef = useRef<HTMLInputElement>(null);

  const [notifications, setNotifications] = useState<WorkspaceNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsError, setNotificationsError] = useState("");
  const [notificationsWarning, setNotificationsWarning] = useState("");
  const [notificationsGeneratedAt, setNotificationsGeneratedAt] = useState("");
  const notificationsAbortRef = useRef<AbortController | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(true);
  const [announcementsError, setAnnouncementsError] = useState("");
  const [announcementTitle, setAnnouncementTitle] = useState("");
  const [announcementContent, setAnnouncementContent] = useState("");
  const [announcementSubmitting, setAnnouncementSubmitting] = useState(false);
  const [announcementDeletingId, setAnnouncementDeletingId] = useState("");
  const announcementsAbortRef = useRef<AbortController | null>(null);
  const announcementMutationAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const notificationRole: NotificationRole = currentUser.role === "specialist"
    ? "sales"
    : currentUser.role;
  const isAdmin = currentUser.role === "admin";
  const agentConversationStorageKey = `${LEGACY_AGENT_CONVERSATION_STORAGE_KEY}:${encodeURIComponent(currentUser.username.toLocaleLowerCase("en-AU"))}:${encodeURIComponent(currentUser.role)}`;

  const loadAgentSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/agent", { cache: "no-store" });
      if (!response.ok) return;
      const body = await readJsonResponse<{ data?: { configured?: unknown } }>(response);
      if (mountedRef.current && typeof body.data?.configured === "boolean") {
        setAgentConfigured(body.data.configured);
        setAgentModelStatus("not_checked");
      }
    } catch {
      // A failed settings check does not prevent local Agent queries from working.
    }
  }, []);

  const loadAgentHealth = useCallback(async () => {
    if (!isAdmin) return;
    agentHealthAbortRef.current?.abort();
    const controller = new AbortController();
    agentHealthAbortRef.current = controller;
    setAgentKnowledgeReadiness((current) => current.status === "checking"
      ? current
      : { ...current, status: "checking" });
    try {
      const response = await fetch("/api/agent/health", { cache: "no-store", signal: controller.signal });
      const body = await readJsonResponse<unknown>(response);
      if (!mountedRef.current || controller.signal.aborted || agentHealthAbortRef.current !== controller) return;
      setAgentKnowledgeReadiness(readAgentKnowledgeReadiness(body));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (mountedRef.current && agentHealthAbortRef.current === controller) {
        setAgentKnowledgeReadiness({ status: "unavailable", readyDocuments: 0, activeChunks: 0 });
      }
    } finally {
      if (agentHealthAbortRef.current === controller) agentHealthAbortRef.current = null;
    }
  }, [isAdmin]);

  useEffect(() => {
    mountedRef.current = true;
    setAgentHistoryHydrated(false);
    setAgentMessages([]);
    setAgentAttachments([]);
    agentConversationIdRef.current = "";
    try {
      const storedConversation = readAgentConversation(window.localStorage.getItem(agentConversationStorageKey));
      setAgentMessages(storedConversation.messages);
      agentConversationIdRef.current = storedConversation.conversationId || crypto.randomUUID();
      window.localStorage.removeItem(LEGACY_AGENT_CONVERSATION_STORAGE_KEY);
    } catch {
      // Agent chat still works for this session if storage is unavailable.
    }
    if (!agentConversationIdRef.current) agentConversationIdRef.current = crypto.randomUUID();
    setAgentHydratedStorageKey(agentConversationStorageKey);
    setAgentHistoryHydrated(true);

    const handleSettingsUpdate = () => {
      void loadAgentSettings();
      void loadAgentHealth();
    };
    const handleConversationStorage = (event: StorageEvent) => {
      if (event.key !== agentConversationStorageKey || event.newValue !== null) return;
      agentStorageClearGuardRef.current = true;
      agentConversationRevisionRef.current += 1;
      agentConversationIdRef.current = crypto.randomUUID();
      agentAbortRef.current?.abort();
      agentAbortRef.current = null;
      try {
        window.localStorage.removeItem(agentConversationStorageKey);
      } catch {
        // The visible clear still succeeds if another tab cannot update browser storage.
      }
      setAgentMessages([]);
      setAgentAttachments([]);
      setAgentSuggestions(DEFAULT_SUGGESTIONS);
      setAgentError("");
      setAgentNotice("");
      setAgentLoading(false);
    };
    void loadAgentSettings();
    void loadAgentHealth();
    window.addEventListener("erp:agent-settings-updated", handleSettingsUpdate);
    window.addEventListener("storage", handleConversationStorage);

    return () => {
      mountedRef.current = false;
      agentAbortRef.current?.abort();
      agentHealthAbortRef.current?.abort();
      notificationsAbortRef.current?.abort();
      announcementsAbortRef.current?.abort();
      announcementMutationAbortRef.current?.abort();
      window.removeEventListener("erp:agent-settings-updated", handleSettingsUpdate);
      window.removeEventListener("storage", handleConversationStorage);
    };
  }, [agentConversationStorageKey, loadAgentHealth, loadAgentSettings]);

  useEffect(() => {
    if (!agentHistoryHydrated
      || agentHydratedStorageKey !== agentConversationStorageKey
      || !agentMessages.length
      || agentStorageClearGuardRef.current) return;
    try {
      window.localStorage.setItem(agentConversationStorageKey, JSON.stringify({
        version: AGENT_CONVERSATION_STORAGE_VERSION,
        conversationId: agentConversationIdRef.current,
        messages: limitAgentMessages(agentMessages),
      }));
    } catch {
      // A storage quota or privacy restriction must not interrupt the Agent conversation.
    }
  }, [agentConversationStorageKey, agentHistoryHydrated, agentHydratedStorageKey, agentMessages]);

  useEffect(() => {
    agentFeedRef.current?.scrollTo({ top: agentFeedRef.current.scrollHeight, behavior: "smooth" });
  }, [agentMessages, agentLoading]);

  const loadNotifications = useCallback(async (role: NotificationRole, keepCurrent = true) => {
    notificationsAbortRef.current?.abort();
    const controller = new AbortController();
    notificationsAbortRef.current = controller;
    if (!keepCurrent) {
      setNotifications([]);
      setNotificationsGeneratedAt("");
    }
    setNotificationsLoading(true);
    setNotificationsError("");
    setNotificationsWarning("");
    try {
      const response = await fetch("/api/notifications", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok) throw new Error(readError(body, "Unable to load notifications."));
      const parsed = readNotificationResponse(body);
      if (!parsed) throw new Error("Notifications returned an invalid response. Please refresh and try again.");
      if (!mountedRef.current || controller.signal.aborted || notificationsAbortRef.current !== controller) return;
      setNotifications(parsed.notifications.filter((notification) => notification.role === role));
      setNotificationsGeneratedAt(parsed.generatedAt);
      setNotificationsWarning(parsed.warnings.join(" "));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (mountedRef.current && notificationsAbortRef.current === controller) {
        setNotificationsError(error instanceof Error ? error.message : "Unable to load notifications.");
      }
    } finally {
      if (notificationsAbortRef.current === controller) {
        notificationsAbortRef.current = null;
        if (mountedRef.current) setNotificationsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadNotifications(notificationRole, false);
    const refreshForPaymentChange = () => void loadNotifications(notificationRole, true);
    window.addEventListener("erp:payment-track-updated", refreshForPaymentChange);
    const interval = window.setInterval(
      () => void loadNotifications(notificationRole, true),
      NOTIFICATION_REFRESH_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("erp:payment-track-updated", refreshForPaymentChange);
      notificationsAbortRef.current?.abort();
    };
  }, [loadNotifications, notificationRole]);

  const loadAnnouncements = useCallback(async (keepCurrent = true) => {
    if (announcementMutationAbortRef.current) return;
    announcementsAbortRef.current?.abort();
    const controller = new AbortController();
    announcementsAbortRef.current = controller;
    if (!keepCurrent) setAnnouncements([]);
    setAnnouncementsLoading(true);
    setAnnouncementsError("");
    try {
      const response = await fetch("/api/announcements", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok) throw new Error(readError(body, "Unable to load public announcements."));
      const parsed = readAnnouncementList(body);
      if (!parsed) throw new Error("Announcements returned an invalid response. Please refresh and try again.");
      if (!mountedRef.current || controller.signal.aborted || announcementsAbortRef.current !== controller) return;
      setAnnouncements(parsed);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (mountedRef.current && announcementsAbortRef.current === controller) {
        setAnnouncementsError(error instanceof Error ? error.message : "Unable to load public announcements.");
      }
    } finally {
      if (announcementsAbortRef.current === controller) {
        announcementsAbortRef.current = null;
        if (mountedRef.current) setAnnouncementsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadAnnouncements(false);
    const refreshWhenVisible = () => {
      if (!document.hidden) void loadAnnouncements(true);
    };
    const interval = window.setInterval(refreshWhenVisible, ANNOUNCEMENT_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      announcementsAbortRef.current?.abort();
    };
  }, [loadAnnouncements]);

  const publishAnnouncement = useCallback(async () => {
    const title = announcementTitle.trim();
    const content = announcementContent.trim();
    if (!isAdmin || !content || announcementSubmitting || Boolean(announcementDeletingId)) return;
    announcementsAbortRef.current?.abort();
    announcementMutationAbortRef.current?.abort();
    const controller = new AbortController();
    announcementMutationAbortRef.current = controller;
    setAnnouncementSubmitting(true);
    setAnnouncementsError("");
    try {
      const response = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok) throw new Error(readError(body, "Unable to publish this announcement."));
      const announcement = readAnnouncementItem(body);
      if (!announcement) throw new Error("The published announcement returned an invalid response.");
      if (!mountedRef.current || controller.signal.aborted || announcementMutationAbortRef.current !== controller) return;
      setAnnouncements((current) => [
        announcement,
        ...current.filter((item) => item.id !== announcement.id),
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)));
      setAnnouncementTitle("");
      setAnnouncementContent("");
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      if (mountedRef.current && announcementMutationAbortRef.current === controller) {
        setAnnouncementsError(error instanceof Error ? error.message : "Unable to publish this announcement.");
      }
    } finally {
      if (announcementMutationAbortRef.current === controller) {
        announcementMutationAbortRef.current = null;
        if (mountedRef.current) setAnnouncementSubmitting(false);
      }
    }
  }, [announcementContent, announcementDeletingId, announcementSubmitting, announcementTitle, isAdmin]);

  const deleteAnnouncement = useCallback(async (announcement: Announcement) => {
    if (!isAdmin || announcementSubmitting || Boolean(announcementDeletingId)) return;
    if (!window.confirm(`Delete ${announcement.title ? `“${announcement.title}”` : "this announcement"}?`)) return;
    announcementsAbortRef.current?.abort();
    announcementMutationAbortRef.current?.abort();
    const controller = new AbortController();
    announcementMutationAbortRef.current = controller;
    setAnnouncementDeletingId(announcement.id);
    setAnnouncementsError("");
    try {
      const response = await fetch(`/api/announcements/${encodeURIComponent(announcement.id)}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok) throw new Error(readError(body, "Unable to delete this announcement."));
      if (!mountedRef.current || controller.signal.aborted || announcementMutationAbortRef.current !== controller) return;
      setAnnouncements((current) => current.filter((item) => item.id !== announcement.id));
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      if (mountedRef.current && announcementMutationAbortRef.current === controller) {
        setAnnouncementsError(error instanceof Error ? error.message : "Unable to delete this announcement.");
      }
    } finally {
      if (announcementMutationAbortRef.current === controller) {
        announcementMutationAbortRef.current = null;
        if (mountedRef.current) setAnnouncementDeletingId("");
      }
    }
  }, [announcementDeletingId, announcementSubmitting, isAdmin]);

  const uploadAgentFiles = useCallback(async (selectedFiles: File[]) => {
    if (!selectedFiles.length || agentLoading
      || agentAttachments.some((attachment) => attachment.status === "uploading")) return;
    const availableSlots = Math.max(0, MAX_AGENT_ATTACHMENTS - agentAttachments.length);
    const files = selectedFiles.slice(0, availableSlots);
    if (!files.length) {
      setAgentError(`Attach up to ${MAX_AGENT_ATTACHMENTS} files per message.`);
      return;
    }
    const tasks: AgentComposerAttachment[] = files.map((file) => ({
      localId: createId("agent-attachment"),
      fileId: "",
      name: file.name || "Unnamed file",
      contentType: file.type || "application/octet-stream",
      size: file.size,
      status: file.size > MAX_AGENT_ATTACHMENT_BYTES ? "failed" : "uploading",
      ...(file.size > MAX_AGENT_ATTACHMENT_BYTES ? { error: "File exceeds the 20 MB limit." } : {}),
    }));
    setAgentError("");
    setAgentAttachments((current) => [...current, ...tasks]);
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const file = files[index];
      if (task.status === "failed") continue;
      try {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch("/api/files/upload", { method: "POST", body: form });
        const body = await readJsonResponse<unknown>(response);
        if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error(readError(body, "Upload failed."));
        }
        const data = (body as { data?: unknown }).data;
        const item = data && typeof data === "object" && !Array.isArray(data)
          ? (data as { item?: unknown }).item : null;
        const knowledgeIndex = data && typeof data === "object" && !Array.isArray(data)
          ? (data as { knowledgeIndex?: unknown }).knowledgeIndex : null;
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Upload returned an invalid file.");
        const uploaded = item as Record<string, unknown>;
        const fileId = typeof uploaded.id === "string" && WORKSPACE_FILE_ID_PATTERN.test(uploaded.id)
          ? uploaded.id.toLocaleLowerCase("en-AU") : "";
        const name = typeof uploaded.name === "string" ? uploaded.name.trim() : "";
        const contentType = typeof uploaded.contentType === "string" ? uploaded.contentType : "";
        const size = typeof uploaded.size === "number" && Number.isSafeInteger(uploaded.size) ? uploaded.size : 0;
        if (!fileId || !name || !contentType || size < 1 || size > MAX_AGENT_ATTACHMENT_BYTES) {
          throw new Error("Upload returned invalid file metadata.");
        }
        const indexStatus = knowledgeIndex && typeof knowledgeIndex === "object" && !Array.isArray(knowledgeIndex)
          ? (knowledgeIndex as { status?: unknown }).status : null;
        const status: AgentAttachmentStatus = agentAttachmentIsImage(contentType)
          ? "ready"
          : indexStatus === "queued"
          ? "processing"
          : indexStatus === "failed"
            ? "failed"
            : indexStatus === "not_supported" || indexStatus === null
              ? "unsupported"
              : "ready";
        setAgentAttachments((current) => current.map((attachment) => attachment.localId === task.localId
          ? {
            localId: task.localId,
            fileId,
            name,
            contentType,
            size,
            status,
            ...(status === "failed" ? { error: "The file was saved, but Agent preparation failed." } : {}),
          }
          : attachment));
      } catch (uploadError) {
        setAgentAttachments((current) => current.map((attachment) => attachment.localId === task.localId
          ? { ...attachment, status: "failed", error: uploadError instanceof Error ? uploadError.message : "Upload failed." }
          : attachment));
      }
    }
    if (agentFileInputRef.current) agentFileInputRef.current.value = "";
  }, [agentAttachments, agentLoading]);

  const processingAttachmentKey = agentAttachments
    .filter((attachment) => attachment.status === "processing" && attachment.fileId)
    .map((attachment) => attachment.fileId)
    .sort()
    .join(":");

  useEffect(() => {
    if (!processingAttachmentKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fileIds = processingAttachmentKey.split(":");
    const check = async () => {
      try {
        const response = await fetch("/api/agent/attachments/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachments: fileIds.map((fileId) => ({ file_id: fileId })) }),
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await readJsonResponse<unknown>(response);
        if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error(readError(body, "Attachment preparation status is unavailable."));
        }
        const data = (body as { data?: unknown }).data;
        const statuses = data && typeof data === "object" && !Array.isArray(data)
          && Array.isArray((data as { attachments?: unknown }).attachments)
          ? (data as { attachments: unknown[] }).attachments : [];
        const byId = new Map<string, AgentAttachmentStatus>();
        for (const raw of statuses) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const item = raw as Record<string, unknown>;
          if (typeof item.fileId === "string" && WORKSPACE_FILE_ID_PATTERN.test(item.fileId)
            && ["ready", "processing", "unsupported", "failed"].includes(String(item.status))) {
            byId.set(item.fileId.toLocaleLowerCase("en-AU"), item.status as AgentAttachmentStatus);
          }
        }
        if (!controller.signal.aborted) {
          setAgentAttachments((current) => current.map((attachment) => {
            const status = byId.get(attachment.fileId);
            return status && status !== attachment.status
              ? { ...attachment, status, ...(status === "failed" ? { error: "Agent preparation failed." } : { error: undefined }) }
              : attachment;
          }));
        }
      } catch (statusError) {
        if (controller.signal.aborted || (statusError instanceof DOMException && statusError.name === "AbortError")) return;
      }
      if (!controller.signal.aborted) timer = setTimeout(check, 2_000);
    };
    timer = setTimeout(check, 1_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [processingAttachmentKey]);

  const removeAgentAttachment = (localId: string) => {
    if (agentLoading) return;
    setAgentAttachments((current) => current.filter((attachment) => attachment.localId !== localId));
  };

  const handleAgentAttachmentDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    void uploadAgentFiles(Array.from(event.dataTransfer.files));
  };

  const handleAgentAttachmentPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void uploadAgentFiles(files);
  };

  const submitAgentMessage = useCallback(async (rawMessage?: string) => {
    const blockedAttachment = agentAttachments.find((attachment) =>
      attachment.status === "uploading" || attachment.status === "processing" || attachment.status === "failed");
    if (blockedAttachment) {
      setAgentError(blockedAttachment.status === "failed"
        ? blockedAttachment.error || "Remove the failed attachment before sending."
        : "Wait for the attachment to finish preparing before sending.");
      return;
    }
    const messageAttachments = agentAttachments.filter((attachment) =>
      attachment.fileId && (attachment.status === "ready" || attachment.status === "unsupported"));
    const message = (rawMessage ?? agentInput).trim()
      || (messageAttachments.length ? "Please review the attached file." : "");
    if (!message || agentLoading || agentAbortRef.current || !agentHistoryHydrated) return;

    agentStorageClearGuardRef.current = false;
    const lastMessage = agentMessages.at(-1);
    const lastAttachmentIds = lastMessage?.attachments?.map((attachment) => attachment.fileId).join(":") || "";
    const currentAttachmentIds = messageAttachments.map((attachment) => attachment.fileId).join(":");
    const isRetry = Boolean(agentError)
      && lastMessage?.role === "user"
      && lastMessage.content.trim() === message
      && lastAttachmentIds === currentAttachmentIds;
    const history = (isRetry ? agentMessages.slice(0, -1) : agentMessages)
      .slice(-10)
      .map(({ role, content }) => ({ role, content: content.slice(0, MAX_MESSAGE_LENGTH) }));
    const persistedAttachments: AgentMessageAttachment[] = messageAttachments.map((attachment) => ({
      fileId: attachment.fileId,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
    }));
    const userMessage: AgentMessage = {
      id: createId("agent-user"),
      role: "user",
      content: message,
      ...(persistedAttachments.length ? { attachments: persistedAttachments } : {}),
    };
    if (!isRetry) {
      setAgentMessages((current) => limitAgentMessages([...current, userMessage]));
    }
    setAgentInput("");
    setAgentAttachments([]);
    setAgentError("");
    setAgentNotice("");
    setAgentLoading(true);
    const controller = new AbortController();
    const conversationRevision = agentConversationRevisionRef.current;
    const conversationId = agentConversationIdRef.current || crypto.randomUUID();
    agentConversationIdRef.current = conversationId;
    agentAbortRef.current = controller;

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          section: "all",
          history,
          conversation_id: conversationId,
          attachments: persistedAttachments.map((attachment) => ({ file_id: attachment.fileId })),
        }),
        signal: controller.signal,
      });
      const rawBody = await readJsonResponse<unknown>(response);
      if (!response.ok) throw new Error(readError(rawBody, "E3 Agent could not answer right now."));
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new Error("E3 Agent returned an invalid response. Please try again.");
      }
      const body = rawBody as {
        data?: { answer?: unknown; response?: unknown; suggestions?: unknown; mode?: unknown; citations?: unknown };
        answer?: unknown;
        response?: unknown;
        suggestions?: unknown;
        meta?: { configured?: unknown; modelStatus?: unknown; warning?: unknown };
      };
      if (
        !mountedRef.current
        || controller.signal.aborted
        || conversationRevision !== agentConversationRevisionRef.current
      ) {
        return;
      }
      const answerValue = body.data?.answer ?? body.data?.response ?? body.answer ?? body.response;
      if (typeof answerValue !== "string" || !answerValue.trim()) {
        throw new Error("E3 Agent returned an empty answer. Please try again.");
      }
      const suggestionValue = body.data?.suggestions ?? body.suggestions;
      if (Array.isArray(suggestionValue)) {
        const nextSuggestions = suggestionValue
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .slice(0, 4);
        if (nextSuggestions.length) setAgentSuggestions(nextSuggestions);
      }
      const mode = typeof body.data?.mode === "string" ? body.data.mode : "";
      const citations = readAgentCitations(body.data?.citations);
      if (typeof body.meta?.configured === "boolean") {
        setAgentConfigured(body.meta.configured);
      } else if (mode === "openai" || mode === "kimi") {
        setAgentConfigured(true);
      }
      if (
        body.meta?.modelStatus === "available"
        || body.meta?.modelStatus === "unavailable"
      ) {
        setAgentModelStatus(body.meta.modelStatus);
      } else if (mode === "openai" || mode === "kimi") {
        setAgentModelStatus("available");
      }
      if (typeof body.meta?.warning === "string") setAgentNotice(body.meta.warning);
      setAgentMessages((current) => limitAgentMessages([
        ...current,
        {
          id: createId("agent-assistant"),
          role: "assistant",
          content: limitAgentContent(answerValue.trim()),
          ...(citations.length ? { citations } : {}),
        },
      ]));
    } catch (error) {
      if (
        controller.signal.aborted
        || conversationRevision !== agentConversationRevisionRef.current
        || (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      if (mountedRef.current) {
        setAgentError(error instanceof Error ? error.message : "E3 Agent could not answer right now.");
        setAgentInput(message);
        setAgentAttachments((current) => current.length ? current : messageAttachments);
      }
    } finally {
      if (agentAbortRef.current === controller) {
        agentAbortRef.current = null;
        if (mountedRef.current && conversationRevision === agentConversationRevisionRef.current) {
          setAgentLoading(false);
        }
      }
    }
  }, [agentAttachments, agentError, agentHistoryHydrated, agentInput, agentLoading, agentMessages]);

  const clearAgentConversation = () => {
    agentStorageClearGuardRef.current = true;
    agentConversationRevisionRef.current += 1;
    agentConversationIdRef.current = crypto.randomUUID();
    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    try {
      window.localStorage.removeItem(agentConversationStorageKey);
    } catch {
      // Clearing the visible conversation still succeeds when browser storage is unavailable.
    }
    setAgentMessages([]);
    setAgentInput("");
    setAgentAttachments([]);
    setAgentError("");
    setAgentNotice("");
    setAgentSuggestions(DEFAULT_SUGGESTIONS);
    setAgentLoading(false);
  };

  const agentModelUnavailable = agentConfigured === false || agentModelStatus === "unavailable";
  const agentStatusLabel = agentConfigured === false
    ? "Model not configured"
    : agentModelStatus === "unavailable"
      ? "Model unavailable"
      : agentModelStatus === "available"
      ? "Model ready"
      : agentConfigured === true
        ? "Model configured"
        : "Workspace connected";
  const agentKnowledgeStatus = knowledgeReadinessPresentation(agentKnowledgeReadiness);
  const notificationSyncLabel = notificationsError
    ? "Refresh needed"
    : notificationsGeneratedAt
      ? `Updated ${formatTime(notificationsGeneratedAt)}`
      : notificationsLoading
        ? "Updating"
        : "Auto refresh";
  const currentRoleLabel = ERP_ROLE_LABELS[currentUser.role];

  return (
    <section className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <span className={styles.eyebrow}>E3 ENERGY · TEAM WORKSPACE</span>
          <h1>Your work, team updates and E3 Agent</h1>
        </div>
      </header>

      <div className={styles.columns}>
        <div className={styles.leftStack}>
          <article className={`${styles.panel} ${styles.reminderPanel}`} aria-label={`${currentRoleLabel} action reminders`}>
            <header className={styles.panelHeader}>
              <span className={`${styles.panelIcon} ${styles.notificationIcon}`}><BellRing size={18} /></span>
              <div className={styles.panelTitle}>
                <h2>My Action Reminders</h2>
              </div>
              <span className={styles.rolePill}>{currentRoleLabel}</span>
              <span className={`${styles.statusBadge} ${notificationsError ? styles.errorBadge : ""}`}><i />{notificationSyncLabel}</span>
              <button
                className={styles.iconButton}
                type="button"
                onClick={() => void loadNotifications(notificationRole, true)}
                disabled={notificationsLoading}
                title="Refresh reminders"
                aria-label="Refresh my action reminders"
              >
                <RefreshCw className={notificationsLoading ? styles.spinning : undefined} size={16} />
              </button>
            </header>

            <div
              id="notification-reminder-feed"
              className={styles.notificationFeed}
              role="region"
              aria-label={`${currentRoleLabel} action reminders`}
              aria-live="polite"
              aria-busy={notificationsLoading}
            >
              {notificationsError && notifications.length > 0 && (
                <div className={styles.notificationBanner} role="alert">
                  <AlertCircle size={15} />
                  <span>{notificationsError}</span>
                </div>
              )}
              {notificationsWarning && (
                <div className={`${styles.notificationBanner} ${styles.warningBanner}`}>
                  <AlertCircle size={15} />
                  <span>{notificationsWarning}</span>
                </div>
              )}

              {notificationsLoading && !notifications.length ? (
                <div className={styles.feedState}>
                  <LoaderCircle className={styles.spinning} size={24} />
                  <strong>Preparing your reminders</strong>
                </div>
              ) : notificationsError && !notifications.length ? (
                <div className={`${styles.feedState} ${styles.errorState}`} role="alert">
                  <span><AlertCircle size={24} /></span>
                  <strong>Reminders are unavailable</strong>
                  <p>{notificationsError}</p>
                  <button type="button" onClick={() => void loadNotifications(notificationRole, false)}>Try again</button>
                </div>
              ) : !notifications.length ? (
                <div className={styles.feedState}>
                  <span><BellRing size={24} /></span>
                  <strong>You are all caught up</strong>
                </div>
              ) : (
                <ul className={styles.notificationList}>
                  {notifications.map((notification) => {
                    const priorityClass = notification.priority === "urgent"
                      ? styles.priorityUrgent
                      : notification.priority === "high"
                        ? styles.priorityHigh
                        : styles.priorityNormal;
                    return (
                      <li key={notification.id}>
                        <button
                          type="button"
                          className={`${styles.notificationCard} ${priorityClass}`}
                          onClick={() => onNavigate?.(notification.module, notification.entityId)}
                          disabled={!onNavigate}
                        >
                          <span className={styles.notificationCardTopline}>
                            <span className={styles.priorityBadge}>
                              {notification.badgeLabel || NOTIFICATION_PRIORITY_LABELS[notification.priority]}
                            </span>
                            {(notification.projectCreatedAt || notification.ownerName) && (
                              <span className={styles.notificationMetadata}>
                                {notification.projectCreatedAt ? (
                                  <time dateTime={notification.projectCreatedAt}>
                                    Created {formatProjectCreatedAt(notification.projectCreatedAt)}
                                  </time>
                                ) : (
                                  <span>Created date unavailable</span>
                                )}
                                <span className={styles.notificationMetadataDivider} aria-hidden="true">·</span>
                                <span>Responsible: {notification.ownerName || "Unassigned"}</span>
                              </span>
                            )}
                          </span>
                          <strong className={styles.notificationTitle}>{notification.title}</strong>
                          <span className={styles.notificationDescription}>{notification.description}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </article>

          <article className={styles.panel} aria-label="Public announcements">
            <header className={styles.panelHeader}>
              <span className={`${styles.panelIcon} ${styles.announcementIcon}`}><Megaphone size={18} /></span>
              <div className={styles.panelTitle}><h2>Public Announcements</h2></div>
              <span className={styles.rolePill}>{isAdmin ? "Admin controls" : "Read only"}</span>
              <button
                className={styles.iconButton}
                type="button"
                onClick={() => void loadAnnouncements(true)}
                disabled={announcementsLoading || announcementSubmitting || Boolean(announcementDeletingId)}
                title="Refresh announcements"
                aria-label="Refresh public announcements"
              >
                <RefreshCw className={announcementsLoading ? styles.spinning : undefined} size={16} />
              </button>
            </header>

            {isAdmin && (
              <form
                className={styles.announcementComposer}
                onSubmit={(event) => {
                  event.preventDefault();
                  void publishAnnouncement();
                }}
              >
                <input
                  value={announcementTitle}
                  onChange={(event) => setAnnouncementTitle(event.target.value)}
                  maxLength={140}
                  placeholder="Title (optional)"
                  aria-label="Announcement title"
                  disabled={announcementSubmitting}
                />
                <div>
                  <textarea
                    value={announcementContent}
                    onChange={(event) => setAnnouncementContent(event.target.value)}
                    maxLength={4_000}
                    rows={2}
                    placeholder="Share an update with everyone..."
                    aria-label="Announcement content"
                    disabled={announcementSubmitting}
                  />
                  <button type="submit" disabled={!announcementContent.trim() || announcementSubmitting || Boolean(announcementDeletingId)}>
                    {announcementSubmitting ? <LoaderCircle className={styles.spinning} size={16} /> : <Send size={16} />}
                    <span>{announcementSubmitting ? "Posting" : "Post"}</span>
                  </button>
                </div>
              </form>
            )}

            <div className={styles.announcementFeed} role="region" aria-label="Public announcement feed" aria-live="polite" aria-busy={announcementsLoading}>
              {announcementsError && (
                <div className={styles.notificationBanner} role="alert">
                  <AlertCircle size={15} />
                  <span>{announcementsError}</span>
                </div>
              )}
              {announcementsLoading && !announcements.length ? (
                <div className={styles.feedState}>
                  <LoaderCircle className={styles.spinning} size={24} />
                  <strong>Loading announcements</strong>
                </div>
              ) : !announcements.length ? (
                <div className={styles.feedState}>
                  <span><Megaphone size={24} /></span>
                  <strong>No announcements yet</strong>
                </div>
              ) : (
                <ul className={styles.announcementList}>
                  {announcements.map((announcement) => (
                    <li key={announcement.id} className={styles.announcementCard}>
                      <div className={styles.announcementMeta}>
                        <span>{announcement.createdBy}</span>
                        <time dateTime={announcement.createdAt}>{formatAnnouncementDate(announcement.createdAt)}</time>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => void deleteAnnouncement(announcement)}
                            disabled={Boolean(announcementDeletingId) || announcementSubmitting}
                            aria-label={`Delete ${announcement.title || "announcement"}`}
                            title="Delete announcement"
                          >
                            {announcementDeletingId === announcement.id
                              ? <LoaderCircle className={styles.spinning} size={14} />
                              : <Trash2 size={14} />}
                          </button>
                        )}
                      </div>
                      {announcement.title && <strong>{announcement.title}</strong>}
                      <p>{announcement.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        </div>

        <article className={`${styles.panel} ${styles.agentPanel}`} aria-label="E3 Agent">
          <header className={styles.panelHeader}>
            <span className={`${styles.panelIcon} ${styles.agentIcon}`}><Sparkles size={18} /></span>
            <div className={styles.panelTitle}>
              <h2>E3 Agent</h2>
            </div>
            <span
              className={`${styles.statusBadge} ${agentModelUnavailable ? styles.localBadge : ""}`}
              title="Language model status only"
            >
              <i />{agentStatusLabel}
            </span>
            {isAdmin && (
              <span
                className={`${styles.statusBadge} ${agentKnowledgeStatus.tone === "error" ? styles.errorBadge : agentKnowledgeStatus.tone === "warning" ? styles.localBadge : ""}`}
                title={agentKnowledgeStatus.title}
                aria-label={agentKnowledgeStatus.title}
              >
                <i />{agentKnowledgeStatus.label}
              </span>
            )}
            {isAdmin && onOpenSkills ? (
              <button
                className={`${styles.iconButton} ${styles.skillManageButton}`}
                type="button"
                onClick={onOpenSkills}
                title="Manage Agent skills"
                aria-label="Manage Agent skills"
                aria-haspopup="dialog"
              >
                <Blocks size={15} />
                <span>Skills</span>
              </button>
            ) : null}
            <button className={styles.iconButton} type="button" onClick={onOpenSettings} disabled={!onOpenSettings} title="Open Agent settings" aria-label="Open Agent settings">
              <Settings2 size={16} />
            </button>
            <button className={styles.iconButton} type="button" onClick={clearAgentConversation} disabled={!agentMessages.length && !agentLoading} title="Clear conversation" aria-label="Clear Agent conversation">
              <Trash2 size={16} />
            </button>
          </header>

          {agentConfigured === false && (
            <div className={styles.setupNotice}>
              <AlertCircle size={15} />
              <span>No model is configured. Local workspace queries are active.</span>
              {onOpenSettings && <button type="button" onClick={onOpenSettings}>Open Settings</button>}
            </div>
          )}

          <div className={styles.agentFeed} ref={agentFeedRef} aria-live="polite">
            {!agentMessages.length && (
              <div className={styles.agentWelcome}>
                <span><Bot size={25} /></span>
                <h3>How can I help?</h3>
              </div>
            )}
            {agentMessages.map((message) => (
              <div key={message.id} className={`${styles.agentMessage} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
                <span className={styles.messageAvatar}>{message.role === "assistant" ? <Bot size={15} /> : "You"}</span>
                <div>
                  <strong className={styles.messageAuthor}>{message.role === "assistant" ? "E3 Agent" : "You"}</strong>
                  {message.role === "assistant" ? (
                    <>
                      <div className={styles.assistantBubble}>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={AGENT_MARKDOWN_COMPONENTS}
                          skipHtml
                          urlTransform={safeMarkdownUrl}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                      {Boolean(message.citations?.length) && (
                        <section className={styles.citationPanel} aria-label="Knowledge sources">
                          <strong><FileText size={14} aria-hidden="true" /> Sources</strong>
                          <ol>
                            {message.citations?.map((citation) => {
                              const updated = formatCitationDate(citation.updatedAt);
                              return (
                                <li key={`${citation.documentId}:${citation.chunkId || "document"}`}>
                                  <div>
                                    <b>{citation.title}</b>
                                    <span>
                                      v{citation.version}
                                      {citation.pageNumber ? ` · Page ${citation.pageNumber}` : ""}
                                      {updated ? ` · Updated ${updated}` : ""}
                                    </span>
                                    {citation.headingPath?.length ? <small>{citation.headingPath.join(" › ")}</small> : null}
                                  </div>
                                  {citation.fileId && (
                                    <span className={styles.citationActions}>
                                      <a
                                        href={workspaceFileCitationHref(citation.fileId, "preview")}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        aria-label={`Preview source: ${citation.title}`}
                                      ><Eye size={13} aria-hidden="true" /> Preview</a>
                                      <a
                                        href={workspaceFileCitationHref(citation.fileId, "download")}
                                        aria-label={`Download source: ${citation.title}`}
                                      ><Download size={13} aria-hidden="true" /> Download</a>
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ol>
                        </section>
                      )}
                    </>
                  ) : (
                    <>
                      <p className={styles.userBubble}>{message.content}</p>
                      {Boolean(message.attachments?.length) && (
                        <div className={styles.messageAttachments} aria-label="Message attachments">
                          {message.attachments?.map((attachment) => (
                            <a
                              key={attachment.fileId}
                              className={styles.messageAttachment}
                              href={workspaceFileCitationHref(
                                attachment.fileId,
                                agentAttachmentContentMode(attachment.contentType),
                              )}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {agentAttachmentIsImage(attachment.contentType) ? (
                                <img
                                  src={workspaceFileCitationHref(attachment.fileId, "preview")}
                                  alt={attachment.name}
                                  loading="lazy"
                                />
                              ) : <FileText size={18} aria-hidden="true" />}
                              <span><strong>{attachment.name}</strong><small>{formatAgentAttachmentBytes(attachment.size)}</small></span>
                            </a>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
            {agentLoading && (
              <div className={`${styles.agentMessage} ${styles.assistantMessage}`}>
                <span className={styles.messageAvatar}><Bot size={15} /></span>
                <div><strong className={styles.messageAuthor}>E3 Agent</strong><span className={styles.thinking}><i /><i /><i />Searching your workspace</span></div>
              </div>
            )}
          </div>

          <div className={styles.agentFooter}>
            {agentError && <div className={styles.inlineError} role="alert"><AlertCircle size={14} /><span>{agentError}</span></div>}
            {agentNotice && !agentError && <div className={styles.inlineNotice}><AlertCircle size={14} /><span>{agentNotice}</span></div>}
            <div className={styles.suggestions} aria-label="Suggested questions">
              {agentSuggestions.slice(0, 3).map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => void submitAgentMessage(suggestion)} disabled={agentLoading || !agentHistoryHydrated}>{suggestion}</button>
              ))}
            </div>
            {Boolean(agentAttachments.length) && (
              <div className={styles.composerAttachments} aria-label="Attachments waiting to send" aria-live="polite">
                {agentAttachments.map((attachment) => (
                  <div
                    key={attachment.localId}
                    className={`${styles.composerAttachment} ${attachment.status === "failed" ? styles.attachmentFailed : ""}`}
                    title={attachment.error || attachment.name}
                  >
                    <span className={styles.attachmentIcon}>
                      {attachment.status === "uploading" || attachment.status === "processing"
                        ? <LoaderCircle className={styles.spinning} size={16} />
                        : agentAttachmentIsImage(attachment.contentType)
                          ? <FileImage size={16} />
                          : <FileText size={16} />}
                    </span>
                    <span className={styles.attachmentDetails}>
                      <strong>{attachment.name}</strong>
                      <small>
                        {attachment.error
                          || (attachment.status === "uploading" ? "Uploading"
                            : attachment.status === "processing" ? "Preparing for Agent"
                              : attachment.status === "unsupported" ? "Uploaded · Preview only"
                                : `${formatAgentAttachmentBytes(attachment.size)} · Ready`)}
                      </small>
                    </span>
                    <button type="button" onClick={() => removeAgentAttachment(attachment.localId)} disabled={agentLoading} aria-label={`Remove ${attachment.name}`}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={agentFileInputRef}
              className={styles.hiddenFileInput}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md,.log,.csv,.xlsx,.pptx,.jpg,.jpeg,.png,.webp"
              onChange={(event) => void uploadAgentFiles(Array.from(event.target.files || []))}
              tabIndex={-1}
              aria-hidden="true"
            />
            <div
              className={styles.composer}
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
              }}
              onDrop={handleAgentAttachmentDrop}
            >
              <button
                className={styles.attachButton}
                type="button"
                onClick={() => agentFileInputRef.current?.click()}
                disabled={agentLoading || agentAttachments.length >= MAX_AGENT_ATTACHMENTS
                  || agentAttachments.some((attachment) => attachment.status === "uploading")}
                aria-label="Attach files or images"
                title="Attach files or images"
              >
                <Paperclip size={17} />
              </button>
              <textarea
                value={agentInput}
                onChange={(event) => setAgentInput(event.target.value)}
                onPaste={handleAgentAttachmentPaste}
                onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitAgentMessage();
                  }
                }}
                maxLength={MAX_MESSAGE_LENGTH}
                rows={2}
                placeholder="Ask E3 Agent about your business..."
                aria-label="Question for E3 Agent"
                disabled={agentLoading || !agentHistoryHydrated}
              />
              <button
                className={styles.sendButton}
                type="button"
                onClick={() => void submitAgentMessage()}
                disabled={(!agentInput.trim() && !agentAttachments.length) || agentLoading || !agentHistoryHydrated
                  || agentAttachments.some((attachment) => attachment.status === "uploading"
                    || attachment.status === "processing" || attachment.status === "failed")}
                aria-label="Send question"
              >
                {agentLoading ? <LoaderCircle className={styles.spinning} size={17} /> : <Send size={17} />}
              </button>
            </div>
            <p className={styles.conversationAuditDisclosure}>
              <ShieldCheck size={12} aria-hidden="true" /> Visible messages are redacted and retained for 30 days in the administrator Agent Trace. Original attachment content and hidden reasoning are not stored; visible answers may contain derived business information. Clearing this panel starts a new chat but does not delete the audit copy.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}
