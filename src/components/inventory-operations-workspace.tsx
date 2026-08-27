"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ErpUser } from "@/lib/auth/types";
import { readJsonResponse } from "@/lib/client/http";
import { inventoryRoleCanAddStock } from "@/lib/inventory-operations/types";
import styles from "./inventory-operations-workspace.module.css";

type InventoryItem = {
  sku: string;
  category: string;
  status: string;
  on_hand: number;
  reserved: number;
  pending: number;
  available: number;
  consumption: number;
};

type Order = {
  id: number;
  order_group: string | null;
  sales_rep: string;
  customer: string;
  phone: string;
  sku: string;
  quantity: number;
  created_at: string;
  status: "pending" | "scheduled" | "delivered" | "cancelled";
  address: string | null;
  planned_date: string | null;
  delivery_time: string | null;
  driver: string | null;
  driver_email: string | null;
  delivered_at: string | null;
  note: string | null;
};
type OrderGroup = { key: string; orders: Order[]; primary: Order };

type ParsedArrival = { sku: string; quantity: number; isNew: boolean; category: string };
type SaleItem = { sku: string; quantity: number };
type StockLoss = {
  id: number;
  sku: string;
  quantity: number;
  reason: string;
  actor: string;
  created_at: string;
};
type ProjectConsumption = {
  id: string;
  sku: string;
  quantity: number;
  customer: string;
  address: string;
  actor: string;
  created_at: string;
};
type SkuHistoryEntry = {
  key: string;
  kind: "delivered" | "installed" | "loss";
  createdAt: string;
  title: string;
  detail: string;
  quantity: number;
};
type ApiState = {
  inventory: InventoryItem[];
  deliveryHistory: Order[];
  lossHistory: StockLoss[];
  projectConsumptionHistory?: ProjectConsumption[];
  admin: boolean;
};
type View = "overview" | "sale" | "arrival" | "history";
type ArrivalMode = "received" | "ordered";

const DELIVERY_TIME_OPTIONS = Array.from({ length: 9 }, (_, index) => {
  const hour = index + 9;
  return {
    value: `${String(hour).padStart(2, "0")}:00`,
    label: `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? "PM" : "AM"}`,
  };
});

const initialState: ApiState = { inventory: [], deliveryHistory: [], lossHistory: [], admin: false };

