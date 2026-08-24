import * as XLSX from "xlsx";
import { calculateQuote } from "./calculate";
import type { AppSettings, CalculationResult, QuoteRecord } from "./model";

export const QUOTE_EXCEL_SHEET = "Quotes";
const SUMMARY_SHEET = "Summary";
const INSTRUCTIONS_SHEET = "Instructions";

const headers = [
  "Status", "Customer Name", "Date", "Mode", "Equipment Brand", "Phone", "Address", "E3 Energy Initiator",
  "PV System Size (kW)", "Battery Size (kWh)", "Inverter", "Customer Balance (incl. GST)",
  "Solar VIC Rebate", "Solar VIC Interest Free Loan", "Discount", "Solar STC (Manual)",
  "Battery STC (Manual)", "Manual Costs JSON", "Manual Margins JSON", "Custom Items JSON",
  "Owner", "Created At", "Updated At", "E3 Payload JSON",
] as const;

type ExcelRow = Record<string, string | number>;
type UnknownRecord = Record<string, unknown>;
type ProjectSheetMetrics = {
  sheetName: string;
  totalReceivedCell: string;
  totalCostCell: string;
  grossMarginCell: string;
  grossMarginRateCell: string;
  targetBalanceCell: string;
};

const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const normalizeHeader = (value: unknown) => String(value ?? "")
  .replace(/[³₃]/g, "3")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "");
const numberOrBlank = (value: number | undefined) => Number.isFinite(value) ? value! : "";
const asNumber = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(String(value).replace(/[$,%]/g, "")) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const asText = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").trim();
const asOptionalNumber = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const parseJsonCell = (value: unknown, fallback: unknown) => {
  if (isRecord(value) || Array.isArray(value)) return value;
  const text = asText(value);
  if (!text) return fallback;
  try { return JSON.parse(text) as unknown; } catch { return fallback; }
};

