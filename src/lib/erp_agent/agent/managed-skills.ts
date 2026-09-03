import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CloudflareDocumentConflictError,
  CloudflareStorageConfigurationError,
  erpCloudflareBindings,
  readVersionedDocument,
  writeVersionedDocument,
// Focused Node ESM tests require the explicit extension; Next's server bundler
// supports the same import path.
// @ts-expect-error -- the project intentionally does not enable emit-time extension imports.
} from "../../server/cloudflare-storage.ts";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { E3_BUSINESS_SKILLS, type BusinessSkillId } from "./skills.ts";

export const WEEKLY_BUSINESS_SUMMARY_SKILL_ID = "weekly-business-summary";
export const PERSONAL_SKILL_BUILDER_SKILL_ID = "personal-skill-builder";

export type AgentManagedSkill = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  enabled: boolean;
  source: "built_in" | "custom";
  capabilityIds: BusinessSkillId[];
  version: number;
  updatedAt: string | null;
  updatedBy: string;
};

type StoredCustomSkill = AgentManagedSkill & {
  source: "custom";
  createdAt: string;
  createdBy: string;
  creationRequestId?: string;
};

type StoredSkillCatalog = {
  schemaVersion: 2;
  ownerPrincipalHash: string;
  ownerUsername: string;
  skills: StoredCustomSkill[];
};

type LegacyStoredSkillCatalog = {
  schemaVersion: 1;
  skills: StoredCustomSkill[];
};

export type ManagedSkillOwner = {
  principalHash: string;
  username: string;
};

export type CreateManagedSkillInput = {
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  enabled: boolean;
  capabilityIds: BusinessSkillId[];
};

export type UpdateManagedSkillInput = Partial<CreateManagedSkillInput> & {
  expectedVersion: number;
};

export class ManagedSkillError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_skill") {
    super(message);
    this.name = "ManagedSkillError";
    this.status = status;
    this.code = code;
  }
}

const BUILT_IN_WEEKLY_SUMMARY: AgentManagedSkill = {
  id: WEEKLY_BUSINESS_SUMMARY_SKILL_ID,
  name: "Summarize this week",
  description: "Delivery, installation, Site Visiting, current inventory health and payment collection in one verified weekly summary.",
  trigger: "Summarize this week",
  prompt: "Summarize this week across delivery and installation, Site Visiting, current inventory health, and payment collection status.",
  enabled: true,
  source: "built_in",
  capabilityIds: ["weekly_schedule", "site_visits", "inventory", "project_track"],
  version: 1,
  updatedAt: null,
  updatedBy: "system",
};

const BUILT_IN_PERSONAL_SKILL_BUILDER: AgentManagedSkill = {
  id: PERSONAL_SKILL_BUILDER_SKILL_ID,
  name: "Create a personal Skill",
  description: "Turn an explicit request into a validated, manually triggered and read-only personal E3 Agent Skill.",
  trigger: "Create a Skill",
  prompt: "Create a personal read-only Skill from my current request.",
  enabled: true,
  source: "built_in",
  capabilityIds: [],
  version: 1,
  updatedAt: null,
  updatedBy: "system",
};

const WEEKLY_SUMMARY_TRIGGER_ALIASES = [
  "Summarize this week",
  "Summarise this week",
  "Summrize this week",
  "This week summary",
  "总结本周",
  "本周汇总",
] as const;
const BUILT_IN_SKILLS = [BUILT_IN_WEEKLY_SUMMARY, BUILT_IN_PERSONAL_SKILL_BUILDER] as const;
const BUILT_IN_TRIGGER_GROUPS = [
  { skill: BUILT_IN_WEEKLY_SUMMARY, aliases: WEEKLY_SUMMARY_TRIGGER_ALIASES },
] as const;
const BUSINESS_SKILL_IDS = new Set<BusinessSkillId>(E3_BUSINESS_SKILLS.map((skill) => skill.id));
const MAX_CUSTOM_SKILLS = 30;
const MAXIMUM_STORAGE_RETRIES = 5;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const PRINCIPAL_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const CREATION_REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const LEGACY_CLOUDFLARE_DOCUMENT_KEY = "agent/managed-skills";
const PERSONAL_CLOUDFLARE_DOCUMENT_PREFIX = "agent/managed-skills/v2";
const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.AGENT_SKILLS_DATA_DIR || path.join(process.cwd(), ".data", "agent"),
);
const legacySkillsPath = path.join(/* turbopackIgnore: true */ dataRoot, "skills.json");
let mutationQueue: Promise<void> = Promise.resolve();

