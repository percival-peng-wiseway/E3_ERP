import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [workspace, home, dialog, styles, homeStyles, collectionRoute, itemRoute, agentRoute] = await Promise.all([
  readFile(new URL("../../../components/erp-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../components/home-collaboration-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../components/agent-skills-dialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../../components/agent-skills-dialog.module.css", import.meta.url), "utf8"),
  readFile(new URL("../../../components/home-collaboration-workspace.module.css", import.meta.url), "utf8"),
  readFile(new URL("../../../app/api/settings/agent/skills/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../app/api/settings/agent/skills/[id]/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../app/api/agent/route.ts", import.meta.url), "utf8"),
]);

test("Skill Management is available to every signed-in user without widening administrator tools", () => {
  assert.match(workspace, /import\("\.\/agent-skills-dialog"\)/);
  assert.match(workspace, /onOpenSkills=\{\(initialSkillId\) => \{[\s\S]*?setAgentSkillsInitialId\(initialSkillId\);[\s\S]*?setAgentSkillsOpen\(true\)/);
  assert.doesNotMatch(workspace, /onOpenSkills=\{currentUser\.role === "admin"/);
  assert.match(workspace, /\{agentSkillsOpen \? \([\s\S]*?<AgentSkillsDialog[\s\S]*?\bopen\b/);
  assert.match(home, /\{onOpenSkills \? \(/);
  assert.doesNotMatch(home, /isAdmin && onOpenSkills/);
  assert.match(home, /aria-label="Manage your Agent skills"/);
  assert.match(home, /aria-haspopup="dialog"/);
  assert.match(workspace, /onOpenSettings=\{currentUser\.role === "admin"/);
  assert.match(workspace, /currentUser\.role === "admin" && agentTraceSidebarOpen/);
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

test("Skill Management describes custom skills as personal", () => {
  assert.match(dialog, />My Agent Skills</);
  assert.match(dialog, /Create and manage your reusable, read-only E3 Agent workflows/);
  assert.match(dialog, /Built-in and your Agent skills/);
  assert.match(dialog, /Enabled for my E3 Agent/);
  assert.match(dialog, /Changing this setting affects only your account/);
  assert.doesNotMatch(dialog, /affects all users|for every E3 Agent user/);
});

test("Skill APIs derive personal ownership from authentication and preserve write guards", () => {
  for (const route of [collectionRoute, itemRoute]) {
    assert.match(route, /agentAuthContext\(request\)/);
    assert.match(route, /principalHash: auth\.principalHash, username: session\.user\.username/);
    assert.doesNotMatch(route, /user\.role\s*[!=]==?\s*"admin"|adminSession|mutationSession/);
  }
  assert.match(collectionRoute, /listManagedAgentSkills\(owner,/);
  assert.match(collectionRoute, /createManagedAgentSkill\(body, owner!/);
  assert.match(itemRoute, /updateManagedAgentSkill\(id, await readBody\(request\), owner!/);
  assert.match(itemRoute, /deleteManagedAgentSkill\(id,[\s\S]*?expectedVersion, owner!/);
  assert.match(collectionRoute, /isSameOriginRequest\(request\)/);
  assert.match(itemRoute, /isSameOriginRequest\(request\)/);
  assert.match(collectionRoute, /ERP_REMOTE_DATA_READ_ONLY/);
  assert.match(itemRoute, /ERP_REMOTE_DATA_READ_ONLY/);
  assert.match(agentRoute, /resolveInvokedManagedSkill\(\{[\s\S]*?owner: \{ principalHash: auth\.principalHash, username: session\.user\.username \}/);
});

test("chat-created Skills use strict structured metadata and remain discoverable", () => {
  assert.match(home, /type AgentSkillMutation = \{[\s\S]*?type: "created";[\s\S]*?capabilityIds: string\[\]/);
  assert.match(home, /hasExactlyKeys\(mutation, \["type", "skill"\]\)/);
  assert.match(home, /hasExactlyKeys\(skill, \["id", "name", "trigger", "version", "capabilityIds"\]\)/);
  assert.match(home, /AGENT_SKILL_ID_PATTERN\.test\(skill\.id\)/);
  assert.match(home, /AGENT_SKILL_CAPABILITY_IDS\.has\(id\)/);
  assert.match(home, /const skillMutation = readAgentSkillMutation\(body\.meta\?\.skillMutation\)/);
  assert.match(home, /const requestId = isRetry && lastMessage\?\.role === "user" \? lastMessage\.id : userMessage\.id/);
  assert.match(home, /request_id: requestId/);
  assert.doesNotMatch(home, /const isRetry = Boolean\(agentError\)/);
  assert.match(home, /skillMutationCharacters = message\.skillMutation \? JSON\.stringify\(message\.skillMutation\)\.length : 0/);
  assert.match(home, /new CustomEvent\("erp:agent-skills-updated"/);
  assert.match(home, /setAgentSuggestions\(\(current\) => \[[\s\S]*?skillMutation\.skill\.trigger/);
  assert.match(home, /Personal Skill created/);
  assert.match(home, /Exact trigger:/);
  assert.match(home, /Open in My Skills/);
  assert.match(home, /onOpenSkills\(message\.skillMutation\?\.skill\.id\)/);
  assert.doesNotMatch(home, /skillMutation\.skill\.(?:prompt|owner|updatedBy)/);
});

test("chat-created Skills open a freshly loaded dialog focused on their ID", () => {
  assert.match(workspace, /const \[agentSkillsInitialId, setAgentSkillsInitialId\] = useState<string>\(\)/);
  assert.match(workspace, /initialSkillId=\{agentSkillsInitialId\}/);
  assert.match(dialog, /initialSkillId\?: string/);
  assert.match(dialog, /void loadSkills\(initialSkillId\)/);
  assert.match(dialog, /fetch\("\/api\/settings\/agent\/skills", \{ cache: "no-store"/);
  assert.match(dialog, /nextSkills\.find\(\(skill\) => skill\.id === preferredId\)/);
});

test("Skill Management preserves modal keyboard and responsive behaviour", () => {
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /returnFocusRef\.current\?\.focus/);
  assert.match(dialog, /role="dialog" aria-modal="true"/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(home, /className=\{styles\.skillCreatedCard\}/);
  assert.match(homeStyles, /\.skillCreatedCard button:focus-visible/);
});
