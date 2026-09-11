import type { KnowledgeDocument, ParsedKnowledgeDocument } from "./types";
// @ts-expect-error -- Node focused tests require explicit extensions.
import { erpCloudflareBindings } from "../server/cloudflare-storage.ts";
// @ts-expect-error -- Node focused tests require explicit extensions.
import { parseKnowledgeDocument, KnowledgeParseError } from "./parser.ts";

export type MarkdownArtifact = {
  converter: "markitdown" | "legacy-parser";
  converterVersion: string;
  sourceChecksum: string;
  generation: number;
  createdAt: string;
  markdown: string;
  pages: { pageNumber: number | null; markdown: string }[];
};
const key = (document: KnowledgeDocument) => `knowledge-artifacts/${document.id}/g${document.indexGeneration}/${document.sourceChecksum}/markdown.json`;

export async function readMarkdownArtifact(document: KnowledgeDocument): Promise<MarkdownArtifact | null> {
  const bindings = await erpCloudflareBindings();
  if (!bindings?.files) return null;
  const raw = await bindings.files.get(key(document), "arrayBuffer");
  if (!raw) return null;
  const artifact = JSON.parse(new TextDecoder().decode(raw)) as MarkdownArtifact;
  return artifact.sourceChecksum === document.sourceChecksum && artifact.generation === document.indexGeneration ? artifact : null;
}

export async function prepareMarkdown(document: KnowledgeDocument, bytes: Uint8Array): Promise<ParsedKnowledgeDocument> {
  const bindings = await erpCloudflareBindings();
  const endpoint = process.env.MARKITDOWN_SERVICE_URL;
  const token = process.env.MARKITDOWN_SERVICE_TOKEN;
  let parsed: ParsedKnowledgeDocument;
  let artifact: MarkdownArtifact;
  if (bindings?.documentConverter || (endpoint && token)) {
    const url = new URL(bindings?.documentConverter ? "https://converter.internal" : endpoint!);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "127.0.0.1")) throw new KnowledgeParseError("parser_unavailable", "The document converter endpoint must use HTTPS.");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/convert`;
    const conversionRequest = new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": document.contentType }, body: new Uint8Array(bytes), redirect: "manual", signal: AbortSignal.timeout(90_000) });
    const response = bindings?.documentConverter ? await bindings.documentConverter.fetch(conversionRequest) : await fetch(conversionRequest);
    if (!response.ok || !response.body) throw new KnowledgeParseError("parser_unavailable", "MarkItDown conversion failed. Check the converter service.");
    const reader = response.body.getReader();
    let size = 0;
    const parts: Uint8Array[] = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new KnowledgeParseError("document_too_large", "Converted document is too large."); }
      parts.push(part.value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    const value = JSON.parse(new TextDecoder().decode(output));
    if (value.converter !== "markitdown" || typeof value.version !== "string" || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 250
      || !value.pages.every((page: {pageNumber: unknown; markdown: unknown}) => typeof page.markdown === "string" && (page.pageNumber === null || Number.isSafeInteger(page.pageNumber) && Number(page.pageNumber) >= 1 && Number(page.pageNumber) <= 250))) throw new KnowledgeParseError("invalid_document", "Invalid converter result.");
    const pages = value.pages as MarkdownArtifact["pages"];
    const sections = [];
    for (const page of pages) {
      if (!page.markdown.trim()) continue;
      const pageParsed = await parseKnowledgeDocument({ bytes: new TextEncoder().encode(page.markdown), contentType: "text/markdown", fileName: "converted.md", title: document.title });
      for (const section of pageParsed.sections) sections.push({ ...section, pageNumber: page.pageNumber, order: sections.length });
    }
    const characterCount = pages.reduce((sum, page) => sum + page.markdown.length, 0);
    if (!sections.length || characterCount > 4_000_000) throw new KnowledgeParseError("invalid_document", "The converted document has no text or is too large.");
    parsed = { title: document.title, contentType: "text/markdown", sections, characterCount };
    artifact = { converter: "markitdown", converterVersion: value.version, sourceChecksum: document.sourceChecksum, generation: document.indexGeneration, createdAt: new Date().toISOString(), pages, markdown: pages.map(p => `${p.pageNumber ? `<!-- page ${p.pageNumber} -->\n\n` : ""}${p.markdown}`).join("\n\n") };
  } else {
    parsed = await parseKnowledgeDocument({ bytes, contentType: document.contentType, fileName: document.fileName, title: document.title });
    const pages = parsed.sections.map(section => ({ pageNumber: section.pageNumber, markdown: `${section.headingPath.map(h => `## ${h}`).join("\n")}\n\n${section.text}`.trim() }));
    artifact = { converter: "legacy-parser", converterVersion: "1", sourceChecksum: document.sourceChecksum, generation: document.indexGeneration, createdAt: new Date().toISOString(), pages, markdown: pages.map(p => p.markdown).join("\n\n") };
  }
  if (bindings?.files) await bindings.files.put(key(document), JSON.stringify(artifact));
  return parsed;
}
