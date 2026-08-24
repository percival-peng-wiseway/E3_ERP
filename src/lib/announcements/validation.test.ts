import assert from "node:assert/strict";
import { test } from "node:test";

const validationModule = "./validation.ts";
const {
  ANNOUNCEMENT_MAX_CONTENT_LENGTH,
  ANNOUNCEMENT_MAX_TITLE_LENGTH,
  parseAnnouncementCreate,
  parseAnnouncementPatch,
} = await import(validationModule) as typeof import("./validation");

test("create accepts a blank title, requires content and normalizes whitespace", () => {
  assert.deepEqual(parseAnnouncementCreate({ title: "  ", content: "  Team update\nSecond line  " }), {
    title: "",
    content: "Team update\nSecond line",
  });
  assert.equal(parseAnnouncementCreate({ title: "Update", content: "  " }), null);
});

test("create rejects extra or spoofed author fields and unsafe values", () => {
  assert.equal(parseAnnouncementCreate({ title: "Update", content: "Hello", createdBy: "Fake Admin" }), null);
  assert.equal(parseAnnouncementCreate({ content: "Hello" }), null);
  assert.equal(parseAnnouncementCreate({ title: "x".repeat(ANNOUNCEMENT_MAX_TITLE_LENGTH + 1), content: "Hello" }), null);
  assert.equal(parseAnnouncementCreate({ title: "Update", content: "x".repeat(ANNOUNCEMENT_MAX_CONTENT_LENGTH + 1) }), null);
  assert.equal(parseAnnouncementCreate({ title: "Unsafe\nTitle", content: "Hello" }), null);
  assert.equal(parseAnnouncementCreate({ title: "Update", content: "Unsafe\u0000content" }), null);
});

test("patch accepts only a non-empty subset of editable fields", () => {
  assert.deepEqual(parseAnnouncementPatch({ title: "" }), { title: "" });
  assert.deepEqual(parseAnnouncementPatch({ content: " Revised " }), { content: "Revised" });
  assert.deepEqual(parseAnnouncementPatch({ title: " Update ", content: " Message " }), {
    title: "Update",
    content: "Message",
  });
  assert.equal(parseAnnouncementPatch({}), null);
  assert.equal(parseAnnouncementPatch({ createdBy: "Fake Admin" }), null);
  assert.equal(parseAnnouncementPatch({ content: "" }), null);
});