export function createQuotesWorkbook(quotes: QuoteRecord[], settings: AppSettings): Uint8Array {
  const rows: ExcelRow[] = quotes.map((quote) => {
    const result = calculateQuote(quote.payload, settings);
    return {
      "Status": quote.status === "done" ? "Done" : "Drafting",
      "Customer Name": quote.payload.customerName,
      "Date": quote.payload.date,
      "Mode": quote.payload.mode === "ci" ? "C&I" : "Residential",
      "Equipment Brand": quote.payload.equipmentBrand === "sig" ? "SIG" : "FOX",
      "Phone": quote.payload.phone,
      "Address": quote.payload.address,
      "E3 Energy Initiator": quote.payload.initiator,
      "PV System Size (kW)": result.totalPvSize,
      "Battery Size (kWh)": result.totalBatteryKwh,
      "Inverter": quote.payload.mode === "ci" || quote.payload.equipmentBrand === "sig" ? result.inverterSummary : quote.payload.inverter,
      "Customer Balance (incl. GST)": quote.payload.customerBalance,
      "Solar VIC Rebate": quote.payload.solarVicRebate,
      "Solar VIC Interest Free Loan": quote.payload.solarVicLoan,
      "Discount": quote.payload.discount,
      "Solar STC (Manual)": numberOrBlank(quote.payload.manualSolarStc),
      "Battery STC (Manual)": numberOrBlank(quote.payload.manualBatteryStc),
      "Manual Costs JSON": JSON.stringify(quote.payload.manualCosts ?? {}),
      "Manual Margins JSON": JSON.stringify(quote.payload.manualMargins ?? {}),
      "Custom Items JSON": JSON.stringify(quote.payload.customItems ?? []),
      "Owner": quote.ownerName,
      "Created At": quote.createdAt,
      "Updated At": quote.updatedAt,
      "E3 Payload JSON": JSON.stringify(quote.payload),
    };
  });

  const importWorksheet = XLSX.utils.json_to_sheet(rows, { header: [...headers] });
  importWorksheet["!cols"] = headers.map((header) => ({ wch: columnWidth(header) }));
  importWorksheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(1, rows.length + 1)}` };
  (importWorksheet as XLSX.WorkSheet & { "!freeze"?: unknown })["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
  applyWorkbookFormatting(importWorksheet, rows.length);

  const instructions = XLSX.utils.aoa_to_sheet([
    ["E3 Quoter Excel Export"],
    ["Use Summary for the portfolio view and each project tab for its full quote breakdown."],
    ["Each project tab includes line-item cost, margin, sales price, funding, GST and gross-margin details."],
    ["The hidden Quotes sheet preserves all data so this workbook can be imported into E3 Quoter again."],
    ["Imported rows are always added as Done, regardless of the Status column."],
    ["XLSX and XLSM files are accepted. VBA macros are never executed."],
    ["Do not delete the hidden Quotes sheet if you want to re-import this workbook."],
  ]);
  instructions["!cols"] = [{ wch: 100 }];
  if (instructions.A1) instructions.A1.s = { font: { bold: true, sz: 16, color: { rgb: "C86117" } } };

  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: "E3 Quoter Shared Quotes", Subject: "Quote import and export", Author: "E3 Energy" };
  const usedSheetNames = new Set([SUMMARY_SHEET.toLowerCase(), QUOTE_EXCEL_SHEET.toLowerCase(), INSTRUCTIONS_SHEET.toLowerCase()]);
  const projects = quotes.map((quote, index) => {
    const result = calculateQuote(quote.payload, settings);
    const sheetName = uniqueProjectSheetName(quote, index, usedSheetNames);
    const metrics = createProjectSheet(workbook, quote, result, settings, sheetName);
    return { quote, result, metrics };
  });
  const summary = createSummarySheet(projects, settings);
  XLSX.utils.book_append_sheet(workbook, summary, SUMMARY_SHEET);
  projects.forEach(({ metrics }) => {
    const projectSheet = workbook.Sheets[metrics.sheetName];
    delete workbook.Sheets[metrics.sheetName];
    workbook.SheetNames = workbook.SheetNames.filter((name) => name !== metrics.sheetName);
    XLSX.utils.book_append_sheet(workbook, projectSheet, metrics.sheetName);
  });
  XLSX.utils.book_append_sheet(workbook, importWorksheet, QUOTE_EXCEL_SHEET);
  XLSX.utils.book_append_sheet(workbook, instructions, INSTRUCTIONS_SHEET);
  type WorkbookMetadata = NonNullable<typeof workbook.Workbook> & {
    CalcPr?: { calcMode?: string; fullCalcOnLoad?: string };
  };
  const workbookMetadata = (workbook.Workbook ?? {}) as WorkbookMetadata;
  workbookMetadata.CalcPr = { ...(workbookMetadata.CalcPr ?? {}), calcMode: "auto", fullCalcOnLoad: "1" };
  workbookMetadata.Sheets = workbook.SheetNames.map((name) => ({ name, Hidden: name === QUOTE_EXCEL_SHEET ? 1 : 0 }));
  workbook.Workbook = workbookMetadata;
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true, cellStyles: true });
  return new Uint8Array(output as ArrayBuffer);
}

function createSummarySheet(
  projects: Array<{ quote: QuoteRecord; result: CalculationResult; metrics: ProjectSheetMetrics }>,
  settings: AppSettings,
) {
  const headerRow = 5;
  const firstDataRow = headerRow + 1;
  const lastDataRow = Math.max(firstDataRow, firstDataRow + projects.length - 1);
  const sheet = XLSX.utils.aoa_to_sheet([
    ["E3 Quote Portfolio Summary"],
    ["One row per project · open the project tab for its full quote breakdown"],
    ["Projects", projects.length, "", "Total Gross Margin", 0, "", "Portfolio Margin", 0, "", "Target Margin", settings.thresholds.target],
    [],
    ["Project", "Date", "Type", "Quote Status", "Margin Status", "Owner", "PV (kW)", "Battery (kWh)", "Customer Balance (incl. GST)", "Total Received (excl. GST)", "Total Cost (excl. GST)", "Gross Margin", "Margin %", "Target Customer Balance", "Project Sheet"],
  ]);

  projects.forEach(({ quote, result, metrics }, index) => {
    const row = firstDataRow + index;
    XLSX.utils.sheet_add_aoa(sheet, [[
      quote.projectName || quote.payload.customerName,
      quote.payload.date,
      quote.payload.mode === "ci" ? "C&I" : "Residential",
      quote.status === "done" ? "Done" : "Drafting",
      marginStatusLabel(result.status),
      quote.ownerName,
      result.totalPvSize,
      result.totalBatteryKwh,
      quote.payload.customerBalance,
      result.totalReceivedExGst,
      result.totalCostExGst,
      result.grossMargin,
      result.grossMarginRate,
      result.targetRequiredBalance,
      "Open project",
    ]], { origin: `A${row}` });
    const source = quoteSheetRef(metrics.sheetName);
    setFormulaCell(sheet, `J${row}`, `=${source}!${metrics.totalReceivedCell}`, result.totalReceivedExGst);
    setFormulaCell(sheet, `K${row}`, `=${source}!${metrics.totalCostCell}`, result.totalCostExGst);
    setFormulaCell(sheet, `L${row}`, `=${source}!${metrics.grossMarginCell}`, result.grossMargin);
    setFormulaCell(sheet, `M${row}`, `=${source}!${metrics.grossMarginRateCell}`, result.grossMarginRate);
    setFormulaCell(sheet, `N${row}`, `=${source}!${metrics.targetBalanceCell}`, result.targetRequiredBalance);
    if (sheet[`O${row}`]) sheet[`O${row}`].l = { Target: `#${source}!A1`, Tooltip: `Open ${metrics.sheetName}` };
    applyMarginStatusStyle(sheet, `E${row}`, result.status);
  });

  const totalGrossMargin = projects.reduce((sum, project) => sum + project.result.grossMargin, 0);
  const totalReceived = projects.reduce((sum, project) => sum + project.result.totalReceivedExGst, 0);
  const portfolioMargin = totalReceived === 0 ? 0 : totalGrossMargin / totalReceived;
  if (projects.length > 0) {
    setFormulaCell(sheet, "E3", `=SUM(L${firstDataRow}:L${lastDataRow})`, totalGrossMargin);
    setFormulaCell(sheet, "H3", `=IF(SUM(J${firstDataRow}:J${lastDataRow})=0,0,SUM(L${firstDataRow}:L${lastDataRow})/SUM(J${firstDataRow}:J${lastDataRow}))`, portfolioMargin);
  }

  sheet["!merges"] = [XLSX.utils.decode_range("A1:O1"), XLSX.utils.decode_range("A2:O2")];
  sheet["!cols"] = [
    { wch: 28 }, { wch: 13 }, { wch: 13 }, { wch: 20 }, { wch: 16 }, { wch: 16 },
    { wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 26 }, { wch: 24 }, { wch: 18 },
    { wch: 13 }, { wch: 26 }, { wch: 18 },
  ];
  sheet["!rows"] = [{ hpt: 28 }, { hpt: 20 }, { hpt: 24 }, { hpt: 8 }, { hpt: 30 }];
  sheet["!autofilter"] = { ref: `A${headerRow}:O${lastDataRow}` };
  (sheet as XLSX.WorkSheet & { "!freeze"?: unknown })["!freeze"] = { xSplit: 0, ySplit: headerRow, topLeftCell: `A${firstDataRow}`, activePane: "bottomLeft", state: "frozen" };
  applyRangeStyle(sheet, "A1:O1", titleStyle);
  applyRangeStyle(sheet, "A2:O2", subtitleStyle);
  applyRangeStyle(sheet, "A3:K3", kpiStyle);
  applyRangeStyle(sheet, `A${headerRow}:O${headerRow}`, tableHeaderStyle);
  applyRangeStyle(sheet, `A${firstDataRow}:O${lastDataRow}`, bodyStyle);
  setNumberFormat(sheet, `G${firstDataRow}:H${lastDataRow}`, "0.00");
  ["I", "J", "K", "L", "N"].forEach((column) => setNumberFormat(sheet, `${column}${firstDataRow}:${column}${lastDataRow}`, currencyFormat));
  setNumberFormat(sheet, `M${firstDataRow}:M${lastDataRow}`, percentageFormat);
  setNumberFormat(sheet, "E3", currencyFormat);
  setNumberFormat(sheet, "H3", percentageFormat);
  setNumberFormat(sheet, "K3", percentageFormat);
  return sheet;
}

