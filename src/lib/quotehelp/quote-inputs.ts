import type { AppSettings, CatalogItem, EquipmentBrand, EquipmentSelection, QuoteInputs, QuoteMode } from "./model";

const positiveQuantity = (value: number) => Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
const selection = (id: string, model: string, quantity = 1): EquipmentSelection => ({ id, model, quantity });

export function getEquipmentCatalogs(settings: AppSettings, brand: EquipmentBrand | undefined, mode: QuoteMode = "residential") {
  if (brand !== "sig") return { inverters: settings.inverters, batteries: settings.batteries, gateways: [], accessories: [] };
  return {
    inverters: mode === "ci" ? settings.sigCiInverters : settings.sigResidentialInverters,
    batteries: mode === "ci" ? settings.sigCiBatteries : settings.sigResidentialBatteries,
    gateways: settings.sigGateways,
    accessories: settings.sigAccessories,
  };
}

const normalizeEquipmentSelections = (
  items: EquipmentSelection[] | undefined,
  catalog: CatalogItem[],
  prefix: string,
  required: boolean,
) => {
  const validModels = new Set(catalog.map((item) => item.name));
  const normalized = (items ?? []).map((item, index) => ({
    id: item.id || `${prefix}-${index + 1}`,
    model: validModels.has(item.model) ? item.model : catalog[0]?.name ?? "",
    quantity: positiveQuantity(item.quantity),
  })).filter((item) => item.model);
  return normalized.length || !required || !catalog.length
    ? normalized
    : [selection(`${prefix}-1`, catalog[0].name)];
};

export function normalizeQuoteConfiguration(inputs: QuoteInputs, settings?: AppSettings): QuoteInputs {
  const equipmentBrand: EquipmentBrand = inputs.equipmentBrand === "sig" ? "sig" : "fox";
  const mode: QuoteMode = inputs.mode === "ci" ? "ci" : "residential";
  const catalogs = settings ? getEquipmentCatalogs(settings, equipmentBrand, mode) : undefined;

  if (equipmentBrand === "sig" && catalogs) {
    const legacyInverter = inputs.inverter && catalogs.inverters.some((item) => item.name === inputs.inverter)
      ? [selection("sig-inverter-1", inputs.inverter)]
      : undefined;
    const legacyBattery = catalogs.batteries.find((item) => Math.abs(item.kwh - inputs.batteryKwh) < 0.001);
    const sigInverters = normalizeEquipmentSelections(inputs.sigInverters ?? legacyInverter, catalogs.inverters, "sig-inverter", true);
    const sigBatteries = normalizeEquipmentSelections(inputs.sigBatteries ?? (legacyBattery ? [selection("sig-battery-1", legacyBattery.name)] : undefined), catalogs.batteries, "sig-battery", true);
    const sigGateways = normalizeEquipmentSelections(inputs.sigGateways, catalogs.gateways, "sig-gateway", false);
    const sigAccessories = normalizeEquipmentSelections(inputs.sigAccessories, catalogs.accessories, "sig-accessory", false);
    const ciPvSystems = mode === "ci"
      ? inputs.ciPvSystems?.length ? inputs.ciPvSystems.map((item, index) => ({
        id: item.id || `ci-pv-${index + 1}`,
        sizeKw: Number.isFinite(item.sizeKw) ? Math.max(0, item.sizeKw) : 0,
        quantity: positiveQuantity(item.quantity),
      })) : [{ id: "ci-pv-1", sizeKw: Math.max(0, inputs.pvSize || 0), quantity: 1 }]
      : inputs.ciPvSystems;
    return syncCiLegacyFields({ ...inputs, mode, equipmentBrand, ciPvSystems, sigInverters, sigBatteries, sigGateways, sigAccessories }, settings);
  }

  if (mode !== "ci") return { ...inputs, mode, equipmentBrand };
  const fallbackInverter = inputs.inverter || catalogs?.inverters[0]?.name || "";
  const fallbackBattery = Number.isFinite(inputs.batteryKwh) ? Math.max(0, inputs.batteryKwh) : catalogs?.batteries[0]?.kwh ?? 0;
  const ciPvSystems = inputs.ciPvSystems?.length ? inputs.ciPvSystems.map((item, index) => ({
    id: item.id || `ci-pv-${index + 1}`,
    sizeKw: Number.isFinite(item.sizeKw) ? Math.max(0, item.sizeKw) : 0,
    quantity: positiveQuantity(item.quantity),
  })) : [{ id: "ci-pv-1", sizeKw: Math.max(0, inputs.pvSize || 0), quantity: 1 }];
  const ciInverters = inputs.ciInverters?.length ? inputs.ciInverters.map((item, index) => ({
    id: item.id || `ci-inverter-${index + 1}`,
    model: item.model || fallbackInverter,
    quantity: positiveQuantity(item.quantity),
  })) : [{ id: "ci-inverter-1", model: fallbackInverter, quantity: 1 }];
  const ciBatteries = inputs.ciBatteries?.length ? inputs.ciBatteries.map((item, index) => ({
    id: item.id || `ci-battery-${index + 1}`,
    kwh: Number.isFinite(item.kwh) ? Math.max(0, item.kwh) : fallbackBattery,
    quantity: positiveQuantity(item.quantity),
  })) : [{ id: "ci-battery-1", kwh: fallbackBattery, quantity: 1 }];
  return syncCiLegacyFields({ ...inputs, mode, equipmentBrand, ciPvSystems, ciInverters, ciBatteries }, settings);
}

