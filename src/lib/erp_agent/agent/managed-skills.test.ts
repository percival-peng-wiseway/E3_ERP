import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDataDirectory = path.join(tmpdir(), `managed-skills-${randomUUID()}`);
const mutableProcessEnv = process.env as Record<string, string | undefined>;
const originalDataDirectory = mutableProcessEnv.AGENT_SKILLS_DATA_DIR;
mutableProcessEnv.AGENT_SKILLS_DATA_DIR = testDataDirectory;

const modulePath = "./managed-skills.ts";
const {
  ManagedSkillError,
  WEEKLY_BUSINESS_SUMMARY_SKILL_ID,
  createManagedAgentSkill,
  deleteManagedAgentSkill,
  listManagedAgentSkills,
  normalizeManagedSkillTrigger,
  parseCreateManagedSkillInput,
  resolveInvokedManagedSkill,
  updateManagedAgentSkill,
} = await import(modulePath) as typeof import("./managed-skills");

const validSkill = {
  name: "Weekly stock brief",
  description: "A short inventory and schedule brief.",
  trigger: "Give me the weekly stock brief",
  prompt: "Summarize this week's Weekly Schedule and current inventory health.",
  enabled: true,
  capabilityIds: ["weekly_schedule", "inventory"],
} as const;

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
  if (originalDataDirectory === undefined) delete mutableProcessEnv.AGENT_SKILLS_DATA_DIR;
  else mutableProcessEnv.AGENT_SKILLS_DATA_DIR = originalDataDirectory;
});

test("managed Skill input is strict and limited to approved read-only capabilities", () => {
  assert.deepEqual(parseCreateManagedSkillInput(validSkill), {
    ...validSkill,
    capabilityIds: ["weekly_schedule", "inventory"],
  });
  for (const value of [
    { ...validSkill, code: "return secrets" },
    { ...validSkill, url: "https://example.com" },
    { ...validSkill, permissions: ["finance.read"] },
    { ...validSkill, capabilityIds: ["arbitrary_tool"] },
    { ...validSkill, capabilityIds: [] },
    { ...validSkill, trigger: " " },
    { ...validSkill, prompt: " " },
  ]) {
    assert.throws(() => parseCreateManagedSkillInput(value), ManagedSkillError);
  }
});

test("trigger normalization is exact, Unicode-safe and punctuation tolerant", () => {
  assert.equal(normalizeManagedSkillTrigger("  ＳＵＭＭＡＲＩＺＥ   this week！ "), "summarize this week");
  assert.equal(normalizeManagedSkillTrigger("总结本周。"), "总结本周");
});

test("built-in weekly summary resolves without mutable catalog state", async () => {
  for (const message of ["Summarize this week", "summarise this week!", "summrize this week", "总结本周。"] ) {
    const skill = await resolveInvokedManagedSkill({ message });
    assert.equal(skill?.id, WEEKLY_BUSINESS_SUMMARY_SKILL_ID, message);
    assert.equal(skill?.source, "built_in");
  }
});

test("custom Skills persist, enforce trigger uniqueness and optimistic versions", async () => {
  const created = await createManagedAgentSkill(validSkill, "admin.user");
  assert.equal(created.source, "custom");
  assert.equal(created.version, 1);
  assert.equal((await listManagedAgentSkills({ includeDisabled: true })).length, 2);
  assert.equal((await resolveInvokedManagedSkill({ message: `${validSkill.trigger}.` }))?.id, created.id);

  await assert.rejects(
    createManagedAgentSkill({ ...validSkill, name: "Duplicate" }, "admin.user"),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_trigger_exists",
  );
  await assert.rejects(
    createManagedAgentSkill({ ...validSkill, name: "Reserved", trigger: "This week summary" }, "admin.user"),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_trigger_exists",
  );

  const disabled = await updateManagedAgentSkill(created.id, {
    expectedVersion: created.version,
    enabled: false,
  }, "admin.user");
  assert.equal(disabled.version, 2);
  assert.equal(disabled.enabled, false);
  assert.equal(await resolveInvokedManagedSkill({ message: validSkill.trigger }), null);
  await assert.rejects(
    resolveInvokedManagedSkill({ skillId: created.id, message: validSkill.trigger }),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_disabled",
  );
  await assert.rejects(
    updateManagedAgentSkill(created.id, { expectedVersion: 1, enabled: true }, "admin.user"),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_conflict",
  );

  assert.equal(await deleteManagedAgentSkill(created.id, disabled.version), created.id);
  assert.equal((await listManagedAgentSkills({ includeDisabled: true })).length, 1);
});