function createProjectSheet(
  workbook: XLSX.WorkBook,
  quote: QuoteRecord,
  result: CalculationResult,
  settings: AppSettings,
  sheetName: string,
): ProjectSheetMetrics {
  const sheet = XLSX.utils.aoa_to_sheet([
    [`E3 Quote Breakdown — ${quote.projectName || quote.payload.customerName}`],
    ["Detailed project pricing, funding and gross-margin summary"],
    ["Customer Name", quote.payload.customerName, "", "Quote ID", quote.id, "Back to Summary"],
    ["Date", quote.payload.date, "", "Quote Status", quote.status === "done" ? "Done" : "Drafting"],
    ["Address", quote.payload.address],
    ["Phone", quote.payload.phone, "", "Owner", quote.ownerName],
    ["Quote Type", quote.payload.mode === "ci" ? "C&I" : "Residential", "", "Initiator", quote.payload.initiator],
    ["PV System Size", result.totalPvSize, "kW", "Battery Size", result.totalBatteryKwh, "kWh"],
    ["Inverter", quote.payload.mode === "ci" || quote.payload.equipmentBrand === "sig" ? result.inverterSummary : quote.payload.inverter, "", "Equipment Brand", quote.payload.equipmentBrand === "sig" ? "SIG" : "FOX"],
    [],
    ["Quote Breakdown"],
    ["Item", "Cost", "Margin", "Sales Price", "Notes"],
  ]);
  if (sheet.F3) sheet.F3.l = { Target: `#'${SUMMARY_SHEET}'!A1`, Tooltip: "Back to portfolio summary" };

  const firstItemRow = 13;
  result.lineItems.forEach((item, index) => {
    const row = firstItemRow + index;
    const excelNote = item.note?.replace(/; /g, "\n") ?? "";
    XLSX.utils.sheet_add_aoa(sheet, [[item.label, item.cost, item.margin, item.salesPrice, excelNote]], { origin: `A${row}` });
    setFormulaCell(sheet, `D${row}`, `=B${row}*(1+C${row})`, item.salesPrice);
  });
  const lastItemRow = firstItemRow + result.lineItems.length - 1;
  const subtotalRow = lastItemRow + 1;
  XLSX.utils.sheet_add_aoa(sheet, [["Line item totals", result.lineItems.reduce((sum, item) => sum + item.cost, 0), "", result.lineItems.reduce((sum, item) => sum + item.salesPrice, 0)]], { origin: `A${subtotalRow}` });
  setFormulaCell(sheet, `B${subtotalRow}`, `=SUM(B${firstItemRow}:B${lastItemRow})`, result.lineItems.reduce((sum, item) => sum + item.cost, 0));
  setFormulaCell(sheet, `D${subtotalRow}`, `=SUM(D${firstItemRow}:D${lastItemRow})`, result.lineItems.reduce((sum, item) => sum + item.salesPrice, 0));

  const sectionRow = subtotalRow + 3;
  const firstSummaryRow = sectionRow + 1;
  XLSX.utils.sheet_add_aoa(sheet, [["Funding & Customer Balance", "", "", "Margin Summary"]], { origin: `A${sectionRow}` });
  const fundingRows: Array<[string, number]> = [
    ["Solar STC", result.solarStc],
    ["Battery STC", result.batteryStc],
    ["Solar VIC Rebate", quote.payload.solarVicRebate],
    ["Solar VIC Interest Free Loan", quote.payload.solarVicLoan],
    ["Discount", -Math.abs(quote.payload.discount)],
    ["Customer Balance (incl. GST)", quote.payload.customerBalance],
  ];
  XLSX.utils.sheet_add_aoa(sheet, fundingRows.map(([label, value]) => [label, value]), { origin: `A${firstSummaryRow}` });

  const summaryLabels = [
    "GST Rate", "Target Margin", "Approval Threshold", "Total Received (excl. GST)", "Total Cost (excl. GST)",
    "Net GST", "Gross Margin", "Gross Margin %", "Margin Status", "Quote Required Customer Balance",
    "Target Customer Balance", "Target Balance Gap",
  ];
  XLSX.utils.sheet_add_aoa(sheet, summaryLabels.map((label) => [label, ""]), { origin: `D${firstSummaryRow}` });

  const gstCell = `E${firstSummaryRow}`;
  const targetMarginCell = `E${firstSummaryRow + 1}`;
  const approvalMarginCell = `E${firstSummaryRow + 2}`;
  const totalReceivedCell = `E${firstSummaryRow + 3}`;
  const totalCostCell = `E${firstSummaryRow + 4}`;
  const netGstCell = `E${firstSummaryRow + 5}`;
  const grossMarginCell = `E${firstSummaryRow + 6}`;
  const grossMarginRateCell = `E${firstSummaryRow + 7}`;
  const statusCell = `E${firstSummaryRow + 8}`;
  const quoteBalanceCell = `E${firstSummaryRow + 9}`;
  const targetBalanceCell = `E${firstSummaryRow + 10}`;
  const targetGapCell = `E${firstSummaryRow + 11}`;
  const solarStcCell = `B${firstSummaryRow}`;
  const batteryStcCell = `B${firstSummaryRow + 1}`;
  const rebateCell = `B${firstSummaryRow + 2}`;
  const loanCell = `B${firstSummaryRow + 3}`;
  const discountCell = `B${firstSummaryRow + 4}`;
  const customerBalanceCell = `B${firstSummaryRow + 5}`;
  const commissionRow = firstItemRow + result.lineItems.findIndex((item) => item.key === "externalCommission");
  const fundingFormula = `SUM(${solarStcCell}:${discountCell})`;

  setValueCell(sheet, gstCell, settings.gstRate);
  setValueCell(sheet, targetMarginCell, settings.thresholds.target);
  setValueCell(sheet, approvalMarginCell, settings.thresholds.approval);
  setFormulaCell(sheet, totalReceivedCell, `=${customerBalanceCell}/(1+${gstCell})+${fundingFormula}`, result.totalReceivedExGst);
  setFormulaCell(sheet, totalCostCell, `=B${subtotalRow}-B${commissionRow}+B${commissionRow}/(1+${gstCell})`, result.totalCostExGst);
  setFormulaCell(sheet, netGstCell, `=${customerBalanceCell}*${gstCell}/(1+${gstCell})-B${subtotalRow}*${gstCell}`, result.netGst);
  setFormulaCell(sheet, grossMarginCell, `=${totalReceivedCell}-${totalCostCell}-${netGstCell}`, result.grossMargin);
  setFormulaCell(sheet, grossMarginRateCell, `=IF(${totalReceivedCell}=0,0,${grossMarginCell}/${totalReceivedCell})`, result.grossMarginRate);
  setFormulaCell(sheet, statusCell, `=IF(${grossMarginRateCell}>=${targetMarginCell},"Healthy",IF(${grossMarginRateCell}>=${approvalMarginCell},"Review","Senior approval"))`, marginStatusLabel(result.status), "s");
  setFormulaCell(sheet, quoteBalanceCell, `=(D${subtotalRow}-D${commissionRow})*(1+${gstCell})+D${commissionRow}-(${solarStcCell}+${batteryStcCell}+${rebateCell}+${loanCell}+ABS(${discountCell}))`, result.quoteRequiredBalance);
  setFormulaCell(sheet, targetBalanceCell, `=MAX(0,(1+${gstCell})*(${totalCostCell}-B${subtotalRow}*${gstCell}-${fundingFormula}*(1-${targetMarginCell}))/(1-${gstCell}-${targetMarginCell}))`, result.targetRequiredBalance);
  setFormulaCell(sheet, targetGapCell, `=${targetBalanceCell}-${customerBalanceCell}`, result.targetGap);
  applyMarginStatusStyle(sheet, statusCell, result.status);

  sheet["!merges"] = [
    XLSX.utils.decode_range("A1:F1"), XLSX.utils.decode_range("A2:F2"), XLSX.utils.decode_range("B5:F5"),
    XLSX.utils.decode_range("B9:F9"), XLSX.utils.decode_range("A11:F11"),
    XLSX.utils.decode_range(`A${sectionRow}:C${sectionRow}`), XLSX.utils.decode_range(`D${sectionRow}:F${sectionRow}`),
  ];
  sheet["!cols"] = [{ wch: 34 }, { wch: 18 }, { wch: 13 }, { wch: 34 }, { wch: 46 }, { wch: 16 }];
  sheet["!rows"] = [{ hpt: 28 }, { hpt: 20 }, { hpt: 22 }, { hpt: 22 }, { hpt: 22 }, { hpt: 22 }, { hpt: 22 }, { hpt: 22 }, { hpt: 22 }, { hpt: 8 }, { hpt: 24 }, { hpt: 24 }];
  (sheet as XLSX.WorkSheet & { "!freeze"?: unknown })["!freeze"] = { xSplit: 0, ySplit: 12, topLeftCell: `A${firstItemRow}`, activePane: "bottomLeft", state: "frozen" };
  applyRangeStyle(sheet, "A1:F1", titleStyle);
  applyRangeStyle(sheet, "A2:F2", subtitleStyle);
  applyRangeStyle(sheet, "A3:F9", bodyStyle);
  applyRangeStyle(sheet, "A11:F11", sectionStyle);
  applyRangeStyle(sheet, "A12:E12", tableHeaderStyle);
  applyRangeStyle(sheet, `A${firstItemRow}:E${lastItemRow}`, bodyStyle);
  applyRangeStyle(sheet, `E${firstItemRow}:E${lastItemRow}`, notesStyle);
  result.lineItems.forEach((item, index) => {
    if (!item.note) return;
    const rowIndex = firstItemRow + index - 1;
    const rows = sheet["!rows"] ?? [];
    rows[rowIndex] = { hpt: item.note.length > 70 ? 40 : 28 };
    sheet["!rows"] = rows;
  });
  applyRangeStyle(sheet, `A${subtotalRow}:E${subtotalRow}`, totalStyle);
  applyRangeStyle(sheet, `A${sectionRow}:F${sectionRow}`, sectionStyle);
  applyRangeStyle(sheet, `A${firstSummaryRow}:B${firstSummaryRow + fundingRows.length - 1}`, bodyStyle);
  applyRangeStyle(sheet, `D${firstSummaryRow}:E${firstSummaryRow + summaryLabels.length - 1}`, bodyStyle);
  setNumberFormat(sheet, `B${firstItemRow}:B${subtotalRow}`, currencyFormat);
  setNumberFormat(sheet, `C${firstItemRow}:C${lastItemRow}`, percentageFormat);
  setNumberFormat(sheet, `D${firstItemRow}:D${subtotalRow}`, currencyFormat);
  setNumberFormat(sheet, `B${firstSummaryRow}:B${firstSummaryRow + fundingRows.length - 1}`, currencyFormat);
  setNumberFormat(sheet, `${gstCell}:${approvalMarginCell}`, percentageFormat);
  setNumberFormat(sheet, `${totalReceivedCell}:${grossMarginCell}`, currencyFormat);
  setNumberFormat(sheet, grossMarginRateCell, percentageFormat);
  setNumberFormat(sheet, `${quoteBalanceCell}:${targetGapCell}`, currencyFormat);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return { sheetName, totalReceivedCell, totalCostCell, grossMarginCell, grossMarginRateCell, targetBalanceCell };
}

