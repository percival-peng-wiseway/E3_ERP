import type { AppSettings, BatteryItem, CatalogItem, QuoteInputs } from "./model";

const sigResidentialInverters: CatalogItem[] = [
  { name: "SigenStor EC 5.0 SP", description: "Sigen Energy Controller 5.0 kW Single Phase", cost: 1289.28 },
  { name: "SigenStor EC 6.0 SP", description: "Sigen Energy Controller 6.0 kW Single Phase", cost: 1393.92 },
  { name: "SigenStor EC 8.0 SP", description: "Sigen Energy Controller 8.0 kW Single Phase", cost: 2382.72 },
  { name: "SigenStor EC 10.0 SP", description: "Sigen Energy Controller 10.0 kW Single Phase", cost: 2568 },
  { name: "SigenStor EC 12.0 SP", description: "Sigen Energy Controller 12.0 kW Single Phase", cost: 2754.24 },
  { name: "SigenStor EC 5.0 TP", description: "Sigen Energy Controller 5.0 kW Three Phase", cost: 2208 },
  { name: "SigenStor EC 10.0 TP", description: "Sigen Energy Controller 10.0 kW Three Phase", cost: 2556.48 },
  { name: "SigenStor EC 15.0 TP", description: "Sigen Energy Controller 15.0 kW Three Phase", cost: 3370.56 },
  { name: "SigenStor EC 20.0 TP", description: "Sigen Energy Controller 20.0 kW Three Phase", cost: 3846.72 },
  { name: "SigenStor EC 25.0 TP", description: "Sigen Energy Controller 25.0 kW Three Phase", cost: 4416 },
  { name: "SigenStor EC 30.0 TP", description: "Sigen Energy Controller 30.0 kW Three Phase", cost: 4857.6 },
];

const sigResidentialBatteries: BatteryItem[] = [
  { name: "SigenStor BAT 5.0", description: "Sigen Battery 5 kWh with LED (5.2 kWh usable)", cost: 1924.8, kwh: 5, certificates: 0 },
  { name: "SigenStor BAT 8.0", description: "Sigen Battery 8 kWh with LED (7.8 kWh usable)", cost: 2375.04, kwh: 8, certificates: 0 },
  { name: "SigenStor BAT 10.0", description: "Sigen Battery 10 kWh with LED (9.0 kWh usable)", cost: 2495.04, kwh: 10, certificates: 0 },
];

const sigCiInverters: CatalogItem[] = [
  { name: "Sigen PV 50M1-AU", description: "Sigen PV Inverter 50kW", cost: 3864 },
  { name: "Sigen PV 99.9M1-AU", description: "Sigen PV Inverter 100kW", cost: 6292.8 },
  { name: "Sigen PV 110M1-AU", description: "Sigen PV Inverter 110kW", cost: 6458.88 },
  { name: "Sigen PV 125M1-AU", description: "Sigen PV Inverter 125kW", cost: 6844.8 },
  { name: "Sigen PV 50M1-HYA-AU", description: "Sigen Hybrid Inverter 50kW HYA (no back up function)", cost: 4692.48 },
  { name: "Sigen PV 99.9M1-HYA-AU", description: "Sigen Hybrid Inverter 100kW HYA (no back up function)", cost: 7176 },
  { name: "Sigen PV 110M1-HYA-AU", description: "Sigen Hybrid Inverter 110kW HYA (no back up function)", cost: 7342.08 },
  { name: "Sigen PV 125M1-HYA-AU", description: "Sigen Hybrid Inverter 125kW HYA (no back up function)", cost: 7728 },
  { name: "Sigen PV 50M1-HYB-AU", description: "Sigen Hybrid Inverter 50kW HYB (back up function)", cost: 7673.28 },
  { name: "Sigen PV 99.9M1-HYB-AU", description: "Sigen Hybrid Inverter 100kW HYB (back up function)", cost: 10156.8 },
  { name: "Sigen PV 110M1-HYB-AU", description: "Sigen Hybrid Inverter 110kW HYB (back up function)", cost: 10322.88 },
  { name: "Sigen PV 125M1-HYB-AU", description: "Sigen Hybrid Inverter 125kW HYB (back up function)", cost: 10708.8 },
];