export function InventoryOperationsWorkspace({ currentUser }: { currentUser: ErpUser }) {
  const [data, setData] = useState<ApiState>(initialState);
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [arrivalText, setArrivalText] = useState("");
  const [arrivalDraft, setArrivalDraft] = useState<ParsedArrival[]>([]);
  const [arrivalMode, setArrivalMode] = useState<ArrivalMode>("received");
  const [orderActor, setOrderActor] = useState(currentUser.role === "sales" ? currentUser.displayName : "Sam");
  const [saleItems, setSaleItems] = useState<SaleItem[]>([{ sku: "", quantity: 1 }]);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [sortBy, setSortBy] = useState("sku");
  const [historyStart, setHistoryStart] = useState("");
  const [historyEnd, setHistoryEnd] = useState("");
  const [consumptionSku, setConsumptionSku] = useState<string | null>(null);
  const [reportingLoss, setReportingLoss] = useState<InventoryItem | null>(null);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [editingInventory, setEditingInventory] = useState<InventoryItem | null>(null);
  const canCreateOrder = currentUser.role === "sales" || currentUser.role === "admin";
  const canAddStock = inventoryRoleCanAddStock(currentUser.role);
  const canManageStock = currentUser.role === "admin";
  const inventoryAdminActive = canManageStock && data.admin;
  const refresh = async () => {
    const response = await fetch("/api/inventory/operations", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load inventory.");
    setData(await readJsonResponse<ApiState>(response));
  };

  useEffect(() => {
    let active = true;
    fetch("/api/inventory/operations", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load inventory.");
        return readJsonResponse<ApiState>(response);
      })
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setToast("Inventory is temporarily unavailable. Refresh the page to try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 3200);
  };

  const mutate = async (body: unknown) => {
    setBusy(true);
    try {
      const response = await fetch("/api/inventory/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readJsonResponse<{ error?: unknown; receivedQuantity?: unknown }>(response);
      if (!response.ok) throw new Error(toEnglishApiMessage(result.error));
      window.dispatchEvent(new CustomEvent("erp:inventory-updated"));
      await refresh();
      return result;
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(
    () =>
      data.inventory.reduce(
        (sum, item) => ({
          onHand: sum.onHand + item.on_hand,
          pending: sum.pending + item.pending,
          available: sum.available + item.available,
        }),
        { onHand: 0, pending: 0, available: 0 },
      ),
    [data.inventory],
  );

  const historyGroups = useMemo(
    () => groupOrderRows(data.deliveryHistory).filter((group) => group.primary.delivered_at
      && isWithinDateRange(group.primary.delivered_at, historyStart, historyEnd)),
    [data.deliveryHistory, historyStart, historyEnd],
  );
  const filteredLossHistory = useMemo(
    () => data.lossHistory.filter((loss) => isWithinDateRange(loss.created_at, historyStart, historyEnd)),
    [data.lossHistory, historyStart, historyEnd],
  );
  const skuHistoryEntries = useMemo<SkuHistoryEntry[]>(
    () => consumptionSku ? [
      ...data.deliveryHistory
        .filter((order) => order.sku === consumptionSku && order.delivered_at)
        .map((order) => ({
          key: `delivery-${order.id}`,
          kind: "delivered" as const,
          createdAt: order.delivered_at as string,
          title: order.customer,
          detail: order.address || "",
          quantity: order.quantity,
        })),
      ...data.lossHistory
        .filter((loss) => loss.sku === consumptionSku)
        .map((loss) => ({
          key: `loss-${loss.id}`,
          kind: "loss" as const,
          createdAt: loss.created_at,
          title: loss.reason,
          detail: loss.actor,
          quantity: loss.quantity,
        })),
      ...(data.projectConsumptionHistory || [])
        .filter((entry) => entry.sku === consumptionSku)
        .map((entry) => ({
          key: `project-installation-${entry.id}`,
          kind: "installed" as const,
          createdAt: entry.created_at,
          title: entry.customer,
          detail: entry.address,
          quantity: entry.quantity,
        })),
    ].sort((a, b) => databaseTimestamp(b.createdAt).getTime() - databaseTimestamp(a.createdAt).getTime()) : [],
    [consumptionSku, data.deliveryHistory, data.lossHistory, data.projectConsumptionHistory],
  );
  const filteredInventory = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return data.inventory
      .filter((item) => !keyword || item.sku.toLowerCase().includes(keyword))
      .filter((item) => categoryFilter === "all" || item.category === categoryFilter)
      .filter((item) => stockFilter === "all" || item.status === stockFilter)
      .sort((a, b) => {
        const orderingPriority = Number(b.status === "订购中") - Number(a.status === "订购中");
        if (orderingPriority) return orderingPriority;
        if (sortBy === "available-asc") return a.available - b.available;
        if (sortBy === "available-desc") return b.available - a.available;
        return a.sku.localeCompare(b.sku);
      });
  }, [data.inventory, search, categoryFilter, stockFilter, sortBy]);

  const handleSale = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (saleItems.some((item) => !item.sku || item.quantity < 1)) {
      notify("Complete every item");
      return;
    }
    try {
      await mutate({
        action: "sale",
        salesRep: orderActor,
        customer: form.get("customer"),
        phone: form.get("phone"),
        address: form.get("address"),
        deliveryTime: form.get("deliveryTime"),
        items: saleItems,
        note: form.get("note"),
      });
      formElement.reset();
      setSaleItems([{ sku: "", quantity: 1 }]);
      notify("Order submitted for PM Review and inventory reserved");
      setView("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not submit the order.");
    }
  };

  const changeStatus = async (sku: string, status: string) => {
    try {
      const result = await mutate({ action: "setStatus", sku, status });
      notify(typeof result.receivedQuantity === "number" && result.receivedQuantity > 0
        ? `Status updated and ${result.receivedQuantity} units moved from Pending to on-hand stock`
        : "Status updated");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Update failed");
    }
  };

  const loginAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await mutate({ action: "adminLogin", password: adminPassword });
      setAdminPassword("");
      setShowAdminLogin(false);
      notify("Admin mode enabled");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Incorrect password");
    }
  };

  const logoutAdmin = async () => {
    try {
      await mutate({ action: "adminLogout" });
      notify("Admin mode disabled");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Sign out failed");
    }
  };

  const deleteSku = async (sku: string) => {
    if (!window.confirm(`Delete SKU ${sku}?`)) return;
    try {
      await mutate({ action: "deleteSku", sku });
      notify("SKU deleted");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Delete failed");
    }
  };

  const handleInventoryEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingInventory) return;
    const form = new FormData(event.currentTarget);
    try {
      await mutate({
        action: "editInventory",
        originalSku: editingInventory.sku,
        sku: form.get("sku"),
        category: form.get("category"),
        status: form.get("status"),
        onHand: Number(form.get("onHand")),
        pending: Number(form.get("pending")),
        available: Number(form.get("available")),
      });
      setEditingInventory(null);
      notify("Inventory item updated");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Update failed");
    }
  };

  const handleReportLoss = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reportingLoss) return;
    const form = new FormData(event.currentTarget);
    try {
      await mutate({
        action: "reportLoss",
        sku: reportingLoss.sku,
        quantity: Number(form.get("quantity")),
        reason: form.get("reason"),
      });
      setReportingLoss(null);
      notify("Damage recorded and inventory reduced");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not record damage");
    }
  };

  const parseArrival = () => {
    const aliases = data.inventory
      .map((item) => item.sku)
      .sort((a, b) => b.length - a.length);
    const parsedMap = new Map<string, ParsedArrival>();
    const segments = arrivalText.split(/[，,\n;；]+/).map((part) => part.trim()).filter(Boolean);

    for (const segment of segments) {
      const quantityMatch = segment.match(/(\d+)\s*(?:个|件|pcs?|units?)?\s*$/i);
      if (!quantityMatch) continue;
      const quantity = Number(quantityMatch[1]);
      const skuText = segment.slice(0, quantityMatch.index).trim()
        .replace(/^(?:今天|今日|新货|到货|入库|新增\s*sku|创建\s*sku|new\s*sku|received|receive|new\s*stock|stock)\s*/i, "")
        .replace(/\s*(?:到货|到了|入库|新增|加|有|arrived|received|add)\s*$/i, "")
        .replace(/[xX×:：]\s*$/, "")
        .trim();
      const compact = skuText.replace(/\s+/g, "").toLowerCase();
      const existingSku = aliases.find((sku) => compact === sku.replace(/\s+/g, "").toLowerCase());
      const sku = (existingSku || skuText.replace(/\s+/g, " ").toUpperCase()).trim();
      if (!sku || !quantity) continue;
      const current = parsedMap.get(sku);
      const existingItem = data.inventory.find((item) => item.sku.toLowerCase() === sku.toLowerCase());
      parsedMap.set(sku, {
        sku,
        quantity: (current?.quantity || 0) + quantity,
        isNew: !existingItem,
        category: current?.category || existingItem?.category || "其他",
      });
    }

    const parsed = [...parsedMap.values()];
    setArrivalDraft(parsed);
    if (!parsed.length) notify("No SKU and quantity found. Try: KH10 5, CQ7 S 20");
  };

  const confirmArrival = async () => {
    try {
      await mutate({ action: "arrival", mode: arrivalMode, rawText: arrivalText, items: arrivalDraft });
      setArrivalText("");
      setArrivalDraft([]);
      setArrivalMode("received");
      notify(arrivalMode === "ordered"
        ? "Order confirmed and items marked as on order"
        : "Stock received and inventory updated");
      setView("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Action failed");
    }
  };

  return (
    <section className={styles.root} lang="en">
      <div className="module-toolbar">
        <div className="module-heading">
          <h1>Inventory management</h1>
        </div>
        <div className="module-toolbar-actions">
          <div className="topbar-stats">
            <span>{"Stock"} <b>{loading ? "—" : totals.onHand}</b></span>
            <span>Pending stock <b>{loading ? "—" : totals.pending}</b></span>
          </div>
          {canManageStock ? (
            <button
              className={`admin-toggle ${inventoryAdminActive ? "active" : ""}`}
              onClick={() => inventoryAdminActive ? logoutAdmin() : setShowAdminLogin(true)}
              disabled={busy}
            >
              {inventoryAdminActive ? "Exit admin" : "Admin"}
            </button>
          ) : null}
        </div>
      </div>

      <nav className="nav-tabs" aria-label={"Primary navigation"}>
        {([
          ["overview", "Inventory"],
          ["sale", "New Order"],
          ["arrival", "New Stock"],
          ["history", "History"],
        ] as [View, string][]).filter(([key]) => (
          key !== "sale" || canCreateOrder
        ) && (
          key !== "arrival" || canAddStock
        )).map(([key, label]) => (
          <button
            key={key}
            className={view === key ? "active" : ""}
            aria-current={view === key ? "page" : undefined}
            onClick={() => setView(key)}
          >
            <strong>{label}</strong>
          </button>
        ))}
      </nav>

      <section className="workspace">
        {view === "overview" && (
          <>
            <div className="section-heading">
              <div><h2>{"Inventory"}</h2></div>
              {canCreateOrder ? <button className="primary small" onClick={() => setView("sale")}>＋ New Order</button> : null}
            </div>
            <div className="stats">
              <article><span>{"On hand"}</span><strong>{totals.onHand}</strong></article>
              <article className="amber"><span>Pending stock</span><strong>{totals.pending}</strong></article>
              <article className="green"><span>{"Available"}</span><strong>{totals.available}</strong></article>
              <article><span>SKU count</span><strong>{data.inventory.length}</strong></article>
            </div>
            <div className="table-card">
              <div className="filter-bar">
                <input
                  aria-label={"Search SKU"}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={"Search SKU…"}
                />
                <select aria-label={"Category"} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                  <option value="all">{"All categories"}</option>
                  <option value="电池">{"Battery"}</option>
                  <option value="太阳能板">{"Solar panel"}</option>
                  <option value="逆变器">{"Inverter"}</option>
                  <option value="安装配件">{"Installation accessories"}</option>
                  <option value="其他">{"Other"}</option>
                </select>
                <select aria-label={"Stock status"} value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}>
                  <option value="all">{"All status"}</option>
                  <option value="充足">{"Sufficient"}</option>
                  <option value="积压">{"Overstock"}</option>
                  <option value="低库存">{"Low stock"}</option>
                  <option value="订购中">{"On order"}</option>
                </select>
                <select aria-label={"Sort"} value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                  <option value="sku">{"Sort by SKU"}</option>
                  <option value="available-asc">{"Available: low to high"}</option>
                  <option value="available-desc">{"Available: high to low"}</option>
                </select>
              </div>
              <div className="table-title"><h3>{"All SKUs"}</h3><span>{filteredInventory.length} SKU</span></div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>{"SKU"}</th><th>{"Category"}</th><th>{"On hand"}</th><th>Pending</th><th>{"Available"}</th><th>Consumption</th><th>{"Status"}</th>{inventoryAdminActive && <th>{"Manage"}</th>}</tr></thead>
                  <tbody>
                    {filteredInventory.map((item) => (
                      <tr key={item.sku}>
                        <td>
                          <button type="button" className="sku-link" onClick={() => setConsumptionSku(item.sku)}>
                            {item.sku}
                          </button>
                        </td>
                        <td><span className={`category-badge ${categoryClass(item.category)}`}>{translateCategory(item.category)}</span></td>
                        <td className="stock-number">{item.on_hand}</td>
                        <td className="stock-number pending-number">{item.pending}</td>
                        <td className="stock-number">{item.available}</td>
                        <td className="stock-number consumption-number">{item.consumption}</td>
                        <td>
                          {inventoryAdminActive ? (
                            <select
                              className={`status-select ${statusClass(item.status)}`}
                              aria-label={`${item.sku} ${"status"}`}
                              value={item.status}
                              disabled={busy}
                              onChange={(event) => changeStatus(item.sku, event.target.value)}
                            >
                              <option value="充足">{"Sufficient"}</option>
                              <option value="积压">{"Overstock"}</option>
                              <option value="低库存">{"Low stock"}</option>
                              <option value="订购中">{"On order"}</option>
                            </select>
                          ) : (
                            <span className={`status-label ${statusClass(item.status)}`}>
                              {translateStatus(item.status)}
                            </span>
                          )}
                        </td>
                        {inventoryAdminActive && (
                          <td>
                            <div className="inventory-actions">
                              <button className="edit-mini" disabled={busy} onClick={() => setEditingInventory(item)}>
                                {"Edit"}
                              </button>
                              <button
                                className="loss-mini"
                                disabled={busy || item.available < 1}
                                onClick={() => setReportingLoss(item)}
                              >
                                {"Damage"}
                              </button>
                              <button className="delete-mini" disabled={busy} onClick={() => deleteSku(item.sku)}>
                                {"Delete"}
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {view === "sale" && (
          <div className="form-layout">
            <h2>New Order</h2>
            <form className="panel form-grid" onSubmit={handleSale}>
              <label>{"Created by"}<select value={orderActor} onChange={(event) => setOrderActor(event.target.value)} disabled={currentUser.role === "sales"} required>{currentUser.role === "sales" ? <option>{currentUser.displayName}</option> : <><option>Sam</option><option>RuiHan</option><option>Hogan</option><option>Kevin</option></>}</select></label>
              <label>{"Customer"}<input name="customer" placeholder="ABC Energy" required /></label>
              <label>{"Phone"}<input name="phone" placeholder="04xx xxx xxx" /></label>
              <label>{"Delivery address"}<input name="address" placeholder={"Full delivery address"} required /></label>
              <label>{"Note"}<input name="note" placeholder={"Optional"} /></label>
              <label>{"Estimated delivery time"}
                <select name="deliveryTime" defaultValue="09:00" required>
                  {DELIVERY_TIME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <div className="sale-items">
                <div className="sale-items-heading">
                  <h3>{"Items"}</h3>
                  <button
                    type="button"
                    className="add-line"
                    onClick={() => setSaleItems((items) => [...items, { sku: "", quantity: 1 }])}
                  >
                    ＋ {"Add item"}
                  </button>
                </div>
                {saleItems.map((line, index) => (
                  <div className="sale-item-row" key={index}>
                    <label>{"SKU"}
                      <select
                        value={line.sku}
                        required
                        onChange={(event) => setSaleItems((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, sku: event.target.value } : item))}
                      >
                        <option value="">{"Select SKU"}</option>
                        {data.inventory.map((item) => <option key={item.sku}>{item.sku}</option>)}
                      </select>
                    </label>
                    <label>{"Quantity"}
                      <input
                        type="number"
                        min="1"
                        value={line.quantity}
                        required
                        onChange={(event) => setSaleItems((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(event.target.value) } : item))}
                      />
                    </label>
                    <button
                      type="button"
                      className="remove-line"
                      aria-label={"Remove item"}
                      disabled={saleItems.length === 1}
                      onClick={() => setSaleItems((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button className="primary full" disabled={busy}>Submit for PM Review</button>
            </form>
          </div>
        )}

        {view === "arrival" && (
          <div className="arrival-layout">
            <h2>New Stock</h2>
            <div className="panel">
              <label className="textarea-label">{"Received items"}<textarea value={arrivalText} onChange={(event) => setArrivalText(event.target.value)} placeholder={"Enter SKUs and quantities…"} /></label>
              <button className="secondary full" onClick={parseArrival} disabled={!arrivalText.trim()}>{"Parse items"}</button>
              {arrivalDraft.length > 0 && (
                <div className="confirm-box">
                  <div className="confirm-title"><h3>{"Confirm"}</h3><span>{"Not saved"}</span></div>
                  <fieldset className="arrival-mode">
                    <legend>{"Action"}</legend>
                    <label className={arrivalMode === "received" ? "selected" : ""}>
                      <input
                        type="radio"
                        name="arrivalMode"
                        value="received"
                        checked={arrivalMode === "received"}
                        onChange={() => setArrivalMode("received")}
                      />
                      <span><b>{"Receive into on-hand"}</b></span>
                    </label>
                    <label className={`ordered ${arrivalMode === "ordered" ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="arrivalMode"
                        value="ordered"
                        checked={arrivalMode === "ordered"}
                        onChange={() => setArrivalMode("ordered")}
                      />
                      <span><b>{"Record as Pending"}</b></span>
                    </label>
                  </fieldset>
                  {arrivalDraft.map((item) => (
                    <div className="arrival-row" key={item.sku}>
                      <div><b>{item.sku}</b>{item.isNew && <em className="new-sku-badge">{"New SKU"}</em>}</div>
                      <select
                        className="arrival-category"
                        aria-label={`${item.sku} ${"category"}`}
                        value={item.category}
                        onChange={(event) => setArrivalDraft((current) => current.map((row) => row.sku === item.sku ? { ...row, category: event.target.value } : row))}
                      >
                        <option value="电池">{"Battery"}</option>
                        <option value="太阳能板">{"Solar panel"}</option>
                        <option value="逆变器">{"Inverter"}</option>
                        <option value="安装配件">{"Installation accessories"}</option>
                        <option value="其他">{"Other"}</option>
                      </select>
                      <span>{arrivalMode === "ordered" ? "×" : "＋"}{item.quantity}</span>
                    </div>
                  ))}
                  <button className="primary full" onClick={confirmArrival} disabled={busy}>
                    {arrivalMode === "ordered" ? "Confirm order" : "Confirm receipt"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {view === "history" && (
          <>
            <div className="section-heading">
              <div>
                <h2>{"History"}</h2>
              </div>
            </div>
            <div className="history-filters panel">
              <label>{"From"}
                <input
                  type="date"
                  value={historyStart}
                  max={historyEnd || undefined}
                  onChange={(event) => setHistoryStart(event.target.value)}
                />
              </label>
              <label>{"To"}
                <input
                  type="date"
                  value={historyEnd}
                  min={historyStart || undefined}
                  onChange={(event) => setHistoryEnd(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={!historyStart && !historyEnd}
                onClick={() => {
                  setHistoryStart("");
                  setHistoryEnd("");
                }}
              >
                {"Clear filter"}
              </button>
              <span className="history-count">
                {"Records"} <b>{historyGroups.length + filteredLossHistory.length}</b>
              </span>
            </div>
            {historyGroups.length === 0 && filteredLossHistory.length === 0 ? (
              <Empty text={"No matching history"} />
            ) : (
              <div className="history-sections">
                {historyGroups.length > 0 && (
                  <section>
                    <h3 className="history-section-title">{"Completed deliveries"}</h3>
                    <div className="driver-grid history-grid">{historyGroups.map((group) => (
                      <article className="driver-card history-card" key={group.key}>
                        <div className="driver-date">
                          <span>{"Completed"}</span>
                          <strong>{group.primary.delivered_at ? formatDateTime(group.primary.delivered_at) : "—"}</strong>
                        </div>
                        <div className="history-status">✓ {"Delivered"}</div>
                        <h3>{group.primary.customer}</h3>
                        <p>{group.primary.address}</p>
                        <div className="history-meta">
                          <span><b>{"Delivery date"}</b>{group.primary.planned_date || "—"}</span>
                          <span><b>Delivery time</b>{group.primary.delivery_time ? formatDeliveryTime(group.primary.delivery_time) : "—"}</span>
                          <span><b>{"Driver"}</b>{group.primary.driver || "—"}</span>
                          <span><b>Driver email</b>{group.primary.driver_email || "—"}</span>
                          <span><b>{"Created by"}</b>{group.primary.sales_rep}</span>
                        </div>
                        {group.primary.phone && <a href={`tel:${group.primary.phone}`}>{group.primary.phone}</a>}
                        <div className="driver-note">
                          <b>{"Note"}</b>
                          <span>{group.primary.note || "None"}</span>
                        </div>
                        <div className="product-lines">
                          {group.orders.map((order) => <div className="product-line" key={order.id}><b>{order.sku}</b><strong>× {order.quantity}</strong></div>)}
                        </div>
                      </article>
                    ))}</div>
                  </section>
                )}
                {filteredLossHistory.length > 0 && (
                  <section>
                    <h3 className="history-section-title">{"Damage records"}</h3>
                    <div className="driver-grid history-grid">{filteredLossHistory.map((loss) => (
                      <article className="driver-card history-card loss-history-card" key={loss.id}>
                        <div className="driver-date loss-date">
                          <span>{"Reported"}</span>
                          <strong>{formatDateTime(loss.created_at)}</strong>
                        </div>
                        <div className="history-status loss-status">− {"Damaged"}</div>
                        <h3>{loss.sku}</h3>
                        <div className="loss-quantity">− {loss.quantity}</div>
                        <div className="history-meta">
                          <span><b>{"Reason"}</b>{loss.reason}</span>
                          <span><b>{"Reported by"}</b>{translateActor(loss.actor)}</span>
                        </div>
                      </article>
                    ))}</div>
                  </section>
                )}
              </div>
            )}
          </>
        )}

      </section>

      {consumptionSku && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConsumptionSku(null)}>
          <div
            className="task-modal consumption-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="consumption-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="task-modal-header">
              <div>
                <h3 id="consumption-title">{consumptionSku}</h3>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label={"Close"}
                onClick={() => setConsumptionSku(null)}
              >
                ×
              </button>
            </div>
            <div className="consumption-summary-grid">
              <div className="consumption-summary">
                <span>{"Total consumption"}</span>
                <strong>{skuHistoryEntries.filter((entry) => entry.kind !== "loss").reduce((total, entry) => total + entry.quantity, 0)}</strong>
              </div>
              <div className="consumption-summary loss-summary">
                <span>{"Total damaged"}</span>
                <strong>{skuHistoryEntries.filter((entry) => entry.kind === "loss").reduce((total, entry) => total + entry.quantity, 0)}</strong>
              </div>
            </div>
            {skuHistoryEntries.length === 0 ? (
              <div className="consumption-empty">{"No delivery or damage records for this SKU"}</div>
            ) : (
              <div className="table-card consumption-table">
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{"Type"}</th>
                        <th>{"Time"}</th>
                        <th>{"Customer or reason"}</th>
                        <th>{"Details"}</th>
                        <th>{"Quantity"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {skuHistoryEntries.map((entry) => (
                        <tr key={entry.key}>
                          <td><span className={`history-type ${entry.kind === "loss" ? "loss-type" : "delivery-type"}`}>
                            {entry.kind === "loss" ? "Damaged" : entry.kind === "installed" ? "Installed" : "Delivered"}
                          </span></td>
                          <td className="log-time">{formatDateTime(entry.createdAt)}</td>
                          <td><b>{entry.title}</b></td>
                          <td>{entry.kind === "loss" ? translateActor(entry.detail) : entry.detail || "—"}</td>
                          <td className={`stock-number ${entry.kind === "loss" ? "loss-number" : "consumption-number"}`}>
                            {entry.kind === "loss" ? "− " : ""}{entry.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {reportingLoss && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setReportingLoss(null)}>
          <form
            className="task-modal loss-modal"
            onSubmit={handleReportLoss}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="task-modal-header">
              <div>
                <h3>{"Report damage"}</h3>
                <p>{"This immediately reduces available stock and saves a permanent record."}</p>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label={"Close"}
                disabled={busy}
                onClick={() => setReportingLoss(null)}
              >
                ×
              </button>
            </div>
            <div className="loss-stock-summary">
              <span><b>SKU</b>{reportingLoss.sku}</span>
              <span><b>{"Available"}</b>{reportingLoss.available}</span>
            </div>
            <div className="task-form-grid">
              <label>{"Damaged quantity"}
                <input name="quantity" type="number" min="1" max={reportingLoss.available} step="1" defaultValue="1" required />
              </label>
              <label className="task-field-wide">{"Reason"}
                <textarea name="reason" rows={3} placeholder={"For example: transit damage or physical damage"} required />
              </label>
            </div>
            <div className="modal-actions task-modal-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => setReportingLoss(null)}>{"Cancel"}</button>
              <button className="danger loss-submit" disabled={busy}>{"Confirm damage"}</button>
            </div>
          </form>
        </div>
      )}

      {editingInventory && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !busy && setEditingInventory(null)}
        >
          <form
            key={editingInventory.sku}
            className="task-modal inventory-modal"
            onSubmit={handleInventoryEdit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="task-modal-header">
              <div>
                <h3>{"Edit inventory"}</h3>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label={"Close"}
                disabled={busy}
                onClick={() => setEditingInventory(null)}
              >
                ×
              </button>
            </div>

            <div className="task-form-grid">
              <label>{"SKU"}
                <input name="sku" defaultValue={editingInventory.sku} required />
              </label>
              <label>{"Category"}
                <select name="category" defaultValue={editingInventory.category} required>
                  <option value="电池">{"Battery"}</option>
                  <option value="太阳能板">{"Solar panel"}</option>
                  <option value="逆变器">{"Inverter"}</option>
                  <option value="安装配件">{"Installation accessories"}</option>
                  <option value="其他">{"Other"}</option>
                </select>
              </label>
              <label>{"On hand"}
                <input
                  name="onHand"
                  type="number"
                  min={editingInventory.reserved}
                  step="1"
                  value={editingInventory.on_hand}
                  onChange={(event) => {
                    const onHand = Math.max(editingInventory.reserved, Number(event.target.value));
                    setEditingInventory({ ...editingInventory, on_hand: onHand, available: onHand - editingInventory.reserved });
                  }}
                  required
                />
              </label>
              <label>{"Status"}
                <select name="status" defaultValue={editingInventory.status} required>
                  <option value="充足">{"Sufficient"}</option>
                  <option value="积压">{"Overstock"}</option>
                  <option value="低库存">{"Low stock"}</option>
                  <option value="订购中">{"On order"}</option>
                </select>
              </label>
              <label>Pending
                <input
                  name="pending"
                  type="number"
                  min={editingInventory.reserved}
                  step="1"
                  value={editingInventory.pending}
                  onChange={(event) => setEditingInventory({
                    ...editingInventory,
                    pending: Math.max(editingInventory.reserved, Number(event.target.value)),
                  })}
                  required
                />
              </label>
              <label>Available
                <input
                  name="available"
                  type="number"
                  min="0"
                  step="1"
                  value={editingInventory.available}
                  onChange={(event) => {
                    const available = Math.max(0, Number(event.target.value));
                    setEditingInventory({
                      ...editingInventory,
                      available,
                      on_hand: available + editingInventory.reserved,
                    });
                  }}
                  required
                />
              </label>
            </div>

            <div className="inventory-derived">
              <span className="task-field-wide">{"Reserved by sales orders"} <b>{editingInventory.reserved}</b></span>
              <small>{"Changing On hand updates Available; changing Available updates On hand. Pending cannot be lower than sales-order reservations."}</small>
            </div>

            <div className="modal-actions task-modal-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => setEditingInventory(null)}>
                {"Cancel"}
              </button>
              <button className="primary" disabled={busy}>
                {"Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showAdminLogin && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowAdminLogin(false)}>
          <form className="admin-modal" onSubmit={loginAdmin} onMouseDown={(event) => event.stopPropagation()}>
            <h3>{"Admin mode"}</h3>
            <label>{"Password"}
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                required
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setShowAdminLogin(false)}>{"Cancel"}</button>
              <button className="primary" disabled={busy}>{"Enter"}</button>
            </div>
          </form>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><span>✓</span><h3>{text}</h3></div>;
}

function toEnglishApiMessage(value: unknown, fallback = "The operation could not be completed.") {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) return fallback;

  const exactMessages: Record<string, string> = {
    "管理员密码尚未配置": "The administrator password has not been configured.",
    "管理员密码错误": "The administrator password is incorrect.",
    "需要管理员权限": "Administrator access is required.",
    "型号无效": "The SKU is invalid.",
    "库存类别无效": "The inventory category is invalid.",
    "库存状态无效": "The inventory status is invalid.",
    "实际库存必须是非负整数": "On-hand stock must be a non-negative whole number.",
    "Pending 必须是非负整数": "Pending stock must be a non-negative whole number.",
    "Available 必须是非负整数": "Available stock must be a non-negative whole number.",
    "找不到这个型号": "The SKU could not be found.",
    "新型号已经存在": "The new SKU already exists.",
    "Pending 高于订单预留数量时，状态必须选择 On order": "Select On order when Pending exceeds sales-order reservations.",
    "报损数量必须是正整数": "The damaged quantity must be a positive whole number.",
    "请填写报损原因": "Enter a reason for the damage.",
    "此型号仍有 Pending 或待送订单，暂时不能删除": "This SKU still has pending or scheduled orders and cannot be deleted.",
    "商品型号或数量有误": "An item SKU or quantity is invalid.",
    "请至少添加一个商品": "Add at least one item.",
    "请填写送货地址": "Enter a delivery address.",
    "请选择 9:00 AM 至 5:00 PM 的预计送达时间": "Select an estimated delivery time from 9:00 AM to 5:00 PM.",
    "没有可入库的项目": "There are no stock items to process.",
    "入库内容有误": "The stock receipt contains invalid data.",
    "不支持的操作": "This operation is not supported.",
  };
  if (exactMessages[message]) return exactMessages[message];

  const reservedOnHand = message.match(/^实际库存不能低于销售订单已预留数量 (\d+)$/);
  if (reservedOnHand) return `On-hand stock cannot be lower than the ${reservedOnHand[1]} units reserved by sales orders.`;
  const reservedPending = message.match(/^Pending 不能低于销售订单已预留数量 (\d+)$/);
  if (reservedPending) return `Pending stock cannot be lower than the ${reservedPending[1]} units reserved by sales orders.`;
  const requiredAvailable = message.match(/^Available 必须等于 On hand 减去订单预留数量，目前应为 (-?\d+)$/);
  if (requiredAvailable) return `Available must equal On hand minus sales-order reservations. It should currently be ${requiredAvailable[1]}.`;
  const maximumDamage = message.match(/^最多只能报损当前可用库存 (-?\d+)$/);
  if (maximumDamage) return `You can report damage for at most ${maximumDamage[1]} currently available units.`;
  const saleStock = message.match(/^(.+?) 可销售库存不足，目前只剩 (-?\d+)$/);
  if (saleStock) return `${saleStock[1]} has insufficient sellable stock; ${saleStock[2]} units remain.`;
  return /\p{Script=Han}/u.test(message) ? fallback : message;
}

function groupOrderRows(orders: Order[]): OrderGroup[] {
  const groups = new Map<string, Order[]>();
  for (const order of orders) {
    const key = order.order_group || [
      "legacy",
      order.sales_rep,
      order.customer,
      order.phone || "",
      order.address || "",
      order.created_at,
      order.note || "",
    ].join(":");
    groups.set(key, [...(groups.get(key) || []), order]);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, orders: rows, primary: rows[0] }));
}

function formatDeliveryTime(value: string) {
  return DELIVERY_TIME_OPTIONS.find((option) => option.value === value)?.label || value;
}

function formatDateTime(value: string) {
  return databaseTimestamp(value).toLocaleString("en-AU", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function databaseTimestamp(value: string) {
  return new Date(`${value.replace(" ", "T")}Z`);
}

function isWithinDateRange(value: string, startDate: string, endDate: string) {
  const timestamp = databaseTimestamp(value).getTime();
  const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  return timestamp >= start && timestamp <= end;
}

function translateActor(value: string) {
  const translations: Record<string, string> = {
    "采购": "Purchasing",
    "司机": "Driver",
    "系统": "System",
    "管理员": "Administrator",
  };
  return translations[value] || value;
}

function translateCategory(category: string) {
  const categories: Record<string, string> = {
    "电池": "Battery",
    "太阳能板": "Solar panel",
    "逆变器": "Inverter",
    "安装配件": "Installation accessories",
    "其他": "Other",
  };
  return categories[category] || category;
}

function categoryClass(category: string) {
  const classes: Record<string, string> = {
    "电池": "category-battery",
    "太阳能板": "category-solar",
    "逆变器": "category-inverter",
    "安装配件": "category-accessory",
    "其他": "category-other",
  };
  return classes[category] || "category-other";
}

function statusClass(status: string) {
  if (status === "订购中") return "status-ordering";
  if (status === "积压") return "status-overstock";
  if (status === "低库存" || status === "缺货") return "status-low";
  return "status-sufficient";
}

function translateStatus(status: string) {
  const statuses: Record<string, string> = {
    "充足": "Sufficient",
    "积压": "Overstock",
    "低库存": "Low stock",
    "订购中": "On order",
    "缺货": "Out of stock",
  };
  return statuses[status] || status;
}
