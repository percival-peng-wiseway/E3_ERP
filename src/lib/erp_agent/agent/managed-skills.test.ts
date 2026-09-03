import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  PERSONAL_SKILL_BUILDER_SKILL_ID,
  WEEKLY_BUSINESS_SUMMARY_SKILL_ID,
  createManagedAgentSkill,
  deleteManagedAgentSkill,
  listManagedAgentSkills,
  normalizeManagedSkillTrigger,
  parseCreateManagedSkillInput,
  resolveInvokedManagedSkill,
  updateManagedAgentSkill,
} = await import(modulePath) as typeof import("./managed-skills");

const ADMIN_OWNER = { username: "admin.user", principalHash: "a".repeat(64) };
const ALICE_OWNER = { username: "alice.user", principalHash: "b".repeat(64) };
const BOB_OWNER = { username: "bob.user", principalHash: "c".repeat(64) };
const MALLORY_OWNER = { username: "mallory.user", principalHash: "d".repeat(64) };
const LEGACY_OWNER = { username: "legacy.user", principalHash: "e".repeat(64) };
const OTHER_LEGACY_OWNER = { username: "other.legacy", principalHash: "f".repeat(64) };

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
    { ...validSkill, owner: ALICE_OWNER },
    { ...validSkill, ownerUsername: ALICE_OWNER.username },
    { ...validSkill, createdBy: ALICE_OWNER.username },
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
    const skill = await resolveInvokedManagedSkill({ message, owner: ADMIN_OWNER });
    assert.equal(skill?.id, WEEKLY_BUSINESS_SUMMARY_SKILL_ID, message);
    assert.equal(skill?.source, "built_in");
  }
});

test("the personal Skill Builder is visible as a locked built-in Skill", async () => {
  const skills = await listManagedAgentSkills(ADMIN_OWNER, { includeDisabled: true });
  const builder = skills.find(({ id }) => id === PERSONAL_SKILL_BUILDER_SKILL_ID);
  assert.ok(builder);
  assert.equal(builder.source, "built_in");
  assert.equal(builder.enabled, true);
  assert.equal(builder.updatedBy, "system");
  assert.equal(
    (await resolveInvokedManagedSkill({
      skillId: PERSONAL_SKILL_BUILDER_SKILL_ID,
      message: "Create a Skill",
      owner: ADMIN_OWNER,
    }))?.id,
    PERSONAL_SKILL_BUILDER_SKILL_ID,
  );

  const legacyCompatible = await createManagedAgentSkill({
    ...validSkill,
    name: "Existing create-skill trigger",
    trigger: "Create a Skill",
  }, ADMIN_OWNER);
  assert.equal(
    (await resolveInvokedManagedSkill({ message: "Create a Skill", owner: ADMIN_OWNER }))?.id,
    legacyCompatible.id,
    "an existing personal trigger must take precedence over the conversational builder heuristic",
  );
  await deleteManagedAgentSkill(legacyCompatible.id, legacyCompatible.version, ADMIN_OWNER);
});