function controlCharacters(value: string, allowWhitespace = false) {
  return allowWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    : /[\u0000-\u001f\u007f]/u.test(value);
}

function normalizedText(value: unknown, field: string, maximum: number, options: { allowEmpty?: boolean; multiline?: boolean } = {}) {
  if (typeof value !== "string") throw new ManagedSkillError(`Enter a valid ${field}.`);
  const normalized = value.normalize("NFKC").trim().replace(options.multiline ? /[ \t]+/gu : /\s+/gu, " ");
  if ((!normalized && !options.allowEmpty) || normalized.length > maximum || controlCharacters(normalized, options.multiline)) {
    throw new ManagedSkillError(`Enter a ${field} of up to ${maximum} characters.`);
  }
  return normalized;
}

export function normalizeManagedSkillTrigger(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-AU")
    .replace(/\s+/gu, " ")
    .replace(/[\s,.!?，。！？…~～]+$/gu, "");
}

function normalizedTrigger(value: unknown) {
  const trigger = normalizedText(value, "trigger phrase", 120);
  const key = normalizeManagedSkillTrigger(trigger);
  if (key.length < 2) throw new ManagedSkillError("Enter a trigger phrase of at least 2 characters.");
  return trigger;
}

function normalizedCapabilities(value: unknown): BusinessSkillId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > E3_BUSINESS_SKILLS.length) {
    throw new ManagedSkillError("Select at least one approved read-only data source.");
  }
  const capabilities: BusinessSkillId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !BUSINESS_SKILL_IDS.has(item as BusinessSkillId)) {
      throw new ManagedSkillError("Select approved read-only data sources only.");
    }
    if (!capabilities.includes(item as BusinessSkillId)) capabilities.push(item as BusinessSkillId);
  }
  if (!capabilities.length) throw new ManagedSkillError("Select at least one approved read-only data source.");
  return capabilities;
}

function normalizedActor(value: unknown) {
  const actor = typeof value === "string" ? value.trim().toLocaleLowerCase("en-AU") : "";
  if (!ACTOR_PATTERN.test(actor)) throw new ManagedSkillError("The user identity is invalid.", 403, "forbidden");
  return actor;
}

function normalizedOwner(value: ManagedSkillOwner): ManagedSkillOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedSkillError("The user identity is invalid.", 403, "forbidden");
  }
  const record = value as unknown as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["principalHash", "username"].includes(key))
    || Object.keys(record).length !== 2
    || typeof record.principalHash !== "string"
    || !PRINCIPAL_HASH_PATTERN.test(record.principalHash)) {
    throw new ManagedSkillError("The user identity is invalid.", 403, "forbidden");
  }
  return {
    principalHash: record.principalHash.toLocaleLowerCase("en-AU"),
    username: normalizedActor(record.username),
  };
}

function normalizedCreationRequestId(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CREATION_REQUEST_ID_PATTERN.test(value)) {
    throw new ManagedSkillError("The Skill creation request ID is invalid.");
  }
  return value;
}

function normalizedCreateInput(value: unknown): CreateManagedSkillInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagedSkillError("Enter a valid Skill configuration.");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["name", "description", "trigger", "prompt", "enabled", "capabilityIds"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || Object.keys(record).length !== allowed.size
    || typeof record.enabled !== "boolean") {
    throw new ManagedSkillError("Enter only the supported Skill fields.");
  }
  return {
    name: normalizedText(record.name, "Skill name", 80),
    description: normalizedText(record.description, "description", 500, { allowEmpty: true }),
    trigger: normalizedTrigger(record.trigger),
    // Stored prompts remain ordinary user-level task text. They are never
    // inserted into the system prompt and cannot create tools or permissions.
    prompt: normalizedText(record.prompt, "task instruction", 1_600, { multiline: true }),
    enabled: record.enabled,
    capabilityIds: normalizedCapabilities(record.capabilityIds),
  };
}

