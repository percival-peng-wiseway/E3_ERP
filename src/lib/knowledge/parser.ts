// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_CHUNK_CONFIG } from "./config.ts";
import type { ParsedKnowledgeDocument, ParsedKnowledgeSection } from "./types";

export const KNOWLEDGE_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/x-markdown",
  "text/plain",
] as const;

export class KnowledgeParseError extends Error {
  readonly code: "unsupported_type" | "invalid_document" | "document_too_large" | "parser_unavailable";

  constructor(code: KnowledgeParseError["code"], message: string) {
    super(message);
    this.name = "KnowledgeParseError";
    this.code = code;
  }
}

type DocxAdapter = (bytes: Uint8Array) => Promise<string | ParsedKnowledgeSection[]>;

export type ParseKnowledgeDocumentInput = {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  title?: string;
  docxAdapter?: DocxAdapter;
};

function cleanText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function inferredTitle(fileName: string) {
  return fileName.replace(/\.(?:pdf|docx|txt|md|markdown)$/i, "").trim() || "Untitled document";
}

function assertCharacterLimit(text: string) {
  if (text.length > KNOWLEDGE_CHUNK_CONFIG.maximumDocumentCharacters) {
    throw new KnowledgeParseError("document_too_large", "The extracted document is too large to index safely.");
  }
}

function markdownSections(text: string): ParsedKnowledgeSection[] {
  const sections: ParsedKnowledgeSection[] = [];
  const headingPath: string[] = [];
  let buffer: string[] = [];
  let order = 0;

  const flush = () => {
    const sectionText = cleanText(buffer.join("\n"));
    buffer = [];
    if (!sectionText) return;
    sections.push({ text: sectionText, headingPath: [...headingPath], pageNumber: null, order: order++ });
  };

  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    headingPath.splice(level - 1);
    headingPath[level - 1] = cleanText(heading[2]);
  }
  flush();
  return sections;
}

function plainTextSections(text: string): ParsedKnowledgeSection[] {
  const pages = text.split("\f");
  return pages.flatMap((page, pageIndex) => {
    const value = cleanText(page);
    return value ? [{ text: value, headingPath: [], pageNumber: pages.length > 1 ? pageIndex + 1 : null, order: pageIndex }] : [];
  });
}

type MatrixSource = ArrayLike<number> | { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number };

class PdfDomMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(source?: MatrixSource) {
    if (!source) return;
    if (typeof (source as ArrayLike<number>).length === "number") {
      const values = Array.from(source as ArrayLike<number>);
      if (values.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = values;
    } else Object.assign(this, source);
  }
  get is2D() { return true; }
  get m11() { return this.a; } get m12() { return this.b; }
  get m21() { return this.c; } get m22() { return this.d; }
  get m41() { return this.e; } get m42() { return this.f; }
  multiplySelf(source: MatrixSource) {
    const other = new PdfDomMatrix(source);
    const [a, b, c, d, e, f] = [this.a, this.b, this.c, this.d, this.e, this.f];
    this.a = a * other.a + c * other.b; this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d; this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e; this.f = b * other.e + d * other.f + f;
    return this;
  }
  preMultiplySelf(source: MatrixSource) {
    const result = new PdfDomMatrix(source).multiplySelf(this);
    Object.assign(this, result); return this;
  }
  multiply(source: MatrixSource) { return new PdfDomMatrix(this).multiplySelf(source); }
  translate(x = 0, y = 0) { return this.multiply([1, 0, 0, 1, x, y]); }
  scale(x = 1, y = x) { return this.multiply([x, 0, 0, y, 0, 0]); }
  translateSelf(x = 0, y = 0) { return this.multiplySelf([1, 0, 0, 1, x, y]); }
  scaleSelf(x = 1, y = x) { return this.multiplySelf([x, 0, 0, y, 0, 0]); }
  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) { this.a = this.b = this.c = this.d = this.e = this.f = Number.NaN; return this; }
    const [a, b, c, d, e, f] = [this.a, this.b, this.c, this.d, this.e, this.f];
    this.a = d / determinant; this.b = -b / determinant; this.c = -c / determinant; this.d = a / determinant;
    this.e = (c * f - d * e) / determinant; this.f = (b * e - a * f) / determinant;
    return this;
  }
}

let pdfRuntime: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