function uniqueProjectSheetName(quote: QuoteRecord, index: number, used: Set<string>) {
  const label = (quote.projectName || quote.payload.customerName || `Project ${index + 1}`)
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const prefix = `${String(index + 1).padStart(2, "0")} `;
  const base = `${prefix}${label}`.slice(0, 31).trim() || `${prefix}Project`.trim();
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    const marker = ` ${suffix}`;
    name = `${base.slice(0, 31 - marker.length).trim()}${marker}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function quoteSheetRef(name: string) {
  return `'${name.replace(/'/g, "''")}'`;
}

function marginStatusLabel(status: CalculationResult["status"]) {
  return status === "healthy" ? "Healthy" : status === "review" ? "Review" : "Senior approval";
}

function setValueCell(sheet: XLSX.WorkSheet, address: string, value: string | number) {
  sheet[address] = { t: typeof value === "number" ? "n" : "s", v: value };
}

function setFormulaCell(sheet: XLSX.WorkSheet, address: string, formula: string, value: string | number, type: "n" | "s" = "n") {
  sheet[address] = { t: type, f: formula.replace(/^=/, ""), v: value };
}

const currencyFormat = '"$"#,##0.00;[Red]-"$"#,##0.00';
const percentageFormat = "0.00%";
const titleStyle = { fill: { patternType: "solid", fgColor: { rgb: "12271E" } }, font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } }, alignment: { vertical: "center", horizontal: "left" } };
const subtitleStyle = { fill: { patternType: "solid", fgColor: { rgb: "EAF1ED" } }, font: { italic: true, color: { rgb: "506259" } }, alignment: { vertical: "center", horizontal: "left" } };
const sectionStyle = { fill: { patternType: "solid", fgColor: { rgb: "12271E" } }, font: { bold: true, color: { rgb: "FFFFFF" } }, alignment: { vertical: "center", horizontal: "left" } };
const tableHeaderStyle = { fill: { patternType: "solid", fgColor: { rgb: "F58A42" } }, font: { bold: true, color: { rgb: "FFFFFF" } }, alignment: { vertical: "center", horizontal: "left" }, border: { bottom: { style: "thin", color: { rgb: "D96B24" } } } };
const kpiStyle = { fill: { patternType: "solid", fgColor: { rgb: "FFF4EC" } }, font: { bold: true, color: { rgb: "8F4515" } }, alignment: { vertical: "center" } };
const bodyStyle = { font: { color: { rgb: "24342C" } }, alignment: { vertical: "center" }, border: { bottom: { style: "thin", color: { rgb: "DDE5E0" } } } };
const notesStyle = { ...bodyStyle, alignment: { vertical: "center", wrapText: true } };
const totalStyle = { fill: { patternType: "solid", fgColor: { rgb: "EAF1ED" } }, font: { bold: true, color: { rgb: "12271E" } }, border: { top: { style: "thin", color: { rgb: "9DB2A6" } }, bottom: { style: "double", color: { rgb: "648071" } } } };