function normalizedUpdateInput(value: unknown): UpdateManagedSkillInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagedSkillError("Enter valid Skill changes.");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["expectedVersion", "name", "description", "trigger", "prompt", "enabled", "capabilityIds"]);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key)) || !keys.some((key) => key !== "expectedVersion")
    || !Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) < 1) {
    throw new ManagedSkillError("Refresh the Skill list and enter valid changes.", 409, "skill_version_required");
  }
  return {
    expectedVersion: record.expectedVersion as number,
    ...(record.name !== undefined ? { name: normalizedText(record.name, "Skill name", 80) } : {}),
    ...(record.description !== undefined
      ? { description: normalizedText(record.description, "description", 500, { allowEmpty: true }) }
      : {}),
    ...(record.trigger !== undefined ? { trigger: normalizedTrigger(record.trigger) } : {}),
    ...(record.prompt !== undefined
      ? { prompt: normalizedText(record.prompt, "task instruction", 1_600, { multiline: true }) }
      : {}),
    ...(record.enabled !== undefined
      ? typeof record.enabled === "boolean" ? { enabled: record.enabled } : (() => { throw new ManagedSkillError("Select a valid Skill status."); })()
      : {}),
    ...(record.capabilityIds !== undefined ? { capabilityIds: normalizedCapabilities(record.capabilityIds) } : {}),
  };
}

function normalizedStoredSkill(value: unknown): StoredCustomSkill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<StoredCustomSkill>;
  const allowed = new Set([
    "id", "name", "description", "trigger", "prompt", "enabled", "source", "capabilityIds",
    "version", "createdAt", "createdBy", "creationRequestId", "updatedAt", "updatedBy",
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))
    || typeof item.id !== "string" || !ID_PATTERN.test(item.id)
    || item.source !== "custom"
    || typeof item.enabled !== "boolean"
    || !Number.isSafeInteger(item.version) || (item.version || 0) < 1
    || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))
    || typeof item.updatedAt !== "string" || Number.isNaN(Date.parse(item.updatedAt))
    || typeof item.createdBy !== "string" || !ACTOR_PATTERN.test(item.createdBy)
    || (item.creationRequestId !== undefined
      && (typeof item.creationRequestId !== "string" || !CREATION_REQUEST_ID_PATTERN.test(item.creationRequestId)))
    || typeof item.updatedBy !== "string" || !ACTOR_PATTERN.test(item.updatedBy)) return null;
  try {
    const normalized = normalizedCreateInput({
      name: item.name,
      description: item.description,
      trigger: item.trigger,
      prompt: item.prompt,
      enabled: item.enabled,
      capabilityIds: item.capabilityIds,
    });
    return {
      ...normalized,
      id: item.id.toLocaleLowerCase("en-AU"),
      source: "custom",
      version: item.version as number,
      createdAt: item.createdAt,
      createdBy: item.createdBy,
      ...(item.creationRequestId !== undefined ? { creationRequestId: item.creationRequestId } : {}),
      updatedAt: item.updatedAt,
      updatedBy: item.updatedBy,
    };
  } catch {
    return null;
  }
}

function normalizedCatalogSkills(value: unknown): StoredCustomSkill[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_SKILLS) {
    throw new ManagedSkillError("The saved Skill catalog is invalid.", 500, "skills_corrupt");
  }
  const skills = value.map(normalizedStoredSkill);
  if (skills.some((skill) => !skill)) {
    throw new ManagedSkillError("The saved Skill catalog is invalid.", 500, "skills_corrupt");
  }
  const ids = new Set<string>();
  const triggers = new Set(BUILT_IN_TRIGGER_GROUPS.flatMap(({ aliases }) => aliases.map(normalizeManagedSkillTrigger)));
  for (const skill of skills as StoredCustomSkill[]) {
    const trigger = normalizeManagedSkillTrigger(skill.trigger);
    if (ids.has(skill.id) || triggers.has(trigger)) {
      throw new ManagedSkillError("The saved Skill catalog contains duplicate entries.", 500, "skills_corrupt");
    }
    ids.add(skill.id);
    triggers.add(trigger);
  }
  return skills as StoredCustomSkill[];
}

