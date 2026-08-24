export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  warehouse: string;
  location: string;
  unit: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
  reorderLevel: number;
  unitCost: number;
  currency: string;
  supplier: string;
  lastUpdated: string;
}

export interface InventoryItemWithStatus extends InventoryItem {
  stockStatus: StockStatus;
}

export type QuotationStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

export interface QuotationLine {
  id: string;
  inventoryItemId?: string;
  sku?: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
}

export interface Quotation {
  id: string;
  quotationNumber: string;
  customerId: string;
  customerName: string;
  contactName: string;
  status: QuotationStatus;
  issueDate: string;
  validUntil: string;
  currency: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  owner: string;
  notes: string;
  items: QuotationLine[];
}

export const inventoryItems: readonly InventoryItem[] = [
  {
    id: "item-001",
    sku: "FAST-M8-SS",
    name: "M8 Stainless Steel Bolt",
    description: "M8 industrial stainless steel fastener",
    category: "Fasteners",
    warehouse: "Melbourne Main Warehouse",
    location: "A-01-03",
    unit: "pcs",
    quantityOnHand: 840,
    quantityReserved: 120,
    quantityAvailable: 720,
    reorderLevel: 300,
    unitCost: 0.42,
    currency: "AUD",
    supplier: "Southern Fasteners",
    lastUpdated: "2026-08-20T05:12:00.000Z"
  },
  {
    id: "item-002",
    sku: "MOTOR-2P2KW",
    name: "2.2kW Three-Phase Motor",
    description: "2.2kW industrial three-phase induction motor",
    category: "Drives",
    warehouse: "Melbourne Main Warehouse",
    location: "B-02-01",
    unit: "units",
    quantityOnHand: 18,
    quantityReserved: 6,
    quantityAvailable: 12,
    reorderLevel: 20,
    unitCost: 438,
    currency: "AUD",
    supplier: "Motion Pacific",
    lastUpdated: "2026-08-20T04:48:00.000Z"
  },
  {
    id: "item-003",
    sku: "PLC-S7-1200",
    name: "S7-1200 PLC Module",
    description: "Siemens S7-1200 series PLC control module",
    category: "Automation Control",
    warehouse: "Melbourne Main Warehouse",
    location: "C-01-02",
    unit: "units",
    quantityOnHand: 4,
    quantityReserved: 4,
    quantityAvailable: 0,
    reorderLevel: 5,
    unitCost: 965,
    currency: "AUD",
    supplier: "Automation Direct AU",
    lastUpdated: "2026-08-20T03:55:00.000Z"
  },
  {
    id: "item-004",
    sku: "PPE-GLOVE-L",
    name: "Industrial Safety Gloves - L",
    description: "General-purpose industrial safety gloves, size L",
    category: "Personal Protective Equipment",
    warehouse: "Sydney Branch Warehouse",
    location: "S-A-04",
    unit: "pairs",
    quantityOnHand: 320,
    quantityReserved: 40,
    quantityAvailable: 280,
    reorderLevel: 150,
    unitCost: 6.8,
    currency: "AUD",
    supplier: "SafeWork Supplies",
    lastUpdated: "2026-08-19T23:16:00.000Z"
  },
  {
    id: "item-005",
    sku: "BEAR-LM25UU",
    name: "LM25UU Linear Bearing",
    description: "25mm bore linear motion bearing",
    category: "Power Transmission",
    warehouse: "Melbourne Main Warehouse",
    location: "B-05-06",
    unit: "units",
    quantityOnHand: 45,
    quantityReserved: 8,
    quantityAvailable: 37,
    reorderLevel: 30,
    unitCost: 28.5,
    currency: "AUD",
    supplier: "Motion Pacific",
    lastUpdated: "2026-08-19T22:40:00.000Z"
  },
  {
    id: "item-006",
    sku: "SERVO-750W",
    name: "750W Servo Drive",
    description: "750W industrial AC servo drive",
    category: "Drives",
    warehouse: "Melbourne Main Warehouse",
    location: "C-02-01",
    unit: "units",
    quantityOnHand: 7,
    quantityReserved: 2,
    quantityAvailable: 5,
    reorderLevel: 8,
    unitCost: 725,
    currency: "AUD",
    supplier: "Automation Direct AU",
    lastUpdated: "2026-08-19T21:10:00.000Z"
  },
  {
    id: "item-007",
    sku: "CABLE-CY4X1P5",
    name: "4×1.5mm² Shielded Cable",
    description: "Four-core flexible shielded control cable",
    category: "Electrical Materials",
    warehouse: "Sydney Branch Warehouse",
    location: "S-C-02",
    unit: "m",
    quantityOnHand: 1250,
    quantityReserved: 300,
    quantityAvailable: 950,
    reorderLevel: 500,
    unitCost: 4.9,
    currency: "AUD",
    supplier: "Cable & Controls",
    lastUpdated: "2026-08-19T18:35:00.000Z"
  },
  {
    id: "item-008",
    sku: "CYL-ISO-32X100",
    name: "ISO Cylinder 32×100",
    description: "ISO-standard pneumatic cylinder, 32mm bore and 100mm stroke",
    category: "Pneumatics",
    warehouse: "Melbourne Main Warehouse",
    location: "D-03-04",
    unit: "units",
    quantityOnHand: 26,
    quantityReserved: 10,
    quantityAvailable: 16,
    reorderLevel: 12,
    unitCost: 118,
    currency: "AUD",
    supplier: "Pneumatics Australia",
    lastUpdated: "2026-08-19T12:28:00.000Z"
  },
  {
    id: "item-009",
    sku: "CAB-800X600",
    name: "800×600 Control Cabinet",
    description: "800 × 600mm industrial electrical control cabinet",
    category: "Enclosures",
    warehouse: "Melbourne Main Warehouse",
    location: "E-01-01",
    unit: "units",
    quantityOnHand: 8,
    quantityReserved: 5,
    quantityAvailable: 3,
    reorderLevel: 4,
    unitCost: 620,
    currency: "AUD",
    supplier: "Enclosure Systems",
    lastUpdated: "2026-08-18T23:05:00.000Z"
  },
  {
    id: "item-010",
    sku: "SENS-M18-PNP",
    name: "M18 PNP Proximity Sensor",
    description: "Normally open M18 PNP inductive proximity sensor",
    category: "Sensors",
    warehouse: "Sydney Branch Warehouse",
    location: "S-B-03",
    unit: "units",
    quantityOnHand: 0,
    quantityReserved: 0,
    quantityAvailable: 0,
    reorderLevel: 15,
    unitCost: 76,
    currency: "AUD",
    supplier: "SensorTech",
    lastUpdated: "2026-08-18T05:45:00.000Z"
  },
  {
    id: "item-011",
    sku: "ALU-4040-6M",
    name: "4040 Industrial Aluminium Profile",
    description: "40 × 40mm aluminium profile for industrial framing",
    category: "Structural Materials",
    warehouse: "Sydney Branch Warehouse",
    location: "S-RACK-1",
    unit: "m",
    quantityOnHand: 480,
    quantityReserved: 80,
    quantityAvailable: 400,
    reorderLevel: 250,
    unitCost: 14.2,
    currency: "AUD",
    supplier: "Profile Solutions",
    lastUpdated: "2026-08-17T22:14:00.000Z"
  },
  {
    id: "item-012",
    sku: "SW-ESTOP-22",
    name: "22mm Emergency Stop Button",
    description: "22mm panel-mount mushroom-head emergency stop button",
    category: "Electrical Components",
    warehouse: "Melbourne Main Warehouse",
    location: "C-04-03",
    unit: "units",
    quantityOnHand: 64,
    quantityReserved: 12,
    quantityAvailable: 52,
    reorderLevel: 40,
    unitCost: 38,
    currency: "AUD",
    supplier: "Cable & Controls",
    lastUpdated: "2026-08-17T09:31:00.000Z"
  },
  {
    id: "item-013",
    sku: "PACK-600X400",
    name: "600×400 Reinforced Carton",
    description: "600 × 400mm reinforced shipping carton",
    category: "Packaging Materials",
    warehouse: "Melbourne Main Warehouse",
    location: "F-02-02",
    unit: "pcs",
    quantityOnHand: 90,
    quantityReserved: 60,
    quantityAvailable: 30,
    reorderLevel: 50,
    unitCost: 4.25,
    currency: "AUD",
    supplier: "Metro Packaging",
    lastUpdated: "2026-08-16T04:20:00.000Z"
  },
  {
    id: "item-014",
    sku: "VFD-4KW-3P",
    name: "4kW Three-Phase Variable Frequency Drive",
    description: "4kW industrial VFD for three-phase motors",
    category: "Drives",
    warehouse: "Sydney Branch Warehouse",
    location: "S-C-05",
    unit: "units",
    quantityOnHand: 11,
    quantityReserved: 3,
    quantityAvailable: 8,
    reorderLevel: 6,
    unitCost: 890,
    currency: "AUD",
    supplier: "Automation Direct AU",
    lastUpdated: "2026-08-15T07:55:00.000Z"
  }
] as const;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function quotationLine(
  id: string,
  inventoryItemId: string | undefined,
  sku: string | undefined,
  name: string,
  quantity: number,
  unit: string,
  unitPrice: number,
  discountPercent = 0
): QuotationLine {
  return {
    id,
    inventoryItemId,
    sku,
    name,
    quantity,
    unit,
    unitPrice,
    discountPercent,
    lineTotal: roundMoney(quantity * unitPrice * (1 - discountPercent / 100))
  };
}