function applyRangeStyle(sheet: XLSX.WorkSheet, rangeAddress: string, style: UnknownRecord) {
  const range = XLSX.utils.decode_range(rangeAddress);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      if (!sheet[address]) sheet[address] = { t: "s", v: "" };
      sheet[address].s = style;
    }
  }
}

function setNumberFormat(sheet: XLSX.WorkSheet, rangeAddress: string, format: string) {
  const range = XLSX.utils.decode_range(rangeAddress);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      if (sheet[address]) sheet[address].z = format;
    }
  }
}

function applyMarginStatusStyle(sheet: XLSX.WorkSheet, address: string, status: CalculationResult["status"]) {
  if (!sheet[address]) return;
  const colors = status === "healthy"
    ? { fill: "DDF4E7", font: "137548" }
    : status === "review"
      ? { fill: "FFF0CC", font: "9A6200" }
      : { fill: "F9DEDC", font: "A33A32" };
  sheet[address].s = { fill: { patternType: "solid", fgColor: { rgb: colors.fill } }, font: { bold: true, color: { rgb: colors.font } } };
}

export function parseQuotesWorkbook(data: ArrayBuffer | Uint8Array): unknown[] {
  const workbook = XLSX.read(data, { type: "array", cellDates: true, bookVBA: false });
  const payloads: unknown[] = [];
  const importSheetNames = workbook.SheetNames.includes(QUOTE_EXCEL_SHEET)
    ? [QUOTE_EXCEL_SHEET]
    : workbook.SheetNames.filter((name) => normalizeHeader(name) !== "instructions");

  importSheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const foxEssPayload = foxEssTemplateToPayload(sheet);
    if (foxEssPayload) {
      payloads.push(foxEssPayload);
      return;
    }
    const tableRows = XLSX.utils.sheet_to_json<UnknownRecord>(sheet, { defval: "", raw: true });
    const tablePayloads = tableRows.map((row) => rowToPayload(row)).filter((value): value is UnknownRecord => value !== null);
    if (tablePayloads.length > 0) payloads.push(...tablePayloads);
    else {
      const labelledPayload = labelledSheetToPayload(sheet);
      if (labelledPayload) payloads.push(labelledPayload);
    }
  });

  if (payloads.length === 0) throw new Error("No quotes with a Customer Name were found in this Excel file");
  return payloads;
}

