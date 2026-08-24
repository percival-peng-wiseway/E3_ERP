import type { AnnouncementCreateInput, AnnouncementPatchInput } from "./types";

export const ANNOUNCEMENT_MAX_TITLE_LENGTH = 140;
export const ANNOUNCEMENT_MAX_CONTENT_LENGTH = 4_000;
export const ANNOUNCEMENT_MAX_CREATED_BY_LENGTH = 120;

const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function announcementTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title.length > ANNOUNCEMENT_MAX_TITLE_LENGTH || SINGLE_LINE_CONTROL_CHARACTERS.test(title)) {
    return null;
  }
  return title;
}

function announcementContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const content = value.trim();
  if (!content
    || content.length > ANNOUNCEMENT_MAX_CONTENT_LENGTH
    || MULTILINE_CONTROL_CHARACTERS.test(content)) {
    return null;
  }
  return content;
}

export function validAnnouncementCreator(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= ANNOUNCEMENT_MAX_CREATED_BY_LENGTH
    && value === value.trim()
    && !SINGLE_LINE_CONTROL_CHARACTERS.test(value);
}

export function parseAnnouncementCreate(value: unknown): AnnouncementCreateInput | null {
  if (!isRecord(value) || !hasExactlyKeys(value, ["title", "content"])) return null;
  const title = announcementTitle(value.title);
  const content = announcementContent(value.content);
  return title !== null && content !== null ? { title, content } : null;
}

export function parseAnnouncementPatch(value: unknown): AnnouncementPatchInput | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => key !== "title" && key !== "content")) return null;

  const patch: AnnouncementPatchInput = {};
  if (Object.hasOwn(value, "title")) {
    const title = announcementTitle(value.title);
    if (title === null) return null;
    patch.title = title;
  }
  if (Object.hasOwn(value, "content")) {
    const content = announcementContent(value.content);
    if (content === null) return null;
    patch.content = content;
  }
  return patch;
}
