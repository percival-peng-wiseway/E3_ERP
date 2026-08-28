import type {
  PaymentTrackCustomer,
  PaymentTrackItem,
  PaymentTrackSpecialist,
} from "./types";

type MatrixSource = ArrayLike<number> | {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
};

// PDF.js references DOMMatrix while its server bundle is evaluated, even for
// text-only extraction. Cloudflare Workers do not provide that browser API.
// This small 2D implementation covers the matrix operations PDF.js uses and is
// installed only immediately before PDF.js is loaded.
class PdfDomMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(source?: MatrixSource) {
    if (!source) return;
    if (typeof (source as ArrayLike<number>).length === "number") {
      const values = Array.from(source as ArrayLike<number>);
      if (values.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = values;
      return;
    }
    const value = source as Exclude<MatrixSource, ArrayLike<number>>;
    this.a = value.a ?? 1;
    this.b = value.b ?? 0;
    this.c = value.c ?? 0;
    this.d = value.d ?? 1;
    this.e = value.e ?? 0;
    this.f = value.f ?? 0;
  }

  get is2D() { return true; }
  get m11() { return this.a; }
  get m12() { return this.b; }
  get m21() { return this.c; }
  get m22() { return this.d; }
  get m41() { return this.e; }
  get m42() { return this.f; }

  private values(other: MatrixSource) {
    const matrix = new PdfDomMatrix(other);
    return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] as const;
  }

  multiplySelf(other: MatrixSource) {
    const [a, b, c, d, e, f] = this.values(other);
    const current = [this.a, this.b, this.c, this.d, this.e, this.f] as const;
    this.a = current[0] * a + current[2] * b;
    this.b = current[1] * a + current[3] * b;
    this.c = current[0] * c + current[2] * d;
    this.d = current[1] * c + current[3] * d;
    this.e = current[0] * e + current[2] * f + current[4];
    this.f = current[1] * e + current[3] * f + current[5];
    return this;
  }

  preMultiplySelf(other: MatrixSource) {
    const matrix = new PdfDomMatrix(other).multiplySelf(this);
    [this.a, this.b, this.c, this.d, this.e, this.f] = [
      matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f,
    ];
    return this;
  }

  multiply(other: MatrixSource) { return new PdfDomMatrix(this).multiplySelf(other); }
  translate(x = 0, y = 0) { return this.multiply([1, 0, 0, 1, x, y]); }
  scale(x = 1, y = x) { return this.multiply([x, 0, 0, y, 0, 0]); }
  translateSelf(x = 0, y = 0) { return this.multiplySelf([1, 0, 0, 1, x, y]); }
  scaleSelf(x = 1, y = x) { return this.multiplySelf([x, 0, 0, y, 0, 0]); }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) {
      this.a = this.b = this.c = this.d = this.e = this.f = Number.NaN;
      return this;
    }
    const [a, b, c, d, e, f] = [this.a, this.b, this.c, this.d, this.e, this.f] as const;
    this.a = d / determinant;
    this.b = -b / determinant;
    this.c = -c / determinant;
    this.d = a / determinant;
    this.e = (c * f - d * e) / determinant;
    this.f = (b * e - a * f) / determinant;
    return this;
  }
}

let pdfRuntime: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

async function loadPdfRuntime() {
  if (!globalThis.DOMMatrix) {
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: PdfDomMatrix,
      writable: true,
    });
  }
  pdfRuntime ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    // PDF.js does not publish declarations for its worker bundle.
    // @ts-expect-error -- pdf.worker.mjs has no accompanying declaration file.
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]).then(([runtime, worker]) => {
    // Next/Turbopack relocates the server bundle, so PDF.js cannot resolve its
    // relative worker automatically. Register the bundled fake-worker handler.
    const pdfWorkerGlobal = globalThis as typeof globalThis & {
      pdfjsWorker?: { WorkerMessageHandler: unknown };
    };
    pdfWorkerGlobal.pdfjsWorker ??= { WorkerMessageHandler: worker.WorkerMessageHandler };
    return runtime;
  });
  return pdfRuntime;
}

