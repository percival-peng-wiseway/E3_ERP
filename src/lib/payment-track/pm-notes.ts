const PM_NOTES_MAX_LENGTH = 5_000;

export type ParsedPaymentTrackPmNotes = {
  notes: string;
  expectedPmNotesUpdatedAt: string | null;
};

function exactUtcTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function parsePaymentTrackPmNotesBody(
  body: Record<string, unknown>,
): ParsedPaymentTrackPmNotes | null {
  const allowed = new Set([
    "action",
    "actorRole",
    "actorName",
    "notes",
    "expectedPmNotesUpdatedAt",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (body.action !== "update_pm_notes" || !("actorRole" in body)) return null;
  if (!("notes" in body) || typeof body.notes !== "string") return null;
  if (!("expectedPmNotesUpdatedAt" in body)) return null;
  if (body.actorName !== undefined && typeof body.actorName !== "string") return null;

  const expected = body.expectedPmNotesUpdatedAt;
  if (expected !== null && (typeof expected !== "string" || !exactUtcTimestamp(expected))) return null;
  const notes = body.notes.trim();
  if (notes.length > PM_NOTES_MAX_LENGTH
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(notes)) return null;
  return { notes, expectedPmNotesUpdatedAt: expected };
}
