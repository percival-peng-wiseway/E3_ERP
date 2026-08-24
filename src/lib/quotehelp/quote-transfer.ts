import { defaultQuote } from "./defaults";
import type { CiBatterySelection, CiInverterSelection, CiPvSystem, EquipmentSelection, QuoteInputs } from "./model";

export const MAX_IMPORT_QUOTES = 500;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const numberValue = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const optionalNumber = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const quantityValue = (value: unknown) => Math.max(1, Math.floor(numberValue(value, 1)));

const manualCostKeys: Array<keyof QuoteInputs["manualCosts"]> = [
  "solarPanel", "backup", "accessories", "solarInstallation", "batteryInstallation", "delivery",
  "acCable", "blinkFee", "switchboard", "subSwitchboard", "externalCommission",
];

export function extractImportedQuotePayloads(input: unknown): QuoteInputs[] {
  const rawQuotes = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.quotes)
      ? input.quotes
      : null;

  if (!rawQuotes) throw new Error("Select a valid E3 quotes Excel file");
  if (rawQuotes.length === 0) throw new Error("The import file does not contain any quotes");
  if (rawQuotes.length > MAX_IMPORT_QUOTES) throw new Error(`A maximum of ${MAX_IMPORT_QUOTES} quotes can be imported at once`);

  return rawQuotes.map((entry, index) => normalizeImportedQuote(entry, index));
}

function normalizeImportedQuote(entry: unknown, index: number): QuoteInputs {
  const record = isRecord(entry) ? entry : {};
  const raw = isRecord(record.payload) ? record.payload : record;
  const customerName = stringValue(raw.customerName).trim();
  if (!customerName) throw new Error(`Quote ${index + 1} needs a customer name`);

  const rawManualCosts = isRecord(raw.manualCosts) ? raw.manualCosts : {};
  const manualCosts = { ...defaultQuote.manualCosts };
  manualCostKeys.forEach((key) => {
    const value = optionalNumber(rawManualCosts[key]);
    if (value !== undefined) manualCosts[key] = value;
  });

  const rawMargins = isRecord(raw.manualMargins) ? raw.manualMargins : {};
  const manualMargins = Object.fromEntries(Object.entries(rawMargins)
    .map(([key, value]) => [key, optionalNumber(value)] as const)
    .filter((entry): entry is [string, number] => entry[1] !== undefined));

  const customItems = Array.isArray(raw.customItems) ? raw.customItems.slice(0, 100).map((item) => {
    const custom = isRecord(item) ? item : {};
    return {
      id: stringValue(custom.id).trim() || crypto.randomUUID(),
      name: stringValue(custom.name).trim() || "Custom item",
      cost: Math.max(0, numberValue(custom.cost)),
      margin: Math.max(0, numberValue(custom.margin)),
    };
  }) : [];
  const ciPvSystems: CiPvSystem[] | undefined = Array.isArray(raw.ciPvSystems) ? raw.ciPvSystems.slice(0, 50).map((item, itemIndex) => {
    const selection = isRecord(item) ? item : {};
    return {
      id: stringValue(selection.id).trim() || `import-pv-${itemIndex + 1}-${crypto.randomUUID()}`,
      sizeKw: Math.max(0, numberValue(selection.sizeKw)),
      quantity: quantityValue(selection.quantity),
    };
  }).filter((item) => item.sizeKw > 0) : undefined;
  const ciInverters: CiInverterSelection[] | undefined = Array.isArray(raw.ciInverters) ? raw.ciInverters.slice(0, 50).map((item, itemIndex) => {
    const selection = isRecord(item) ? item : {};
    return {
      id: stringValue(selection.id).trim() || `import-inverter-${itemIndex + 1}-${crypto.randomUUID()}`,
      model: stringValue(selection.model).trim(),
      quantity: quantityValue(selection.quantity),
    };
  }).filter((item) => item.model) : undefined;
  const ciBatteries: CiBatterySelection[] | undefined = Array.isArray(raw.ciBatteries) ? raw.ciBatteries.slice(0, 50).map((item, itemIndex) => {
    const selection = isRecord(item) ? item : {};
    return {
      id: stringValue(selection.id).trim() || `import-battery-${itemIndex + 1}-${crypto.randomUUID()}`,
      kwh: Math.max(0, numberValue(selection.kwh)),
      quantity: quantityValue(selection.quantity),
    };
  }).filter((item) => item.kwh > 0) : undefined;
  const equipmentSelections = (value: unknown, prefix: string): EquipmentSelection[] | undefined => Array.isArray(value)
    ? value.slice(0, 100).map((item, itemIndex) => {
      const selection = isRecord(item) ? item : {};
      return {
        id: stringValue(selection.id).trim() || `${prefix}-${itemIndex + 1}-${crypto.randomUUID()}`,
        model: stringValue(selection.model).trim(),
        quantity: quantityValue(selection.quantity),
      };
    }).filter((item) => item.model)
    : undefined;

  return {
    ...defaultQuote,
    mode: raw.mode === "ci" ? "ci" : "residential",
    equipmentBrand: raw.equipmentBrand === "sig" ? "sig" : "fox",
    date: stringValue(raw.date),
    customerName,
    phone: stringValue(raw.phone),
    address: stringValue(raw.address),
    pvSize: Math.max(0, numberValue(raw.pvSize)),
    batteryKwh: Math.max(0, numberValue(raw.batteryKwh, defaultQuote.batteryKwh)),
    inverter: stringValue(raw.inverter, defaultQuote.inverter),
    ciPvSystems,
    ciInverters,
    ciBatteries,
    sigInverters: equipmentSelections(raw.sigInverters, "import-sig-inverter"),
    sigBatteries: equipmentSelections(raw.sigBatteries, "import-sig-battery"),
    sigGateways: equipmentSelections(raw.sigGateways, "import-sig-gateway"),
    sigAccessories: equipmentSelections(raw.sigAccessories, "import-sig-accessory"),
    initiator: stringValue(raw.initiator),
    customerBalance: numberValue(raw.customerBalance, defaultQuote.customerBalance),
    solarVicRebate: Math.max(0, numberValue(raw.solarVicRebate)),
    solarVicLoan: Math.max(0, numberValue(raw.solarVicLoan)),
    discount: Math.max(0, Math.abs(numberValue(raw.discount))),
    manualSolarStc: optionalNumber(raw.manualSolarStc),
    manualBatteryStc: optionalNumber(raw.manualBatteryStc),
    manualMargins,
    customItems,
    manualCosts,
  };
}
