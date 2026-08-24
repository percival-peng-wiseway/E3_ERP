"use client";

import {
  Activity,
  Bell,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  CreditCard,
  FileBarChart,
  FileText,
  HelpCircle,
  Home,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  PanelLeftClose,
  Search,
  Settings,
  ReceiptText,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ERP_ROLE_LABELS, type ErpUser } from "@/lib/auth/types";
import { groupOrders, type Order } from "@/lib/inventory-operations/types";
import { AgentSettingsDialog } from "./agent-settings-dialog";
import { HomeCollaborationWorkspace } from "./home-collaboration-workspace";
import { InventoryOperationsWorkspace } from "./inventory-operations-workspace";
import { ProjectDeliveryBoard } from "./project-delivery-board";
import { QuoteHelpWorkspace } from "./quotehelp-workspace";
import { ReimbursementWorkspace } from "./reimbursement-workspace";
import { ReportsWorkspace } from "./reports-workspace";
import { PaymentTrackWorkspace } from "./payment-track-workspace";
import { SiteVisitingWorkspace } from "./site-visiting-workspace";

type ModuleId = "home" | "inventory" | "quotations" | "projects" | "site-visits" | "payments" | "reimbursements" | "reports" | "finance";

const NAVIGATION: Array<{
  group: string;
  items: Array<{ id: ModuleId; label: string; icon: LucideIcon; enabled: boolean }>;
}> = [
  {
    group: "Workspace",
    items: [
      { id: "home", label: "Home", icon: Home, enabled: true },
      { id: "inventory", label: "Inventory", icon: Warehouse, enabled: true },
      { id: "quotations", label: "Quotations", icon: FileText, enabled: true },
      { id: "projects", label: "Project Management", icon: ClipboardList, enabled: true },
      { id: "site-visits", label: "Site Visiting", icon: MapPin, enabled: true },
      { id: "payments", label: "Payment Track", icon: CreditCard, enabled: true },
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
  inventory: "Inventory",
  quotations: "Quotations",
  projects: "Project Management",
  "site-visits": "Site Visiting",
  payments: "Payment Track",
  reimbursements: "Reimbursements",
  reports: "Reports",
  finance: "Finance & Accounting",
};

const ERP_BROWSER_ACCOUNT_KEY = "e3-erp-browser-account:v1";
const LEGACY_AGENT_CONVERSATION_KEY = "e3-agent-conversation:v1";

export function ERPWorkspace({ currentUser }: { currentUser: ErpUser }) {
  const [activeModule, setActiveModule] = useState<ModuleId>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [pendingPmReviewCount, setPendingPmReviewCount] = useState<number | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

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

    async function loadPendingPmReviewCount() {
      const requestId = ++latestRequest;
      try {
        const response = await fetch("/api/inventory/operations", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json() as { orders?: Order[] };
        if (!active || requestId !== latestRequest || !Array.isArray(body.orders)) return;
        setPendingPmReviewCount(groupOrders(
          body.orders.filter((order) => order.status === "pending"),
        ).length);
      } catch {
        // Retain the last confirmed count while the Inventory service is unavailable.
      }
    }

    const refresh = () => void loadPendingPmReviewCount();
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };

    refresh();
    window.addEventListener("erp:inventory-updated", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const refreshTimer = window.setInterval(refreshWhenVisible, 60_000);

    return () => {
      active = false;
      latestRequest += 1;
      window.clearInterval(refreshTimer);
      window.removeEventListener("erp:inventory-updated", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const navigate = (module: ModuleId, enabled = true) => {
    if (!enabled) return;
    setActiveModule(module);
    setSidebarOpen(false);
  };

  return (
    <div className="erpnext-app">
      <header className="desk-navbar">
        <button className="mobile-nav-trigger" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
          <Menu size={19} />
        </button>
        <button className="desk-brand" onClick={() => navigate("home")}>
          <span className="desk-logo"><span /><span /><span /></span>
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
          <strong>E3 ERP</strong>
          <button onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={19} /></button>
        </div>
        <div className="company-switcher">
          <span><Building2 size={17} /></span>
          <div><small>Company</small><strong>E3 Energy Pty Ltd</strong></div>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="ERP module navigation">
          {NAVIGATION.map((section) => (
            <div className="nav-section" key={section.group}>
              <p>{section.group}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                const pendingReviewLabel = pendingPmReviewCount === null
                  ? "Pending PM Review count is loading"
                  : `${pendingPmReviewCount} ${pendingPmReviewCount === 1 ? "order" : "orders"} pending PM review`;
                return (
                  <button
                    key={item.id}
                    className={`${activeModule === item.id ? "active" : ""} ${!item.enabled ? "disabled" : ""}`}
                    onClick={() => navigate(item.id, item.enabled)}
                    title={!item.enabled
                      ? "Not available yet"
                      : item.id === "projects" ? pendingReviewLabel : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} />
                    <span className="nav-item-label">{item.label}</span>
                    {item.id === "projects" && pendingPmReviewCount !== null && pendingPmReviewCount > 0 && (
                      <span
                        className="nav-count-badge"
                        aria-label={pendingReviewLabel}
                        aria-live="polite"
                      >
                        {pendingPmReviewCount > 99 ? "99+" : pendingPmReviewCount}
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
            <button onClick={() => setAgentSettingsOpen(true)}><Settings size={16} /><span>Settings</span></button>
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
        <main className={`desk-main ${activeModule === "home" || activeModule === "projects" || activeModule === "site-visits" || activeModule === "payments" || activeModule === "reimbursements" ? "wide-workspace" : ""}`}>
          <div className="persistent-home-workspace" hidden={activeModule !== "home"}>
            <HomeCollaborationWorkspace
              onOpenSettings={currentUser.role === "admin" ? () => setAgentSettingsOpen(true) : undefined}
              onNavigate={(module) => navigate(module)}
            />
          </div>
          {activeModule === "inventory" && <InventoryOperationsWorkspace />}
          {activeModule === "quotations" && <QuoteHelpWorkspace />}
          {activeModule === "projects" && <ProjectDeliveryBoard />}
          {activeModule === "site-visits" && <SiteVisitingWorkspace />}
          {activeModule === "payments" && <PaymentTrackWorkspace authenticatedRole={currentUser.role} />}
          {activeModule === "reimbursements" && <ReimbursementWorkspace />}
          {activeModule === "reports" && <ReportsWorkspace />}
          {activeModule === "finance" && <ComingSoon />}
        </main>
      </div>
      {currentUser.role === "admin" ? (
        <AgentSettingsDialog open={agentSettingsOpen} onClose={() => setAgentSettingsOpen(false)} />
      ) : null}
    </div>
  );
}

function ComingSoon() {
  return <section className="module-placeholder"><span><CircleDollarSign size={26} /></span><h1>Finance &amp; Accounting is not available yet</h1><button className="ghost-button"><CheckCircle2 size={15} />View Implementation Checklist</button></section>;
}