function foxEssTemplateToPayload(sheet: XLSX.WorkSheet): UnknownRecord | null {
  if (!isFoxEssGrossMarginTemplate(sheet)) return null;

  const customerName = asText(cellValue(sheet, "D14"));
  if (!customerName) return null;

  const manualCosts = {
    backup: asNumber(cellValue(sheet, "F38")),
    accessories: asNumber(cellValue(sheet, "F40")),
    solarInstallation: asNumber(cellValue(sheet, "F42")),
    batteryInstallation: asNumber(cellValue(sheet, "F44")),
    delivery: asNumber(cellValue(sheet, "F46")),
    acCable: asNumber(cellValue(sheet, "F48")),
    blinkFee: asNumber(cellValue(sheet, "F50")),
    switchboard: asNumber(cellValue(sheet, "F52")),
    subSwitchboard: asNumber(cellValue(sheet, "F54")),
    externalCommission: asNumber(cellValue(sheet, "F56")),
  };
  const manualMargins = Object.fromEntries([
    ["solarPanel", "H32"], ["inverter", "H34"], ["battery", "H36"], ["backup", "H38"],
    ["accessories", "H40"], ["solarInstallation", "H42"], ["batteryInstallation", "H44"],
    ["delivery", "H46"], ["acCable", "H48"], ["blinkFee", "H50"], ["switchboard", "H52"],
    ["subSwitchboard", "H54"], ["externalCommission", "H56"],
  ].map(([key, address]) => [key, asNumber(cellValue(sheet, address))]));

  return {
    customerName,
    date: normalizeQuoteDate(cellValue(sheet, "D12")),
    mode: "residential",
    phone: "",
    address: asText(cellValue(sheet, "D16")),
    initiator: asText(cellValue(sheet, "D24")),
    pvSize: asNumber(cellValue(sheet, "D18")),
    batteryKwh: asNumber(cellValue(sheet, "D20")),
    inverter: asText(cellValue(sheet, "D22")),
    customerBalance: asNumber(cellValue(sheet, "D77")),
    solarVicRebate: asNumber(cellValue(sheet, "D71")),
    solarVicLoan: asNumber(cellValue(sheet, "D73")),
    discount: Math.abs(asNumber(cellValue(sheet, "D75"))),
    manualSolarStc: asOptionalNumber(cellValue(sheet, "D59")),
    manualBatteryStc: asOptionalNumber(cellValue(sheet, "D65")),
    manualCosts,
    manualMargins,
    customItems: [],
  };
}

