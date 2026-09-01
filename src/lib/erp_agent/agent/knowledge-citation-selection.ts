const CHUNK_ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,160}$/;
const FOOTER_PATTERN = /\n?\[\[KB_CITATIONS:([^\]\n]{1,1400})\]\]\s*$/;

/**
 * Parse the model's machine-readable citation selection. The caller must still
 * map every returned ID to this turn's authorised tool result.
 */
export function parseKnowledgeCitationSelection(content: string) {
  const match = content.match(FOOTER_PATTERN);
  if (!match) return null;
  const answer = content.slice(0, match.index).trim();
  const chunkIds = [...new Set(match[1].split(",").map((value) => value.trim()).filter(Boolean))];
  if (!answer || !chunkIds.length || chunkIds.length > 8 || chunkIds.some((value) => !CHUNK_ID_PATTERN.test(value))) {
    return null;
  }
  return { answer, chunkIds };
}
