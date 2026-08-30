"use client";

import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  CreditCard,
  FileBarChart,
  FileText,
  FolderOpen,
  HelpCircle,
  Home,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  PanelLeftClose,
  Search,
  Settings,
  Users,
  ReceiptText,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import e3EnergyMark from "@/assets/e3-energy-mark.png";
import { ERP_ROLE_LABELS, type ErpUser } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import {
  countActivePaymentTrackProjects,
  type PaymentTrackListResponse,
  type PaymentTrackUpdatedEventDetail,
} from "@/lib/payment-track/types";
import { countScheduledIncompletePaymentTrackProjects } from "@/lib/payment-track/scheduled-work";
import {
  isProjectScheduleSourceOverride,
  type ProjectScheduleSourceOverride,
} from "@/lib/project-schedule/types";
import {
  countOngoingSiteVisits,
  type SiteVisitListResponse,
} from "@/lib/site-visits/types";

const AgentSettingsDialog = dynamic(
  () => import("./agent-settings-dialog").then((module) => module.AgentSettingsDialog),
  { ssr: false, loading: WorkspaceLoading },
);
const FilesWorkspace = dynamic(
  () => import("./files-workspace").then((module) => module.FilesWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const HomeCollaborationWorkspace = dynamic(
  () => import("./home-collaboration-workspace").then((module) => module.HomeCollaborationWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const InventoryOperationsWorkspace = dynamic(
  () => import("./inventory-operations-workspace").then((module) => module.InventoryOperationsWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const ProjectDeliveryBoard = dynamic(
  () => import("./project-delivery-board").then((module) => module.ProjectDeliveryBoard),
  { ssr: false, loading: WorkspaceLoading },
);
const QuoteHelpWorkspace = dynamic(
  () => import("./quotehelp-workspace").then((module) => module.QuoteHelpWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const ReimbursementWorkspace = dynamic(
  () => import("./reimbursement-workspace").then((module) => module.ReimbursementWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const ReportsWorkspace = dynamic(
  () => import("./reports-workspace").then((module) => module.ReportsWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const PaymentTrackWorkspace = dynamic(
  () => import("./payment-track-workspace").then((module) => module.PaymentTrackWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const SiteVisitingWorkspace = dynamic(
  () => import("./site-visiting-workspace").then((module) => module.SiteVisitingWorkspace),
  { ssr: false, loading: WorkspaceLoading },
);
const UserManagementDialog = dynamic(
  () => import("./user-management-dialog").then((module) => module.UserManagementDialog),
  { ssr: false, loading: WorkspaceLoading },
);

type ModuleId = "home" | "files" | "inventory" | "quotations" | "projects" | "site-visits" | "payments" | "reimbursements" | "reports" | "finance";
type EntityNavigationTarget = { module: ModuleId; entityId: string; requestId: number };

const NAVIGATION: Array<{
  group: string;
  items: Array<{ id: ModuleId; label: string; icon: LucideIcon; enabled: boolean }>;
}> = [
  {
    group: "Workspace",
    items: [
      { id: "home", label: "Home", icon: Home, enabled: true },
      { id: "files", label: "Files", icon: FolderOpen, enabled: true },
      { id: "payments", label: "Project Track", icon: CreditCard, enabled: true },
      { id: "inventory", label: "Inventory", icon: Warehouse, enabled: true },
      { id: "quotations", label: "Quotations", icon: FileText, enabled: true },
      { id: "projects", label: "Weekly Schedule", icon: ClipboardList, enabled: true },
      { id: "site-visits", label: "Site Visiting", icon: MapPin, enabled: true },
      { id: "reimbursements", label: "Reimbursements", icon: ReceiptText, enabled: true },
    ],
  },
  {
    group: "Coming Soon",
    items: [
      { id: "finance", label: "Finance & Accounting", icon: CircleDollarSign, enabled: false },
    ],
  },
];

const MODULE_LABELS: Record<ModuleId, string> = {
  home: "Home",
  files: "Files",
  inventory: "Inventory",
  quotations: "Quotations",
  projects: "Weekly Schedule",
  "site-visits": "Site Visiting",
  payments: "Project Track",
  reimbursements: "Reimbursements",
  reports: "Reports",
  finance: "Finance & Accounting",
};

const ERP_BROWSER_ACCOUNT_KEY = "e3-erp-browser-account:v1";
const LEGACY_AGENT_CONVERSATION_KEY = "e3-agent-conversation:v1";
const MELBOURNE_TIME_ZONE = "Australia/Melbourne";

function melbourneTodayIso() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function ERPWorkspace({ currentUser }: { currentUser: ErpUser }) {
  const [activeModule, setActiveModule] = useState<ModuleId>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [userManagementOpen, setUserManagementOpen] = useState(false);
  const [scheduledIncompleteProjectCount, setScheduledIncompleteProjectCount] = useState<number | null>(null);
  const [activeProjectTrackCount, setActiveProjectTrackCount] = useState<number | null>(null);
  const [activeSiteVisitCount, setActiveSiteVisitCount] = useState<number | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [entityNavigationTarget, setEntityNavigationTarget] = useState<EntityNavigationTarget | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const navigationRequestIdRef = useRef(0);

  const userInitials = currentUser.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("en-AU"))
    .join("") || currentUser.username.slice(0, 2).toLocaleUpperCase("en-AU");

  useEffect(() => {
    try {
      const username = currentUser.username.toLocaleLowerCase("en-AU");
      const previousUsername = window.localStorage.getItem(ERP_BROWSER_ACCOUNT_KEY);
      if (previousUsername !== username) {
        window.localStorage.removeItem(LEGACY_AGENT_CONVERSATION_KEY);
        window.localStorage.setItem(ERP_BROWSER_ACCOUNT_KEY, username);
      }
    } catch {
      // Login and workspace navigation still work when browser storage is unavailable.
    }
  }, [currentUser.username]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [userMenuOpen]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Unable to sign out.");
      window.location.assign("/login");
    } catch {
      setSigningOut(false);
      window.alert("Unable to sign out right now. Please try again.");
    }
  };

  useEffect(() => {
    let active = true;
    let latestRequest = 0;

    async function loadScheduledIncompleteProjectCount() {
      const requestId = ++latestRequest;
      try {
        const today = melbourneTodayIso();
        const [paymentResponse, scheduleResponse] = await Promise.all([
          fetch("/api/payment-track", { cache: "no-store" }),
          fetch(`/api/project-schedule?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`, { cache: "no-store" }),
        ]);
        if (!paymentResponse.ok || !scheduleResponse.ok) return;
        const [paymentBody, scheduleBody] = await Promise.all([
          readJsonResponse<PaymentTrackListResponse>(paymentResponse),
          readJsonResponse<{ data?: { overrides?: unknown[] } }>(scheduleResponse),
        ]);
        if (!active
          || requestId !== latestRequest
          || !Array.isArray(paymentBody.data)
          || !Array.isArray(scheduleBody.data?.overrides)
          || !scheduleBody.data.overrides.every(isProjectScheduleSourceOverride)) return;
        setScheduledIncompleteProjectCount(countScheduledIncompletePaymentTrackProjects(
          paymentBody.data,
          scheduleBody.data.overrides as ProjectScheduleSourceOverride[],
        ));
      } catch {
        // Retain the last confirmed count while either Project Track or Weekly Schedule is unavailable.
      }
    }

    const refresh = () => void loadScheduledIncompleteProjectCount();
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };

    refresh();
    window.addEventListener("erp:payment-track-updated", refresh);
    window.addEventListener("erp:project-schedule-updated", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const refreshTimer = window.setInterval(refreshWhenVisible, 60_000);

    return () => {
      active = false;
      latestRequest += 1;
      window.clearInterval(refreshTimer);
      window.removeEventListener("erp:payment-track-updated", refresh);
      window.removeEventListener("erp:project-schedule-updated", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let latestRequest = 0;

    async function loadActiveSiteVisitCount() {
      const requestId = ++latestRequest;
      try {
        const response = await fetch("/api/site-visits", { cache: "no-store" });
        if (!response.ok) return;
        const body = await readJsonResponse<SiteVisitListResponse>(response);
        if (!active || requestId !== latestRequest || !Array.isArray(body.data?.visits)) return;
        setActiveSiteVisitCount(countOngoingSiteVisits(body.data.visits));
      } catch {
        // Retain the last confirmed count while Site Visiting is unavailable.
      }
    }

    const refresh = () => void loadActiveSiteVisitCount();
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };

    refresh();
    window.addEventListener("erp:site-visits-updated", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const refreshTimer = window.setInterval(refreshWhenVisible, 60_000);

    return () => {
      active = false;
      latestRequest += 1;
      window.clearInterval(refreshTimer);
      window.removeEventListener("erp:site-visits-updated", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let latestRequest = 0;

    async function loadActiveProjectTrackCount() {
      const requestId = ++latestRequest;
      try {
        const response = await fetch("/api/payment-track", { cache: "no-store" });
        if (!response.ok) return;
        const body = await readJsonResponse<PaymentTrackListResponse>(response);
        if (!active || requestId !== latestRequest || !Array.isArray(body.data)) return;
        setActiveProjectTrackCount(countActivePaymentTrackProjects(body.data));
      } catch {
        // Retain the last confirmed count while Project Track is unavailable.
      }
    }

    const refresh = (event?: Event) => {
      const eventCount = event?.type === "erp:payment-track-updated"
        ? (event as CustomEvent<PaymentTrackUpdatedEventDetail>).detail?.activeProjectCount
        : undefined;
      if (typeof eventCount === "number" && Number.isSafeInteger(eventCount) && eventCount >= 0) {
        latestRequest += 1;
        setActiveProjectTrackCount(eventCount);
        return;
      }
      void loadActiveProjectTrackCount();
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };

    refresh();
    window.addEventListener("erp:payment-track-updated", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const refreshTimer = window.setInterval(refreshWhenVisible, 60_000);

    return () => {
      active = false;
      latestRequest += 1;
      window.clearInterval(refreshTimer);
      window.removeEventListener("erp:payment-track-updated", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const navigate = (module: ModuleId, enabled = true, entityId?: string) => {
    if (!enabled) return;
    const normalizedEntityId = entityId?.trim();
    setEntityNavigationTarget(normalizedEntityId ? {
      module,
      entityId: normalizedEntityId,
      requestId: ++navigationRequestIdRef.current,
    } : null);
    setActiveModule(module);
    setSidebarOpen(false);
  };

  return (
    <div className="erpnext-app">
      <header className="desk-navbar">
        <button className="mobile-nav-trigger" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
          <Menu size={19} />
        </button>
        <button className="desk-brand" type="button" onClick={() => navigate("home")} aria-label="Go to E3 ERP home">
          <Image className="desk-logo" src={e3EnergyMark} alt="" aria-hidden="true" priority sizes="29px" />
          <strong>E3 ERP</strong>
        </button>
        <div className="desk-search">
          <Search size={15} />
          <input placeholder="Search items, quotations, customers or projects (⌘ K)" aria-label="Global search" />
        </div>
        <div className="desk-actions">
          <button aria-label="Help"><HelpCircle size={18} /></button>
          <button className="notification" aria-label="Notifications"><Bell size={18} /><i /></button>
          <div className="user-account" ref={userMenuRef}>
            <button
              className="user-menu"
              type="button"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((open) => !open)}
            >
              <span>{userInitials}</span>
              <div><strong>{currentUser.displayName}</strong><small>{ERP_ROLE_LABELS[currentUser.role]}</small></div>
              <ChevronDown size={14} />
            </button>
            {userMenuOpen ? (
              <div className="user-popover" role="menu">
                <div><strong>{currentUser.displayName}</strong><small>@{currentUser.username} · {ERP_ROLE_LABELS[currentUser.role]}</small></div>
                <button type="button" role="menuitem" disabled={signingOut} onClick={() => void signOut()}>
                  <LogOut size={15} />{signingOut ? "Signing out…" : "Sign out"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <aside className={`desk-sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-mobile-heading">
          <div><Image className="sidebar-mobile-logo" src={e3EnergyMark} alt="" aria-hidden="true" sizes="28px" /><strong>E3 ERP</strong></div>
          <button onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={19} /></button>
        </div>
        <div className="company-switcher">
          <span><Image className="company-logo" src={e3EnergyMark} alt="" aria-hidden="true" sizes="25px" /></span>
          <div><small>Company</small><strong>E3 Energy Pty Ltd</strong></div>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="ERP module navigation">
          {NAVIGATION.map((section) => (
            <div className="nav-section" key={section.group}>
              <p>{section.group}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                const scheduledIncompleteLabel = scheduledIncompleteProjectCount === null
                  ? "Scheduled Project Track project count is loading"
                  : `${scheduledIncompleteProjectCount} scheduled Project Track ${scheduledIncompleteProjectCount === 1 ? "project" : "projects"} not completed`;
                const activeProjectTrackLabel = activeProjectTrackCount === null
                  ? "Active Project Track count is loading"
                  : `${activeProjectTrackCount} active ${activeProjectTrackCount === 1 ? "project" : "projects"}`;
                const activeSiteVisitLabel = activeSiteVisitCount === null
                  ? "Active Site Visiting count is loading"
                  : `${activeSiteVisitCount} active site ${activeSiteVisitCount === 1 ? "visit" : "visits"}`;
                return (
                  <button
                    key={item.id}
                    className={`${activeModule === item.id ? "active" : ""} ${!item.enabled ? "disabled" : ""}`}
                    onClick={() => navigate(item.id, item.enabled)}
                    title={!item.enabled
                      ? "Not available yet"
                      : item.id === "projects"
                        ? scheduledIncompleteLabel
                        : item.id === "payments"
                          ? activeProjectTrackLabel
                          : item.id === "site-visits" ? activeSiteVisitLabel : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} />
                    <span className="nav-item-label">{item.label}</span>
                    {item.id === "projects" && scheduledIncompleteProjectCount !== null && (
                      <span
                        className="nav-count-badge"
                        aria-label={scheduledIncompleteLabel}
                        aria-live="polite"
                      >
                        {scheduledIncompleteProjectCount > 99 ? "99+" : scheduledIncompleteProjectCount}
                      </span>
                    )}
                    {item.id === "payments" && activeProjectTrackCount !== null && (
                      <span
                        className="nav-count-badge"
                        aria-label={activeProjectTrackLabel}
                        aria-live="polite"
                      >
                        {activeProjectTrackCount > 99 ? "99+" : activeProjectTrackCount}
                      </span>
                    )}
                    {item.id === "site-visits" && activeSiteVisitCount !== null && (
                      <span
                        className="nav-count-badge"
                        aria-label={activeSiteVisitLabel}
                        aria-live="polite"
                      >
                        {activeSiteVisitCount > 99 ? "99+" : activeSiteVisitCount}
                      </span>
                    )}
                    {!item.enabled && <LockKeyhole size={12} />}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className={activeModule === "reports" ? "active" : ""} onClick={() => navigate("reports")}><FileBarChart size={16} /><span>Reports</span></button>
          {currentUser.role === "admin" ? (
            <>
              <button onClick={() => setAgentSettingsOpen(true)}><Settings size={16} /><span>Agent Settings</span></button>
              <button onClick={() => setUserManagementOpen(true)}><Users size={16} /><span>User Management</span></button>
            </>
          ) : null}
          <div><i /><span>Business services operational</span></div>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}

      <div className="desk-main-shell">
        <div className="page-bar">
          <div className="page-breadcrumb"><span>E3 Energy</span><ChevronRight size={12} /><strong>{MODULE_LABELS[activeModule]}</strong></div>
          <div className="page-bar-actions"><button><Activity size={15} />Activity</button><button><PanelLeftClose size={15} />Sidebar</button></div>
        </div>
        <main className={`desk-main ${activeModule === "home" || activeModule === "files" || activeModule === "projects" || activeModule === "site-visits" || activeModule === "payments" || activeModule === "reimbursements" ? "wide-workspace" : ""}`}>
          <div className="persistent-home-workspace" hidden={activeModule !== "home"}>
            <HomeCollaborationWorkspace
              currentUser={currentUser}
              onOpenSettings={currentUser.role === "admin" ? () => setAgentSettingsOpen(true) : undefined}
              onNavigate={(module, entityId) => navigate(module, true, entityId)}
            />
          </div>
          {activeModule === "files" && <FilesWorkspace currentUser={currentUser} />}
          {activeModule === "inventory" && <InventoryOperationsWorkspace currentUser={currentUser} />}
          {activeModule === "quotations" && <QuoteHelpWorkspace />}
          {activeModule === "projects" && (
            <ProjectDeliveryBoard
              authenticatedRole={currentUser.role}
              openEntityTarget={entityNavigationTarget?.module === "projects" ? entityNavigationTarget : undefined}
              onOpenProjectTrackProject={(projectId) => navigate("payments", true, projectId)}
            />
          )}
          {activeModule === "site-visits" && <SiteVisitingWorkspace authenticatedRole={currentUser.role} />}
          {activeModule === "payments" && <PaymentTrackWorkspace authenticatedRole={currentUser.role} openEntityTarget={entityNavigationTarget?.module === "payments" ? entityNavigationTarget : undefined} />}
          {activeModule === "reimbursements" && <ReimbursementWorkspace authenticatedRole={currentUser.role} openEntityTarget={entityNavigationTarget?.module === "reimbursements" ? entityNavigationTarget : undefined} />}
          {activeModule === "reports" && <ReportsWorkspace />}
          {activeModule === "finance" && <ComingSoon />}
        </main>
      </div>
      {currentUser.role === "admin" ? (
        <>
          {agentSettingsOpen ? (
            <AgentSettingsDialog open onClose={() => setAgentSettingsOpen(false)} />
          ) : null}
          {userManagementOpen ? (
            <UserManagementDialog open onClose={() => setUserManagementOpen(false)} currentUsername={currentUser.username} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ComingSoon() {
  return <section className="module-placeholder"><span><CircleDollarSign size={26} /></span><h1>Finance &amp; Accounting is not available yet</h1><button className="ghost-button"><CheckCircle2 size={15} />View Implementation Checklist</button></section>;
}

function WorkspaceLoading() {
  return <section className="module-placeholder" role="status" aria-label="Loading workspace" />;
}