function normalizedLegacyCatalog(value: unknown): LegacyStoredSkillCatalog {
  if (value === null) return { schemaVersion: 1, skills: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedSkillError("The saved Skill catalog is invalid.", 500, "skills_corrupt");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "skills"].includes(key))
    || record.schemaVersion !== 1) {
    throw new ManagedSkillError("The saved Skill catalog is invalid.", 500, "skills_corrupt");
  }
  return { schemaVersion: 1, skills: normalizedCatalogSkills(record.skills) };
}

function emptyCatalog(owner: ManagedSkillOwner): StoredSkillCatalog {
  return {
    schemaVersion: 2,
    ownerPrincipalHash: owner.principalHash,
    ownerUsername: owner.username,
    skills: [],
  };
}

function normalizedPersonalCatalog(value: unknown, owner: ManagedSkillOwner): StoredSkillCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedSkillError("The saved Skill catalog is invalid.", 500, "skills_corrupt");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "ownerPrincipalHash", "ownerUsername", "skills"].includes(key))
    || Object.keys(record).length !== 4
    || record.schemaVersion !== 2
    || record.ownerPrincipalHash !== owner.principalHash
    || record.ownerUsername !== owner.username) {
    throw new ManagedSkillError("The saved Skill catalog is invalid.", 500, "skills_corrupt");
  }
  const skills = normalizedCatalogSkills(record.skills);
  if (skills.some((skill) => skill.createdBy !== owner.username)) {
    throw new ManagedSkillError("The saved Skill catalog owner is invalid.", 500, "skills_corrupt");
  }
  return { ...emptyCatalog(owner), skills };
}

function personalCatalogFromLegacy(catalog: LegacyStoredSkillCatalog, owner: ManagedSkillOwner): StoredSkillCatalog {
  return {
    ...emptyCatalog(owner),
    skills: catalog.skills
      .filter((skill) => skill.createdBy === owner.username)
      .map((skill) => ({ ...skill })),
  };
}

function personalStorage(owner: ManagedSkillOwner) {
  return {
    documentKey: `${PERSONAL_CLOUDFLARE_DOCUMENT_PREFIX}/${owner.principalHash}`,
    localPath: path.join(/* turbopackIgnore: true */ dataRoot, `skills-${owner.principalHash}.json`),
  };
}

async function ensureLocalStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
}

async function readLocalDocument(filePath: string): Promise<{ exists: boolean; value: unknown }> {
  try {
    const raw = await readFile(/* turbopackIgnore: true */ filePath, "utf8");
    await chmod(filePath, 0o600);
    return { exists: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, value: null };
    }
    throw error;
  }
}

async function readStoredCatalog(owner: ManagedSkillOwner): Promise<{ catalog: StoredSkillCatalog; documentVersion: number | null }> {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database) throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    const storage = personalStorage(owner);
    const document = await readVersionedDocument<unknown>(bindings.database, storage.documentKey);
    if (document.value !== null) {
      return { catalog: normalizedPersonalCatalog(document.value, owner), documentVersion: document.version };
    }
    const legacyDocument = await readVersionedDocument<unknown>(bindings.database, LEGACY_CLOUDFLARE_DOCUMENT_KEY);
    return {
      catalog: personalCatalogFromLegacy(normalizedLegacyCatalog(legacyDocument.value), owner),
      documentVersion: document.version,
    };
  }
  await ensureLocalStorage();
  const personalDocument = await readLocalDocument(personalStorage(owner).localPath);
  if (personalDocument.exists) {
    return { catalog: normalizedPersonalCatalog(personalDocument.value, owner), documentVersion: null };
  }
  const legacyDocument = await readLocalDocument(legacySkillsPath);
  return {
    catalog: personalCatalogFromLegacy(normalizedLegacyCatalog(legacyDocument.value), owner),
    documentVersion: null,
  };
}

