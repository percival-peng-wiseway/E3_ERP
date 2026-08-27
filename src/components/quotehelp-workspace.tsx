"use client";

import {
  BookOpenCheck,
  Building2,
  Calculator,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  CopyPlus,
  Database,
  Download,
  FileClock,
  FileText,
  History,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  PackagePlus,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { calculateQuote, requiredCustomerBalanceForMargin } from "@/lib/quotehelp/calculate";
import { defaultQuote, defaultSettings, normalizeSettings } from "@/lib/quotehelp/defaults";
import type {
  AppSettings,
  BatteryItem,
  CatalogItem,
  CiBatterySelection,
  CiInverterSelection,
  CiPvSystem,
  EquipmentSelection,
  QuoteInputs,
  QuoteRecord,
  QuoteStatus,
  Role,
  SystemNotification,
  Viewer,
} from "@/lib/quotehelp/model";
import {
  getEquipmentCatalogs,
  normalizeQuoteConfiguration,
  setEquipmentBrand as applyEquipmentBrand,
  setQuoteMode,
  syncCiLegacyFields,
  updatePvSize,
} from "@/lib/quotehelp/quote-inputs";
import { extractImportedQuotePayloads } from "@/lib/quotehelp/quote-transfer";
import styles from "./quotehelp-workspace.module.css";

type UserRow = {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
};

type SessionData = {
  viewer: Viewer;
  settings: AppSettings;
  quotes: QuoteRecord[];
  users: UserRow[];
  notifications: SystemNotification[];
};

type WorkspaceTab = "calculator" | "history" | "settings" | "users";
type ApiObject = Record<string, unknown>;

const money = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
});

const shortMoney = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const percentageRate = (value: number) => Math.round((value / 100) * 1_000_000) / 1_000_000;
const SIG_BATTERY_STC_REFERENCE = [
  [{ kwh: 16, stc: 101 }, { kwh: 24, stc: 133 }, { kwh: 32, stc: 155 }, { kwh: 40, stc: 163 }, { kwh: 48, stc: 171 }],
  [{ kwh: 20, stc: 119 }, { kwh: 30, stc: 154 }, { kwh: 40, stc: 164 }, { kwh: 50, stc: 174 }],
] as const;
const safeNumber = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const quantity = (value: number) => Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function createdDateKey(value: string) {
  return value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
}

function formatDate(value: string) {
  const key = createdDateKey(value);
  if (!key) return "—";
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { year: "numeric", month: "short", day: "numeric" })
    .format(new Date(year, month - 1, day));
}

function formatTimestamp(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function safeExportName(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "quote";
}

function unwrap<T>(value: unknown): T {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as ApiObject).error;
  if (typeof error === "string") return /[\u3400-\u9fff]/u.test(error) ? fallback : error;
  if (error && typeof error === "object" && typeof (error as ApiObject).message === "string") {
    const message = String((error as ApiObject).message);
    return /[\u3400-\u9fff]/u.test(message) ? fallback : message;
  }
  if (typeof (value as ApiObject).message !== "string") return fallback;
  const message = String((value as ApiObject).message);
  return /[\u3400-\u9fff]/u.test(message) ? fallback : message;
}

function cloneQuoteBase(): QuoteInputs {
  return {
    ...defaultQuote,
    date: today(),
    manualCosts: { ...defaultQuote.manualCosts },
    manualMargins: { ...(defaultQuote.manualMargins ?? {}) },
    customItems: (defaultQuote.customItems ?? []).map((item) => ({ ...item })),
  };
}

function hydrateQuote(payload: QuoteInputs, settings: AppSettings): QuoteInputs {
  return normalizeQuoteConfiguration({
    ...cloneQuoteBase(),
    ...payload,
    discount: Math.abs(payload.discount ?? 0),
    manualCosts: { ...defaultQuote.manualCosts, ...(payload.manualCosts ?? {}) },
    manualMargins: { ...(payload.manualMargins ?? {}) },
    customItems: (payload.customItems ?? []).map((item) => ({ ...item })),
  }, settings);
}

async function responseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const TAB_ITEMS: Array<{ id: WorkspaceTab; label: string; icon: LucideIcon; admin?: boolean }> = [
  { id: "calculator", label: "Quote Builder", icon: Calculator },
  { id: "history", label: "Team Quotes", icon: History },
  { id: "settings", label: "Pricing Settings", icon: Database, admin: true },
  { id: "users", label: "User Access", icon: Users, admin: true },
];