async function loadPdfRuntime() {
  if (!globalThis.DOMMatrix) {
    Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: PdfDomMatrix, writable: true });
  }
  pdfRuntime ??= Promise.all([
    // The minified distributions expose the same runtime API while keeping the
    // Cloudflare Worker below its compressed script-size limit.
    // @ts-expect-error -- PDF.js does not ship a declaration for the minified module.
    import("pdfjs-dist/legacy/build/pdf.min.mjs"),
    // @ts-expect-error -- PDF.js does not ship a declaration for its worker module.
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  ]).then(([runtime, worker]) => {
    const target = globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler: unknown } };
    target.pdfjsWorker ??= { WorkerMessageHandler: worker.WorkerMessageHandler };
    return runtime;
  });
  return pdfRuntime;
}

async function pdfSections(bytes: Uint8Array): Promise<ParsedKnowledgeSection[]> {
  const { getDocument } = await loadPdfRuntime();
  const loadingTask = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: true });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > KNOWLEDGE_CHUNK_CONFIG.maximumPdfPages) {
      throw new KnowledgeParseError("document_too_large", "The PDF page count is outside the supported range.");
    }
    const sections: ParsedKnowledgeSection[] = [];
    const recurringEdgeLines = new Map<string, number>();
    const edgeSignature = (text: string) => text.toLocaleLowerCase("en-AU")
      .replace(/\bpage\s+\d+(?:\s+of\s+\d+)?\b/gi, "page #")
      .replace(/\b\d+\s*\/\s*\d+\b/g, "#/#")
      .replace(/\s+/g, " ").trim();
    const rawPages: Array<Array<{ text: string; fontSize: number }>> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: Array<{ text: string; fontSize: number }> = [];
      let line = "";
      let lineFontSize = 0;
      for (const item of content.items) {
        if (!("str" in item) || typeof item.str !== "string") continue;
        line += `${line && !/^\s|^[,.;:)]/.test(item.str) ? " " : ""}${item.str}`;
        if ("transform" in item && Array.isArray(item.transform)) {
          lineFontSize = Math.max(lineFontSize, Math.abs(Number(item.transform[0]) || 0), Math.abs(Number(item.transform[3]) || 0));
        }
        if ("hasEOL" in item && item.hasEOL) {
          const cleaned = cleanText(line);
          if (cleaned) lines.push({ text: cleaned, fontSize: lineFontSize });
          line = "";
          lineFontSize = 0;
        }
      }
      const trailing = cleanText(line);
      if (trailing) lines.push({ text: trailing, fontSize: lineFontSize });
      rawPages.push(lines);
      const edges = [...lines.slice(0, 2), ...lines.slice(-2)];
      for (const edge of new Map(edges.map((candidate) => [edgeSignature(candidate.text), candidate])).values()) {
        if (edge && edge.text.length <= 160) {
          const signature = edgeSignature(edge.text);
          recurringEdgeLines.set(signature, (recurringEdgeLines.get(signature) || 0) + 1);
        }
      }
    }
    const repeatThreshold = Math.max(2, Math.ceil(rawPages.length * 0.6));
    let order = 0;
    let currentHeading: string[] = [];
    rawPages.forEach((lines, pageIndex) => {
      const filtered = lines.filter((line, index) => {
        const edge = index < 2 || index >= lines.length - 2;
        return !edge || (recurringEdgeLines.get(edgeSignature(line.text)) || 0) < repeatThreshold;
      });
      const sizes = filtered.map((line) => line.fontSize).filter((size) => size > 0).sort((a, b) => a - b);
      const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
      let buffer: string[] = [];
      const flush = () => {
        const text = cleanText(buffer.join("\n"));
        buffer = [];
        if (text) sections.push({ text, headingPath: [...currentHeading], pageNumber: pageIndex + 1, order: order++ });
      };
      for (const line of filtered) {
        const looksLikeHeading = median > 0 && line.fontSize >= median * 1.25
          && line.text.length <= 180 && !/[.!?。！？]$/.test(line.text);
        if (looksLikeHeading) {
          flush();
          currentHeading = [line.text];
        } else buffer.push(line.text);
      }
      flush();
    });
    assertCharacterLimit(sections.map((section) => section.text).join("\n").slice(0));
    return sections;
  } catch (error) {
    if (error instanceof KnowledgeParseError) throw error;
    throw new KnowledgeParseError("invalid_document", "The PDF could not be parsed safely.");
  } finally {
    await loadingTask.destroy();
  }
}

function decodedHtmlText(html: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return cleanText(html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (_, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] || "";
  }));
}