const sigCiBatteries: BatteryItem[] = [
  { name: "SigenStack BAT 12.0", description: "SigenStack Battery 12.0 kWh", cost: 3582.72, kwh: 12, certificates: 0 },
  { name: "SigenStack BC M2-0.5C", description: "SigenStack Battery Controller M2 - 0.5C", cost: 3864, kwh: 0, certificates: 0 },
  { name: "SigenStack BC M2-0.5C-BST", description: "SigenStack Battery Controller M2 - 0.5C - BST", cost: 4968, kwh: 0, certificates: 0 },
  { name: "SigenStack BC M2-1C-BST", description: "SigenStack Battery Controller M2 - 1C - BST", cost: 7728, kwh: 0, certificates: 0 },
  { name: "SigenStack Cover", description: "Sigen Battery Cover", cost: 303.36, kwh: 0, certificates: 0 },
  { name: "SigenStack Base 4S-0.5C", description: "Sigen Battery 4-stack Base 0.5C", cost: 3640.32, kwh: 0, certificates: 0 },
  { name: "SigenStack Base MAIN-0.5C", description: "Sigen Battery Main Base 0.5C", cost: 910.08, kwh: 0, certificates: 0 },
  { name: "SigenStack Base SUB-0.5C", description: "Sigen Battery Sub Base 0.5C", cost: 910.08, kwh: 0, certificates: 0 },
  { name: "SigenStack Base MAIN-1C", description: "Sigen Battery Main Base 1.0C", cost: 1091.52, kwh: 0, certificates: 0 },
  { name: "SigenStack Base SUB-1C", description: "Sigen Battery Sub Base 1.0C", cost: 1091.52, kwh: 0, certificates: 0 },
];

const sigGateways: CatalogItem[] = [
  { name: "Sigen Gateway Home TP", description: "Sigen Energy Gateway Home Three Phase - Promo", cost: 1512 },
  { name: "Sigen Gateway Home SP AU (Pro)", description: "New gateway with back entry", cost: 667.2 },
  { name: "Sigen Gateway Home TP AU (Pro)", description: "Simple version with 2 inverter connection", cost: 824.64 },
  { name: "Sigen Gateway C60 AU", description: "Sigen Energy Gateway C&I 60 kW - Promo", cost: 1698.24 },
  { name: "ES Gateway SP-63", description: "Customised Single Gateway with 63A up to 24kW on/off grid", cost: 2304 },
  { name: "ES Gateway SP-63 - Hybrid", description: "Customised Single Gateway with 63A up to 24kW on and off grid", cost: 3168 },
  { name: "ES Gateway SP-125", description: "Customised Single Gateway with 125A up to 24kW on/off grid", cost: 3360 },
  { name: "Sigen Gateway HomePro SP-F AU", description: "Sigen Energy Gateway Homepro Single Phase Full Backup Australia", cost: 1500.48 },
  { name: "Sigen Gateway Customized", description: "More than 2 EC per site; quote by project", cost: 0 },
];