export function syncCiLegacyFields(inputs: QuoteInputs, settings?: AppSettings): QuoteInputs {
  const pvSize = inputs.mode === "ci"
    ? (inputs.ciPvSystems ?? []).reduce((sum, item) => sum + Math.max(0, item.sizeKw) * positiveQuantity(item.quantity), 0)
    : inputs.pvSize;
  if (inputs.equipmentBrand === "sig" && settings) {
    const catalogs = getEquipmentCatalogs(settings, "sig", inputs.mode === "ci" ? "ci" : "residential");
    const batteryKwh = (inputs.sigBatteries ?? []).reduce((sum, item) => {
      const battery = catalogs.batteries.find((candidate) => candidate.name === item.model);
      return sum + (battery?.kwh ?? 0) * positiveQuantity(item.quantity);
    }, 0);
    return { ...inputs, pvSize, inverter: inputs.sigInverters?.[0]?.model ?? "", batteryKwh };
  }
  if (inputs.mode !== "ci") return inputs;
  const batteryKwh = (inputs.ciBatteries ?? []).reduce((sum, item) => sum + Math.max(0, item.kwh) * positiveQuantity(item.quantity), 0);
  const inverter = inputs.ciInverters?.[0]?.model ?? inputs.inverter;
  return { ...inputs, pvSize, batteryKwh, inverter };
}

export function setQuoteMode(inputs: QuoteInputs, mode: QuoteMode, settings: AppSettings): QuoteInputs {
  if (inputs.equipmentBrand === "sig") {
    const catalogs = getEquipmentCatalogs(settings, "sig", mode);
    return normalizeQuoteConfiguration({
      ...inputs,
      mode,
      sigInverters: catalogs.inverters[0] ? [selection("sig-inverter-1", catalogs.inverters[0].name)] : [],
      sigBatteries: catalogs.batteries[0] ? [selection("sig-battery-1", catalogs.batteries[0].name)] : [],
    }, settings);
  }
  return mode === "ci"
    ? normalizeQuoteConfiguration({ ...inputs, mode }, settings)
    : {
      ...inputs,
      mode,
      inverter: inputs.ciInverters?.[0]?.model ?? inputs.inverter,
      batteryKwh: inputs.ciBatteries?.[0]?.kwh ?? inputs.batteryKwh,
    };
}

export function setEquipmentBrand(inputs: QuoteInputs, brand: EquipmentBrand, settings: AppSettings): QuoteInputs {
  const mode = inputs.mode === "ci" ? "ci" : "residential";
  const catalogs = getEquipmentCatalogs(settings, brand, mode);
  if (brand === "sig") {
    return normalizeQuoteConfiguration({
      ...inputs,
      equipmentBrand: brand,
      sigInverters: catalogs.inverters[0] ? [selection("sig-inverter-1", catalogs.inverters[0].name)] : [],
      sigBatteries: catalogs.batteries[0] ? [selection("sig-battery-1", catalogs.batteries[0].name)] : [],
      sigGateways: [],
      sigAccessories: [],
    }, settings);
  }

  const inverter = catalogs.inverters[0]?.name ?? "";
  const batteryKwh = catalogs.batteries[0]?.kwh ?? 0;
  if (mode !== "ci") return { ...inputs, equipmentBrand: brand, inverter, batteryKwh };
  const ciInverters = (inputs.ciInverters?.length ? inputs.ciInverters : [{ id: "ci-inverter-1", model: "", quantity: 1 }])
    .map((item) => ({ ...item, model: inverter }));
  const ciBatteries = (inputs.ciBatteries?.length ? inputs.ciBatteries : [{ id: "ci-battery-1", kwh: 0, quantity: 1 }])
    .map((item) => ({ ...item, kwh: batteryKwh }));
  return syncCiLegacyFields({ ...inputs, equipmentBrand: brand, inverter, batteryKwh, ciInverters, ciBatteries }, settings);
}

export function updatePvSize(inputs: QuoteInputs, pvSize: number): QuoteInputs {
  const manualCosts = { ...inputs.manualCosts };
  delete manualCosts.accessories;
  delete manualCosts.solarInstallation;
  return { ...inputs, pvSize: Number.isFinite(pvSize) ? Math.max(0, pvSize) : 0, manualCosts };
}
