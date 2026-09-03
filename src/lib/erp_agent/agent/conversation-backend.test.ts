import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sanitizerModule = "./conversation-sanitizer.ts";
const {
  sanitiseConversationAuditAnswer,
  sanitiseConversationAuditQuestion,
} = await import(sanitizerModule) as typeof import("./conversation-sanitizer");

test("Conversation Audit deterministically redacts secrets and direct identifiers", () => {
  const raw = "email me@example.com password=hunter2 Authorization: Bearer abcdefghijklmnop\nPhone 0412 345 678; date 2026-08-24";
  const first = sanitiseConversationAuditQuestion(raw);
  const second = sanitiseConversationAuditQuestion(raw);
  assert.deepEqual(first, second);
  assert.equal(first.text.includes("me@example.com"), false);
  assert.equal(first.text.includes("hunter2"), false);
  assert.equal(first.text.includes("abcdefghijklmnop"), false);
  assert.equal(first.text.includes("0412 345 678"), false);
  assert.match(first.text, /2026-08-24/);
  assert.ok(first.redactionCount >= 4);
});

test("Conversation Audit limits visible content after redaction", () => {
  const question = sanitiseConversationAuditQuestion("问".repeat(2_100));
  const answer = sanitiseConversationAuditAnswer("答".repeat(8_100));
  assert.equal(question.text.length, 2_000);
  assert.equal(question.truncated, true);
  assert.equal(answer.text.length, 8_000);
  assert.equal(answer.truncated, true);
});

test("Conversation Audit never leaves a partial unquoted multi-word credential", () => {
  const english = sanitiseConversationAuditQuestion("My password is correct horse battery staple\nKeep this line.");
  const chinese = sanitiseConversationAuditQuestion("我的密码是 正确 马 电池 订书钉\n保留这一行。");
  assert.equal(english.text.includes("correct horse battery staple"), false);
  assert.equal(english.text.includes("horse battery staple"), false);
  assert.match(english.text, /Keep this line\./);
  assert.equal(chinese.text.includes("正确 马 电池 订书钉"), false);
  assert.equal(chinese.text.includes("马 电池 订书钉"), false);
  assert.match(chinese.text, /保留这一行。/);
});

test("Conversation Audit resists natural-language and provider-token escapes", () => {
  const githubToken = `${["github", "pat"].join("_")}_${"a".repeat(24)}`;
  const googleToken = `AI${"za"}${"a".repeat(28)}`;
  const slackToken = `xo${"xb"}-${"1".repeat(12)}-${"a".repeat(20)}`;
  const huggingFaceToken = `${"h"}f_${"a".repeat(22)}`;
  const anthropicToken = `${"sk"}-ant-api03-${"a".repeat(24)}`;
  const basicCredential = Buffer.from("user:password", "utf8").toString("base64");
  const privateKeyBody = "short-but-sensitive";
  const dataPayload = "YWJj ZGVm Z2hp amts";
  const raw = [
    `我的密码是“dragon-boat-7788”，访问令牌为 ${githubToken}。`,
    "My password was hunter2 and the passcode is set to 884422.",
    `The API key\nis \`${googleToken}\`.`,
    `Slack token is ${slackToken} and Hugging Face 密钥：${huggingFaceToken}.`,
    `private key is '${anthropicToken}'.`,
    `Authorization: Basic ${basicCredential}\n  continued-secret-value`,
    `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----`,
    `data:image/png;base64,\n${dataPayload}`,
  ].join("\n");
  const safe = sanitiseConversationAuditAnswer(raw);
  for (const secret of [
    "dragon-boat-7788",
    "hunter2",
    "884422",
    githubToken,
    googleToken,
    slackToken,
    huggingFaceToken,
    anthropicToken,
    basicCredential,
    "continued-secret-value",
    privateKeyBody,
    dataPayload,
  ]) assert.equal(safe.text.includes(secret), false, `escaped secret remained: ${secret}`);
  assert.ok(safe.redactionCount >= 10);
});

test("Conversation Audit schema and admin API omit forbidden payload fields", async () => {
  const [migration, store, route, agentRoute, legacyAgentRoute] = await Promise.all([
    readFile(new URL("../../../../migrations/0007_agent_conversations.sql", import.meta.url), "utf8"),
    readFile(new URL("./conversation-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../app/api/agent/conversations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../app/api/agent/chat/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /question_text TEXT NOT NULL/);
  assert.match(migration, /answer_text TEXT NOT NULL/);
  const schemaWithoutComments = migration.replace(/--.*$/gm, "");
  assert.doesNotMatch(schemaWithoutComments, /reasoning|tool_(?:args|results?)|attachment_(?:content|data)|cookie|api_key/i);
  assert.match(store, /sanitiseConversationAuditQuestion\(input\.question\)/);
  assert.match(store, /sanitiseConversationAuditAnswer\(input\.visibleAnswer\)/);
  assert.match(route, /session\?\.user\.role !== "admin"/);
  assert.match(route, /isAuthorizedMutationRequest\(request\)/);
  assert.match(route, /export async function DELETE/);
  assert.match(store, /await cleanupExpiredConversations\(database\);[\s\S]*WHERE datetime\(created_at\) >= datetime/);
  assert.match(store, /deleteAgentConversationAuditSession/);
  assert.match(store, /DELETE FROM erp_agent_conversations[\s\S]*WHERE actor_username = \?1 AND conversation_key = \?2/);
  assert.match(route, /keys\.length === 2[\s\S]*actorUsername[\s\S]*conversationKey/);
  const persistenceCall = agentRoute.match(/scheduleConversationAudit\(\{([\s\S]*?)\n\s*\}\);/);
  assert.ok(persistenceCall, "the successful Agent response must persist one sanitised exchange");
  assert.match(persistenceCall[1], /question:\s*input\.message/);
  assert.match(persistenceCall[1], /visibleAnswer/);
  assert.doesNotMatch(persistenceCall[1], /history|attachment|citation|tool/i);
  assert.match(agentRoute, /after\(\(\) => persistConversationAudit\(input\)\)/);
  assert.match(legacyAgentRoute, /scheduleConversationAudit\(\{/);
  assert.match(legacyAgentRoute, /question:\s*input\.message/);
  assert.match(legacyAgentRoute, /visibleAnswer:\s*response\.answer/);
});