test("custom Skills persist, enforce trigger uniqueness and optimistic versions", async () => {
  const created = await createManagedAgentSkill(validSkill, ADMIN_OWNER);
  assert.equal(created.source, "custom");
  assert.equal(created.version, 1);
  assert.equal((await listManagedAgentSkills(ADMIN_OWNER, { includeDisabled: true })).length, 3);
  assert.equal((await resolveInvokedManagedSkill({ message: `${validSkill.trigger}.`, owner: ADMIN_OWNER }))?.id, created.id);

  await assert.rejects(
    createManagedAgentSkill({ ...validSkill, name: "Duplicate" }, ADMIN_OWNER),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_trigger_exists",
  );
  await assert.rejects(
    createManagedAgentSkill({ ...validSkill, name: "Reserved", trigger: "This week summary" }, ADMIN_OWNER),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_trigger_exists",
  );
  const disabled = await updateManagedAgentSkill(created.id, {
    expectedVersion: created.version,
    enabled: false,
  }, ADMIN_OWNER);
  assert.equal(disabled.version, 2);
  assert.equal(disabled.enabled, false);
  assert.equal(await resolveInvokedManagedSkill({ message: validSkill.trigger, owner: ADMIN_OWNER }), null);
  await assert.rejects(
    resolveInvokedManagedSkill({ skillId: created.id, message: validSkill.trigger, owner: ADMIN_OWNER }),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_disabled",
  );
  await assert.rejects(
    updateManagedAgentSkill(created.id, { expectedVersion: 1, enabled: true }, ADMIN_OWNER),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_conflict",
  );

  assert.equal(await deleteManagedAgentSkill(created.id, disabled.version, ADMIN_OWNER), created.id);
  assert.equal((await listManagedAgentSkills(ADMIN_OWNER, { includeDisabled: true })).length, 2);
});

test("custom Skills are isolated per owner while the same trigger remains available to each owner", async () => {
  const sharedTrigger = "Show my private weekly brief";
  const alice = await createManagedAgentSkill({
    ...validSkill,
    name: "Alice private brief",
    trigger: sharedTrigger,
    prompt: "Summarize Alice's inventory only.",
    capabilityIds: ["inventory"],
  }, ALICE_OWNER);
  const bob = await createManagedAgentSkill({
    ...validSkill,
    name: "Bob private brief",
    trigger: sharedTrigger,
    prompt: "Summarize Bob's reimbursements only.",
    capabilityIds: ["reimbursements"],
  }, BOB_OWNER);

  assert.notEqual(alice.id, bob.id);
  assert.deepEqual(
    (await listManagedAgentSkills(ALICE_OWNER, { includeDisabled: true })).map(({ id }) => id),
    [WEEKLY_BUSINESS_SUMMARY_SKILL_ID, PERSONAL_SKILL_BUILDER_SKILL_ID, alice.id],
  );
  assert.deepEqual(
    (await listManagedAgentSkills(BOB_OWNER, { includeDisabled: true })).map(({ id }) => id),
    [WEEKLY_BUSINESS_SUMMARY_SKILL_ID, PERSONAL_SKILL_BUILDER_SKILL_ID, bob.id],
  );

  const aliceResolved = await resolveInvokedManagedSkill({ message: `${sharedTrigger}!`, owner: ALICE_OWNER });
  const bobResolved = await resolveInvokedManagedSkill({ message: sharedTrigger, owner: BOB_OWNER });
  assert.equal(aliceResolved?.id, alice.id);
  assert.equal(aliceResolved?.prompt, "Summarize Alice's inventory only.");
  assert.deepEqual(aliceResolved?.capabilityIds, ["inventory"]);
  assert.equal(bobResolved?.id, bob.id);
  assert.equal(bobResolved?.prompt, "Summarize Bob's reimbursements only.");
  assert.deepEqual(bobResolved?.capabilityIds, ["reimbursements"]);

  const aliceUpdated = await updateManagedAgentSkill(alice.id, {
    expectedVersion: alice.version,
    name: "Alice updated brief",
  }, ALICE_OWNER);
  assert.equal(aliceUpdated.name, "Alice updated brief");
  assert.equal((await resolveInvokedManagedSkill({ skillId: bob.id, message: sharedTrigger, owner: BOB_OWNER }))?.id, bob.id);

  assert.equal(await deleteManagedAgentSkill(alice.id, aliceUpdated.version, ALICE_OWNER), alice.id);
  assert.equal(await deleteManagedAgentSkill(bob.id, bob.version, BOB_OWNER), bob.id);
});

