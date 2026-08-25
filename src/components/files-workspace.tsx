"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Download,
  Eye,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  HardDrive,
  House,
  LayoutList,
  LoaderCircle,
  MoreHorizontal,
  Move,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErpUser } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import type {
  WorkspaceFileBreadcrumb,
  WorkspaceFileFolderOption,
  WorkspaceFileItem,
  WorkspaceFilesListing,
  WorkspaceFilesUsage,
  WorkspaceFilesView,
} from "@/lib/workspace-files/types";
import styles from "./files-workspace.module.css";

const ROOT_PARENT = "root";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_ACCEPT = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".txt",
  ".md",
  ".log",
  ".csv",
  ".docx",
  ".xlsx",
  ".pptx",
].join(",");
const PREVIEW_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type SortKey = "name" | "updated" | "size";
type LayoutMode = "list" | "grid";
type UploadState = "queued" | "uploading" | "complete" | "failed";

type FolderDestination = WorkspaceFileFolderOption;
type UsageSummary = WorkspaceFilesUsage;
type FilesListingPayload = WorkspaceFilesListing;

type FilesResponse = {
  data?: FilesListingPayload;
  error?: string;
  code?: string;
};

type ItemResponse = {
  data?: { item?: WorkspaceFileItem } | WorkspaceFileItem;
  error?: string;
  code?: string;
};

type UploadTask = {
  id: string;
  file: File;
  state: UploadState;
  error: string;
};