function docxHtmlSections(html: string): ParsedKnowledgeSection[] {
  const headings: string[] = [];
  const sections: ParsedKnowledgeSection[] = [];
  let buffer: string[] = [];
  let order = 0;
  const flush = () => {
    const text = cleanText(buffer.join("\n"));
    buffer = [];
    if (text) sections.push({ text, headingPath: [...headings], pageNumber: null, order: order++ });
  };
  for (const match of html.matchAll(/<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = match[1].toLowerCase();
    const text = decodedHtmlText(match[2]);
    if (!text) continue;
    if (tag.startsWith("h")) {
      flush();
      const level = Number(tag[1]);
      headings.splice(level - 1);
      headings[level - 1] = text;
    } else buffer.push(tag === "li" ? `• ${text}` : text);
  }
  flush();
  return sections;
}

function validateDocxArchiveBounds(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEnd = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEnd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new KnowledgeParseError("invalid_document", "The DOCX archive is invalid.");
  const entries = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || entries < 1 || entries > KNOWLEDGE_CHUNK_CONFIG.maximumDocxEntries
    || directoryOffset + directorySize > endOffset) {
    throw new KnowledgeParseError("document_too_large", "The DOCX archive is outside the supported safety limits.");
  }
  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new KnowledgeParseError("invalid_document", "The DOCX archive directory is invalid.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || expanded === 0xffffffff
      || expanded > KNOWLEDGE_CHUNK_CONFIG.maximumDocxEntryBytes) {
      throw new KnowledgeParseError("document_too_large", "The DOCX archive contains an unsupported or oversized entry.");
    }
    expandedBytes += expanded;
    if (expandedBytes > KNOWLEDGE_CHUNK_CONFIG.maximumDocxExpandedBytes) {
      throw new KnowledgeParseError("document_too_large", "The expanded DOCX archive is too large to index safely.");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

async function defaultDocxAdapter(bytes: Uint8Array): Promise<ParsedKnowledgeSection[]> {
  validateDocxArchiveBounds(bytes);
  const mammoth = await import("mammoth");
  const arrayBuffer = new Uint8Array(bytes).buffer;
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return docxHtmlSections(result.value);
}

export function supportsKnowledgeContentType(contentType: string) {
  return (KNOWLEDGE_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase().split(";")[0].trim());
}

export async function parseKnowledgeDocument(input: ParseKnowledgeDocumentInput): Promise<ParsedKnowledgeDocument> {
  if (input.bytes.byteLength > KNOWLEDGE_CHUNK_CONFIG.maximumSourceBytes) {
    throw new KnowledgeParseError("document_too_large", "The source file is too large to index safely.");
  }
  const declaredContentType = input.contentType.toLowerCase().split(";")[0].trim();
  const contentType = declaredContentType === "text/plain" && /\.md$/i.test(input.fileName)
    ? "text/markdown"
    : declaredContentType;
  if (!supportsKnowledgeContentType(contentType)) {
    throw new KnowledgeParseError("unsupported_type", `Unsupported knowledge document type: ${contentType || "unknown"}.`);
  }
  let sections: ParsedKnowledgeSection[] | null = null;
  if (contentType === "application/pdf") sections = await pdfSections(input.bytes);
  else {
    let text: string;
    if (contentType.includes("wordprocessingml")) {
      try {
        const parsed = await (input.docxAdapter || defaultDocxAdapter)(input.bytes);
        if (Array.isArray(parsed)) {
          sections = parsed.map((section, order) => ({ ...section, text: cleanText(section.text), order })).filter((section) => section.text);
          text = "";
        } else text = parsed;
      }
      catch (error) {
        if (error instanceof KnowledgeParseError) throw error;
        throw new KnowledgeParseError("parser_unavailable", "The DOCX parser is unavailable or could not parse this document.");
      }
    } else {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes); }
      catch { throw new KnowledgeParseError("invalid_document", "The text document is not valid UTF-8."); }
    }
    if (!sections) {
      text = cleanText(text!);
      assertCharacterLimit(text);
      sections = contentType.includes("markdown") ? markdownSections(text) : plainTextSections(text);
    } else assertCharacterLimit(sections.map((section) => section.text).join("\n"));
  }
  if (!sections.length) throw new KnowledgeParseError("invalid_document", "The document contains no indexable text.");
  const characterCount = sections.reduce((sum, section) => sum + section.text.length, 0);
  return {
    title: cleanText(input.title || "") || inferredTitle(input.fileName),
    contentType,
    sections,
    characterCount,
  };
}
