import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GroupChatMessage } from "./types";

export const GROUP_CHAT_MAX_MESSAGES = 500;
export const GROUP_CHAT_MAX_DISPLAY_NAME_LENGTH = 60;
export const GROUP_CHAT_MAX_CONTENT_LENGTH = 2_000;

const dataRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.GROUP_CHAT_DATA_DIR || path.join(process.cwd(), ".data", "group-chat"),
);
const recordsPath = path.join(/* turbopackIgnore: true */ dataRoot, "messages.json");
let mutationQueue: Promise<void> = Promise.resolve();

async function ensureStorage() {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
}

function isStoredMessage(value: unknown): value is GroupChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<GroupChatMessage>;
  const validTimestamp = typeof candidate.createdAt === "string"
    && !Number.isNaN(Date.parse(candidate.createdAt))
    && new Date(candidate.createdAt).toISOString() === candidate.createdAt;
  return typeof candidate.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id)
    && typeof candidate.displayName === "string"
    && candidate.displayName.length > 0
    && candidate.displayName.length <= GROUP_CHAT_MAX_DISPLAY_NAME_LENGTH
    && candidate.displayName === candidate.displayName.trim()
    && !/[\u0000-\u001f\u007f]/.test(candidate.displayName)
    && typeof candidate.content === "string"
    && candidate.content.length > 0
    && candidate.content.length <= GROUP_CHAT_MAX_CONTENT_LENGTH
    && candidate.content === candidate.content.trim()
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.content)
    && validTimestamp;
}

async function readStoredMessages(): Promise<GroupChatMessage[]> {
  await ensureStorage();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ recordsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isStoredMessage)) {
      throw new Error("Group chat data has an invalid format.");
    }
    return parsed.slice(-GROUP_CHAT_MAX_MESSAGES);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStoredMessages(messages: GroupChatMessage[]) {
  await ensureStorage();
  const temporaryPath = path.join(/* turbopackIgnore: true */ dataRoot, `.messages-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(messages, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, recordsPath);
    await chmod(recordsPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function listGroupChatMessages(): Promise<GroupChatMessage[]> {
  return mutationQueue.then(() => readStoredMessages());
}

export function createGroupChatMessage(displayName: string, content: string): Promise<GroupChatMessage> {
  return withMutation(async () => {
    const messages = await readStoredMessages();
    const message: GroupChatMessage = {
      id: randomUUID(),
      displayName,
      content,
      createdAt: new Date().toISOString(),
    };
    messages.push(message);
    await writeStoredMessages(messages.slice(-GROUP_CHAT_MAX_MESSAGES));
    return message;
  });
}