const sigAccessories: CatalogItem[] = [
  { name: "Sigen Sensor SP-CT100", description: "Power Sensor Single Phase External CT 100A", cost: 96.96 },
  { name: "Sigen Sensor TP-CT100", description: "Power Sensor Three Phase External CT 100A", cost: 193.92 },
  { name: "Sigen Sensor TP-CT300-DH", description: "Power Sensor Three Phase External CT 300 A DH", cost: 279.36 },
  { name: "Sigen Sensor TP-CT600-DH", description: "Power Sensor Three Phase External CT 600 A DH", cost: 328.32 },
  { name: "Sigen Power Sensor TP DH-C&I", description: "Compatible with third-party CTs with secondary current 5A", cost: 291.84 },
  { name: "Sigen Sensor TP-RC300", description: "Sigen Power Sensor Three Phase External Rogowski Coil 300 A", cost: 507.84 },
  { name: "Sigen Sensor TP-RC1000", description: "Sigen Power Sensor Three Phase External Rogowski Coil 1000 A", cost: 883.2 },
  { name: "Sigen Sensor TP-RC3000", description: "Sigen Power Sensor Three Phase External Rogowski Coil 3000 A", cost: 971.52 },
  { name: "Sigen Sensor SubIG Kit AU", description: "Compatible with all Sigen power sensors", cost: 121.92 },
  { name: "Sigen 4G CommMod", description: "Sigen 4G Communication Module with 2 Year Data Plan", cost: 169.92 },
  { name: "Mounting Kit", description: "Mounting kit", cost: 193.92 },
  { name: "SigenStor Installation Kit for Wall-mount", description: "SigenStor wall-mount installation kit", cost: 193.92 },
  { name: "SigenStor Installation Kit for Ground-mount with Adjustable Feet", description: "SigenStor ground-mount installation kit", cost: 193.92 },
  { name: "SigenStack Bc Cables 4m", description: "Sigen Battery Controller Cables 4m", cost: 303.36 },
  { name: "SigenStack Installation Kit for Wall / Back-to-back Fixation", description: "SigenStack installation kit for wall/back-to-back fixation", cost: 22.08 },
  { name: "SigenStack Lifting Tool kit", description: "SigenStack Lifting Tool Kit", cost: 3700.8 },
];

export const defaultSettings: AppSettings = {
  thresholds: { approval: 0.22, target: 0.25 },
  gstRate: 0.1,
  solarStcUnitPrice: 41,
  batteryStcUnitPrice: 41,
  stcScaleFactor: 1.185,
  stcYears: 5,
  panelBatchWatts: 475,
  panelBatchCost: 125,
  accessoryCostPerKw: 95,
  solarInstallCostPerKw: 300,
  batteryInstallCost: 1800,
  deliveryCost: 200,
  blinkFee: 300,
  margins: {
    solarPanel: 0.1,
    inverter: 0.25,
    battery: 0.25,
    backup: 0.25,
    accessories: 0.25,
    solarInstallation: 0.05,
    batteryInstallation: 0.05,
    delivery: 0.25,
    acCable: 0.25,
    blinkFee: 0,
    switchboard: 0.25,
    subSwitchboard: 0.25,
    externalCommission: 0.25,
    sigGateway: 0.25,
    sigAccessories: 0.25,
  },
  inverters: [
    { name: "H1-5.0-E-G2 Single Phase Hybrid inverter 5KW", cost: 1042 },
    { name: "KH8 Single Phase Hybrid inverter 8KW", cost: 1638 },
    { name: "KH9 Single Phase Hybrid inverter 9KW", cost: 1737 },
    { name: "KH10.5 Single Phase Hybrid inverter 10.5KW", cost: 1737 },
    { name: "H3-10.0-Smart Three Phase Hybrid 10kW", cost: 1795 },
    { name: "H3-15.0-Smart Three Phase Hybrid 15kW", cost: 1853 },
    { name: "H3-15.0-Pro Three Phase Hybrid 15kW", cost: 2697 },
    { name: "H3-20.0-Pro Three Phase Hybrid 20kW", cost: 3884 },
    { name: "H3-25.0-Pro Three Phase Hybrid 25kW", cost: 4192 },
    { name: "H3-30.0-Pro Three Phase Hybrid 30kW", cost: 4820 },
    { name: "H3-50.0-Plus Three Phase Hybrid 50kW", cost: 7850 },
    { name: "H3-60.0-Pro Three Phase Hybrid 30kW", cost: 8070 },
    { name: "H3-75.0-Pro Three Phase Hybrid 30kW", cost: 8730 },
    { name: "H3-80.0-Pro Three Phase Hybrid 30kW", cost: 9465 },
    { name: "H3-100.0-Pro Three Phase Hybrid 30kW", cost: 10350 },
    { name: "H3-125.0-Pro Three Phase Hybrid 30kW", cost: 10520 },
  ],
  batteries: [
    [1, 6.96, 94], [2, 13.92, 94], [3, 20.88, 123], [4, 27.84, 151],
    [5, 34.8, 159], [6, 41.76, 166], [7, 48.72, 173], [8, 55.68, 174],
    [9, 62.64, 174], [10, 69.6, 174], [11, 76.56, 174], [12, 83.52, 174],
    [13, 90.48, 174], [14, 97.44, 174],
  ].map(([units, kwh, certificates]) => ({
    name: `${units} × Fox ESS CQ7 (${kwh} kWh)`,
    kwh,
    certificates,
    cost: units * 1479,
  })),
  sigResidentialInverters,
  sigResidentialBatteries,
  sigCiInverters,
  sigCiBatteries,
  sigGateways,
  sigAccessories,
};