export function QuoteHelpWorkspace() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(() => structuredClone(defaultSettings));
  const [inputs, setInputs] = useState<QuoteInputs>(() => cloneQuoteBase());
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("calculator");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [quoteSearch, setQuoteSearch] = useState("");
  const [quoteInitiator, setQuoteInitiator] = useState("");
  const [quoteStatus, setQuoteStatus] = useState<QuoteStatus | "">("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [marginTarget, setMarginTarget] = useState(17.5);
  const [transferBusy, setTransferBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);

  const flash = (text: string) => {
    setMessage(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setMessage(""), 3200);
  };

  const applySession = (raw: SessionData) => {
    const normalizedSettings = normalizeSettings(raw.settings ?? defaultSettings);
    const normalized: SessionData = {
      viewer: raw.viewer,
      settings: normalizedSettings,
      quotes: Array.isArray(raw.quotes)
        ? raw.quotes.map((quote) => ({ ...quote, payload: hydrateQuote(quote.payload, normalizedSettings) }))
        : [],
      users: Array.isArray(raw.users) ? raw.users : [],
      notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
    };
    setSession(normalized);
    setSettingsDraft(structuredClone(normalizedSettings));
    setLoginRequired(false);
    setLoadError("");
  };

  const loadSession = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/quotehelp/session", { cache: "no-store", credentials: "include" });
      if (response.status === 401) {
        setSession(null);
        setLoginRequired(true);
        return;
      }
      const payload = await responseJson(response);
      if (!response.ok || !payload) throw new Error(apiError(payload, "Unable to load QuoteHelp data"));
      applySession(unwrap<SessionData>(payload));
    } catch (error) {
      setSession(null);
      setLoadError(error instanceof Error ? error.message : "Unable to load QuoteHelp data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSession();
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
    // The bootstrap request intentionally runs once when the module mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settings = session?.settings ?? defaultSettings;
  const result = useMemo(() => calculateQuote(inputs, settings), [inputs, settings]);
  const role = session?.viewer.role ?? "user";
  const isAdmin = role === "admin";
  const isCi = inputs.mode === "ci";
  const brand = inputs.equipmentBrand === "sig" ? "sig" : "fox";
  const catalogs = getEquipmentCatalogs(settings, brand, isCi ? "ci" : "residential");
  const stcEditable = isCi || brand === "sig";

  const initiators = useMemo(() => Array.from(new Set((session?.quotes ?? [])
    .map((quote) => quote.payload.initiator?.trim())
    .filter((value): value is string => Boolean(value))))
    .sort((a, b) => a.localeCompare(b, "en-AU", { sensitivity: "base" })), [session?.quotes]);

  const filteredQuotes = useMemo(() => {
    const query = quoteSearch.trim().toLocaleLowerCase("en-AU");
    return (session?.quotes ?? []).filter((quote) => {
      const matchesSearch = !query || [
        quote.projectName,
        quote.payload.customerName,
        quote.payload.address,
        quote.payload.phone,
        quote.payload.initiator,
        quote.ownerName,
      ].some((value) => String(value ?? "").toLocaleLowerCase("en-AU").includes(query));
      const initiator = quote.payload.initiator?.trim() ?? "";
      const date = createdDateKey(quote.createdAt);
      return matchesSearch
        && (!quoteInitiator || (quoteInitiator === "__none__" ? !initiator : initiator === quoteInitiator))
        && (!quoteStatus || quote.status === quoteStatus)
        && (!createdFrom || Boolean(date && date >= createdFrom))
        && (!createdTo || Boolean(date && date <= createdTo));
    });
  }, [createdFrom, createdTo, quoteInitiator, quoteSearch, quoteStatus, session?.quotes]);

  const setField = <K extends keyof QuoteInputs>(key: K, value: QuoteInputs[K]) => {
    setInputs((current) => ({ ...current, [key]: value }));
  };

  const setManualCost = (key: keyof QuoteInputs["manualCosts"], value: number) => {
    setInputs((current) => ({
      ...current,
      manualCosts: { ...current.manualCosts, [key]: Math.max(0, value) },
    }));
  };

  const setManualMargin = (key: string, value: number) => {
    setInputs((current) => ({
      ...current,
      manualMargins: { ...(current.manualMargins ?? {}), [key]: Math.max(0, value) },
    }));
  };

  const updateCiPv = (id: string, patch: Partial<CiPvSystem>) => {
    setInputs((current) => {
      const manualCosts = { ...current.manualCosts };
      delete manualCosts.accessories;
      delete manualCosts.solarInstallation;
      return syncCiLegacyFields({
        ...current,
        manualCosts,
        ciPvSystems: (current.ciPvSystems ?? []).map((item) => item.id === id
          ? { ...item, ...patch, sizeKw: Math.max(0, patch.sizeKw ?? item.sizeKw), quantity: quantity(patch.quantity ?? item.quantity) }
          : item),
      }, settings);
    });
  };

  const updateCiInverter = (id: string, patch: Partial<CiInverterSelection>) => {
    setInputs((current) => syncCiLegacyFields({
      ...current,
      ciInverters: (current.ciInverters ?? []).map((item) => item.id === id
        ? { ...item, ...patch, quantity: quantity(patch.quantity ?? item.quantity) }
        : item),
    }, settings));
  };

  const updateCiBattery = (id: string, patch: Partial<CiBatterySelection>) => {
    setInputs((current) => {
      const manualCosts = { ...current.manualCosts };
      delete manualCosts.batteryInstallation;
      return syncCiLegacyFields({
        ...current,
        manualCosts,
        ciBatteries: (current.ciBatteries ?? []).map((item) => item.id === id
          ? { ...item, ...patch, kwh: Math.max(0, patch.kwh ?? item.kwh), quantity: quantity(patch.quantity ?? item.quantity) }
          : item),
      }, settings);
    });
  };

  const addCiPv = () => setInputs((current) => {
    const manualCosts = { ...current.manualCosts };
    delete manualCosts.accessories;
    delete manualCosts.solarInstallation;
    return syncCiLegacyFields({
      ...current,
      manualCosts,
      ciPvSystems: [...(current.ciPvSystems ?? []), { id: crypto.randomUUID(), sizeKw: 0, quantity: 1 }],
    }, settings);
  });

  const addCiInverter = () => setInputs((current) => syncCiLegacyFields({
    ...current,
    ciInverters: [...(current.ciInverters ?? []), {
      id: crypto.randomUUID(),
      model: catalogs.inverters[0]?.name ?? "",
      quantity: 1,
    }],
  }, settings));

  const addCiBattery = () => setInputs((current) => {
    const manualCosts = { ...current.manualCosts };
    delete manualCosts.batteryInstallation;
    return syncCiLegacyFields({
      ...current,
      manualCosts,
      ciBatteries: [...(current.ciBatteries ?? []), {
        id: crypto.randomUUID(),
        kwh: catalogs.batteries[0]?.kwh ?? 0,
        quantity: 1,
      }],
    }, settings);
  });

  const removeCi = (key: "ciPvSystems" | "ciInverters" | "ciBatteries", id: string) => {
    setInputs((current) => {
      const items = current[key] ?? [];
      if (items.length <= 1) return current;
      const manualCosts = { ...current.manualCosts };
      if (key === "ciPvSystems") {
        delete manualCosts.accessories;
        delete manualCosts.solarInstallation;
      }
      if (key === "ciBatteries") delete manualCosts.batteryInstallation;
      return syncCiLegacyFields({ ...current, manualCosts, [key]: items.filter((item) => item.id !== id) }, settings);
    });
  };

  type SigKey = "sigInverters" | "sigBatteries" | "sigGateways" | "sigAccessories";
  const sigOptions = (key: SigKey, current: QuoteInputs) => {
    const available = getEquipmentCatalogs(settings, "sig", current.mode === "ci" ? "ci" : "residential");
    if (key === "sigInverters") return available.inverters;
    if (key === "sigBatteries") return available.batteries;
    if (key === "sigGateways") return available.gateways;
    return available.accessories;
  };

  const updateSig = (key: SigKey, id: string, patch: Partial<EquipmentSelection>) => {
    setInputs((current) => {
      const manualCosts = { ...current.manualCosts };
      if (key === "sigBatteries") delete manualCosts.batteryInstallation;
      return syncCiLegacyFields({
        ...current,
        manualCosts,
        [key]: (current[key] ?? []).map((item) => item.id === id
          ? { ...item, ...patch, quantity: quantity(patch.quantity ?? item.quantity) }
          : item),
      }, settings);
    });
  };

  const addSig = (key: SigKey) => setInputs((current) => {
    const options = sigOptions(key, current);
    if (!options.length) return current;
    const manualCosts = { ...current.manualCosts };
    if (key === "sigBatteries") delete manualCosts.batteryInstallation;
    return syncCiLegacyFields({
      ...current,
      manualCosts,
      [key]: [...(current[key] ?? []), { id: crypto.randomUUID(), model: options[0].name, quantity: 1 }],
    }, settings);
  });

  const removeSig = (key: SigKey, id: string) => setInputs((current) => {
    const items = current[key] ?? [];
    const required = key === "sigInverters" || key === "sigBatteries";
    if (required && items.length <= 1) return current;
    const manualCosts = { ...current.manualCosts };
    if (key === "sigBatteries") delete manualCosts.batteryInstallation;
    return syncCiLegacyFields({ ...current, manualCosts, [key]: items.filter((item) => item.id !== id) }, settings);
  });

  const addCustomItem = () => setInputs((current) => ({
    ...current,
    customItems: [...(current.customItems ?? []), {
      id: crypto.randomUUID(),
      name: "Custom item",
      cost: 0,
      margin: 0.25,
    }],
  }));

  const updateCustomItem = (id: string, patch: Partial<NonNullable<QuoteInputs["customItems"]>[number]>) => {
    setInputs((current) => ({
      ...current,
      customItems: (current.customItems ?? []).map((item) => item.id === id ? { ...item, ...patch } : item),
    }));
  };

  const resetQuote = () => {
    setInputs(hydrateQuote(cloneQuoteBase(), settings));
    setQuoteId(null);
    setMarginTarget(17.5);
    setTab("calculator");
    flash("Started a new blank quote");
  };

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      const response = await fetch("/api/quotehelp/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(apiError(payload, "Incorrect username or password"));
      setLoginPassword("");
      await loadSession();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Sign-in failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/quotehelp/logout", { method: "POST", credentials: "include" });
      if (!response.ok) {
        const payload = await responseJson(response);
        throw new Error(apiError(payload, "Unable to sign out. Please try again."));
      }
      setSession(null);
      setLoginRequired(true);
      setTab("calculator");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to sign out. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const saveQuote = async (saveAsNew = false) => {
    if (!inputs.customerName.trim()) {
      flash("Enter a customer name before saving");
      document.getElementById("qh-customer-name")?.focus();
      return;
    }
    setBusy(true);
    try {
      const send = async (allowDuplicate = false) => {
        const response = await fetch("/api/quotehelp/quotes", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: saveAsNew ? null : quoteId, payload: inputs, allowDuplicate }),
        });
        return { response, payload: await responseJson(response) };
      };
      let request = await send();
      const body = (request.payload ?? {}) as ApiObject;
      if (request.response.status === 409 && body.duplicate === true) {
        const confirmed = window.confirm(`${apiError(body, "A quote already exists for this customer.")}\n\nSave anyway?`);
        if (!confirmed) return;
        request = await send(true);
      }
      const saved = unwrap<{ id?: string }>(request.payload ?? {});
      if (!request.response.ok || !saved.id) throw new Error(apiError(request.payload, "Unable to save quote"));
      setQuoteId(saved.id);
      await loadSession();
      flash(saveAsNew ? "Saved as a new quote" : "Quote saved");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to save quote");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (id: string, status: QuoteStatus) => {
    setStatusBusyId(id);
    try {
      const response = await fetch("/api/quotehelp/quotes", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(apiError(payload, "Unable to update quote status"));
      setSession((current) => current ? {
        ...current,
        quotes: current.quotes.map((quote) => quote.id === id ? { ...quote, status } : quote),
      } : current);
      flash(status === "done" ? "Quote marked as completed" : "Quote moved back to Drafting");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to update quote status");
    } finally {
      setStatusBusyId("");
    }
  };

  const deleteQuote = async (quote: QuoteRecord) => {
    if (!isAdmin || !window.confirm(`Delete “${quote.projectName}”? This action cannot be undone.`)) return;
    setStatusBusyId(quote.id);
    try {
      const response = await fetch("/api/quotehelp/quotes", {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: quote.id }),
      });
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(apiError(payload, "Unable to delete quote"));
      setSession((current) => current ? {
        ...current,
        quotes: current.quotes.filter((item) => item.id !== quote.id),
      } : current);
      if (quoteId === quote.id) resetQuote();
      flash("Quote deleted");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to delete quote");
    } finally {
      setStatusBusyId("");
    }
  };

  const publishSettings = async () => {
    if (!isAdmin) return;
    setBusy(true);
    try {
      const response = await fetch("/api/quotehelp/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: settingsDraft }),
      });
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(apiError(payload, "Unable to publish pricing settings"));
      await loadSession();
      flash("Pricing settings published");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to publish pricing settings");
    } finally {
      setBusy(false);
    }
  };

  const downloadExcel = async (quotes: QuoteRecord[], filename: string, successMessage: string) => {
    if (!quotes.length) return;
    setTransferBusy(true);
    try {
      const { createQuotesWorkbook } = await import("@/lib/quotehelp/quote-excel");
      const bytes = createQuotesWorkbook(quotes, settings);
      const blob = new Blob([new Uint8Array(bytes)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      flash(successMessage);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to export the Excel file");
    } finally {
      setTransferBusy(false);
    }
  };

  const exportAllExcel = async () => {
    if (!session?.quotes.length) return;
    await downloadExcel(session.quotes, `e3-quotes-${today()}.xlsx`, `Exported ${session.quotes.length} quote${session.quotes.length === 1 ? "" : "s"}`);
  };

  const importExcel = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setTransferBusy(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Import files must be no larger than 20 MB");
      const { parseQuotesWorkbook } = await import("@/lib/quotehelp/quote-excel");
      const payloads = extractImportedQuotePayloads(parseQuotesWorkbook(await file.arrayBuffer()));
      const response = await fetch("/api/quotehelp/quotes/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloads),
      });
      const payload = await responseJson(response);
      const imported = unwrap<{ imported?: number }>(payload ?? {}).imported;
      if (!response.ok || !imported) throw new Error(apiError(payload, "Unable to import quotes"));
      await loadSession();
      flash(`Imported ${imported} quote${imported === 1 ? "" : "s"}`);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to import quotes");
    } finally {
      event.target.value = "";
      setTransferBusy(false);
    }
  };

  const openQuote = (quote: QuoteRecord) => {
    setQuoteId(quote.id);
    setInputs(hydrateQuote(quote.payload, settings));
    setTab("calculator");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clearFilters = () => {
    setQuoteSearch("");
    setQuoteInitiator("");
    setQuoteStatus("");
    setCreatedFrom("");
    setCreatedTo("");
  };

  const updateCatalog = (
    key: "inverters" | "batteries" | "sigResidentialInverters" | "sigResidentialBatteries" | "sigCiInverters" | "sigCiBatteries" | "sigGateways" | "sigAccessories",
    index: number,
    patch: Partial<BatteryItem>,
  ) => {
    setSettingsDraft((current) => {
      const next = structuredClone(current);
      Object.assign(next[key][index], patch);
      return next;
    });
  };

  if (loading) return <LoadingState />;
  if (loginRequired) {
    return (
      <LoginPanel
        username={loginUsername}
        password={loginPassword}
        error={loginError}
        busy={loginBusy}
        onUsername={setLoginUsername}
        onPassword={setLoginPassword}
        onSubmit={signIn}
      />
    );
  }
  if (!session || loadError) return <ErrorState message={loadError || "Unable to load QuoteHelp data"} onRetry={() => void loadSession()} />;

  const statusContent = {
    healthy: { label: "Healthy", detail: `Meets the ${percent(settings.thresholds.target)} target margin`, icon: Check },
    review: { label: "Review required", detail: "Below target, but still within the review range", icon: CircleAlert },
    approval: { label: "Senior approval required", detail: `Below the ${percent(settings.thresholds.approval)} approval threshold`, icon: LockKeyhole },
  }[result.status];
  const StatusIcon = statusContent.icon;
  const latestNotification = session.notifications[0];

  return (
    <section className={styles.workspace} aria-label="QuoteHelp quotation workspace">
      <header className={styles.moduleHeader}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}><Sparkles size={13} /> Sales · QuoteHelp</span>
          <div className={styles.titleRow}>
            <h1>Quotes &amp; Margin</h1>
            <span className={styles.liveBadge}><i /> Live calculation</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.secondaryButton} onClick={resetQuote}>
            <Plus size={16} /> New Quote
          </button>
          {tab === "calculator" && quoteId && (
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void saveQuote(true)}>
              <CopyPlus size={16} /> Save As
            </button>
          )}
          {tab === "calculator" && (
            <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void saveQuote()}>
              {busy ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}
              {busy ? "Saving" : "Save Quote"}
            </button>
          )}
          {tab === "settings" && isAdmin && (
            <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void publishSettings()}>
              {busy ? <LoaderCircle className={styles.spin} size={16} /> : <BookOpenCheck size={16} />}
              Publish Changes
            </button>
          )}
        </div>
      </header>

      <div className={styles.utilityBar}>
        <nav className={styles.tabs} aria-label="QuoteHelp features">
          {TAB_ITEMS.filter((item) => !item.admin || isAdmin).map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={tab === item.id ? styles.activeTab : undefined}
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
              >
                <Icon size={16} /> {item.label}
                {item.id === "history" && <span>{session.quotes.length}</span>}
              </button>
            );
          })}
        </nav>
        <div className={styles.viewerMenu}>
          <span className={styles.viewerAvatar}>{session.viewer.displayName.slice(0, 1).toUpperCase()}</span>
          <span><b>{session.viewer.displayName}</b><small>{isAdmin ? "Administrator" : "Standard user"}</small></span>
          <button type="button" disabled={busy} onClick={() => void signOut()} aria-label="Sign out of QuoteHelp">
            <LogOut size={16} />
          </button>
        </div>
      </div>

      {latestNotification && (
        <div className={styles.notification} role="status">
          <CircleAlert size={16} />
          <span><b>Pricing settings updated</b>{latestNotification.message}</span>
          <time>{formatTimestamp(latestNotification.createdAt)}</time>
        </div>
      )}

      {tab === "calculator" && (
        <div className={styles.calculatorLayout}>
          <div className={styles.formStack}>
            <Panel
              icon={Building2}
              number="01"
              title="Customer & System Details"
            >
              <div className={styles.projectGrid}>
                <div className={styles.fieldColumn}>
                  <h3>Customer Details</h3>
                  <Field label="Quote date">
                    <input type="date" value={inputs.date} onChange={(event) => setField("date", event.target.value)} />
                  </Field>
                  <Field label="Customer name" required>
                    <input id="qh-customer-name" required value={inputs.customerName} placeholder="Enter a customer or project name" onChange={(event) => setField("customerName", event.target.value)} />
                  </Field>
                  <Field label="Contact number">
                    <input type="tel" value={inputs.phone} placeholder="Enter a phone number" onChange={(event) => setField("phone", event.target.value)} />
                  </Field>
                  <Field label="Project address">
                    <input value={inputs.address} placeholder="Enter the installation address" onChange={(event) => setField("address", event.target.value)} />
                  </Field>
                  <Field label="E³ Energy initiator">
                    <input value={inputs.initiator} placeholder="Enter the project owner" onChange={(event) => setField("initiator", event.target.value)} />
                  </Field>
                </div>

                <div className={cx(styles.fieldColumn, styles.systemColumn)}>
                  <div className={styles.configurationHeading}>
                    <h3>System Configuration</h3>
                    <div className={styles.modeToggle} role="group" aria-label="Quote type">
                      <button type="button" className={!isCi ? styles.selected : undefined} aria-pressed={!isCi} onClick={() => setInputs((current) => setQuoteMode(current, "residential", settings))}>Residential</button>
                      <button type="button" className={isCi ? styles.selected : undefined} aria-pressed={isCi} onClick={() => setInputs((current) => setQuoteMode(current, "ci", settings))}>C&amp;I</button>
                    </div>
                  </div>
                  <div className={styles.brandToggle} role="group" aria-label="Equipment brand">
                    <button type="button" className={brand === "fox" ? styles.selected : undefined} aria-pressed={brand === "fox"} onClick={() => setInputs((current) => applyEquipmentBrand(current, "fox", settings))}>FOX</button>
                    <button type="button" className={brand === "sig" ? styles.selected : undefined} aria-pressed={brand === "sig"} onClick={() => setInputs((current) => applyEquipmentBrand(current, "sig", settings))}>SIG</button>
                  </div>

                  {!isCi ? (
                    <Field label="PV system capacity">
                      <NumberField value={inputs.pvSize} suffix="kW" onChange={(value) => setInputs((current) => updatePvSize(current, value))} />
                    </Field>
                  ) : (
                    <SelectionGroup title="PV systems" summary={`${result.totalPvSize} kW`} action="Add system" onAdd={addCiPv}>
                      {(inputs.ciPvSystems ?? []).map((item) => (
                        <SelectionRow key={item.id} onRemove={() => removeCi("ciPvSystems", item.id)} disableRemove={(inputs.ciPvSystems?.length ?? 0) <= 1}>
                          <Field label="Capacity"><NumberField value={item.sizeKw} suffix="kW" onChange={(value) => updateCiPv(item.id, { sizeKw: value })} /></Field>
                          <Field label="Quantity"><NumberField value={item.quantity} step={1} onChange={(value) => updateCiPv(item.id, { quantity: value })} /></Field>
                        </SelectionRow>
                      ))}
                    </SelectionGroup>
                  )}

                  {brand === "fox" && !isCi && (
                    <>
                      <Field label="Inverter">
                        <select value={inputs.inverter} onChange={(event) => setField("inverter", event.target.value)}>
                          {catalogs.inverters.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Battery capacity">
                        <select value={inputs.batteryKwh} onChange={(event) => setField("batteryKwh", safeNumber(event.target.value))}>
                          {catalogs.batteries.map((item) => <option key={item.name} value={item.kwh}>{item.name}</option>)}
                        </select>
                      </Field>
                    </>
                  )}

                  {brand === "fox" && isCi && (
                    <>
                      <SelectionGroup title="Inverters" summary={`${(inputs.ciInverters ?? []).reduce((sum, item) => sum + item.quantity, 0)} units`} action="Add inverter" onAdd={addCiInverter}>
                        {(inputs.ciInverters ?? []).map((item) => (
                          <SelectionRow key={item.id} onRemove={() => removeCi("ciInverters", item.id)} disableRemove={(inputs.ciInverters?.length ?? 0) <= 1}>
                            <Field label="Model"><select value={item.model} onChange={(event) => updateCiInverter(item.id, { model: event.target.value })}>{catalogs.inverters.map((option) => <option key={option.name}>{option.name}</option>)}</select></Field>
                            <Field label="Quantity"><NumberField value={item.quantity} step={1} onChange={(value) => updateCiInverter(item.id, { quantity: value })} /></Field>
                          </SelectionRow>
                        ))}
                      </SelectionGroup>
                      <SelectionGroup title="Batteries" summary={`${result.totalBatteryKwh} kWh`} action="Add battery" onAdd={addCiBattery}>
                        {(inputs.ciBatteries ?? []).map((item) => (
                          <SelectionRow key={item.id} onRemove={() => removeCi("ciBatteries", item.id)} disableRemove={(inputs.ciBatteries?.length ?? 0) <= 1}>
                            <Field label="Model"><select value={item.kwh} onChange={(event) => updateCiBattery(item.id, { kwh: safeNumber(event.target.value) })}>{catalogs.batteries.map((option) => <option key={option.name} value={option.kwh}>{option.name}</option>)}</select></Field>
                            <Field label="Quantity"><NumberField value={item.quantity} step={1} onChange={(value) => updateCiBattery(item.id, { quantity: value })} /></Field>
                          </SelectionRow>
                        ))}
                      </SelectionGroup>
                    </>
                  )}

                  {brand === "sig" && (
                    <>
                      <SigSelectionGroup label="Inverters" items={inputs.sigInverters ?? []} options={catalogs.inverters} required onAdd={() => addSig("sigInverters")} onUpdate={(id, patch) => updateSig("sigInverters", id, patch)} onRemove={(id) => removeSig("sigInverters", id)} />
                      <SigSelectionGroup label="Batteries & controllers" items={inputs.sigBatteries ?? []} options={catalogs.batteries} required onAdd={() => addSig("sigBatteries")} onUpdate={(id, patch) => updateSig("sigBatteries", id, patch)} onRemove={(id) => removeSig("sigBatteries", id)} />
                      <SigSelectionGroup label="Gateway" items={inputs.sigGateways ?? []} options={catalogs.gateways} onAdd={() => addSig("sigGateways")} onUpdate={(id, patch) => updateSig("sigGateways", id, patch)} onRemove={(id) => removeSig("sigGateways", id)} />
                      <SigSelectionGroup label="SIG Accessories" items={inputs.sigAccessories ?? []} options={catalogs.accessories} onAdd={() => addSig("sigAccessories")} onUpdate={(id, patch) => updateSig("sigAccessories", id, patch)} onRemove={(id) => removeSig("sigAccessories", id)} />
                    </>
                  )}
                </div>
              </div>
            </Panel>

            <Panel icon={FileText} number="02" title="Quote Breakdown">
              <div className={styles.breakdownHeader}>
                <div><b>Costs &amp; Sale Prices</b><span>{result.lineItems.length} line items</span></div>
                <button type="button" className={styles.smallButton} onClick={addCustomItem}><Plus size={14} /> Custom Item</button>
              </div>
              <div className={styles.tableScroll}>
                <table className={styles.breakdownTable}>
                  <thead><tr><th>Item</th><th>Cost (ex GST)</th><th>Margin</th><th>Sale Price (ex GST)</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead>
                  <tbody>
                    {result.lineItems.map((item) => {
                      const custom = Boolean(item.customItemId);
                      const manualKey = item.key as keyof QuoteInputs["manualCosts"];
                      return (
                        <tr key={item.key}>
                          <td>
                            {custom ? (
                              <input className={styles.inlineInput} aria-label="Custom item name" value={item.customItemName ?? ""} onChange={(event) => updateCustomItem(item.customItemId!, { name: event.target.value })} />
                            ) : <span className={styles.itemName}><b>{item.label}</b>{item.note && <small>{item.note}</small>}</span>}
                          </td>
                          <td>{custom ? <NumberField ariaLabel={`${item.label} cost`} compact value={item.cost} prefix="$" onChange={(value) => updateCustomItem(item.customItemId!, { cost: Math.max(0, value) })} /> : item.editableByUser ? <NumberField ariaLabel={`${item.label} cost`} compact value={item.cost} prefix="$" onChange={(value) => setManualCost(manualKey, value)} /> : <b>{money.format(item.cost)}</b>}</td>
                          <td>{custom ? <NumberField ariaLabel={`${item.label} margin`} compact value={item.margin * 100} suffix="%" onChange={(value) => updateCustomItem(item.customItemId!, { margin: percentageRate(Math.max(0, value)) })} /> : isCi ? <NumberField ariaLabel={`${item.label} margin`} compact value={item.margin * 100} suffix="%" onChange={(value) => setManualMargin(item.key, percentageRate(value))} /> : <span className={styles.marginPill}>{percent(item.margin)}</span>}</td>
                          <td><b>{money.format(item.salesPrice)}</b></td>
                          <td>{custom && <button type="button" className={styles.iconDanger} aria-label={`Delete ${item.label}`} onClick={() => setInputs((current) => ({ ...current, customItems: (current.customItems ?? []).filter((entry) => entry.id !== item.customItemId) }))}><Trash2 size={14} /></button>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel icon={CircleDollarSign} number="03" title="Incentives & Customer Balance">
              <div className={styles.fundingGrid}>
                {stcEditable ? (
                  <Field label={`Solar STC · ${result.solarCertificates} certificates`}><NumberField value={result.solarStc} prefix="$" onChange={(value) => setField("manualSolarStc", Math.max(0, value))} /></Field>
                ) : <Readout label="Solar STC" value={money.format(result.solarStc)} detail={`${result.solarCertificates} certificates`} />}
                {stcEditable ? (
                  <Field label={`Battery STC · ${result.batteryCertificates} certificates`}><NumberField value={result.batteryStc} prefix="$" onChange={(value) => setField("manualBatteryStc", Math.max(0, value))} /></Field>
                ) : <Readout label="Battery STC" value={money.format(result.batteryStc)} detail={`${result.batteryCertificates} certificates`} />}
                <Field label="Solar VIC Rebate"><NumberField value={inputs.solarVicRebate} prefix="$" onChange={(value) => setField("solarVicRebate", Math.max(0, value))} /></Field>
                <Field label="VIC interest-free loan"><NumberField value={inputs.solarVicLoan} prefix="$" onChange={(value) => setField("solarVicLoan", Math.max(0, value))} /></Field>
                <Field label="Discount"><NumberField value={inputs.discount} prefix="$" onChange={(value) => setField("discount", Math.max(0, value))} /></Field>
                <Field label="Customer balance (incl. GST)"><NumberField value={inputs.customerBalance} prefix="$" onChange={(value) => setField("customerBalance", value)} /></Field>
              </div>
              {!isCi && (
                <div className={styles.marginSlider}>
                  <div><span>Target margin</span><b>{marginTarget.toFixed(1)}%</b></div>
                  <input
                    type="range"
                    min="15"
                    max="30"
                    step="0.5"
                    value={marginTarget}
                    aria-label="Target margin rate"
                    onChange={(event) => {
                      const target = safeNumber(event.target.value);
                      setMarginTarget(target);
                      setField("customerBalance", Math.round(requiredCustomerBalanceForMargin(result, settings.gstRate, target / 100) * 100) / 100);
                    }}
                  />
                  <div><span>Required customer balance</span><b>{money.format(requiredCustomerBalanceForMargin(result, settings.gstRate, marginTarget / 100))}</b></div>
                </div>
              )}
            </Panel>
          </div>

          <aside className={styles.summaryColumn} aria-label="Live margin results">
            <section className={cx(styles.approvalCard, styles[result.status])}>
              <div className={styles.approvalTop}><span><StatusIcon size={17} /></span><b>{statusContent.label}</b></div>
              <strong>{percent(result.grossMarginRate)}</strong>
              <p>{statusContent.detail}</p>
              <div className={styles.progress}><i style={{ width: `${Math.min(100, Math.max(0, result.grossMarginRate / settings.thresholds.target * 100))}%` }} /></div>
              <div className={styles.progressLabels}><span>Approval {percent(settings.thresholds.approval)}</span><span>Target {percent(settings.thresholds.target)}</span></div>
            </section>
            <section className={styles.summaryPanel}>
              <div className={styles.summaryTitle}><div><SlidersHorizontal size={17} /><b>Margin Summary</b></div><span><i /> LIVE</span></div>
              <SummaryMetric label="Total received (ex GST)" value={money.format(result.totalReceivedExGst)} />
              <SummaryMetric label="Total cost (ex GST)" value={money.format(result.totalCostExGst)} />
              <SummaryMetric label="Sale price (ex GST)" value={money.format(result.totalSalesPriceExGst)} />
              <SummaryMetric label="Net GST" value={money.format(result.netGst)} muted />
              <SummaryMetric label="Gross margin" value={money.format(result.grossMargin)} accent />
            </section>
            <section className={styles.balanceCard}>
              <span>Customer balance<small>incl. GST</small></span>
              <b>{money.format(inputs.customerBalance)}</b>
            </section>
            <section className={styles.contextCard}>
              <span><Zap size={15} /> System Summary</span>
              <dl>
                <div><dt>Mode</dt><dd>{isCi ? "C&I" : "Residential"} · {brand.toUpperCase()}</dd></div>
                <div><dt>PV</dt><dd>{result.totalPvSize} kW</dd></div>
                <div><dt>Battery</dt><dd>{result.totalBatteryKwh} kWh</dd></div>
              </dl>
            </section>
          </aside>
        </div>
      )}

      {tab === "history" && (
        <section className={styles.historyPanel}>
          <div className={styles.sectionHeader}>
            <div><span className={styles.sectionIcon}><FileClock size={18} /></span><div><h2>Team Quotes</h2></div></div>
            <div className={styles.transferActions}>
              <input ref={importRef} hidden type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12" onChange={importExcel} />
              <button type="button" disabled={transferBusy} onClick={() => importRef.current?.click()}><Upload size={15} /> Import Excel</button>
              <button type="button" disabled={transferBusy || !session.quotes.length} onClick={() => void exportAllExcel()}><Download size={15} /> Export Excel</button>
            </div>
          </div>
          <div className={styles.historyTools}>
            <label className={styles.searchBox}><Search size={17} /><span className={styles.srOnly}>Search quotes</span><input type="search" value={quoteSearch} placeholder="Search customer, address, phone or owner" onChange={(event) => setQuoteSearch(event.target.value)} />{quoteSearch && <button type="button" aria-label="Clear search" onClick={() => setQuoteSearch("")}><X size={14} /></button>}</label>
            <label><span>Initiator</span><select value={quoteInitiator} onChange={(event) => setQuoteInitiator(event.target.value)}><option value="">All</option>{initiators.map((item) => <option key={item}>{item}</option>)}<option value="__none__">Not provided</option></select></label>
            <label><span>Status</span><select value={quoteStatus} onChange={(event) => setQuoteStatus(event.target.value as QuoteStatus | "")}><option value="">All</option><option value="drafting">Drafting</option><option value="done">Completed</option></select></label>
            <label><span>Start date</span><input type="date" value={createdFrom} max={createdTo || undefined} onChange={(event) => setCreatedFrom(event.target.value)} /></label>
            <label><span>End date</span><input type="date" value={createdTo} min={createdFrom || undefined} onChange={(event) => setCreatedTo(event.target.value)} /></label>
            <button type="button" className={styles.clearButton} onClick={clearFilters}><RotateCcw size={14} /> Clear</button>
          </div>
          <div className={styles.historySummary}>Showing <b>{filteredQuotes.length}</b> of {session.quotes.length} quotes</div>
          {filteredQuotes.length === 0 ? <EmptyHistory onCreate={resetQuote} /> : (
            <div className={styles.quoteList}>
              {filteredQuotes.map((quote) => {
                const calculated = calculateQuote(quote.payload, settings);
                return (
                  <article className={styles.quoteRow} key={quote.id}>
                    <button type="button" className={styles.quoteMain} onClick={() => openQuote(quote)}>
                      <span className={styles.quoteDocument}><FileText size={17} /></span>
                      <span className={styles.quoteCustomer}>
                        <b>{quote.projectName}{quote.payload.mode === "ci" && <em>C&amp;I</em>}</b>
                        <small>{quote.payload.address || "No address provided"}</small>
                        <small>{quote.payload.phone || "No phone provided"} · {quote.ownerName}</small>
                      </span>
                      <span className={styles.quoteSystem}>
                        <small>System configuration</small>
                        <b>{calculated.totalPvSize || "—"} kW · {calculated.totalBatteryKwh || "—"} kWh</b>
                        <span>{calculated.inverterSummary || quote.payload.inverter}</span>
                      </span>
                      <span className={styles.quoteMargin}>
                        <small>Gross margin</small><b>{shortMoney.format(calculated.grossMargin)}</b>
                        <em className={styles[calculated.status]}>{percent(calculated.grossMarginRate)}</em>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                    <div className={styles.quoteActions}>
                      <span>{formatDate(quote.createdAt)}</span>
                      <button type="button" className={styles.exportButton} disabled={transferBusy} onClick={() => void downloadExcel([quote], `e3-${safeExportName(quote.projectName)}-${today()}.xlsx`, `Exported ${quote.projectName}`)}><Download size={14} /> Export</button>
                      <select aria-label={`${quote.projectName} status`} className={styles[quote.status]} value={quote.status} disabled={statusBusyId === quote.id} onChange={(event) => void changeStatus(quote.id, event.target.value as QuoteStatus)}><option value="drafting">Drafting</option><option value="done">Completed</option></select>
                      {isAdmin && <button type="button" className={styles.deleteButton} disabled={statusBusyId === quote.id} onClick={() => void deleteQuote(quote)}><Trash2 size={14} /> Delete</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === "settings" && isAdmin && (
        <div className={styles.settingsStack}>
          <Panel icon={Settings2} number="A" title="Calculation Model Parameters">
            <div className={styles.settingsGrid}>
              <Field label="Senior approval threshold"><NumberField value={settingsDraft.thresholds.approval * 100} suffix="%" onChange={(value) => setSettingsDraft((current) => ({ ...current, thresholds: { ...current.thresholds, approval: percentageRate(value) } }))} /></Field>
              <Field label="Target margin"><NumberField value={settingsDraft.thresholds.target * 100} suffix="%" onChange={(value) => setSettingsDraft((current) => ({ ...current, thresholds: { ...current.thresholds, target: percentageRate(value) } }))} /></Field>
              <Field label="Solar STC unit price"><NumberField value={settingsDraft.solarStcUnitPrice} prefix="$" onChange={(value) => setSettingsDraft((current) => ({ ...current, solarStcUnitPrice: value }))} /></Field>
              <Field label="Battery STC unit price"><NumberField value={settingsDraft.batteryStcUnitPrice} prefix="$" onChange={(value) => setSettingsDraft((current) => ({ ...current, batteryStcUnitPrice: value }))} /></Field>
              <Field label="Battery installation cost"><NumberField value={settingsDraft.batteryInstallCost} prefix="$" onChange={(value) => setSettingsDraft((current) => ({ ...current, batteryInstallCost: value }))} /></Field>
              <Field label="Delivery cost"><NumberField value={settingsDraft.deliveryCost} prefix="$" onChange={(value) => setSettingsDraft((current) => ({ ...current, deliveryCost: value }))} /></Field>
              <Field label="Accessories cost / kW"><NumberField value={settingsDraft.accessoryCostPerKw} prefix="$" onChange={(value) => setSettingsDraft((current) => ({ ...current, accessoryCostPerKw: value }))} /></Field>
              <Field label="Solar installation cost / kW"><NumberField value={settingsDraft.solarInstallCostPerKw} prefix="$" onChange={(value) => setSettingsDraft((current) => ({ ...current, solarInstallCostPerKw: value }))} /></Field>
            </div>
          </Panel>
          <SigBatteryStcReference />
          <div className={styles.catalogGrid}>
            <CatalogEditor title="FOX Inverters" items={settingsDraft.inverters} onItemChange={(index, patch) => updateCatalog("inverters", index, patch)} />
            <CatalogEditor title="FOX Batteries" items={settingsDraft.batteries} battery onItemChange={(index, patch) => updateCatalog("batteries", index, patch)} />
            <CatalogEditor title="SIG Residential Inverters" items={settingsDraft.sigResidentialInverters} onItemChange={(index, patch) => updateCatalog("sigResidentialInverters", index, patch)} />
            <CatalogEditor title="SIG Residential Batteries" items={settingsDraft.sigResidentialBatteries} battery onItemChange={(index, patch) => updateCatalog("sigResidentialBatteries", index, patch)} />
            <CatalogEditor title="SIG C&I Inverters" items={settingsDraft.sigCiInverters} onItemChange={(index, patch) => updateCatalog("sigCiInverters", index, patch)} />
            <CatalogEditor title="SIG C&I Batteries" items={settingsDraft.sigCiBatteries} battery onItemChange={(index, patch) => updateCatalog("sigCiBatteries", index, patch)} />
            <CatalogEditor title="SIG Gateway" items={settingsDraft.sigGateways} onItemChange={(index, patch) => updateCatalog("sigGateways", index, patch)} />
            <CatalogEditor title="SIG Accessories" items={settingsDraft.sigAccessories} onItemChange={(index, patch) => updateCatalog("sigAccessories", index, patch)} />
          </div>
        </div>
      )}

      {tab === "users" && isAdmin && (
        <section className={styles.usersPanel}>
          <div className={styles.sectionHeader}>
            <div><span className={styles.sectionIcon}><ShieldCheck size={18} /></span><div><h2>Users &amp; Permissions</h2></div></div>
          </div>
          <div className={styles.userList}>
            {session.users.map((user) => (
              <div className={styles.userRow} key={user.userId}>
                <span>{user.displayName.slice(0, 1).toUpperCase()}</span>
                <div><b>{user.displayName}{user.userId === session.viewer.userId && <em>Current user</em>}</b><small>{user.email}</small></div>
                <time>{formatDate(user.createdAt)}</time>
                <strong className={user.role === "admin" ? styles.adminRole : styles.userRole}>{user.role === "admin" ? "Administrator" : "Standard user"}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      {message && <div className={styles.toast} role="status" aria-live="polite"><Check size={16} />{message}</div>}
    </section>
  );
}

function LoadingState() {
  return (
    <section className={styles.stateCard} role="status" aria-live="polite">
      <span className={styles.stateIcon}><LoaderCircle className={styles.spin} size={22} /></span>
      <div><h2>Connecting to QuoteHelp</h2></div>
    </section>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className={styles.stateCard} role="alert">
      <span className={cx(styles.stateIcon, styles.errorIcon)}><CircleAlert size={22} /></span>
      <div><h2>QuoteHelp is temporarily unavailable</h2><p>{message}</p><button type="button" className={styles.secondaryButton} onClick={onRetry}><RefreshCcw size={15} /> Retry</button></div>
    </section>
  );
}

function LoginPanel({
  username,
  password,
  error,
  busy,
  onUsername,
  onPassword,
  onSubmit,
}: {
  username: string;
  password: string;
  error: string;
  busy: boolean;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className={styles.loginShell}>
      <div className={styles.loginCard}>
        <span className={styles.loginIcon}><Calculator size={24} /></span>
        <span className={styles.eyebrow}>QUOTEHELP SECURE ACCESS</span>
        <h1>Sign in to the Quote Workspace</h1>
        <form onSubmit={onSubmit}>
          <Field label="Username" required><input autoFocus autoComplete="username" value={username} onChange={(event) => onUsername(event.target.value)} /></Field>
          <Field label="Password" required><input type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} /></Field>
          {error && <div className={styles.loginError} role="alert"><CircleAlert size={15} />{error}</div>}
          <button type="submit" className={styles.primaryButton} disabled={busy || !username.trim() || !password}>{busy ? <LoaderCircle className={styles.spin} size={16} /> : <LogIn size={16} />}{busy ? "Signing in" : "Sign in"}</button>
        </form>
      </div>
    </section>
  );
}

function Panel({ icon: Icon, number, title, children }: { icon: LucideIcon; number: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div><span><Icon size={16} /></span><div><small>{number}</small><h2>{title}</h2></div></div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <label className={styles.field}><span>{label}{required && <em>*</em>}</span>{children}</label>;
}

function NumberField({ value, onChange, prefix, suffix, compact, step = "any", ariaLabel }: { value: number; onChange: (value: number) => void; prefix?: string; suffix?: string; compact?: boolean; step?: number | "any"; ariaLabel?: string }) {
  return (
    <span className={cx(styles.numberField, compact && styles.compactNumber)}>
      {prefix && <i>{prefix}</i>}
      <input aria-label={ariaLabel} type="number" step={step} value={Number.isFinite(value) ? value : 0} onChange={(event) => onChange(safeNumber(event.target.value))} />
      {suffix && <i>{suffix}</i>}
    </span>
  );
}

function Readout({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className={styles.readout}><span>{label}</span><b>{value}</b><small>{detail}</small></div>;
}

function SelectionGroup({ title, summary, action, onAdd, children }: { title: string; summary: string; action: string; onAdd: () => void; children: ReactNode }) {
  return (
    <section className={styles.selectionGroup}>
      <header><div><b>{title}</b><span>{summary}</span></div><button type="button" onClick={onAdd}><Plus size={13} />{action}</button></header>
      <div>{children}</div>
    </section>
  );
}

function SelectionRow({ children, onRemove, disableRemove }: { children: ReactNode; onRemove: () => void; disableRemove?: boolean }) {
  return <div className={styles.selectionRow}>{children}<button type="button" className={styles.removeSelection} disabled={disableRemove} onClick={onRemove} aria-label="Remove this configuration"><X size={14} /></button></div>;
}

function SigSelectionGroup({ label, items, options, required, onAdd, onUpdate, onRemove }: {
  label: string;
  items: EquipmentSelection[];
  options: CatalogItem[];
  required?: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<EquipmentSelection>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <SelectionGroup title={label} summary={`${items.reduce((sum, item) => sum + item.quantity, 0)} items`} action="Add" onAdd={onAdd}>
      {!items.length && <div className={styles.emptySelection}>No {label.toLowerCase()} added</div>}
      {items.map((item) => (
        <SelectionRow key={item.id} onRemove={() => onRemove(item.id)} disableRemove={Boolean(required && items.length <= 1)}>
          <Field label="Model"><select value={item.model} onChange={(event) => onUpdate(item.id, { model: event.target.value })}>{options.map((option) => <option key={option.name}>{option.name}</option>)}</select></Field>
          <Field label="Quantity"><NumberField value={item.quantity} step={1} onChange={(value) => onUpdate(item.id, { quantity: value })} /></Field>
        </SelectionRow>
      ))}
    </SelectionGroup>
  );
}

function SummaryMetric({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return <div className={cx(styles.summaryMetric, accent && styles.summaryAccent, muted && styles.summaryMuted)}><span>{label}</span><b>{value}</b></div>;
}

function EmptyHistory({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.emptyHistory}>
      <span><PackagePlus size={24} /></span>
      <h3>No matching quotes</h3>
      <button type="button" className={styles.primaryButton} onClick={onCreate}><Plus size={15} /> New Quote</button>
    </div>
  );
}

function CatalogEditor({ title, items, battery, onItemChange }: {
  title: string;
  items: Array<CatalogItem | BatteryItem>;
  battery?: boolean;
  onItemChange: (index: number, patch: Partial<BatteryItem>) => void;
}) {
  return (
    <details className={styles.catalogPanel}>
      <summary><span><Database size={16} /><b>{title}</b><small>{items.length} items</small></span><ChevronRight size={16} /></summary>
      <div className={styles.catalogTable}>
        <div className={styles.catalogHead}><span>Model</span><span>Description</span>{battery && <span>Capacity</span>}<span>Cost</span>{battery && <span>STC</span>}</div>
        {items.map((item, index) => {
          const batteryItem = item as BatteryItem;
          return (
            <div className={styles.catalogRow} key={`${title}-${index}`}>
              <input aria-label={`${title} model ${index + 1}`} value={item.name} onChange={(event) => onItemChange(index, { name: event.target.value })} />
              <input aria-label={`${title} description ${index + 1}`} value={item.description ?? ""} onChange={(event) => onItemChange(index, { description: event.target.value })} />
              {battery && <NumberField ariaLabel={`${title} ${index + 1} capacity`} compact value={batteryItem.kwh} suffix="kWh" onChange={(value) => onItemChange(index, { kwh: value })} />}
              <NumberField ariaLabel={`${title} ${index + 1} cost`} compact value={item.cost} prefix="$" onChange={(value) => onItemChange(index, { cost: value })} />
              {battery && <NumberField ariaLabel={`${title} ${index + 1} STC`} compact value={batteryItem.certificates} step={1} onChange={(value) => onItemChange(index, { certificates: value })} />}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function SigBatteryStcReference() {
  return (
    <section className={styles.stcReferencePanel} aria-labelledby="sig-battery-stc-title">
      <header className={styles.stcReferenceHeader}>
        <div><span aria-hidden="true">J</span><h2 id="sig-battery-stc-title">SIG Battery STC reference</h2></div>
        <strong>Reference only</strong>
      </header>
      <div className={styles.stcReferenceTableWrap}>
        <table className={styles.stcReferenceTable}>
          <caption className={styles.srOnly}>SIG battery capacity and STC reference values</caption>
          <thead><tr><th scope="col">BAT kWh</th><th scope="col">STC</th></tr></thead>
          {SIG_BATTERY_STC_REFERENCE.map((group, groupIndex) => (
            <tbody key={`sig-stc-group-${groupIndex}`} className={groupIndex ? styles.stcReferenceGroup : undefined}>
              {group.map((row) => <tr key={`${groupIndex}-${row.kwh}`}><td>{row.kwh}</td><td>{row.stc}</td></tr>)}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