async function writeStoredCatalog(owner: ManagedSkillOwner, catalog: StoredSkillCatalog, documentVersion: number | null) {
  const bindings = await erpCloudflareBindings();
  if (bindings) {
    if (!bindings.database || documentVersion === null) throw new CloudflareStorageConfigurationError("The ERP_DB binding is missing.");
    await writeVersionedDocument(bindings.database, personalStorage(owner).documentKey, catalog, documentVersion);
    return;
  }
  await ensureLocalStorage();
  const storage = personalStorage(owner);
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.skills-${owner.principalHash}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, storage.localPath);
    await chmod(storage.localPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function withCatalogMutation<T>(owner: ManagedSkillOwner, work: (catalog: StoredSkillCatalog) => Promise<T>): Promise<T> {
  const retryingWork = async () => {
    for (let attempt = 0; attempt < MAXIMUM_STORAGE_RETRIES; attempt += 1) {
      const { catalog, documentVersion } = await readStoredCatalog(owner);
      try {
        const result = await work(catalog);
        await writeStoredCatalog(owner, catalog, documentVersion);
        return result;
      } catch (error) {
        if (!(error instanceof CloudflareDocumentConflictError)) throw error;
      }
    }
    throw new ManagedSkillError("Skills changed in another session. Refresh and try again.", 409, "skills_conflict");
  };
  const result = mutationQueue.then(retryingWork, retryingWork);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function assertUniqueTrigger(trigger: string, skills: readonly StoredCustomSkill[], exceptId?: string) {
  const key = normalizeManagedSkillTrigger(trigger);
  if (BUILT_IN_TRIGGER_GROUPS.some(({ aliases }) => aliases.some((value) => normalizeManagedSkillTrigger(value) === key))
    || skills.some((skill) => skill.id !== exceptId && normalizeManagedSkillTrigger(skill.trigger) === key)) {
    throw new ManagedSkillError("That trigger phrase is already used by another Skill.", 409, "skill_trigger_exists");
  }
}

export function parseCreateManagedSkillInput(value: unknown) {
  return normalizedCreateInput(value);
}

export function parseUpdateManagedSkillInput(value: unknown) {
  return normalizedUpdateInput(value);
}

function publicManagedSkill(skill: StoredCustomSkill): AgentManagedSkill {
  const {
    createdAt: _createdAt,
    createdBy: _createdBy,
    creationRequestId: _creationRequestId,
    ...publicSkill
  } = skill;
  return publicSkill;
}

export async function listManagedAgentSkills(
  ownerValue: ManagedSkillOwner,
  options: { includeDisabled?: boolean } = {},
): Promise<AgentManagedSkill[]> {
  const owner = normalizedOwner(ownerValue);
  await mutationQueue;
  const { catalog } = await readStoredCatalog(owner);
  const custom = catalog.skills
    .filter((skill) => options.includeDisabled || skill.enabled)
    .map(publicManagedSkill)
    .sort((left, right) => left.name.localeCompare(right.name, "en-AU"));
  return [...BUILT_IN_SKILLS, ...custom];
}

export async function findManagedAgentSkillByCreationRequestId(
  ownerValue: ManagedSkillOwner,
  requestIdValue: string,
): Promise<AgentManagedSkill | null> {
  const owner = normalizedOwner(ownerValue);
  const requestId = normalizedCreationRequestId(requestIdValue);
  await mutationQueue;
  const { catalog } = await readStoredCatalog(owner);
  const existing = catalog.skills.find((skill) => skill.creationRequestId === requestId);
  return existing ? publicManagedSkill(existing) : null;
}

export async function createManagedAgentSkill(
  value: unknown,
  ownerValue: ManagedSkillOwner,
  options: { requestId?: string } = {},
): Promise<AgentManagedSkill> {
  const input = normalizedCreateInput(value);
  const owner = normalizedOwner(ownerValue);
  const requestId = normalizedCreationRequestId(options.requestId);
  return withCatalogMutation(owner, async (catalog) => {
    const existing = requestId
      ? catalog.skills.find((skill) => skill.creationRequestId === requestId)
      : null;
    if (existing) return publicManagedSkill(existing);
    if (catalog.skills.length >= MAX_CUSTOM_SKILLS) {
      throw new ManagedSkillError("The custom Skill limit has been reached.", 409, "skill_limit");
    }
    assertUniqueTrigger(input.trigger, catalog.skills);
    const timestamp = new Date().toISOString();
    const skill: StoredCustomSkill = {
      ...input,
      id: randomUUID(),
      source: "custom",
      version: 1,
      createdAt: timestamp,
      createdBy: owner.username,
      ...(requestId ? { creationRequestId: requestId } : {}),
      updatedAt: timestamp,
      updatedBy: owner.username,
    };
    catalog.skills.push(skill);
    return publicManagedSkill(skill);
  });
}

export async function updateManagedAgentSkill(
  idValue: string,
  value: unknown,
  ownerValue: ManagedSkillOwner,
): Promise<AgentManagedSkill> {
  const id = idValue.toLocaleLowerCase("en-AU");
  if (!ID_PATTERN.test(id)) throw new ManagedSkillError("The custom Skill ID is invalid.");
  const input = normalizedUpdateInput(value);
  const owner = normalizedOwner(ownerValue);
  return withCatalogMutation(owner, async (catalog) => {
    const index = catalog.skills.findIndex((skill) => skill.id === id);
    if (index < 0) throw new ManagedSkillError("The custom Skill was not found.", 404, "skill_not_found");
    const current = catalog.skills[index];
    if (current.version !== input.expectedVersion) {
      throw new ManagedSkillError("This Skill changed in another session. Refresh and try again.", 409, "skill_conflict");
    }
    const nextTrigger = input.trigger ?? current.trigger;
    assertUniqueTrigger(nextTrigger, catalog.skills, id);
    const { expectedVersion: _expectedVersion, ...changes } = input;
    const next: StoredCustomSkill = {
      ...current,
      ...changes,
      trigger: nextTrigger,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: owner.username,
    };
    catalog.skills[index] = next;
    return publicManagedSkill(next);
  });
}

export async function deleteManagedAgentSkill(
  idValue: string,
  expectedVersion: unknown,
  ownerValue: ManagedSkillOwner,
): Promise<string> {
  const id = idValue.toLocaleLowerCase("en-AU");
  if (!ID_PATTERN.test(id)) throw new ManagedSkillError("The custom Skill ID is invalid.");
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) {
    throw new ManagedSkillError("Refresh the Skill list and try again.", 409, "skill_version_required");
  }
  const owner = normalizedOwner(ownerValue);
  return withCatalogMutation(owner, async (catalog) => {
    const index = catalog.skills.findIndex((skill) => skill.id === id);
    if (index < 0) throw new ManagedSkillError("The custom Skill was not found.", 404, "skill_not_found");
    if (catalog.skills[index].version !== expectedVersion) {
      throw new ManagedSkillError("This Skill changed in another session. Refresh and try again.", 409, "skill_conflict");
    }
    catalog.skills.splice(index, 1);
    return id;
  });
}

export async function resolveInvokedManagedSkill(input: {
  skillId?: string;
  message: string;
  owner: ManagedSkillOwner;
}) {
  const owner = normalizedOwner(input.owner);
  const requestedId = input.skillId?.toLocaleLowerCase("en-AU");
  const trigger = normalizeManagedSkillTrigger(input.message);
  const requestedBuiltIn = requestedId ? BUILT_IN_SKILLS.find((skill) => skill.id === requestedId) : null;
  if (requestedBuiltIn) return requestedBuiltIn;
  if (!requestedId) {
    const triggeredBuiltIn = BUILT_IN_TRIGGER_GROUPS.find(({ aliases }) => (
      aliases.some((value) => normalizeManagedSkillTrigger(value) === trigger)
    ));
    if (triggeredBuiltIn) return triggeredBuiltIn.skill;
  }
  const skills = await listManagedAgentSkills(owner, { includeDisabled: true });
  if (requestedId) {
    const skill = skills.find((candidate) => candidate.id === requestedId);
    if (!skill) throw new ManagedSkillError("The selected Skill was not found.", 404, "skill_not_found");
    if (!skill.enabled) throw new ManagedSkillError("The selected Skill is disabled.", 409, "skill_disabled");
    return skill;
  }
  if (!trigger) return null;
  return skills.find((skill) => skill.source === "custom" && skill.enabled
    && normalizeManagedSkillTrigger(skill.trigger) === trigger) || null;
}