function isFoxEssGrossMarginTemplate(sheet: XLSX.WorkSheet) {
  return normalizeHeader(cellValue(sheet, "B10")) === "projectinfo"
    && normalizeHeader(cellValue(sheet, "C12")) === "date"
    && normalizeHeader(cellValue(sheet, "C14")) === "name"
    && normalizeHeader(cellValue(sheet, "C18")) === "pvsize"
    && normalizeHeader(cellValue(sheet, "C20")) === "batterysize"
    && normalizeHeader(cellValue(sheet, "B28")) === "quote";
}

function cellValue(sheet: XLSX.WorkSheet, address: string): unknown {
  return sheet[address]?.v ?? "";
}

function normalizeQuoteDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const text = asText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const namedMonth = text.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{4})$/);
  if (namedMonth) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf(namedMonth[2].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return `${namedMonth[3]}-${String(month).padStart(2, "0")}-${namedMonth[1].padStart(2, "0")}`;
  }
  return text;
}

function rowToPayload(row: UnknownRecord): UnknownRecord | null {
  const values = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  const get = (...names: string[]) => names.map(normalizeHeader).map((key) => values.get(key)).find((value) => value !== undefined && value !== "");
  const customerName = asText(get("Customer Name", "Customer", "Name"));
  if (!customerName) return null;

  const embedded = parseJsonCell(get("E3 Payload JSON"), null);
  if (isRecord(embedded)) return { ...embedded, customerName };

  return mappedPayload(get, customerName);
}