type EditorDialog =
  | { type: "create" }
  | { type: "rename"; item: WorkspaceFileItem }
  | { type: "move"; item: WorkspaceFileItem }
  | { type: "trash"; item: WorkspaceFileItem }
  | { type: "purge"; item: WorkspaceFileItem };

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const message = (value as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function unwrapItem(value: ItemResponse): WorkspaceFileItem | null {
  if (!value.data || typeof value.data !== "object") return null;
  if ("item" in value.data) return value.data.item || null;
  return value.data as WorkspaceFileItem;
}

function formatBytes(value: number | null | undefined) {
  if (!value || value < 1) return value === 0 ? "0 B" : "—";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function itemIcon(item: WorkspaceFileItem): LucideIcon {
  if (item.kind === "folder") return Folder;
  if (item.contentType?.startsWith("image/")) return FileImage;
  if (item.contentType === "text/csv" || item.contentType?.includes("spreadsheet")) return FileSpreadsheet;
  if (item.contentType === "application/pdf" || item.contentType?.startsWith("text/")) return FileText;
  return FileIcon;
}

function itemTone(item: WorkspaceFileItem) {
  if (item.kind === "folder") return styles.folderTone;
  if (item.contentType?.startsWith("image/")) return styles.imageTone;
  if (item.contentType === "text/csv" || item.contentType?.includes("spreadsheet")) return styles.sheetTone;
  if (item.contentType === "application/pdf") return styles.pdfTone;
  return styles.fileTone;
}

function canPreview(item: WorkspaceFileItem) {
  return item.kind === "file" && Boolean(item.contentType && PREVIEW_TYPES.has(item.contentType));
}

function contentUrl(item: WorkspaceFileItem, mode: "preview" | "download") {
  return `/api/files/items/${encodeURIComponent(item.id)}/content?mode=${mode}`;
}

function uploadTaskId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function usageFrom(payload: FilesListingPayload): UsageSummary | null {
  const usage = payload.usage;
  if (!usage || ![
    usage.usedBytes,
    usage.workspaceLimitBytes,
    usage.ownerUsedBytes,
    usage.ownerLimitBytes,
  ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  return usage;
}

export function FilesWorkspace({ currentUser }: { currentUser: ErpUser }) {
  const [view, setView] = useState<WorkspaceFilesView>("active");
  const [parentId, setParentId] = useState(ROOT_PARENT);
  const [items, setItems] = useState<WorkspaceFileItem[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<WorkspaceFileBreadcrumb[]>([]);
  const [folderDestinations, setFolderDestinations] = useState<FolderDestination[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [layout, setLayout] = useState<LayoutMode>("list");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyItemId, setBusyItemId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [menuItemId, setMenuItemId] = useState("");
  const [dialog, setDialog] = useState<EditorDialog | null>(null);
  const [editorName, setEditorName] = useState("");
  const [moveParentId, setMoveParentId] = useState(ROOT_PARENT);
  const [previewItem, setPreviewItem] = useState<WorkspaceFileItem | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const requestIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = Boolean(busyItemId) || uploading;
  }, [busyItemId, uploading]);

  useEffect(() => {
    if (view === "trash") {
      setAppliedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setAppliedQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query, view]);

  const loadFiles = useCallback(async (quiet = false) => {
    const requestId = ++requestIdRef.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams();
      if (view === "trash") params.set("view", "trash");
      else if (appliedQuery) params.set("query", appliedQuery);
      else if (parentId !== ROOT_PARENT) params.set("parentId", parentId);
      const queryString = params.toString();
      const response = await fetch(`/api/files${queryString ? `?${queryString}` : ""}`, { cache: "no-store" });
      const body = await readJsonResponse<FilesResponse>(response);
      if (!response.ok || !body.data || !Array.isArray(body.data.items) || !Array.isArray(body.data.breadcrumbs)) {
        throw new Error(apiError(body, "Unable to load workspace files."));
      }
      if (requestId !== requestIdRef.current) return;
      setItems(body.data.items);
      setBreadcrumbs(body.data.breadcrumbs);
      setUsage(usageFrom(body.data));
      setFolderDestinations(Array.isArray(body.data.folders) ? body.data.folders : []);
      setError("");
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load workspace files.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [appliedQuery, parentId, view]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!menuItemId) return;
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('button[role="menuitem"], a[role="menuitem"]')?.focus();
    });
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTriggerRef.current?.contains(event.target as Node)) {
        setMenuItemId("");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuItemId("");
      window.requestAnimationFrame(() => menuTriggerRef.current?.focus());
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuItemId]);

  const modalOpen = Boolean(dialog || previewItem);
  useEffect(() => {
    if (!modalOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = modalRef.current?.querySelector<HTMLElement>("[autofocus]");
      const fallback = modalRef.current?.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], iframe",
      );
      (preferred || fallback || modalRef.current)?.focus();
    });
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        setDialog(null);
        setPreviewItem(null);
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], iframe",
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        modalRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!modalRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeys);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleKeys);
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [modalOpen]);

  const sortedItems = useMemo(() => {
    const copy = [...items];
    copy.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      if (sortKey === "updated") return right.updatedAt.localeCompare(left.updatedAt);
      if (sortKey === "size") return (right.size ?? -1) - (left.size ?? -1) || left.name.localeCompare(right.name, "en-AU", { numeric: true });
      return left.name.localeCompare(right.name, "en-AU", { numeric: true, sensitivity: "base" });
    });
    return copy;
  }, [items, sortKey]);

  const currentFolderName = breadcrumbs.at(-1)?.name || "All files";
  const currentParentId = parentId === ROOT_PARENT ? null : parentId;
  const uploadingCount = uploadTasks.filter((task) => task.state === "queued" || task.state === "uploading").length;
  const failedCount = uploadTasks.filter((task) => task.state === "failed").length;

  const switchView = (nextView: WorkspaceFilesView) => {
    if (nextView === view) return;
    setView(nextView);
    setParentId(ROOT_PARENT);
    setQuery("");
    setAppliedQuery("");
    setMenuItemId("");
    setNotice("");
  };

  const navigateFolder = (id: string) => {
    if (view !== "active") return;
    setParentId(id);
    setQuery("");
    setAppliedQuery("");
    setMenuItemId("");
  };

  const openDialog = (nextDialog: EditorDialog, trigger?: HTMLElement | null) => {
    returnFocusRef.current = trigger || menuTriggerRef.current;
    setMenuItemId("");
    setDialog(nextDialog);
    setEditorName(nextDialog.type === "rename" ? nextDialog.item.name : "");
    setMoveParentId(nextDialog.type === "move" ? nextDialog.item.parentId || ROOT_PARENT : ROOT_PARENT);
    setError("");
  };

  const openPreview = (item: WorkspaceFileItem, trigger?: HTMLElement | null) => {
    returnFocusRef.current = trigger || menuTriggerRef.current;
    setMenuItemId("");
    setPreviewFailed(false);
    setPreviewItem(item);
  };

  const closeModal = () => {
    if (busyRef.current) return;
    setDialog(null);
    setPreviewItem(null);
  };

  const createFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = editorName.trim();
    if (!name) return;
    setBusyItemId("create");
    setError("");
    try {
      const response = await fetch("/api/files/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId: currentParentId }),
      });
      const body = await readJsonResponse<ItemResponse>(response);
      if (!response.ok || !unwrapItem(body)) throw new Error(apiError(body, "Unable to create the folder."));
      setDialog(null);
      setNotice(`Folder “${name}” created.`);
      await loadFiles(true);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create the folder.");
    } finally {
      setBusyItemId("");
    }
  };

  const patchItem = async (
    item: WorkspaceFileItem,
    payload: Record<string, unknown>,
    successMessage: string,
  ) => {
    setBusyItemId(item.id);
    setError("");
    try {
      const response = await fetch(`/api/files/items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, expectedVersion: item.version }),
      });
      const body = await readJsonResponse<ItemResponse>(response);
      if (!response.ok || !unwrapItem(body)) throw new Error(apiError(body, "Unable to update this item."));
      setDialog(null);
      setNotice(successMessage);
      await loadFiles(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Unable to update this item.");
    } finally {
      setBusyItemId("");
    }
  };

  const purgeItem = async (item: WorkspaceFileItem) => {
    setBusyItemId(item.id);
    setError("");
    try {
      const response = await fetch(`/api/files/items/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: item.version }),
      });
      const body = await readJsonResponse<{ data?: { id?: string }; error?: string; code?: string }>(response);
      if (!response.ok) throw new Error(apiError(body, "Unable to permanently delete this item."));
      setDialog(null);
      setNotice(`“${item.name}” was permanently deleted.`);
      await loadFiles(true);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to permanently delete this item.");
    } finally {
      setBusyItemId("");
    }
  };

  const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog) return;
    if (dialog.type === "create") {
      await createFolder(event);
      return;
    }
    if (dialog.type === "rename") {
      const name = editorName.trim();
      if (!name) return;
      await patchItem(dialog.item, { action: "rename", name }, `Renamed to “${name}”.`);
      return;
    }
    if (dialog.type === "move") {
      const nextParentId = moveParentId === ROOT_PARENT ? null : moveParentId;
      await patchItem(dialog.item, { action: "move", parentId: nextParentId }, `“${dialog.item.name}” was moved.`);
      return;
    }
    if (dialog.type === "trash") {
      await patchItem(dialog.item, { action: "trash" }, `“${dialog.item.name}” moved to Trash.`);
      return;
    }
    await purgeItem(dialog.item);
  };

  const restoreItem = async (item: WorkspaceFileItem) => {
    returnFocusRef.current = menuTriggerRef.current;
    setMenuItemId("");
    await patchItem(item, { action: "restore" }, `“${item.name}” restored.`);
  };

  const uploadFiles = async (selectedFiles: File[]) => {
    if (uploading || view !== "active" || !selectedFiles.length) return;
    const tasks: UploadTask[] = selectedFiles.map((file) => ({
      id: uploadTaskId(),
      file,
      state: file.size > MAX_FILE_BYTES ? "failed" : "queued",
      error: file.size > MAX_FILE_BYTES ? "File exceeds the 20 MB limit." : "",
    }));
    const queued = tasks.filter((task) => task.state === "queued");
    setUploadTasks(tasks);
    setUploading(Boolean(queued.length));
    setError("");
    let completed = 0;
    for (const task of queued) {
      setUploadTasks((current) => current.map((entry) => entry.id === task.id ? { ...entry, state: "uploading" } : entry));
      try {
        const form = new FormData();
        form.set("file", task.file);
        if (currentParentId) form.set("parentId", currentParentId);
        const response = await fetch("/api/files/upload", { method: "POST", body: form });
        const body = await readJsonResponse<ItemResponse>(response);
        if (!response.ok || !unwrapItem(body)) throw new Error(apiError(body, "Upload failed."));
        completed += 1;
        setUploadTasks((current) => current.map((entry) => entry.id === task.id ? { ...entry, state: "complete", error: "" } : entry));
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : "Upload failed.";
        setUploadTasks((current) => current.map((entry) => entry.id === task.id ? { ...entry, state: "failed", error: message } : entry));
      }
    }
    setUploading(false);
    if (completed) {
      setNotice(`${completed} ${completed === 1 ? "file" : "files"} uploaded to ${currentFolderName}.`);
      await loadFiles(true);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const retryUpload = (task: UploadTask) => {
    if (uploading) return;
    void uploadFiles([task.file]);
  };

  const hasDraggedFiles = (event: ReactDragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (view !== "active" || !hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (view !== "active" || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDragActive(false);
  };
  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (view !== "active" || !hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const handleMenuKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button[role="menuitem"]:not([disabled]), a[role="menuitem"]')];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + buttons.length) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const renderItemMenu = (item: WorkspaceFileItem) => {
    if (menuItemId !== item.id) return null;
    return (
      <div
        ref={menuRef}
        id={`file-actions-${item.id}`}
        className={styles.actionMenu}
        role="menu"
        aria-label={`Actions for ${item.name}`}
        onKeyDown={handleMenuKeys}
      >
        {item.kind === "file" && canPreview(item) ? <button role="menuitem" type="button" onClick={() => openPreview(item)}><Eye size={15} />Preview</button> : null}
        {item.kind === "file" ? <a role="menuitem" href={contentUrl(item, "download")} onClick={() => setMenuItemId("")}><Download size={15} />Download</a> : null}
        {view === "active" && item.capabilities.rename ? <button role="menuitem" type="button" onClick={() => openDialog({ type: "rename", item })}><Pencil size={15} />Rename</button> : null}
        {view === "active" && item.capabilities.move ? <button role="menuitem" type="button" onClick={() => openDialog({ type: "move", item })}><Move size={15} />Move</button> : null}
        {view === "active" && item.capabilities.trash ? <button role="menuitem" type="button" className={styles.menuDanger} onClick={() => openDialog({ type: "trash", item })}><Trash2 size={15} />Move to Trash</button> : null}
        {view === "trash" && item.capabilities.restore ? <button role="menuitem" type="button" onClick={() => void restoreItem(item)}><RotateCcw size={15} />Restore</button> : null}
        {view === "trash" && item.capabilities.purge ? <button role="menuitem" type="button" className={styles.menuDanger} onClick={() => openDialog({ type: "purge", item })}><Trash2 size={15} />Delete forever</button> : null}
      </div>
    );
  };

  const renderActionButton = (item: WorkspaceFileItem) => (
    <div className={styles.actionWrap}>
      <button
        ref={menuItemId === item.id ? menuTriggerRef : undefined}
        type="button"
        className={styles.moreButton}
        aria-label={`Actions for ${item.name}`}
        aria-haspopup="menu"
        aria-expanded={menuItemId === item.id}
        aria-controls={menuItemId === item.id ? `file-actions-${item.id}` : undefined}
        disabled={busyItemId === item.id}
        onClick={(event) => {
          menuTriggerRef.current = event.currentTarget;
          setMenuItemId((current) => current === item.id ? "" : item.id);
        }}
      >
        {busyItemId === item.id ? <LoaderCircle className={styles.spinning} size={17} /> : <MoreHorizontal size={18} />}
      </button>
      {renderItemMenu(item)}
    </div>
  );

  const renderPrimaryItemButton = (item: WorkspaceFileItem, className: string) => {
    const Icon = itemIcon(item);
    if (view === "trash") {
      return (
        <div className={className}>
          <span className={`${styles.itemIcon} ${itemTone(item)}`}><Icon size={20} /></span>
          <span className={styles.itemName}><strong>{item.name}</strong><small>{item.kind === "folder" ? "Folder in Trash" : "File in Trash"}</small></span>
        </div>
      );
    }
    const opens = item.kind === "folder" ? "folder" : canPreview(item) ? "preview" : "download";
    if (opens === "download") {
      return (
        <a className={className} href={contentUrl(item, "download")} aria-label={`Download ${item.name}`}>
          <span className={`${styles.itemIcon} ${itemTone(item)}`}><Icon size={20} /></span>
          <span className={styles.itemName}><strong>{item.name}</strong><small>{item.kind === "folder" ? "Folder" : item.contentType || "File"}</small></span>
        </a>
      );
    }
    return (
      <button
        type="button"
        className={className}
        aria-label={`${opens === "folder" ? "Open folder" : "Preview"} ${item.name}`}
        onClick={(event) => opens === "folder" ? navigateFolder(item.id) : openPreview(item, event.currentTarget)}
      >
        <span className={`${styles.itemIcon} ${itemTone(item)}`}><Icon size={20} /></span>
        <span className={styles.itemName}><strong>{item.name}</strong><small>{item.kind === "folder" ? "Folder" : item.contentType || "File"}</small></span>
      </button>
    );
  };

  const excludedMoveFolders = new Set<string>();
  if (dialog?.type === "move" && dialog.item.kind === "folder") {
    excludedMoveFolders.add(dialog.item.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folderDestinations) {
        if (folder.parentId && excludedMoveFolders.has(folder.parentId) && !excludedMoveFolders.has(folder.id)) {
          excludedMoveFolders.add(folder.id);
          changed = true;
        }
      }
    }
  }
  const moveOptions = folderDestinations
    .filter((folder) => !excludedMoveFolders.has(folder.id))
    .sort((left, right) => left.path.localeCompare(right.path, "en-AU", { numeric: true, sensitivity: "base" }));
  const moveTargetUnchanged = dialog?.type === "move"
    && (moveParentId === ROOT_PARENT ? null : moveParentId) === dialog.item.parentId;

  return (
    <section
      className={`${styles.workspace} ${dragActive ? styles.dragging : ""}`}
      aria-labelledby="files-workspace-title"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>DOCUMENTS · SHARED WORKSPACE</span>
          <h1 id="files-workspace-title">Files</h1>
          <p>Create folders, upload working documents and keep the team&apos;s files in one place.</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.secondaryButton} disabled={view !== "active"} onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}><FolderPlus size={17} />New folder</button>
          <button type="button" className={styles.primaryButton} disabled={view !== "active" || uploading} onClick={() => fileInputRef.current?.click()}><UploadCloud size={17} />Upload files</button>
          <input
            ref={fileInputRef}
            className={styles.hiddenInput}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            tabIndex={-1}
            onChange={(event) => void uploadFiles(Array.from(event.target.files || []))}
          />
        </div>
      </header>

      {notice ? <div className={styles.notice} role="status" aria-live="polite"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15} /></button></div> : null}
      {error ? <div className={styles.error} role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div> : null}

      <div className={styles.driveShell}>
        <aside className={styles.viewRail} aria-label="Files views">
          <div className={styles.railActions}>
            <button type="button" className={styles.railNewButton} disabled={view !== "active"} onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}><Plus size={18} />New</button>
          </div>
          <nav>
            <button type="button" className={view === "active" ? styles.activeRailItem : ""} aria-current={view === "active" ? "page" : undefined} onClick={() => switchView("active")}><FolderOpen size={18} /><span>All files</span></button>
            <button type="button" className={view === "trash" ? styles.activeRailItem : ""} aria-current={view === "trash" ? "page" : undefined} onClick={() => switchView("trash")}><Trash2 size={18} /><span>Trash</span></button>
          </nav>
          <div className={styles.storageSummary}>
            <span><HardDrive size={18} /></span>
            <div>
              <strong>Workspace storage</strong>
              {usage ? <small>{formatBytes(usage.usedBytes)} of {formatBytes(usage.workspaceLimitBytes)} used · yours {formatBytes(usage.ownerUsedBytes)}</small> : <small>Shared by E3 ERP users</small>}
            </div>
          </div>
        </aside>

        <section className={styles.contentPanel} aria-label={view === "trash" ? "Trash" : currentFolderName}>
          <div className={styles.toolbar}>
            <label className={`${styles.searchBox} ${view === "trash" ? styles.searchDisabled : ""}`}>
              <Search size={17} />
              <input
                type="search"
                value={query}
                maxLength={120}
                disabled={view === "trash"}
                placeholder={view === "trash" ? "Search is unavailable in Trash" : "Search files and folders"}
                aria-label="Search files and folders"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear file search"><X size={14} /></button> : null}
            </label>
            <div className={styles.toolbarControls}>
              <label className={styles.sortControl}>Sort
                <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} aria-label="Sort files">
                  <option value="name">Name</option>
                  <option value="updated">Last modified</option>
                  <option value="size">Size</option>
                </select>
              </label>
              <div className={styles.layoutToggle} role="group" aria-label="File layout">
                <button type="button" className={layout === "list" ? styles.activeLayout : ""} aria-label="List view" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><LayoutList size={17} /></button>
                <button type="button" className={layout === "grid" ? styles.activeLayout : ""} aria-label="Grid view" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><Grid2X2 size={16} /></button>
              </div>
              <button type="button" className={styles.refreshButton} disabled={refreshing} onClick={() => void loadFiles(true)} aria-label="Refresh files"><RefreshCw className={refreshing ? styles.spinning : ""} size={16} /><span>Refresh</span></button>
            </div>
          </div>

          <div className={styles.locationBar}>
            {view === "active" ? (
              <nav className={styles.breadcrumbs} aria-label="Folder breadcrumb">
                <ol>
                  <li><button type="button" aria-label="All files" aria-current={!breadcrumbs.length ? "page" : undefined} onClick={() => navigateFolder(ROOT_PARENT)}><House size={15} /><span>All files</span></button></li>
                  {breadcrumbs.map((crumb, index) => {
                    const current = index === breadcrumbs.length - 1;
                    return <li key={crumb.id}><ChevronRight size={13} aria-hidden="true" /><button type="button" aria-current={current ? "page" : undefined} disabled={current} onClick={() => navigateFolder(crumb.id)}>{crumb.name}</button></li>;
                  })}
                </ol>
              </nav>
            ) : <div className={styles.trashHeading}><Trash2 size={16} /><strong>Trash</strong><span>Items stay here until an administrator deletes them forever.</span></div>}
            <span className={styles.itemCount}>{sortedItems.length} {sortedItems.length === 1 ? "item" : "items"}</span>
          </div>

          {loading ? (
            <div className={styles.loadingState} role="status"><LoaderCircle className={styles.spinning} size={23} />Loading files…</div>
          ) : !sortedItems.length ? (
            <div className={styles.emptyState}>
              <span>{view === "trash" ? <Trash2 size={27} /> : appliedQuery ? <Search size={27} /> : <FolderOpen size={27} />}</span>
              <h2>{view === "trash" ? "Trash is empty" : appliedQuery ? "No files match your search" : `No files in ${currentFolderName}`}</h2>
              <p>{view === "trash" ? "Files and folders moved to Trash will appear here." : appliedQuery ? "Try a different file or folder name." : "Create a folder or upload the first document to this location."}</p>
              {view === "active" && !appliedQuery ? <div><button type="button" className={styles.secondaryButton} onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}><FolderPlus size={16} />New folder</button><button type="button" className={styles.primaryButton} onClick={() => fileInputRef.current?.click()}><UploadCloud size={16} />Upload files</button></div> : null}
            </div>
          ) : layout === "list" ? (
            <div className={styles.listRegion}>
              <table className={styles.fileTable}>
                <caption className={styles.srOnly}>{view === "trash" ? "Files and folders in Trash" : `Files and folders in ${currentFolderName}`}</caption>
                <thead><tr><th scope="col">Name</th><th scope="col">Owner</th><th scope="col">Modified</th><th scope="col">Size</th><th scope="col"><span className={styles.srOnly}>Actions</span></th></tr></thead>
                <tbody>
                  {sortedItems.map((item) => (
                    <tr key={item.id}>
                      <td>{renderPrimaryItemButton(item, styles.nameButton)}</td>
                      <td className={styles.ownerCell}><span className={item.ownerUsername === currentUser.username ? styles.youAvatar : ""}>{item.ownerDisplayName.slice(0, 1).toLocaleUpperCase("en-AU")}</span><div><strong>{item.ownerDisplayName}</strong><small>{item.ownerUsername === currentUser.username ? "You" : `@${item.ownerUsername}`}</small></div></td>
                      <td className={styles.modifiedCell}><span>{formatDate(item.updatedAt)}</span><small>by {item.updatedBy}</small></td>
                      <td className={styles.sizeCell}>{item.kind === "folder" ? "—" : formatBytes(item.size)}</td>
                      <td className={styles.actionsCell}>{renderActionButton(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.fileGrid}>
              {sortedItems.map((item) => {
                return (
                  <article className={styles.fileCard} key={item.id}>
                    <div className={styles.cardTop}><span>{item.kind === "folder" ? "Folder" : "File"}</span>{renderActionButton(item)}</div>
                    {renderPrimaryItemButton(item, styles.cardPrimary)}
                    <div className={styles.cardMeta}><span>{item.ownerUsername === currentUser.username ? "You" : item.ownerDisplayName}</span><span>{formatDate(item.updatedAt)}</span><span>{item.kind === "folder" ? "Folder" : formatBytes(item.size)}</span></div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {dragActive ? <div className={styles.dropOverlay} aria-hidden="true"><span><UploadCloud size={32} /></span><strong>Drop files in {currentFolderName}</strong><small>PDF, images, text and Microsoft Office files · 20 MB each</small></div> : null}

      {uploadTasks.length ? (
        <aside className={styles.uploadQueue} aria-label="File uploads" aria-live="polite">
          <header><div><strong>{uploadingCount ? `Uploading ${uploadingCount} ${uploadingCount === 1 ? "file" : "files"}` : failedCount ? `${failedCount} upload ${failedCount === 1 ? "needs" : "need"} attention` : "Uploads complete"}</strong><small>Files upload one at a time</small></div><button type="button" disabled={uploading} onClick={() => setUploadTasks([])} aria-label="Close upload status"><X size={17} /></button></header>
          <div className={styles.uploadList}>
            {uploadTasks.map((task) => (
              <div className={styles.uploadRow} key={task.id}>
                <span className={task.state === "failed" ? styles.uploadFailed : task.state === "complete" ? styles.uploadComplete : ""}>{task.state === "uploading" ? <LoaderCircle className={styles.spinning} size={16} /> : task.state === "complete" ? <CheckCircle2 size={16} /> : task.state === "failed" ? <AlertCircle size={16} /> : <FileIcon size={16} />}</span>
                <div><strong>{task.file.name}</strong><small>{task.error || `${formatBytes(task.file.size)} · ${task.state === "queued" ? "Waiting" : task.state === "uploading" ? "Uploading" : "Uploaded"}`}</small>{task.state === "uploading" ? <i /> : null}</div>
                {task.state === "failed" && task.file.size <= MAX_FILE_BYTES ? <button type="button" disabled={uploading} onClick={() => retryUpload(task)}>Retry</button> : null}
              </div>
            ))}
          </div>
        </aside>
      ) : null}

      {dialog ? (
        <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <div ref={modalRef} className={`${styles.dialog} ${(dialog.type === "trash" || dialog.type === "purge") ? styles.confirmDialog : ""}`} role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" aria-describedby={(dialog.type === "trash" || dialog.type === "purge") ? "files-dialog-description" : undefined}>
            <header>
              <div className={`${styles.dialogIcon} ${dialog.type === "purge" ? styles.dangerDialogIcon : ""}`}>{dialog.type === "create" ? <FolderPlus size={20} /> : dialog.type === "rename" ? <Pencil size={20} /> : dialog.type === "move" ? <Move size={20} /> : <Trash2 size={20} />}</div>
              <div><span>FILES</span><h2 id="files-dialog-title">{dialog.type === "create" ? "New folder" : dialog.type === "rename" ? "Rename item" : dialog.type === "move" ? "Move item" : dialog.type === "trash" ? "Move to Trash?" : "Delete forever?"}</h2></div>
              <button type="button" aria-label="Close" disabled={Boolean(busyItemId)} onClick={closeModal}><X size={19} /></button>
            </header>
            {error ? <div className={styles.dialogError} role="alert"><AlertCircle size={16} />{error}</div> : null}
            <form onSubmit={(event) => void submitDialog(event)}>
              {dialog.type === "create" || dialog.type === "rename" ? (
                <label>{dialog.type === "create" ? "Folder name" : "New name"}<input autoFocus required maxLength={180} value={editorName} onChange={(event) => setEditorName(event.target.value)} placeholder={dialog.type === "create" ? "e.g. Project documents" : undefined} /></label>
              ) : dialog.type === "move" ? (
                <label>Move “{dialog.item.name}” to<select autoFocus value={moveParentId} onChange={(event) => setMoveParentId(event.target.value)}><option value={ROOT_PARENT}>All files{dialog.item.parentId === null ? " (current)" : ""}</option>{moveOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.path || folder.name}{folder.id === dialog.item.parentId ? " (current)" : ""}</option>)}</select><small className={styles.fieldHint}>Choose a different destination. A folder cannot be moved inside itself.</small></label>
              ) : (
                <div className={styles.confirmCopy}>
                  <p id="files-dialog-description">{dialog.type === "trash" ? <>“{dialog.item.name}” will leave its current folder and move to Trash. It can be restored later.</> : <>“{dialog.item.name}” and its contents will be permanently removed. This cannot be undone.</>}</p>
                </div>
              )}
              <footer><button type="button" className={styles.secondaryButton} disabled={Boolean(busyItemId)} onClick={closeModal}>Cancel</button><button type="submit" className={dialog.type === "purge" ? styles.dangerButton : styles.primaryButton} disabled={Boolean(busyItemId) || ((dialog.type === "create" || dialog.type === "rename") && !editorName.trim()) || Boolean(moveTargetUnchanged)}>{busyItemId ? <LoaderCircle className={styles.spinning} size={16} /> : null}{dialog.type === "create" ? "Create folder" : dialog.type === "rename" ? "Save name" : dialog.type === "move" ? "Move item" : dialog.type === "trash" ? "Move to Trash" : "Delete forever"}</button></footer>
            </form>
          </div>
        </div>
      ) : null}

      {previewItem ? (
        <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <div ref={modalRef} className={styles.previewDialog} role="dialog" aria-modal="true" aria-labelledby="file-preview-title">
            <header><div><span>FILE PREVIEW</span><h2 id="file-preview-title">{previewItem.name}</h2><small>{formatBytes(previewItem.size)} · Updated {formatDate(previewItem.updatedAt)}</small></div><div><a href={contentUrl(previewItem, "download")} className={styles.secondaryButton}><Download size={16} />Download</a><button type="button" aria-label="Close preview" onClick={closeModal}><X size={20} /></button></div></header>
            <div className={styles.previewBody}>
              {previewFailed || !canPreview(previewItem) ? <div className={styles.previewFallback}><span><FileIcon size={32} /></span><h3>Preview unavailable</h3><p>Download this file to open it in the appropriate application.</p><a href={contentUrl(previewItem, "download")} className={styles.primaryButton}><Download size={16} />Download file</a></div> : previewItem.contentType === "application/pdf" ? <iframe src={contentUrl(previewItem, "preview")} title={`Preview of ${previewItem.name}`} onError={() => setPreviewFailed(true)} /> : <img src={contentUrl(previewItem, "preview")} alt={previewItem.name} onError={() => setPreviewFailed(true)} />}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
