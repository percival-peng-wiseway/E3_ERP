// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { sha256Hex } from "./checksum.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KNOWLEDGE_CHUNK_CONFIG } from "./config.ts";
import type { KnowledgeChunkDraft, ParsedKnowledgeDocument, ParsedKnowledgeSection } from "./types";

export type KnowledgeChunkingConfig = typeof KNOWLEDGE_CHUNK_CONFIG;

type TextUnit = { text: string; tokens: number };

const TOKEN_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\p{L}\p{N}_]+(?:[.\-/][\p{L}\p{N}_]+)*|[^\s]/gu;

export function estimateKnowledgeTokens(text: string): number {
  return Array.from(text.matchAll(TOKEN_PATTERN)).length;
}

function tokenSpans(text: string) {
  return Array.from(text.matchAll(TOKEN_PATTERN), (match) => ({ start: match.index, end: match.index + match[0].length }));
}

function hardSplit(text: string, maximumTokens: number): string[] {
  const spans = tokenSpans(text);
  if (spans.length <= maximumTokens) return [text.trim()].filter(Boolean);
  const output: string[] = [];
  let start = 0;
  while (start < spans.length) {
    const end = Math.min(spans.length, start + maximumTokens);
    const startOffset = spans[start].start;
    const endOffset = end === spans.length ? text.length : spans[end - 1].end;
    const value = text.slice(startOffset, endOffset).trim();
    if (value) output.push(value);
    start = end;
  }
  return output;
}

function sentenceUnits(block: string, maximumTokens: number): TextUnit[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const sentences = Array.from(segmenter.segment(block), ({ segment }) => segment.trim()).filter(Boolean);
  return sentences.flatMap((sentence) => hardSplit(sentence, maximumTokens))
    .map((text) => ({ text, tokens: estimateKnowledgeTokens(text) }))
    .filter((unit) => unit.tokens > 0);
}

function tableUnits(lines: string[], maximumTokens: number): TextUnit[] {
  if (lines.length < 2 || !lines.every((line) => line.includes("|"))) return [];
  const header = lines.slice(0, /^\s*\|?\s*:?-+/.test(lines[1]) ? 2 : 1);
  const rows = lines.slice(header.length);
  const units: TextUnit[] = [];
  let current = [...header];
  let currentTokens = estimateKnowledgeTokens(current.join("\n"));
  for (const row of rows) {
    const rowTokens = estimateKnowledgeTokens(row);
    if (current.length > header.length && currentTokens + rowTokens > maximumTokens) {
      const text = current.join("\n").trim();
      units.push({ text, tokens: estimateKnowledgeTokens(text) });
      current = [...header];
      currentTokens = estimateKnowledgeTokens(current.join("\n"));
    }
    if (currentTokens + rowTokens > maximumTokens) {
      for (const text of hardSplit(row, Math.max(1, maximumTokens - currentTokens))) {
        const withHeader = [...header, text].join("\n").trim();
        units.push({ text: withHeader, tokens: estimateKnowledgeTokens(withHeader) });
      }
      current = [...header];
      currentTokens = estimateKnowledgeTokens(current.join("\n"));
    } else {
      current.push(row);
      currentTokens += rowTokens;
    }
  }
  if (current.length > header.length || !rows.length) {
    const text = current.join("\n").trim();
    if (text) units.push({ text, tokens: estimateKnowledgeTokens(text) });
  }
  return units;
}

function sectionUnits(section: ParsedKnowledgeSection, maximumTokens: number): TextUnit[] {
  const blocks = section.text.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  return blocks.flatMap((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const table = tableUnits(lines, maximumTokens);
    if (table.length) return table;
    if (estimateKnowledgeTokens(block) <= maximumTokens) {
      // A complete paragraph or list is the preferred atomic boundary.
      return [{ text: block, tokens: estimateKnowledgeTokens(block) }];
    }
    return sentenceUnits(block, maximumTokens);
  });
}

function joinUnits(units: TextUnit[]) {
  return units.map(({ text }) => text).join("\n\n").trim();
}

function chunkSection(section: ParsedKnowledgeSection, config: KnowledgeChunkingConfig): string[] {
  const units = sectionUnits(section, config.maximumTokens);
  if (!units.length) return [];
  const totalTokens = units.reduce((sum, unit) => sum + unit.tokens, 0);
  if (totalTokens <= config.maximumTokens) return [joinUnits(units)];

  const output: string[] = [];
  const desiredOverlap = Math.max(1, Math.round(config.targetTokens * config.overlapRatio));
  let start = 0;
  while (start < units.length) {
    let end = start;
    let tokens = 0;
    while (end < units.length) {
      const next = units[end].tokens;
      if (tokens > 0 && tokens + next > config.maximumTokens) break;
      tokens += next;
      end += 1;
      if (tokens >= config.targetTokens) break;
    }
    const trailingTokens = units.slice(end).reduce((sum, unit) => sum + unit.tokens, 0);
    if (trailingTokens > 0 && trailingTokens < config.minimumTokens && tokens + trailingTokens <= config.maximumTokens) {
      end = units.length;
    }
    if (end === start) end += 1;
    output.push(joinUnits(units.slice(start, end)));
    if (end >= units.length) break;
    let nextStart = end;
    let overlap = 0;
    while (nextStart > start && overlap < desiredOverlap) {
      nextStart -= 1;
      overlap += units[nextStart].tokens;
    }
    start = nextStart < end ? nextStart : end;
  }
  return output;
}

export function chunkIndexItemKey(documentId: string, indexGeneration: number, chunkIndex: number) {
  return `knowledge/${documentId}/g${indexGeneration}/${String(chunkIndex).padStart(5, "0")}`;
}

export function chunkParsedKnowledgeDocument(input: {
  documentId: string;
  indexGeneration: number;
  parsed: ParsedKnowledgeDocument;
  config?: KnowledgeChunkingConfig;
}): KnowledgeChunkDraft[] {
  const config = input.config || KNOWLEDGE_CHUNK_CONFIG;
  if (config.minimumTokens < 1 || config.targetTokens < config.minimumTokens
    || config.maximumTokens < config.targetTokens || config.overlapRatio < 0 || config.overlapRatio >= 0.5) {
    throw new Error("Invalid knowledge chunk configuration.");
  }
  let chunkIndex = 0;
  return [...input.parsed.sections]
    .sort((left, right) => left.order - right.order)
    .flatMap((section) => chunkSection(section, config).map((text) => {
      const currentIndex = chunkIndex++;
      return {
        text,
        tokenCount: estimateKnowledgeTokens(text),
        headingPath: [...section.headingPath],
        pageFrom: section.pageNumber,
        pageTo: section.pageNumber,
        contentChecksum: sha256Hex(text),
        indexItemKey: chunkIndexItemKey(input.documentId, input.indexGeneration, currentIndex),
      };
    }));
}
