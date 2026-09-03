// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { focusedAgentToolNames } from "./tool-routing.ts";

export type WeeklyFollowUpHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

const FIXED_WEEKLY_VERIFICATION_FOLLOW_UPS = new Set([
  "确定没有遗漏吗",
  "有遗漏吗",
  "还有吗",
  "only three",
  "anything else",
  "are you sure nothing is missing",
]);

function normalizedVerificationFollowUp(message: string) {
  return message
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-AU")
    .replace(/[?？!！。]+$/u, "")
    .trim();
}

/**
 * Re-runs the immediately preceding user's explicit Weekly Schedule query for
 * a deliberately small set of verification follow-ups. Assistant text is
 * never evidence, and an intervening non-weekly user request stops inheritance.
 */
export function resolveWeeklyFollowUpMessage(
  message: string,
  history: readonly WeeklyFollowUpHistoryMessage[],
) {
  const followUp = normalizedVerificationFollowUp(message);
  const boundedCountCheck = /^只有(?:这些|[零一二两三四五六七八九十百\d]+(?:个|条|单|项)?)吗$/u.test(followUp)
    || /^only (?:these|those|\d+)(?: (?:records?|jobs?|orders?|items?))?$/u.test(followUp);
  if (!boundedCountCheck && !FIXED_WEEKLY_VERIFICATION_FOLLOW_UPS.has(followUp)) {
    return message;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role !== "user") continue;
    const tools = focusedAgentToolNames(item.content);
    return tools?.length === 1 && tools[0] === "search_weekly_schedule"
      ? item.content
      : message;
  }

  return message;
}
