import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [workspace, home, dialog, styles] = await Promise.all([
  readFile(new URL("../../../components/erp-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../components/agent-skills-dialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../components/agent-skills-dialog.module.css", import.meta.url), "utf8"),
]);

test("Skill Management is mounted from the Agent header for administrators only", () => {
  assert.match(workspace, /import\("\.\/agent-skills-dialog"\)/);
  assert.match(workspace, /onOpenSkills=\{currentUser\.role === "admin"/);
  assert.match(workspace, /currentUser\.role === "admin"[\s\S]*?<AgentSkillsDialog open/);
  assert.match(home, /isAdmin && onOpenSkills/);
  assert.match(home, /aria-label="Manage Agent skills"/);
  assert.match(home, /aria-haspopup="dialog"/);
});

test("Skill Management uses the fixed CRUD endpoints and locks built-in skills", () => {
  assert.match(dialog, /fetch\("\/api\/settings\/agent\/skills"/);
  assert.match(dialog, /method: creating \? "POST" : "PATCH"/);
  assert.match(dialog, /method: "DELETE"/);
  assert.match(dialog, /expectedVersion: editor\.version/);
  assert.match(dialog, /editor\.source === "built_in"/);
  assert.match(dialog, /Built-in skills are reviewed in source control and cannot be edited here/);
  assert.match(dialog, /setConfirmingDelete\(true\)/);
});

test("Skill Management preserves modal keyboard and responsive behaviour", () => {
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /returnFocusRef\.current\?\.focus/);
  assert.match(dialog, /role="dialog" aria-modal="true"/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /:focus-visible/);
});
