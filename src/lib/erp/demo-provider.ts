import type { ERPProvider } from "./provider";
import type {
  InventoryItem,
  InventoryQuery,
  Quotation,
  QuotationItem,
  QuotationQuery,
  QuotationStatus,
} from "./types";

const INVENTORY: InventoryItem[] = [
  {
    id: "item-001",
    sku: "FAST-M8-SS",
    name: "M8 Stainless Steel Bolt",
    category: "Fasteners",
    warehouse: "Melbourne Main Warehouse",
    location: "A-01-03",
    onHand: 840,
    reserved: 120,
    available: 720,
    reorderLevel: 300,
    uom: "pc",
    status: "in_stock",
    unitCost: 0.42,
    currency: "AUD",
    supplier: "Southern Fasteners",
    updatedAt: "2026-08-20T05:12:00.000Z",
  },
  {
    id: "item-002",
    sku: "MOTOR-2P2KW",
    name: "2.2kW Three-Phase Motor",
    category: "Drives",
    warehouse: "Melbourne Main Warehouse",
    location: "B-02-01",
    onHand: 18,
    reserved: 6,
    available: 12,
    reorderLevel: 20,
    uom: "unit",
    status: "low_stock",
    unitCost: 438,
    currency: "AUD",
    supplier: "Motion Pacific",
    updatedAt: "2026-08-20T04:48:00.000Z",
  },
  {
    id: "item-003",
    sku: "PLC-S7-1200",
    name: "S7-1200 PLC Module",
    category: "Automation",
    warehouse: "Melbourne Main Warehouse",
    location: "C-01-02",
    onHand: 4,
    reserved: 4,
    available: 0,
    reorderLevel: 5,
    uom: "unit",
    status: "out_of_stock",
    unitCost: 965,
    currency: "AUD",
    supplier: "Automation Direct AU",
    updatedAt: "2026-08-20T03:55:00.000Z",
  },
  {
    id: "item-004",
    sku: "PPE-GLOVE-L",
    name: "Industrial Safety Gloves L",
    category: "PPE",
    warehouse: "Sydney Warehouse",
    location: "S-A-04",
    onHand: 320,
    reserved: 40,
    available: 280,
    reorderLevel: 150,
    uom: "pair",
    status: "in_stock",
    unitCost: 6.8,
    currency: "AUD",
    supplier: "SafeWork Supplies",
    updatedAt: "2026-08-19T23:16:00.000Z",
  },
  {
    id: "item-005",
    sku: "BEAR-LM25UU",
    name: "LM25UU Linear Bearing",
    category: "Power Transmission",
    warehouse: "Melbourne Main Warehouse",
    location: "B-05-06",
    onHand: 45,
    reserved: 8,
    available: 37,
    reorderLevel: 30,
    uom: "unit",
    status: "in_stock",
    unitCost: 28.5,
    currency: "AUD",
    supplier: "Motion Pacific",
    updatedAt: "2026-08-19T22:40:00.000Z",
  },
  {
    id: "item-006",
    sku: "SERVO-750W",
    name: "750W Servo Drive",
    category: "Drives",
    warehouse: "Melbourne Main Warehouse",
    location: "C-02-01",
    onHand: 7,
    reserved: 2,
    available: 5,
    reorderLevel: 8,
    uom: "unit",
    status: "low_stock",
    unitCost: 725,
    currency: "AUD",
    supplier: "Automation Direct AU",
    updatedAt: "2026-08-19T21:10:00.000Z",
  },
  {
    id: "item-007",
    sku: "CABLE-CY4X1P5",
    name: "4×1.5mm² Shielded Cable",
    category: "Electrical Materials",
    warehouse: "Sydney Warehouse",
    location: "S-C-02",
    onHand: 1250,
    reserved: 300,
    available: 950,
    reorderLevel: 500,
    uom: "metre",
    status: "in_stock",
    unitCost: 4.9,
    currency: "AUD",
    supplier: "Cable & Controls",
    updatedAt: "2026-08-19T18:35:00.000Z",
  },
  {
    id: "item-008",
    sku: "CYL-ISO-32X100",
    name: "ISO Cylinder 32×100",
    category: "Pneumatics",
    warehouse: "Melbourne Main Warehouse",
    location: "D-03-04",
    onHand: 26,
    reserved: 10,
    available: 16,
    reorderLevel: 12,
    uom: "unit",
    status: "in_stock",
    unitCost: 118,
    currency: "AUD",
    supplier: "Pneumatics Australia",
    updatedAt: "2026-08-19T12:28:00.000Z",
  },
  {
    id: "item-009",
    sku: "CAB-800X600",
    name: "800×600 Control Cabinet",
    category: "Enclosures",
    warehouse: "Melbourne Main Warehouse",
    location: "E-01-01",
    onHand: 8,
    reserved: 5,
    available: 3,
    reorderLevel: 4,
    uom: "set",
    status: "low_stock",
    unitCost: 620,
    currency: "AUD",
    supplier: "Enclosure Systems",
    updatedAt: "2026-08-18T23:05:00.000Z",
  },
  {
    id: "item-010",
    sku: "SENS-M18-PNP",
    name: "M18 PNP Proximity Sensor",
    category: "Sensors",
    warehouse: "Sydney Warehouse",
    location: "S-B-03",
    onHand: 0,
    reserved: 0,
    available: 0,
    reorderLevel: 15,
    uom: "unit",
    status: "out_of_stock",
    unitCost: 76,
    currency: "AUD",
    supplier: "SensorTech",
    updatedAt: "2026-08-18T05:45:00.000Z",
  },
  {
    id: "item-011",
    sku: "ALU-4040-6M",
    name: "4040 Industrial Aluminium Profile",
    category: "Structural Materials",
    warehouse: "Sydney Warehouse",
    location: "S-RACK-1",
    onHand: 480,
    reserved: 80,
    available: 400,
    reorderLevel: 250,
    uom: "metre",
    status: "in_stock",
    unitCost: 14.2,
    currency: "AUD",
    supplier: "Profile Solutions",
    updatedAt: "2026-08-17T22:14:00.000Z",
  },
  {
    id: "item-012",
    sku: "SW-ESTOP-22",
    name: "22mm Emergency Stop Button",
    category: "Electrical Components",
    warehouse: "Melbourne Main Warehouse",
    location: "C-04-03",
    onHand: 64,
    reserved: 12,
    available: 52,
    reorderLevel: 40,
    uom: "unit",
    status: "in_stock",
    unitCost: 38,
    currency: "AUD",
    supplier: "Cable & Controls",
    updatedAt: "2026-08-17T09:31:00.000Z",
  },
  {
    id: "item-013",
    sku: "PACK-600X400",
    name: "600×400 Reinforced Carton",
    category: "Packaging",
    warehouse: "Melbourne Main Warehouse",
    location: "F-02-02",
    onHand: 90,
    reserved: 60,
    available: 30,
    reorderLevel: 50,
    uom: "pc",
    status: "low_stock",
    unitCost: 4.25,
    currency: "AUD",
    supplier: "Metro Packaging",
    updatedAt: "2026-08-16T04:20:00.000Z",
  },
  {
    id: "item-014",
    sku: "VFD-4KW-3P",
    name: "4kW Three-Phase VFD",
    category: "Drives",
    warehouse: "Sydney Warehouse",
    location: "S-C-05",
    onHand: 11,
    reserved: 3,
    available: 8,
    reorderLevel: 6,
    uom: "unit",
    status: "in_stock",
    unitCost: 890,
    currency: "AUD",
    supplier: "Automation Direct AU",
    updatedAt: "2026-08-15T07:55:00.000Z",
  },
];

