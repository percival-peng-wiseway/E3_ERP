"use client";

import {
  AlertCircle,
  BellRing,
  Bot,
  LoaderCircle,
  Megaphone,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ERP_ROLE_LABELS, type ErpUser } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import styles from "./home-collaboration-workspace.module.css";

type AgentRole = "user" | "assistant";

type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
};

type NotificationRole = "all" | "sales" | "specialist" | "pm" | "admin";
type NotificationOwnerRole = Exclude<NotificationRole, "all">;
type NotificationPriority = "urgent" | "high" | "normal";
type NotificationModule = "payments" | "projects" | "reimbursements" | "inventory" | "quotations";

type WorkspaceNotification = {
  id: string;
  role: NotificationOwnerRole;
  priority: NotificationPriority;
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
  onOpenSettings?: () => void;
  onNavigate?: (module: NotificationModule, entityId?: string) => void;
};

const DEFAULT_SUGGESTIONS = [
  "Which inventory items need attention?",
  "Summarise current payment collections",
  "What deliveries are waiting for PM review?",
];
const LEGACY_AGENT_CONVERSATION_STORAGE_KEY = "e3-agent-conversation:v1";
const AGENT_CONVERSATION_STORAGE_VERSION = 1;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_AGENT_HISTORY_MESSAGES = 100;
const MAX_AGENT_HISTORY_CHARACTERS = 200_000;
const MAX_AGENT_HISTORY_MESSAGE_CHARACTERS = 50_000;
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
  return { id: item.id, role: item.role, content: item.content };
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
    const nextCharacterCount = characterCount + message.id.length + message.content.length;
    if (limited.length >= MAX_AGENT_HISTORY_MESSAGES || nextCharacterCount > MAX_AGENT_HISTORY_CHARACTERS) break;
    limited.push(message);
    ids.add(message.id);
    characterCount = nextCharacterCount;
  }

  return limited.reverse();
}

function readAgentConversation(rawValue: string | null) {
  if (!rawValue) return [];
  try {
    const value: unknown = JSON.parse(rawValue);
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (record.version !== AGENT_CONVERSATION_STORAGE_VERSION || !Array.isArray(record.messages)) return [];
    return limitAgentMessages(record.messages);
  } catch {
    return [];
  }
}

function safeMarkdownUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return value;
    }
  } catch {
    // Agent links must be absolute and use one of the explicitly allowed protocols.
  }
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