export type ParsedPaymentAgreement = {
  quoteNumber: string;
  specialist: PaymentTrackSpecialist;
  customer: PaymentTrackCustomer;
  items: Array<Omit<PaymentTrackItem, "id">>;
  balanceDueCents: number;
  expectedDepositCents: number | null;
  stcSolarRequired: boolean;
  stcBatteryRequired: boolean;
  solarRebateRequired: boolean;
  sourceText: string;
};

export class PaymentAgreementParseError extends Error {
  readonly missingFields: string[];

  constructor(message: string, missingFields: string[]) {
    super(message);
    this.name = "PaymentAgreementParseError";
    this.missingFields = missingFields;
  }
}

type PositionedText = {
  text: string;
  x: number;
  y: number;
  width: number;
};

function printableText(value: unknown): value is PositionedText {
  if (!value || typeof value !== "object" || !("str" in value) || !("transform" in value)) return false;
  const item = value as { str?: unknown; transform?: unknown; width?: unknown };
  return typeof item.str === "string"
    && Array.isArray(item.transform)
    && typeof item.transform[4] === "number"
    && typeof item.transform[5] === "number";
}

function lineText(items: PositionedText[]) {
  return items
    .sort((left, right) => left.x - right.x)
    .reduce((line, item, index, all) => {
      if (!index) return item.text;
      const previous = all[index - 1];
      const previousEnd = previous.x + previous.width;
      const gap = item.x - previousEnd;
      const separator = /\s$/.test(line) || /^\s|^[,.;:)]/.test(item.text) || gap < 0.35 ? "" : " ";
      return `${line}${separator}${item.text}`;
    }, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

type ExtractedPdfText = {
  layoutText: string;
  semanticText: string;
};

const MAX_PROPOSAL_PAGES = 40;

async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdfText> {
  const { getDocument } = await loadPdfRuntime();
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const layoutPages: string[] = [];
  const semanticPages: string[] = [];
  let accumulatedCharacters = 0;

  try {
    if (document.numPages < 1 || document.numPages > MAX_PROPOSAL_PAGES) {
      throw new Error("Agreement page count is outside the supported range");
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      if (content.items.length > 50_000) throw new Error("Agreement contains too many text items");
      const positioned: PositionedText[] = content.items
        .filter(printableText)
        .map((item) => {
          const source = item as unknown as { str: string; transform: number[]; width?: number };
          return {
            text: source.str,
            x: source.transform[4],
            y: source.transform[5],
            width: typeof source.width === "number" ? source.width : 0,
          };
        })
        .filter((item) => item.text.trim());
      accumulatedCharacters += positioned.reduce((total, item) => total + item.text.length, 0);
      if (accumulatedCharacters > 1_000_000) throw new Error("Agreement text is too large");

      // PDF generators often store multi-column content in logical reading
      // order even when the visual rows interleave the columns. Keep both
      // representations: layout text is best for quote tables, while semantic
      // text is best for Proposal cover-page fields such as Prepared by.
      semanticPages.push(positioned.map((item) => item.text).join(" "));

      const rows: Array<{ y: number; items: PositionedText[] }> = [];
      for (const item of positioned.sort((left, right) => right.y - left.y || left.x - right.x)) {
        const row = rows.at(-1);
        if (row && Math.abs(row.y - item.y) <= 1.5) row.items.push(item);
        else rows.push({ y: item.y, items: [item] });
      }
      layoutPages.push(rows
        .sort((left, right) => right.y - left.y)
        .map((row) => lineText(row.items))
        .filter(Boolean)
        .join("\n"));
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    layoutText: layoutPages.join("\n\f\n"),
    semanticText: semanticPages.join("\n\f\n"),
  };
}

function captured(text: string, expression: RegExp) {
  const match = expression.exec(text);
  return match?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function capturedLast(text: string, expression: RegExp) {
  const flags = expression.flags.includes("g") ? expression.flags : `${expression.flags}g`;
  const matches = text.matchAll(new RegExp(expression.source, flags));
  let value = "";
  for (const match of matches) {
    if (match[1]) value = match[1].replace(/\s+/g, " ").trim();
  }
  return value;
}

function amountToCents(value: string) {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function withoutHonorific(value: string) {
  return value
    .replace(/^(?:mr|mrs|miss|ms|dr)\.?\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPersonName(value: string) {
  const parts = withoutHonorific(value).split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || "",
    lastName: parts.join(" "),
  };
}

type GreenSketchPartyDetails = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  specialistName: string;
  specialistPhone: string;
  address: ReturnType<typeof parseAustralianAddress>;
};

function parseAustralianAddress(value: string) {
  const match = /^(.*?),\s*([^,]+?)\s+(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})(?:,\s*Australia)?$/i.exec(value.trim());
  if (!match) return null;
  return {
    addressLine1: match[1].trim(),
    suburb: match[2].replace(/\s+/g, " ").trim(),
    state: match[3].toUpperCase(),
    postcode: match[4],
  };
}

function greenSketchPartyDetails(layoutText: string): GreenSketchPartyDetails | null {
  const coverLines = (layoutText.split("\f", 1)[0] || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let headingIndex = -1;
  for (let index = 0; index < coverLines.length; index += 1) {
    if (/^Prepared\s+for\s+(?:Prepared\s+)?By$/i.test(coverLines[index])) headingIndex = index;
  }
  if (headingIndex < 0) return null;

  const nextHeadingOffset = coverLines
    .slice(headingIndex + 1)
    .findIndex((line) => /^Prepared\s+for\s+(?:Prepared\s+)?By$/i.test(line));
  const quoteOffset = coverLines
    .slice(headingIndex + 1)
    .findIndex((line) => /^(?:Quote\s+No\.?|Quotation)\b/i.test(line));
  const candidateEnds = [
    nextHeadingOffset >= 0 ? headingIndex + 1 + nextHeadingOffset : -1,
    quoteOffset >= 0 ? headingIndex + 1 + quoteOffset : -1,
    Math.min(coverLines.length, headingIndex + 20),
  ].filter((value) => value > headingIndex);
  const blockEnd = Math.min(...candidateEnds);

  let emailIndex = -1;
  for (let index = headingIndex + 1; index < blockEnd; index += 1) {
    if ((coverLines[index].match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.length || 0) >= 2) {
      emailIndex = index;
    }
  }
  if (emailIndex < 0) return null;

  const emails = coverLines[emailIndex].match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  let specialistEmail = emails.at(-1) || "";
  for (let index = emails.length - 1; index >= 0; index -= 1) {
    if (/@e3energy\.com\.au$/i.test(emails[index])) {
      specialistEmail = emails[index];
      break;
    }
  }
  const customerEmail = emails.find((email) => email.toLowerCase() !== specialistEmail.toLowerCase()) || emails[0] || "";
  const namesLine = coverLines[emailIndex - 1] || "";
  const specialistFirstName = specialistEmail.split("@", 1)[0]?.split(/[+._-]/, 1)[0] || "";
  let specialistStart = -1;
  if (specialistFirstName) {
    const nameExpression = new RegExp(
      `\\b${specialistFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    for (const match of namesLine.matchAll(nameExpression)) specialistStart = match.index;
  }
  if (specialistStart <= 0) return null;

  const phoneExpression = /(?:\+?61|0)[\s-]?\(?[23478]\)?(?:[\s-]*\d){8}/g;
  let phoneIndex = -1;
  for (let index = emailIndex + 1; index < blockEnd; index += 1) {
    if ((coverLines[index].match(phoneExpression)?.length || 0) >= 2) phoneIndex = index;
  }
  const phones = phoneIndex >= 0
    ? coverLines[phoneIndex].match(phoneExpression) || []
    : [];
  const address = coverLines
    .slice(Math.max(phoneIndex + 1, emailIndex + 1), blockEnd)
    .map(parseAustralianAddress)
    .find((value) => value !== null) || null;

  return {
    customerName: namesLine.slice(0, specialistStart).trim(),
    customerEmail,
    customerPhone: phones[0] || "",
    specialistName: namesLine.slice(specialistStart).trim(),
    specialistPhone: phones[1] || "",
    address,
  };
}

function proposalAddress(semanticText: string) {
  const fullAddress = captured(
    semanticText,
    /\bAddress\s*:\s*(.+?)(?=\s+Property\s+Information\b)/i,
  );
  if (!fullAddress) return null;
  const match = /^(.*?)\s+([A-Z][A-Z ]{1,60})\s+(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})$/.exec(fullAddress);
  if (!match) return null;
  return {
    addressLine1: match[1].trim(),
    suburb: match[2].replace(/\s+/g, " ").trim(),
    state: match[3],
    postcode: match[4],
  };
}

function agreementItem(
  category: string,
  text: string,
  capacityUnit: "W" | "kW" | "kWh",
): Omit<PaymentTrackItem, "id"> | null {
  const headerless = text
    .replace(/Manufacturer\s+Model\s+Capacity\s+Quantity(?:\s+Price\s+inclusive\s+of\s+GST)?/gi, " ")
    .replace(/Price\s+inclusive\s+of\s+GST/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const labelledModel = captured(headerless, /Model\s+No\.?\s*:?\s*(.+?)(?=$|\s+(?:Solar\s+Inverter|Battery|Racking|Installation)\b)/i);
  const labelledDescription = captured(headerless, /(?:Manufacturer|Brand)\s*:?\s*(.+?)(?=\s+Capacity\s*:)/i);
  const labelledCapacity = captured(headerless, /Capacity\s*:?\s*(\d+(?:\.\d+)?\s*(?:kWh|kW|Watts?|W))/i);
  const labelledQuantity = captured(headerless, /QTY\s*:?\s*(\d{1,3})/i);
  if (labelledDescription && labelledCapacity && labelledQuantity) {
    let cleanDescription = labelledDescription.includes("_")
      ? labelledDescription.slice(labelledDescription.lastIndexOf("_") + 1)
      : labelledDescription;
    cleanDescription = cleanDescription.replace(/\s+Phase\s*:\s*\d+\s*$/i, "").trim();
    if (labelledModel && cleanDescription.toLowerCase().startsWith(`${labelledModel.toLowerCase()}-`)) {
      cleanDescription = cleanDescription.slice(labelledModel.length + 1).trim();
    }
    return {
      category,
      description: cleanDescription.replace(/\s+/g, " ").trim(),
      model: labelledModel || labelledDescription.split(/\s+/)[0],
      capacity: labelledCapacity.replace(/\s+/g, ""),
      quantity: Number(labelledQuantity),
    };
  }
  const unit = capacityUnit.replace("k", "k\\s*");
  const row = new RegExp(
    `([A-Z][A-Z0-9 &.-]{1,40}?)\\s+([A-Z0-9][A-Z0-9+_.-]{2,50})\\s+(\\d+(?:\\.\\d+)?\\s*${unit})\\s+(\\d{1,3})(?:\\s|$)`,
    "i",
  ).exec(headerless);
  if (!row) return null;
  return {
    category,
    description: row[1].replace(/\s+/g, " ").trim(),
    model: row[2].trim(),
    capacity: row[3].replace(/\s+/g, ""),
    quantity: Number(row[4]),
  };
}

function between(text: string, start: RegExp, end: RegExp) {
  const startMatch = start.exec(text);
  if (!startMatch) return "";
  const source = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = end.exec(source);
  return endMatch ? source.slice(0, endMatch.index) : source;
}

type GreenQuotationBlock = {
  itemText: string;
  priceText: string;
};

const greenSystemTotalExpression = /\bSystem\s+Total\s*\((?:incl\.?|including)\s*GST\)\s*\$?\s*[\d,]+(?:\.\d{1,2})?/i;

// Proposal generators use several names for the same Victorian solar rebate.
// Keep this deliberately narrower than a generic "rebate" match: battery
// rebates, STCs and Solar Victoria loans have independent operational flows.
const solarRebateLabelExpression = /(?:\bSolar\s*VIC(?:toria)?(?:['’]s)?\s+Solar\s+PV\s+Rebate\b|\b(?:VIC\s+)?Solar(?:\s+PV)?\s+Rebate\b|\bSolar\s+VIC(?:toria)?\s+Rebate\b)/i;

function normalizedPricingText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Assesses rebate rows only after the caller has isolated an authoritative
 * pricing/deductions block. A value must immediately follow its label (apart
 * from punctuation and an optional Amount/Value word), so an ambiguous Solar
 * Rebate row can never steal the amount from a later interest-free-loan row.
 */
function assessSolarRebateRows(value: string): boolean | null {
  const text = normalizedPricingText(value);
  const matches = Array.from(text.matchAll(new RegExp(solarRebateLabelExpression.source, "gi")));
  if (!matches.length) return false;

  let ambiguous = false;
  for (const match of matches) {
    const afterLabel = text.slice((match.index ?? 0) + match[0].length);
    const amountMatch = /^[\s:]*(?:(?:deduction|amount|value)\s*:?\s*)?(?:(?:[-–—]\s*)(?:AUD\s*)?\$?\s*|(?:AUD\s*)?\$\s*)([\d,]+(?:\.\d{1,2})?)(?![\d.])/i.exec(
      afterLabel,
    );
    if (!amountMatch) {
      ambiguous = true;
      continue;
    }
    const cents = amountToCents(amountMatch[1]);
    if (cents === null) {
      ambiguous = true;
      continue;
    }
    if (cents > 0) return true;
  }
  return ambiguous ? null : false;
}

function greenQuotationBlock(flatText: string): GreenQuotationBlock | null {
  const quotationMatches = Array.from(flatText.matchAll(/\bQuotation\b/gi));
  for (let index = quotationMatches.length - 1; index >= 0; index -= 1) {
    const quotation = quotationMatches[index];
    const quotationEnd = (quotation.index ?? 0) + quotation[0].length;
    const source = flatText.slice(quotationEnd);
    const total = greenSystemTotalExpression.exec(source);
    if (!total || total.index > 20_000) continue;
    const nextQuotation = source.search(/\bQuotation\b/i);
    if (nextQuotation >= 0 && nextQuotation < total.index) continue;
    return {
      itemText: source.slice(0, total.index).trim(),
      priceText: source.slice(total.index).trim(),
    };
  }
  return null;
}

export function assessProposalSolarRebateRequirement(sourceText: string): boolean | null {
  const flatText = normalizedPricingText(sourceText);
  const greenQuotation = greenQuotationBlock(flatText);
  if (greenQuotation) {
    const deductions = /\bDeductions\b/i.exec(greenQuotation.priceText);
    const finalPrice = /\bFinal\s+Price\s*\((?:incl\.?|including)\s*GST\)\s*\$?\s*[\d,]+(?:\.\d{1,2})?/i.exec(
      greenQuotation.priceText,
    );
    if (!deductions || !finalPrice || finalPrice.index <= deductions.index) return null;
    const deductionText = greenQuotation.priceText.slice(
      deductions.index + deductions[0].length,
      finalPrice.index,
    );
    return assessSolarRebateRows(deductionText);
  }

  const systemQuoteIndex = flatText.search(/\bSystem\s+Quote\b/i);
  if (systemQuoteIndex < 0) return null;
  const quoteText = flatText.slice(systemQuoteIndex);
  const balanceDue = /\bBalance\s+Due\b\s*:?\s*\$?\s*[\d,]+(?:\.\d{1,2})?/i.exec(quoteText);
  if (!balanceDue) return null;
  // Balance Due closes the price table. Excluding everything after it prevents
  // terms/eligibility prose from being mistaken for an applied deduction.
  const priceBlock = quoteText.slice(0, balanceDue.index + balanceDue[0].length);
  if (!/\b(?:System\s+Price|Final\s+Buyout\s+Price)\b/i.test(priceBlock)) return null;
  return assessSolarRebateRows(priceBlock);
}

export function proposalRequiresSolarRebate(sourceText: string) {
  return assessProposalSolarRebateRequirement(sourceText) === true;
}

export async function paymentAgreementRequiresSolarRebatePdf(bytes: Uint8Array) {
  const extractedText = await extractPdfText(bytes);
  return assessProposalSolarRebateRequirement(extractedText.layoutText);
}

type ExtractedItems = {
  items: Array<Omit<PaymentTrackItem, "id">>;
  unparsedGreenCoreCategories: string[];
};

const greenRowMarkerExpression = /\b(?:Solar\s+Panels?|Inverter|Battery)\s*:|\b(?:Sub[\s-]*switchboard|AC\s+Cable\s+Run|Installation\s+Cost|Delivery\s+Cost)\b(?=\s*(?::|x\b))/i;

function greenItemCapacity(category: string, name: string) {
  const unit = category === "Solar Panel" ? "W" : category === "Solar Inverter" ? "kW" : "kWh";
  const match = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`, "i").exec(name);
  return match ? `${match[1]}${unit}` : "";
}

function extractGreenItems(quoteBlock: string): ExtractedItems {
  const items: Array<Omit<PaymentTrackItem, "id">> = [];
  const unparsed = new Set<string>();
  const coreMatches = Array.from(quoteBlock.matchAll(/\b(Solar\s+Panels?|Inverter|Battery)\s*:/gi));

  for (const match of coreMatches) {
    const label = match[1];
    const category = /^Solar\s+Panels?$/i.test(label)
      ? "Solar Panel"
      : /^Inverter$/i.test(label)
        ? "Solar Inverter"
        : "Battery";
    const rowStart = (match.index ?? 0) + match[0].length;
    const remaining = quoteBlock.slice(rowStart);
    const nextMarker = greenRowMarkerExpression.exec(remaining);
    const rowText = (nextMarker ? remaining.slice(0, nextMarker.index) : remaining).trim();
    const row = /^(.+?)\s+x\s*(\d{1,3})\b/i.exec(rowText);
    const name = row?.[1]?.replace(/\s+/g, " ").replace(/^[\s:–—-]+|[\s:–—-]+$/g, "").trim() || "";
    const quantity = row ? Number(row[2]) : 0;
    if (!name || !Number.isSafeInteger(quantity) || quantity < 1) {
      unparsed.add(category);
      continue;
    }
    items.push({
      category,
      description: name,
      model: name,
      capacity: greenItemCapacity(category, name),
      quantity,
    });
  }

  const supportingItems: Array<[RegExp, string, string]> = [
    [/\bSub[\s-]*switchboard\b(?:\s*:\s*[^x]{1,160}?)?\s+x\s*(\d{1,3})\b/i, "Electrical", "Sub switchboard"],
    [/\bAC\s+Cable\s+Run\b(?:\s*:\s*[^x]{1,160}?)?\s+x\s*(\d{1,3})\b/i, "Electrical", "AC Cable Run"],
    [/\bInstallation\s+Cost\b(?:\s*:\s*[^x]{1,160}?)?\s+x\s*(\d{1,3})\b/i, "Installation", "Installation Cost"],
    [/\bDelivery\s+Cost\b(?:\s*:\s*[^x]{1,160}?)?\s+x\s*(\d{1,3})\b/i, "Delivery", "Delivery Cost"],
  ];
  for (const [expression, category, description] of supportingItems) {
    const match = expression.exec(quoteBlock);
    const quantity = match ? Number(match[1]) : 0;
    if (Number.isSafeInteger(quantity) && quantity > 0) {
      items.push({ category, description, model: "", capacity: "", quantity });
    }
  }
  return { items, unparsedGreenCoreCategories: [...unparsed] };
}

function extractItems(flatText: string, greenQuotation: GreenQuotationBlock | null): ExtractedItems {
  if (greenQuotation) return extractGreenItems(greenQuotation.itemText);

  // Proposal documents repeat product names throughout the cover and system
  // summary. When a priced System Quote exists, use that authoritative table
  // so an earlier "Battery Storage System" heading cannot steal the section.
  const systemQuoteIndex = flatText.search(/\bSystem\s+Quote\b/i);
  const itemText = systemQuoteIndex >= 0 ? flatText.slice(systemQuoteIndex) : flatText;
  const items: Array<Omit<PaymentTrackItem, "id">> = [];
  const panelSection = between(itemText, /(?:Solar\s+)?Panels?\b/i, /Solar\s+Inverter/i);
  const inverterSection = between(itemText, /Solar\s+Inverter/i, /Battery/i);
  const batterySection = between(
    itemText,
    /\bBattery\s+(?=(?:Brand|Manufacturer)\s*:)/i,
    /Racking|Installation|System\s+Price/i,
  ) || between(itemText, /Battery/i, /Racking|Installation|System\s+Price/i);
  const panel = agreementItem("Solar Panel", panelSection, "W");
  const inverter = agreementItem("Solar Inverter", inverterSection, "kW");
  const battery = agreementItem("Battery", batterySection, "kWh");
  if (panel) items.push(panel);
  if (inverter) items.push(inverter);
  if (battery) items.push(battery);

  const racking = captured(itemText, /Racking\s+(?:Type\s+)?(.+?)(?=\s+Installation\b|\s+System\s+Price\b)/i);
  if (racking) {
    const cleaned = racking.replace(/Price\s+inclusive\s+of\s+GST/gi, "").trim();
    if (cleaned) items.push({ category: "Racking", description: cleaned, model: "", quantity: 1, capacity: "" });
  }
  if (/\bInstallation\b[\s\S]*?\bSystem\s+Price\b/i.test(itemText)) {
    items.push({ category: "Installation", description: "System installation", model: "", quantity: 1, capacity: "" });
  }
  return { items, unparsedGreenCoreCategories: [] };
}

export async function parsePaymentAgreementPdf(bytes: Uint8Array): Promise<ParsedPaymentAgreement> {
  let extractedText: ExtractedPdfText;
  try {
    extractedText = await extractPdfText(bytes);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Payment proposal PDF extraction failed", error);
    }
    throw new PaymentAgreementParseError("The Solar Proposal PDF could not be read.", ["readable PDF text"]);
  }

  const sourceText = extractedText.layoutText;
  const flatText = sourceText.replace(/\s+/g, " ").trim();
  const semanticText = extractedText.semanticText.replace(/\s+/g, " ").trim();
  const greenSketchQuotation = greenQuotationBlock(flatText);
  const greenSketchParties = greenSketchQuotation ? greenSketchPartyDetails(sourceText) : null;
  const pricingText = greenSketchQuotation?.priceText || flatText;
  const proposalNumber = captured(
    semanticText,
    /Proposal\s*(?:No|Number)\.?\s*:?\s*([A-Z0-9-]{4,})/i,
  );
  const quoteNumber = proposalNumber
    || (greenSketchQuotation
      ? capturedLast(sourceText.split("\f", 1)[0] || "", /(?:^|\n)\s*Quote\s*No\.?\s*:?\s*([A-Z0-9-]{4,})/im)
      : captured(flatText, /Quote\s*No\.?\s*:?\s*([A-Z0-9-]{4,})/i));
  const legacySpecialistName = captured(flatText, /(?:Solar\s+)?Specialist\s*:?\s*(.+?)(?=\s+Mobile\s*:)/i);
  const preparedByName = captured(
    semanticText,
    /Prepared\s+by\s*:?\s*(.+?)(?=\s+[+()\d][+()\d\s-]{7,25}\s+[A-Z0-9._%+-]+@)/i,
  );
  const specialistName = withoutHonorific(greenSketchParties?.specialistName || legacySpecialistName || preparedByName);
  const specialistPhone = greenSketchParties?.specialistPhone
    || captured(flatText, /Specialist[\s\S]*?Mobile\s*:?\s*([+()\d][+()\d\s-]{5,25})/i)
    || captured(
      semanticText,
      /Prepared\s+by\s*:?\s*.+?\s+([+()\d][+()\d\s-]{7,25})(?=\s+[A-Z0-9._%+-]+@)/i,
    );
  const legacyFirstName = captured(flatText, /First\s*Name\s*:?\s*(.+?)(?=\s+Last\s*Name\s*:)/i);
  const legacyLastName = captured(flatText, /Last\s*Name\s*:?\s*(.+?)(?=\s+Contact\s*No\.?\s*:)/i);
  const preparedForName = captured(
    semanticText,
    /Prepared\s+for\s*:?\s*(.+?)(?=\s+[+()\d][+()\d\s-]{7,25}\s+(?:Unit|Suite|Shop|Lot|\d))/i,
  );
  const proposalCustomerName = splitPersonName(greenSketchParties?.customerName || preparedForName);
  const firstName = legacyFirstName || proposalCustomerName.firstName;
  const lastName = legacyLastName || proposalCustomerName.lastName;
  const customerPhone = greenSketchParties?.customerPhone
    || captured(flatText, /Contact\s*No\.?\s*:?\s*([+()\d][+()\d\s-]{5,25})(?=\s+Email\s*:)/i)
    || captured(
      semanticText,
      /Prepared\s+for\s*:?\s*.+?\s+([+()\d][+()\d\s-]{7,25})(?=\s+(?:Unit|Suite|Shop|Lot|\d))/i,
    );
  const email = greenSketchParties?.customerEmail
    || captured(flatText, /Email\s*:?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);

  const installationBlock = between(flatText, /Installation\s+Address\s*:?/i, /Installation\s+Information/i);
  const legacyAddressLine1 = captured(installationBlock, /Address\s+Line\s+1\s*:?\s*(.+?)(?=\s+Address\s+Line\s+1\s*:)/i)
    || captured(installationBlock, /Address\s+Line\s+1\s*:?\s*(.+?)(?=\s+Address\s+Line\s+2\s*:)/i);
  const legacySuburb = captured(installationBlock, /Suburb\s*:?\s*(.+?)(?=\s+Suburb\s*:)/i)
    || captured(installationBlock, /Suburb\s*:?\s*(.+?)(?=\s+State\s*:)/i);
  const legacyState = captured(installationBlock, /State\s*:?\s*([A-Z]{2,3})(?=\s+State\s*:)/i)
    || captured(installationBlock, /State\s*:?\s*([A-Z]{2,3})(?=\s+Postcode\s*:)/i);
  const legacyPostcode = captured(installationBlock, /Postcode\s*:?\s*(\d{4})/i);
  const parsedProposalAddress = proposalAddress(semanticText) || greenSketchParties?.address;
  const addressLine1 = legacyAddressLine1 || parsedProposalAddress?.addressLine1 || "";
  const suburb = legacySuburb || parsedProposalAddress?.suburb || "";
  const state = legacyState || parsedProposalAddress?.state || "";
  const postcode = legacyPostcode || parsedProposalAddress?.postcode || "";
  const balanceText = greenSketchQuotation
    ? captured(pricingText, /\bFinal\s+Price\s*\((?:incl\.?|including)\s*GST\)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i)
    : captured(pricingText, /\bBalance\s+Due\b\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const depositText = greenSketchQuotation
    ? captured(pricingText, /\bDeposit\b\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i)
    : captured(pricingText, /\bDeposit\s+Amount\b\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i)
      || captured(pricingText, /\bLess\s+Deposit(?:\s+Payment\s+pending)?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const balanceDueCents = amountToCents(balanceText);
  const expectedDepositCents = depositText ? amountToCents(depositText) : null;
  const extractedItems = extractItems(flatText, greenSketchQuotation);
  const items = extractedItems.items;
  const solarRebateAssessment = assessProposalSolarRebateRequirement(sourceText);

  const missingFields: string[] = [];
  if (!quoteNumber) missingFields.push("Proposal Number / Quote No");
  if (!specialistName) missingFields.push("Sales representative");
  if (!firstName && !lastName) missingFields.push("customer name");
  if (greenSketchQuotation && !customerPhone) missingFields.push("customer phone");
  if (greenSketchQuotation && (!addressLine1 || !suburb || !state || !postcode)) {
    missingFields.push("installation address");
  }
  if (balanceDueCents === null) missingFields.push("Balance Due");
  if (!items.length) missingFields.push("items");
  if (solarRebateAssessment === null) missingFields.push("Solar Rebate assessment");
  for (const category of extractedItems.unparsedGreenCoreCategories) {
    missingFields.push(`${category} item details`);
  }
  if (missingFields.length) {
    throw new PaymentAgreementParseError(
      `The proposal is missing fields required for Project Track: ${missingFields.join(", ")}.`,
      missingFields,
    );
  }

  const hasBattery = items.some((item) => item.category.toLowerCase().includes("battery"));
  const hasSolarPanel = items.some((item) => item.category.toLowerCase().includes("solar panel"));
  return {
    quoteNumber,
    specialist: { name: specialistName, phone: specialistPhone },
    customer: {
      firstName,
      lastName,
      phone: customerPhone,
      email,
      addressLine1,
      suburb,
      state,
      postcode,
    },
    items,
    balanceDueCents: balanceDueCents ?? 0,
    expectedDepositCents,
    stcSolarRequired: hasSolarPanel,
    stcBatteryRequired: hasBattery,
    // New projects must never turn an ambiguous rebate label into `false`,
    // because that would permanently bypass the pre-scheduling QR gate.
    solarRebateRequired: solarRebateAssessment === true,
    sourceText,
  };
}
