/** Status values used by the existing Inventory application. */
export type InventoryStatus = "充足" | "低库存" | "订购中" | "积压" | "缺货";

export interface InventoryItem {
  sku: string;
  category: string;
  status: InventoryStatus;
  on_hand: number;
  reserved: number;
  pending: number;
  available: number;
  consumption: number;
}

export type OrderStatus = "pending" | "scheduled" | "delivered" | "cancelled";

export interface Order {
  id: number;
  order_group: string | null;
  sales_rep: string;
  customer: string;
  phone: string;
  sku: string;
  quantity: number;
  created_at: string;
  status: OrderStatus;
  address: string;
  planned_date: string | null;
  driver: string | null;
  delivered_at: string | null;
  note: string;
  driver_email: string | null;
  delivery_time: string | null;
}

export interface InventoryLoss {
  id: number;
  sku: string;
  quantity: number;
  reason: string;
  actor: string;
  created_at: string;
}

export interface InventoryLog {
  id: number;
  actor: string;
  action: string;
  detail: string;
  created_at: string;
}

/** Composite state returned by GET /api/inventory on the source application. */
export interface ApiState {
  inventory: InventoryItem[];
  orders: Order[];
  deliveryHistory: Order[];
  lossHistory: InventoryLoss[];
  logs: InventoryLog[];
  admin: boolean;
}

export interface OrderGroup {
  key: string;
  orders: Order[];
  primary: Order;
}

/**
 * Groups the line-level order records used by the source application into one
 * customer order. Legacy records without order_group receive a deterministic
 * composite key, matching the source application's grouping behaviour.
 */
export function groupOrders(orders: readonly Order[]): OrderGroup[] {
  const grouped = new Map<string, Order[]>();

  for (const order of orders) {
    const key =
      order.order_group ||
      [
        "legacy",
        order.sales_rep,
        order.customer,
        order.phone || "",
        order.address || "",
        order.created_at,
        order.note || "",
      ].join(":");

    const group = grouped.get(key);
    if (group) group.push(order);
    else grouped.set(key, [order]);
  }

  return [...grouped.entries()].map(([key, groupedOrders]) => ({
    key,
    orders: groupedOrders,
    primary: groupedOrders[0],
  }));
}

export type InventoryOperationAction =
  | "adminLogin"
  | "adminLogout"
  | "editInventory"
  | "reportLoss"
  | "deleteSku"
  | "deleteLog"
  | "clearLogs"
  | "sale"
  | "setStatus"
  | "cancelOrder"
  | "cancelDelivery"
  | "recallDelivery"
  | "schedule"
  | "editTask"
  | "deliver"
  | "arrival";