type LegacyAppSettings = Omit<AppSettings,
  "solarInstallCostPerKw" | "sigResidentialInverters" | "sigResidentialBatteries" |
  "sigCiInverters" | "sigCiBatteries" | "sigGateways" | "sigAccessories"> & {
  solarInstallCostPerKw?: number;
  solarInstallCostPerWatt?: number;
  sigInverters?: CatalogItem[];
  sigBatteries?: BatteryItem[];
  sigResidentialInverters?: CatalogItem[];
  sigResidentialBatteries?: BatteryItem[];
  sigCiInverters?: CatalogItem[];
  sigCiBatteries?: BatteryItem[];
  sigGateways?: CatalogItem[];
  sigAccessories?: CatalogItem[];
};

export function normalizeSettings(input: AppSettings | LegacyAppSettings): AppSettings {
  const stored = input as AppSettings & LegacyAppSettings;
  const solarInstallCostPerKw = Number.isFinite(stored.solarInstallCostPerKw)
    ? stored.solarInstallCostPerKw
    : Number.isFinite(stored.solarInstallCostPerWatt)
      ? stored.solarInstallCostPerWatt! * 1000
      : defaultSettings.solarInstallCostPerKw;
  const normalized = {
    ...stored,
    solarInstallCostPerKw,
    margins: { ...defaultSettings.margins, ...stored.margins },
    sigResidentialInverters: Array.isArray(stored.sigResidentialInverters) ? stored.sigResidentialInverters : Array.isArray(stored.sigInverters) && stored.sigInverters.length ? stored.sigInverters : defaultSettings.sigResidentialInverters,
    sigResidentialBatteries: Array.isArray(stored.sigResidentialBatteries) ? stored.sigResidentialBatteries : Array.isArray(stored.sigBatteries) && stored.sigBatteries.length ? stored.sigBatteries : defaultSettings.sigResidentialBatteries,
    sigCiInverters: Array.isArray(stored.sigCiInverters) ? stored.sigCiInverters : defaultSettings.sigCiInverters,
    sigCiBatteries: Array.isArray(stored.sigCiBatteries) ? stored.sigCiBatteries : defaultSettings.sigCiBatteries,
    sigGateways: Array.isArray(stored.sigGateways) ? stored.sigGateways : defaultSettings.sigGateways,
    sigAccessories: Array.isArray(stored.sigAccessories) ? stored.sigAccessories : defaultSettings.sigAccessories,
  } as AppSettings & Record<string, unknown>;
  delete normalized.solarInstallCostPerWatt;
  delete normalized.sigInverters;
  delete normalized.sigBatteries;
  return normalized;
}

export const defaultQuote: QuoteInputs = {
  mode: "residential",
  equipmentBrand: "fox",
  date: "",
  customerName: "",
  phone: "",
  address: "",
  pvSize: 0,
  batteryKwh: 20.88,
  inverter: "KH8 Single Phase Hybrid inverter 8KW",
  initiator: "",
  customerBalance: 5500,
  solarVicRebate: 0,
  solarVicLoan: 0,
  discount: 0,
  manualMargins: {},
  customItems: [],
  manualCosts: {
    backup: 0,
    acCable: 0,
    switchboard: 0,
    subSwitchboard: 0,
    externalCommission: 0,
  },
};