test("foreign Skill UUIDs return 404 before version or enabled state can leak", async () => {
  const victim = await createManagedAgentSkill({
    ...validSkill,
    name: "Alice disabled private brief",
    trigger: "Alice disabled private trigger",
    enabled: false,
  }, ALICE_OWNER);

  const isHiddenNotFound = (error: unknown) => error instanceof ManagedSkillError
    && error.status === 404
    && error.code === "skill_not_found";
  await assert.rejects(
    updateManagedAgentSkill(victim.id, { expectedVersion: victim.version + 99, enabled: true }, MALLORY_OWNER),
    isHiddenNotFound,
  );
  await assert.rejects(
    deleteManagedAgentSkill(victim.id, victim.version + 99, MALLORY_OWNER),
    isHiddenNotFound,
  );
  await assert.rejects(
    resolveInvokedManagedSkill({ skillId: victim.id, message: victim.trigger, owner: MALLORY_OWNER }),
    isHiddenNotFound,
  );
  assert.equal(
    await resolveInvokedManagedSkill({ message: victim.trigger, owner: MALLORY_OWNER }),
    null,
    "a trigger phrase must not discover another owner's Skill",
  );

  const unchanged = (await listManagedAgentSkills(ALICE_OWNER, { includeDisabled: true }))
    .find(({ id }) => id === victim.id);
  assert.equal(unchanged?.version, victim.version);
  assert.equal(unchanged?.enabled, false);
  await assert.rejects(
    resolveInvokedManagedSkill({ skillId: victim.id, message: victim.trigger, owner: ALICE_OWNER }),
    (error: unknown) => error instanceof ManagedSkillError && error.code === "skill_disabled",
  );
  assert.equal(await deleteManagedAgentSkill(victim.id, victim.version, ALICE_OWNER), victim.id);
});

test("an empty personal catalog remains authoritative after deleting a legacy Skill", async () => {
  const timestamp = "2026-09-04T00:00:00.000Z";
  const legacySkill = {
    ...validSkill,
    id: randomUUID(),
    name: "Legacy personal brief",
    trigger: "Run my legacy personal brief",
    source: "custom" as const,
    version: 1,
    createdAt: timestamp,
    createdBy: LEGACY_OWNER.username,
    updatedAt: timestamp,
    updatedBy: LEGACY_OWNER.username,
  };
  const otherLegacySkill = {
    ...legacySkill,
    id: randomUUID(),
    name: "Other owner's legacy brief",
    trigger: "Run the other legacy brief",
    createdBy: OTHER_LEGACY_OWNER.username,
    updatedBy: OTHER_LEGACY_OWNER.username,
  };
  await mkdir(testDataDirectory, { recursive: true });
  await writeFile(path.join(testDataDirectory, "skills.json"), `${JSON.stringify({
    schemaVersion: 1,
    skills: [legacySkill, otherLegacySkill],
  }, null, 2)}\n`, "utf8");

  assert.deepEqual(
    (await listManagedAgentSkills(LEGACY_OWNER, { includeDisabled: true })).map(({ id }) => id),
    [WEEKLY_BUSINESS_SUMMARY_SKILL_ID, PERSONAL_SKILL_BUILDER_SKILL_ID, legacySkill.id],
  );
  assert.equal(await deleteManagedAgentSkill(legacySkill.id, legacySkill.version, LEGACY_OWNER), legacySkill.id);
  assert.deepEqual(
    (await listManagedAgentSkills(LEGACY_OWNER, { includeDisabled: true })).map(({ id }) => id),
    [WEEKLY_BUSINESS_SUMMARY_SKILL_ID, PERSONAL_SKILL_BUILDER_SKILL_ID],
    "the still-present legacy file must not resurrect a Skill after its personal catalog is saved empty",
  );
  assert.deepEqual(
    (await listManagedAgentSkills(OTHER_LEGACY_OWNER, { includeDisabled: true })).map(({ id }) => id),
    [WEEKLY_BUSINESS_SUMMARY_SKILL_ID, PERSONAL_SKILL_BUILDER_SKILL_ID, otherLegacySkill.id],
    "migrating one owner must not consume another owner's legacy Skills",
  );
});