export function HomeCollaborationWorkspace({ currentUser, onOpenSettings, onNavigate }: HomeCollaborationWorkspaceProps) {
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentHistoryHydrated, setAgentHistoryHydrated] = useState(false);
  const [agentHydratedStorageKey, setAgentHydratedStorageKey] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [agentSuggestions, setAgentSuggestions] = useState(DEFAULT_SUGGESTIONS);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentNotice, setAgentNotice] = useState("");
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const agentConversationRevisionRef = useRef(0);
  const agentStorageClearGuardRef = useRef(false);
  const agentFeedRef = useRef<HTMLDivElement>(null);

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
  const notificationRole = currentUser.role;
  const isAdmin = currentUser.role === "admin";
  const agentConversationStorageKey = `${LEGACY_AGENT_CONVERSATION_STORAGE_KEY}:${encodeURIComponent(currentUser.username.toLocaleLowerCase("en-AU"))}`;

  const loadAgentSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/agent", { cache: "no-store" });
      if (!response.ok) return;
      const body = await readJsonResponse<{ data?: { configured?: unknown } }>(response);
      if (mountedRef.current && typeof body.data?.configured === "boolean") {
        setAgentConfigured(body.data.configured);
      }
    } catch {
      // A failed settings check does not prevent local Agent queries from working.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setAgentHistoryHydrated(false);
    setAgentMessages([]);
    try {
      setAgentMessages(readAgentConversation(window.localStorage.getItem(agentConversationStorageKey)));
      window.localStorage.removeItem(LEGACY_AGENT_CONVERSATION_STORAGE_KEY);
    } catch {
      // Agent chat still works for this session if storage is unavailable.
    }
    setAgentHydratedStorageKey(agentConversationStorageKey);
    setAgentHistoryHydrated(true);

    const handleSettingsUpdate = () => void loadAgentSettings();
    const handleConversationStorage = (event: StorageEvent) => {
      if (event.key !== agentConversationStorageKey || event.newValue !== null) return;
      agentStorageClearGuardRef.current = true;
      agentConversationRevisionRef.current += 1;
      agentAbortRef.current?.abort();
      agentAbortRef.current = null;
      try {
        window.localStorage.removeItem(agentConversationStorageKey);
      } catch {
        // The visible clear still succeeds if another tab cannot update browser storage.
      }
      setAgentMessages([]);
      setAgentSuggestions(DEFAULT_SUGGESTIONS);
      setAgentError("");
      setAgentNotice("");
      setAgentLoading(false);
    };
    void loadAgentSettings();
    window.addEventListener("erp:agent-settings-updated", handleSettingsUpdate);
    window.addEventListener("storage", handleConversationStorage);

    return () => {
      mountedRef.current = false;
      agentAbortRef.current?.abort();
      notificationsAbortRef.current?.abort();
      announcementsAbortRef.current?.abort();
      announcementMutationAbortRef.current?.abort();
      window.removeEventListener("erp:agent-settings-updated", handleSettingsUpdate);
      window.removeEventListener("storage", handleConversationStorage);
    };
  }, [agentConversationStorageKey, loadAgentSettings]);

  useEffect(() => {
    if (!agentHistoryHydrated
      || agentHydratedStorageKey !== agentConversationStorageKey
      || !agentMessages.length
      || agentStorageClearGuardRef.current) return;
    try {
      window.localStorage.setItem(agentConversationStorageKey, JSON.stringify({
        version: AGENT_CONVERSATION_STORAGE_VERSION,
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
    const interval = window.setInterval(
      () => void loadNotifications(notificationRole, true),
      NOTIFICATION_REFRESH_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(interval);
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

  const submitAgentMessage = useCallback(async (rawMessage?: string) => {
    const message = (rawMessage ?? agentInput).trim();
    if (!message || agentLoading || agentAbortRef.current || !agentHistoryHydrated) return;

    agentStorageClearGuardRef.current = false;
    const lastMessage = agentMessages.at(-1);
    const isRetry = Boolean(agentError)
      && lastMessage?.role === "user"
      && lastMessage.content.trim() === message;
    const history = (isRetry ? agentMessages.slice(0, -1) : agentMessages)
      .slice(-10)
      .map(({ role, content }) => ({ role, content: content.slice(0, MAX_MESSAGE_LENGTH) }));
    const userMessage: AgentMessage = { id: createId("agent-user"), role: "user", content: message };
    if (!isRetry) {
      setAgentMessages((current) => limitAgentMessages([...current, userMessage]));
    }
    setAgentInput("");
    setAgentError("");
    setAgentNotice("");
    setAgentLoading(true);
    const controller = new AbortController();
    const conversationRevision = agentConversationRevisionRef.current;
    agentAbortRef.current = controller;

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, section: "all", history }),
        signal: controller.signal,
      });
      const rawBody = await readJsonResponse<unknown>(response);
      if (!response.ok) throw new Error(readError(rawBody, "E3 Agent could not answer right now."));
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new Error("E3 Agent returned an invalid response. Please try again.");
      }
      const body = rawBody as {
        data?: { answer?: unknown; response?: unknown; suggestions?: unknown; mode?: unknown };
        answer?: unknown;
        response?: unknown;
        suggestions?: unknown;
        meta?: { configured?: unknown; warning?: unknown };
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
      if (typeof body.meta?.configured === "boolean") {
        setAgentConfigured(body.meta.configured);
      } else if (mode === "openai" || mode === "deepseek") {
        setAgentConfigured(true);
      }
      if (typeof body.meta?.warning === "string") setAgentNotice(body.meta.warning);
      setAgentMessages((current) => limitAgentMessages([
        ...current,
        {
          id: createId("agent-assistant"),
          role: "assistant",
          content: limitAgentContent(answerValue.trim()),
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
      }
    } finally {
      if (agentAbortRef.current === controller) {
        agentAbortRef.current = null;
        if (mountedRef.current && conversationRevision === agentConversationRevisionRef.current) {
          setAgentLoading(false);
        }
      }
    }
  }, [agentError, agentHistoryHydrated, agentInput, agentLoading, agentMessages]);

  const clearAgentConversation = () => {
    agentStorageClearGuardRef.current = true;
    agentConversationRevisionRef.current += 1;
    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    try {
      window.localStorage.removeItem(agentConversationStorageKey);
    } catch {
      // Clearing the visible conversation still succeeds when browser storage is unavailable.
    }
    setAgentMessages([]);
    setAgentInput("");
    setAgentError("");
    setAgentNotice("");
    setAgentSuggestions(DEFAULT_SUGGESTIONS);
    setAgentLoading(false);
  };

  const agentStatusLabel = agentConfigured === false
    ? "Local mode"
    : agentConfigured === true
      ? "Model ready"
      : "Workspace connected";
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
                  <p>Checking the work assigned to your account.</p>
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
                  <p>No actions currently need your attention.</p>
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
                            <span className={styles.priorityBadge}>{NOTIFICATION_PRIORITY_LABELS[notification.priority]}</span>
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
                  <p>{isAdmin ? "Post the first update for the team." : "Team updates will appear here."}</p>
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
            <span className={`${styles.statusBadge} ${agentConfigured === false ? styles.localBadge : ""}`}>
              <i />{agentStatusLabel}
            </span>
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
              <span>The model endpoint is unavailable. E3 Agent is using local workspace queries.</span>
              {onOpenSettings && <button type="button" onClick={onOpenSettings}>Open Settings</button>}
            </div>
          )}

          <div className={styles.agentFeed} ref={agentFeedRef} aria-live="polite">
            {!agentMessages.length && (
              <div className={styles.agentWelcome}>
                <span><Bot size={25} /></span>
                <h3>How can I help?</h3>
                <p>I can search your connected E3 workspaces, summarise records and help answer operational questions.</p>
              </div>
            )}
            {agentMessages.map((message) => (
              <div key={message.id} className={`${styles.agentMessage} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
                <span className={styles.messageAvatar}>{message.role === "assistant" ? <Bot size={15} /> : "You"}</span>
                <div>
                  <strong className={styles.messageAuthor}>{message.role === "assistant" ? "E3 Agent" : "You"}</strong>
                  {message.role === "assistant" ? (
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
                  ) : (
                    <p className={styles.userBubble}>{message.content}</p>
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
            <div className={styles.composer}>
              <textarea
                value={agentInput}
                onChange={(event) => setAgentInput(event.target.value)}
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
              <button type="button" onClick={() => void submitAgentMessage()} disabled={!agentInput.trim() || agentLoading || !agentHistoryHydrated} aria-label="Send question">
                {agentLoading ? <LoaderCircle className={styles.spinning} size={17} /> : <Send size={17} />}
              </button>
            </div>
            <small className={styles.composerHint}>Enter to send · Shift + Enter for a new line</small>
          </div>
        </article>
      </div>
    </section>
  );
}
