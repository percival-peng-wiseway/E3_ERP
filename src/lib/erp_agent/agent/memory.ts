import type { AgentHistoryMessage } from "@/lib/erp";

export type AgentControlledMemory = {
  responseLanguage: "english" | "chinese" | null;
  detailLevel: "concise" | "detailed" | null;
  tablePreference: "prefer" | "avoid" | null;
  keys: readonly string[];
};

const EMPTY_MEMORY: AgentControlledMemory = {
  responseLanguage: null,
  detailLevel: null,
  tablePreference: null,
  keys: [],
};

/**
 * Extract only explicit presentation preferences from user-authored turns.
 * Business facts, identifiers, permissions and personal data are deliberately
 * excluded, so conversation history can never become an evidence source.
 */
export function controlledMemoryFromConversation(
  message: string,
  history: readonly AgentHistoryMessage[] = [],
): AgentControlledMemory {
  const userTurns = [
    ...history.filter((item) => item.role === "user").map((item) => item.content),
    message,
  ].slice(-12);
  if (!userTurns.length) return EMPTY_MEMORY;

  let responseLanguage: AgentControlledMemory["responseLanguage"] = null;
  let detailLevel: AgentControlledMemory["detailLevel"] = null;
  let tablePreference: AgentControlledMemory["tablePreference"] = null;

  for (const raw of userTurns) {
    const value = raw.normalize("NFKC").toLocaleLowerCase("en-AU");
    if (/\b(?:always|from now on|please)\b.{0,24}\b(?:answer|reply|respond)\b.{0,16}\b(?:in )?(?:chinese|mandarin)\b|以后.{0,12}(?:用中文|中文回答)|请.{0,12}(?:用中文|中文回答)/u.test(value)) {
      responseLanguage = "chinese";
    }
    if (/\b(?:always|from now on|please)\b.{0,24}\b(?:answer|reply|respond)\b.{0,16}\b(?:in )?english\b|以后.{0,12}(?:用英文|英文回答)|请.{0,12}(?:用英文|英文回答)/u.test(value)) {
      responseLanguage = "english";
    }
    if (/\b(?:keep|make|prefer)\b.{0,20}\b(?:answers?|replies?)\b.{0,12}\b(?:brief|concise|short)\b|以后.{0,12}(?:简短|简洁)|回答.{0,8}(?:简短|简洁)/u.test(value)) {
      detailLevel = "concise";
    }
    if (/\b(?:prefer|give|provide)\b.{0,20}\b(?:detailed|thorough)\b.{0,12}\b(?:answers?|replies?)?\b|以后.{0,12}(?:详细|完整)|回答.{0,8}(?:详细|完整)/u.test(value)) {
      detailLevel = "detailed";
    }
    if (/\b(?:prefer|use)\b.{0,16}\btables?\b|优先.{0,8}表格|使用表格/u.test(value)) {
      tablePreference = "prefer";
    }
    if (/\b(?:avoid|do not|don't)\b.{0,16}\btables?\b|不要.{0,8}表格|避免.{0,8}表格/u.test(value)) {
      tablePreference = "avoid";
    }
  }

  const keys = [
    responseLanguage ? "response_language" : null,
    detailLevel ? "detail_level" : null,
    tablePreference ? "table_preference" : null,
  ].filter((value): value is string => Boolean(value));
  return { responseLanguage, detailLevel, tablePreference, keys };
}

export function controlledMemoryPrompt(memory: AgentControlledMemory): string[] {
  const guidance: string[] = [];
  if (memory.responseLanguage === "chinese") guidance.push("The user explicitly prefers responses in Chinese.");
  if (memory.responseLanguage === "english") guidance.push("The user explicitly prefers responses in English.");
  if (memory.detailLevel === "concise") guidance.push("The user explicitly prefers concise answers.");
  if (memory.detailLevel === "detailed") guidance.push("The user explicitly prefers detailed answers when evidence supports them.");
  if (memory.tablePreference === "prefer") guidance.push("Prefer a compact table when comparing repeated records.");
  if (memory.tablePreference === "avoid") guidance.push("Avoid tables unless they are required for clarity.");
  return guidance;
}