function quotationItem(
  id: string,
  sku: string | undefined,
  description: string,
  quantity: number,
  uom: string,
  unitPrice: number,
  discount = 0,
): QuotationItem {
  return {
    id,
    sku,
    description,
    quantity,
    uom,
    unitPrice,
    discount,
    amount: Math.round(quantity * unitPrice * (1 - discount / 100) * 100) / 100,
  };
}

function quotation(seed: {
  id: string;
  number: string;
  customer: string;
  customerContact: string;
  status: QuotationStatus;
  validUntil: string;
  createdAt: string;
  owner: string;
  notes?: string;
  items: QuotationItem[];
}): Quotation {
  const subtotal = Math.round(seed.items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const tax = Math.round(subtotal * 0.1 * 100) / 100;
  return {
    ...seed,
    subtotal,
    tax,
    total: Math.round((subtotal + tax) * 100) / 100,
    currency: "AUD",
  };
}

const QUOTATIONS: Quotation[] = [
  quotation({
    id: "quote-098",
    number: "QTN-2026-0098",
    customer: "Northstar Food Systems",
    customerContact: "Olivia Chen",
    status: "draft",
    validUntil: "2026-09-19",
    createdAt: "2026-08-20T02:40:00.000Z",
    owner: "Grace Lin",
    notes: "Packaging line safety upgrade; awaiting confirmation of site dimensions.",
    items: [
      quotationItem("qi-098-1", "SW-ESTOP-22", "22mm Emergency Stop Button", 24, "pc", 56),
      quotationItem("qi-098-2", "CAB-800X600", "800×600 Control Cabinet", 4, "set", 910, 3),
      quotationItem("qi-098-3", undefined, "Safety Circuit Design and Commissioning", 32, "hour", 185),
    ],
  }),
  quotation({
    id: "quote-096",
    number: "QTN-2026-0096",
    customer: "Brighton Water Services",
    customerContact: "James Walker",
    status: "sent",
    validUntil: "2026-09-15",
    createdAt: "2026-08-18T06:22:00.000Z",
    owner: "Ethan Chen",
    notes: "Phase two of the pump station control system.",
    items: [
      quotationItem("qi-096-1", "VFD-4KW-3P", "4kW Three-Phase VFD", 8, "unit", 1280, 4),
      quotationItem("qi-096-2", "PLC-S7-1200", "S7-1200 PLC Module", 3, "unit", 1480),
      quotationItem("qi-096-3", undefined, "Control Programming and On-Site Commissioning", 72, "hour", 190),
    ],
  }),
  quotation({
    id: "quote-094",
    number: "QTN-2026-0094",
    customer: "Crestline Fabrication",
    customerContact: "Mia Thompson",
    status: "draft",
    validUntil: "2026-09-12",
    createdAt: "2026-08-15T01:05:00.000Z",
    owner: "Grace Lin",
    items: [
      quotationItem("qi-094-1", "ALU-4040-6M", "4040 Industrial Aluminium Profile", 180, "metre", 22.5, 5),
      quotationItem("qi-094-2", "FAST-M8-SS", "M8 Stainless Steel Bolt", 600, "pc", 0.78),
      quotationItem("qi-094-3", undefined, "Frame Cutting and Assembly", 18, "hour", 165),
    ],
  }),
  quotation({
    id: "quote-091",
    number: "QTN-2026-0091",
    customer: "Harbour Packaging Group",
    customerContact: "Noah Williams",
    status: "sent",
    validUntil: "2026-09-05",
    createdAt: "2026-08-11T07:50:00.000Z",
    owner: "Ethan Chen",
    notes: "High-speed cartoning machine retrofit; estimated lead time is eight weeks.",
    items: [
      quotationItem("qi-091-1", "SERVO-750W", "750W Servo Drive", 10, "unit", 1080, 5),
      quotationItem("qi-091-2", "MOTOR-2P2KW", "2.2kW Three-Phase Motor", 6, "unit", 690),
      quotationItem("qi-091-3", undefined, "Mechanical and Electrical Retrofit Package", 1, "package", 27600),
    ],
  }),
  quotation({
    id: "quote-089",
    number: "QTN-2026-0089",
    customer: "Vertex Cold Storage",
    customerContact: "Ethan Brown",
    status: "rejected",
    validUntil: "2026-08-30",
    createdAt: "2026-08-06T03:18:00.000Z",
    owner: "Ryan Zhou",
    notes: "The customer has placed the project on hold.",
    items: [
      quotationItem("qi-089-1", "SENS-M18-PNP", "M18 PNP Proximity Sensor", 30, "unit", 112),
      quotationItem("qi-089-2", "CABLE-CY4X1P5", "4×1.5mm² Shielded Cable", 400, "metre", 7.4),
      quotationItem("qi-089-3", undefined, "Cold Storage Conveyor Detection Upgrade", 1, "package", 7200),
    ],
  }),
  quotation({
    id: "quote-087",
    number: "QTN-2026-0087",
    customer: "Atlas Engineering",
    customerContact: "Sophie Martin",
    status: "accepted",
    validUntil: "2026-08-28",
    createdAt: "2026-08-02T23:35:00.000Z",
    owner: "Ryan Zhou",
    notes: "Customer confirmed; awaiting sales order creation.",
    items: [
      quotationItem("qi-087-1", "MOTOR-2P2KW", "2.2kW Three-Phase Motor", 12, "unit", 675, 3),
      quotationItem("qi-087-2", "VFD-4KW-3P", "4kW Three-Phase VFD", 6, "unit", 1260, 3),
      quotationItem("qi-087-3", undefined, "Electrical Controls Integration and FAT", 1, "package", 10400),
    ],
  }),
  quotation({
    id: "quote-083",
    number: "QTN-2026-0083",
    customer: "Redgum Logistics",
    customerContact: "Jack Wilson",
    status: "expired",
    validUntil: "2026-08-12",
    createdAt: "2026-07-22T05:16:00.000Z",
    owner: "Grace Lin",
    items: [
      quotationItem("qi-083-1", "CYL-ISO-32X100", "ISO Cylinder 32×100", 16, "unit", 176),
      quotationItem("qi-083-2", undefined, "Pneumatic Circuit Upgrade Kit", 1, "package", 3650),
    ],
  }),
  quotation({
    id: "quote-079",
    number: "QTN-2026-0079",
    customer: "Pacific Dairy Equipment",
    customerContact: "Amelia Taylor",
    status: "accepted",
    validUntil: "2026-08-05",
    createdAt: "2026-07-14T00:42:00.000Z",
    owner: "Ethan Chen",
    items: [
      quotationItem("qi-079-1", "PLC-S7-1200", "S7-1200 PLC Module", 5, "unit", 1460),
      quotationItem("qi-079-2", "SERVO-750W", "750W Servo Drive", 12, "unit", 1050, 4),
      quotationItem("qi-079-3", undefined, "Filling Line Control System Integration", 1, "package", 26400),
    ],
  }),
];

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-AU");
}

function safeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  return Math.max(0, Math.floor(limit));
}

function cloneInventory(item: InventoryItem): InventoryItem {
  return { ...item };
}

function cloneQuotation(item: Quotation): Quotation {
  return { ...item, items: item.items.map((line) => ({ ...line })) };
}

export class DemoProvider implements ERPProvider {
  readonly source = "demo" as const;

  async listInventory(query: InventoryQuery = {}): Promise<InventoryItem[]> {
    let result = INVENTORY;

    if (query.search) {
      const term = normalized(query.search);
      result = result.filter((item) =>
        [item.id, item.sku, item.name, item.category, item.supplier, item.warehouse]
          .filter(Boolean)
          .some((value) => normalized(String(value)).includes(term)),
      );
    }
    if (query.warehouse) {
      const warehouse = normalized(query.warehouse);
      result = result.filter((item) => normalized(item.warehouse).includes(warehouse));
    }
    if (query.status) {
      result = result.filter((item) => item.status === query.status);
    }
    if (query.lowStockOnly) {
      result = result.filter((item) => item.status !== "in_stock");
    }

    const limit = safeLimit(query.limit);
    return (limit === undefined ? result : result.slice(0, limit)).map(cloneInventory);
  }

  async getInventoryItem(identifier: string): Promise<InventoryItem | null> {
    const term = normalized(identifier);
    const item = INVENTORY.find(
      (candidate) =>
        normalized(candidate.id) === term ||
        normalized(candidate.sku) === term ||
        normalized(candidate.name) === term,
    );
    return item ? cloneInventory(item) : null;
  }

  async listQuotations(query: QuotationQuery = {}): Promise<Quotation[]> {
    let result = QUOTATIONS;

    if (query.search) {
      const term = normalized(query.search);
      result = result.filter((item) =>
        [item.id, item.number, item.customer, item.customerContact, item.owner]
          .filter(Boolean)
          .some((value) => normalized(String(value)).includes(term)),
      );
    }
    if (query.customer) {
      const customer = normalized(query.customer);
      result = result.filter((item) => normalized(item.customer).includes(customer));
    }
    if (query.status) {
      result = result.filter((item) => item.status === query.status);
    }

    const limit = safeLimit(query.limit);
    return (limit === undefined ? result : result.slice(0, limit)).map(cloneQuotation);
  }

  async getQuotation(identifier: string): Promise<Quotation | null> {
    const term = normalized(identifier);
    const item = QUOTATIONS.find(
      (candidate) =>
        normalized(candidate.id) === term || normalized(candidate.number) === term,
    );
    return item ? cloneQuotation(item) : null;
  }
}