function quotation(seed: {
  id: string;
  quotationNumber: string;
  customerId: string;
  customerName: string;
  contactName: string;
  status: QuotationStatus;
  createdAt: string;
  validUntil: string;
  owner: string;
  notes?: string;
  items: QuotationLine[];
}): Quotation {
  const grossSubtotal = roundMoney(
    seed.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  );
  const subtotal = roundMoney(seed.items.reduce((sum, item) => sum + item.lineTotal, 0));
  const taxTotal = roundMoney(subtotal * 0.1);

  return {
    id: seed.id,
    quotationNumber: seed.quotationNumber,
    customerId: seed.customerId,
    customerName: seed.customerName,
    contactName: seed.contactName,
    status: seed.status,
    issueDate: seed.createdAt.slice(0, 10),
    validUntil: seed.validUntil,
    currency: "AUD",
    subtotal,
    discountTotal: roundMoney(grossSubtotal - subtotal),
    taxTotal,
    grandTotal: roundMoney(subtotal + taxTotal),
    owner: seed.owner,
    notes: seed.notes ?? "",
    items: seed.items
  };
}

export const quotations: readonly Quotation[] = [
  quotation({
    id: "quote-098",
    quotationNumber: "QTN-2026-0098",
    customerId: "CUS-NORTHSTAR",
    customerName: "Northstar Food Systems",
    contactName: "Olivia Chen",
    status: "draft",
    createdAt: "2026-08-20T02:40:00.000Z",
    validUntil: "2026-09-19",
    owner: "Jiayi Lin",
    notes: "Packaging line safety upgrade; awaiting on-site dimension confirmation.",
    items: [
      quotationLine("qi-098-1", "item-012", "SW-ESTOP-22", "22mm Emergency Stop Button", 24, "units", 56),
      quotationLine("qi-098-2", "item-009", "CAB-800X600", "800×600 Control Cabinet", 4, "units", 910, 3),
      quotationLine("qi-098-3", undefined, undefined, "Safety Circuit Design and Commissioning", 32, "hours", 185)
    ]
  }),
  quotation({
    id: "quote-096",
    quotationNumber: "QTN-2026-0096",
    customerId: "CUS-BRIGHTON",
    customerName: "Brighton Water Services",
    contactName: "James Walker",
    status: "sent",
    createdAt: "2026-08-18T06:22:00.000Z",
    validUntil: "2026-09-15",
    owner: "Yuhang Chen",
    notes: "Phase two of the pump station control system.",
    items: [
      quotationLine("qi-096-1", "item-014", "VFD-4KW-3P", "4kW Three-Phase Variable Frequency Drive", 8, "units", 1280, 4),
      quotationLine("qi-096-2", "item-003", "PLC-S7-1200", "S7-1200 PLC Module", 3, "units", 1480),
      quotationLine("qi-096-3", undefined, undefined, "Control Programming and On-Site Commissioning", 72, "hours", 190)
    ]
  }),
  quotation({
    id: "quote-094",
    quotationNumber: "QTN-2026-0094",
    customerId: "CUS-CRESTLINE",
    customerName: "Crestline Fabrication",
    contactName: "Mia Thompson",
    status: "draft",
    createdAt: "2026-08-15T01:05:00.000Z",
    validUntil: "2026-09-12",
    owner: "Jiayi Lin",
    items: [
      quotationLine("qi-094-1", "item-011", "ALU-4040-6M", "4040 Industrial Aluminium Profile", 180, "m", 22.5, 5),
      quotationLine("qi-094-2", "item-001", "FAST-M8-SS", "M8 Stainless Steel Bolt", 600, "pcs", 0.78),
      quotationLine("qi-094-3", undefined, undefined, "Frame Cutting and Assembly", 18, "hours", 165)
    ]
  }),
  quotation({
    id: "quote-091",
    quotationNumber: "QTN-2026-0091",
    customerId: "CUS-HARBOUR",
    customerName: "Harbour Packaging Group",
    contactName: "Noah Williams",
    status: "sent",
    createdAt: "2026-08-11T07:50:00.000Z",
    validUntil: "2026-09-05",
    owner: "Yuhang Chen",
    notes: "High-speed cartoning machine retrofit; approximately eight weeks lead time.",
    items: [
      quotationLine("qi-091-1", "item-006", "SERVO-750W", "750W Servo Drive", 10, "units", 1080, 5),
      quotationLine("qi-091-2", "item-002", "MOTOR-2P2KW", "2.2kW Three-Phase Motor", 6, "units", 690),
      quotationLine("qi-091-3", undefined, undefined, "Mechanical and Electrical Retrofit Package", 1, "lot", 27600)
    ]
  }),
  quotation({
    id: "quote-089",
    quotationNumber: "QTN-2026-0089",
    customerId: "CUS-VERTEX",
    customerName: "Vertex Cold Storage",
    contactName: "Ethan Brown",
    status: "rejected",
    createdAt: "2026-08-06T03:18:00.000Z",
    validUntil: "2026-08-30",
    owner: "Siyuan Zhou",
    notes: "The customer has put the project on hold.",
    items: [
      quotationLine("qi-089-1", "item-010", "SENS-M18-PNP", "M18 PNP Proximity Sensor", 30, "units", 112),
      quotationLine("qi-089-2", "item-007", "CABLE-CY4X1P5", "4×1.5mm² Shielded Cable", 400, "m", 7.4),
      quotationLine("qi-089-3", undefined, undefined, "Cold-Storage Conveyor Detection Upgrade", 1, "lot", 7200)
    ]
  }),
  quotation({
    id: "quote-087",
    quotationNumber: "QTN-2026-0087",
    customerId: "CUS-ATLAS",
    customerName: "Atlas Engineering",
    contactName: "Sophie Martin",
    status: "accepted",
    createdAt: "2026-08-02T23:35:00.000Z",
    validUntil: "2026-08-28",
    owner: "Siyuan Zhou",
    notes: "The customer has approved the quotation; awaiting sales order creation.",
    items: [
      quotationLine("qi-087-1", "item-002", "MOTOR-2P2KW", "2.2kW Three-Phase Motor", 12, "units", 675, 3),
      quotationLine("qi-087-2", "item-014", "VFD-4KW-3P", "4kW Three-Phase Variable Frequency Drive", 6, "units", 1260, 3),
      quotationLine("qi-087-3", undefined, undefined, "Electrical Control Integration and FAT Testing", 1, "lot", 10400)
    ]
  }),
  quotation({
    id: "quote-083",
    quotationNumber: "QTN-2026-0083",
    customerId: "CUS-REDGUM",
    customerName: "Redgum Logistics",
    contactName: "Jack Wilson",
    status: "expired",
    createdAt: "2026-07-22T05:16:00.000Z",
    validUntil: "2026-08-12",
    owner: "Jiayi Lin",
    items: [
      quotationLine("qi-083-1", "item-008", "CYL-ISO-32X100", "ISO Cylinder 32×100", 16, "units", 176),
      quotationLine("qi-083-2", undefined, undefined, "Pneumatic Circuit Upgrade Kit", 1, "lot", 3650)
    ]
  }),
  quotation({
    id: "quote-079",
    quotationNumber: "QTN-2026-0079",
    customerId: "CUS-PACIFIC",
    customerName: "Pacific Dairy Equipment",
    contactName: "Amelia Taylor",
    status: "accepted",
    createdAt: "2026-07-14T00:42:00.000Z",
    validUntil: "2026-08-05",
    owner: "Yuhang Chen",
    items: [
      quotationLine("qi-079-1", "item-003", "PLC-S7-1200", "S7-1200 PLC Module", 5, "units", 1460),
      quotationLine("qi-079-2", "item-006", "SERVO-750W", "750W Servo Drive", 12, "units", 1050, 4),
      quotationLine("qi-079-3", undefined, undefined, "Filling Line Control System Integration", 1, "lot", 26400)
    ]
  })
] as const;

export function getStockStatus(item: InventoryItem): StockStatus {
  if (item.quantityAvailable <= 0) {
    return "out_of_stock";
  }

  if (item.quantityAvailable <= item.reorderLevel) {
    return "low_stock";
  }

  return "in_stock";
}

export function withStockStatus(item: InventoryItem): InventoryItemWithStatus {
  return { ...item, stockStatus: getStockStatus(item) };
}
