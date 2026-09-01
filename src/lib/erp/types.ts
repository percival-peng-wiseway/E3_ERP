export type InventoryStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  warehouse: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number;
  uom: string;
  status: InventoryStatus;
  category?: string;
  location?: string;
  unitCost?: number;
  currency?: string;
  supplier?: string;
  updatedAt?: string;
}

export type QuotationStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired";

export interface QuotationItem {
  id: string;
  sku?: string;
  description: string;
  quantity: number;
  uom: string;
  unitPrice: number;
  discount?: number;
  amount: number;
}

export interface Quotation {
  id: string;
  number: string;
  customer: string;
  customerContact?: string;
  status: QuotationStatus;
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  validUntil: string;
  createdAt: string;
  owner?: string;
  notes?: string;
  items: QuotationItem[];
}

export interface InventoryQuery {
  search?: string;
  warehouse?: string;
  status?: InventoryStatus;
  lowStockOnly?: boolean;
  limit?: number;
}

export interface QuotationQuery {
  search?: string;
  status?: QuotationStatus;
  customer?: string;
  limit?: number;
}

export type ERPDataSource = "demo" | "http" | "hybrid";

export interface DashboardMetrics {
  totalSkus: number;
  totalOnHand: number;
  totalAvailable: number;
  lowStockItems: number;
  outOfStockItems: number;
  activeQuotations: number;
  quotationValue: number;
  currency: string;
}

export interface DashboardData {
  metrics: DashboardMetrics;
  lowStock: InventoryItem[];
  recentQuotations: Quotation[];
}

export interface AgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRequest {
  message: string;
  section?: string;
  history?: AgentHistoryMessage[];
}

export interface AgentCitation {
  documentId: string;
  chunkId?: string;
  fileId?: string;
  title: string;
  version: string;
  effectiveFrom: string | null;
  source: string;
  pageNumber?: number | null;
  sourcePath?: string | null;
  headingPath?: string[];
  updatedAt?: string;
}

export interface AgentAnswer {
  answer: string;
  mode: "local" | "openai" | "kimi";
  suggestions: string[];
  citations?: AgentCitation[];
}

export interface ApiMeta {
  source: ERPDataSource;
  generatedAt: string;
  total?: number;
}