function labelledSheetToPayload(sheet: XLSX.WorkSheet): UnknownRecord | null {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true });
  const values = new Map<string, unknown>();
  rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    const key = normalizeHeader(cell);
    if (!knownLabels.has(key)) return;
    const right = row[columnIndex + 1];
    const below = rows[rowIndex + 1]?.[columnIndex];
    values.set(key, asText(right) !== "" ? right : below ?? "");
  }));
  const get = (...names: string[]) => names.map(normalizeHeader).map((key) => values.get(key)).find((value) => value !== undefined && value !== "");
  const customerName = asText(get("Customer Name", "Customer", "Name"));
  return customerName ? mappedPayload(get, customerName) : null;
}

function mappedPayload(get: (...names: string[]) => unknown, customerName: string): UnknownRecord {
  const mode = normalizeHeader(get("Mode", "Quote Mode"));
  return {
    customerName,
    date: asText(get("Date", "Quote Date")),
    mode: mode === "ci" || mode === "commercialindustrial" ? "ci" : "residential",
    equipmentBrand: normalizeHeader(get("Equipment Brand", "Brand")) === "sig" ? "sig" : "fox",
    phone: asText(get("Phone", "Phone Number", "Mobile")),
    address: asText(get("Address", "Project Address", "Installation Address")),
    initiator: asText(get("E3 Energy Initiator", "Initiator", "Owner")),
    pvSize: asNumber(get("PV System Size (kW)", "PV System Size", "PV Size", "Solar Size", "Solar")),
    batteryKwh: asNumber(get("Battery Size (kWh)", "Battery Size", "Battery")),
    inverter: asText(get("Inverter", "Inverter Model")),
    customerBalance: asNumber(get("Customer Balance (incl. GST)", "Customer Balance")),
    solarVicRebate: asNumber(get("Solar VIC Rebate")),
    solarVicLoan: asNumber(get("Solar VIC Interest Free Loan", "Solar VIC PV Interest Free Loan", "Solar VIC Loan", "Interest Free Loan")),
    discount: Math.abs(asNumber(get("Discount"))),
    manualSolarStc: get("Solar STC (Manual)", "Solar STC"),
    manualBatteryStc: get("Battery STC (Manual)", "Battery STC"),
    manualCosts: parseJsonCell(get("Manual Costs JSON"), {}),
    manualMargins: parseJsonCell(get("Manual Margins JSON"), {}),
    customItems: parseJsonCell(get("Custom Items JSON"), []),
  };
}

function applyWorkbookFormatting(sheet: XLSX.WorkSheet, rowCount: number) {
  const lastColumn = XLSX.utils.encode_col(headers.length - 1);
  for (let column = 0; column < headers.length; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })];
    if (cell) cell.s = {
      fill: { patternType: "solid", fgColor: { rgb: "12271E" } },
      font: { bold: true, color: { rgb: "FFFFFF" } },
      alignment: { vertical: "center" },
    };
  }
  for (let row = 2; row <= rowCount + 1; row += 1) {
    ["K", "L", "M", "N", "O", "P"].forEach((column) => {
      const cell = sheet[`${column}${row}`];
      if (cell?.t === "n") cell.z = '"$"#,##0.00';
    });
    ["H", "I"].forEach((column) => {
      const cell = sheet[`${column}${row}`];
      if (cell?.t === "n") cell.z = "0.00";
    });
  }
  sheet["!ref"] = sheet["!ref"] ?? `A1:${lastColumn}${Math.max(1, rowCount + 1)}`;
}

function columnWidth(header: string) {
  if (["Address", "Inverter", "E3 Payload JSON"].includes(header)) return header === "E3 Payload JSON" ? 18 : 34;
  if (header.includes("JSON")) return 18;
  if (["Customer Name", "E3 Energy Initiator"].includes(header)) return 22;
  if (["Created At", "Updated At"].includes(header)) return 21;
  return Math.max(12, Math.min(24, header.length + 2));
}

const knownLabels = new Set([
  "customername", "customer", "name", "date", "quotedate", "mode", "quotemode", "equipmentbrand", "brand", "phone", "phonenumber", "mobile",
  "address", "projectaddress", "installationaddress", "e3energyinitiator", "initiator", "owner", "pvsystemsizekw",
  "pvsystemsize", "pvsize", "solarsize", "solar", "batterysizekwh", "batterysize", "battery", "inverter", "invertermodel",
  "customerbalanceinclgst", "customerbalance", "solarvicrebate", "solarvicinterestfreeloan", "solarvicloan",
  "solarvicpvinterestfreeloan", "interestfreeloan", "discount", "solarstcmanual", "solarstc", "batterystcmanual", "batterystc",
]);
