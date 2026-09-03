import type { AgentConversationAuditText } from "./conversation-record";

// Kept in step with the D1 CHECK constraints and the public constants in
// conversation-record.ts. Literal use here keeps this sanitizer testable as a
// dependency-free privacy boundary.
const QUESTION_LIMIT = 2_000;
const ANSWER_LIMIT = 8_000;

type RedactionRule = {
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: string[]) => string);
};

const REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: /data:[a-z0-9.+/-]{1,100}(?:;[a-z0-9.+_-]+=[^,;\s]{0,100})*;base64,\s*(?:[a-z0-9+/=_-]\s*){8,}/giu,
    replacement: "[REDACTED_DATA]",
  },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/giu,
    replacement: (value) => `${value.slice(0, value.indexOf(":"))}: [REDACTED]`,
  },
  {
    pattern: /\bbearer\s+[a-z0-9._~+/=-]{8,}/giu,
    replacement: "Bearer [REDACTED]",
  },
  {
    pattern: /\bbasic\s+[a-z0-9+/=_-]{8,}/giu,
    replacement: "Basic [REDACTED]",
  },
  {
    pattern: /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/giu,
    replacement: "[REDACTED_TOKEN]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_KEY]",
  },
  {
    pattern: /\b(?:sk|pk|rk|key|token)-[a-z0-9_-]{12,}\b/giu,
    replacement: "[REDACTED_KEY]",
  },
  {
    pattern: /(?<![a-z0-9])(?:github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,}|(?:sk|pk|rk)_(?:live|test)_[a-z0-9]{12,}|sk-ant-[a-z0-9_-]{12,}|hf_[a-z0-9]{20,}|npm_[a-z0-9]{20,}|SG\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})(?![a-z0-9])/giu,
    replacement: "[REDACTED_PROVIDER_TOKEN]",
  },
  {
    // Quoted values can be bounded precisely. An unquoted value is redacted to
    // the end of its line so a multi-word passphrase can never leak partially.
    pattern: /(["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth(?:orization)?|password|passcode|passwd|secret|session|cookie|credential|private[-_ ]?key|密码|口令|验证码|密钥|秘钥|访问令牌|刷新令牌|令牌|授权码|会话密钥|凭据)["']?\s*(?::|=|：|\bis\s+set\s+to\b|\bis\b|\bare\b|\bwas\b|\bwere\b|\bequals?\b|设置为|是|为)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|“[^”\r\n]*”|‘[^’\r\n]*’|[^\r\n]+)/giu,
    replacement: (_value, prefix) => `${prefix}[REDACTED]`,
  },
  {
    pattern: /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth|password|secret|session|signature)=)[^&#\s]*/giu,
    replacement: (_value, prefix) => `${prefix}[REDACTED]`,
  },
  {
    pattern: /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    replacement: (_value, protocol) => `${protocol}[REDACTED]@`,
  },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    pattern: /(?<!\d)(?:\+61[ .-]?(?:(?:4\d{2})[ .-]?\d{3}[ .-]?\d{3}|(?:[2378])[ .-]?\d{4}[ .-]?\d{4})|(?:04\d{2})[ .-]?\d{3}[ .-]?\d{3}|(?:0[2378])[ .-]?\d{4}[ .-]?\d{4})(?!\d)/gu,
    replacement: "[REDACTED_PHONE]",
  },
  {
    pattern: /\b(?:[a-z0-9+/_=-]{32,})\b/giu,
    replacement: "[REDACTED_OPAQUE_VALUE]",
  },
];

function replaceAndCount(value: string, rule: RedactionRule) {
  let count = 0;
  const text = value.replace(rule.pattern, (...args: [string, ...string[]]) => {
    count += 1;
    return typeof rule.replacement === "string"
      ? rule.replacement
      : rule.replacement(...args);
  });
  return { text, count };
}

function sliceCodePoints(value: string, maximum: number) {
  if (value.length <= maximum) return { text: value, truncated: false };
  const points = Array.from(value);
  if (points.length <= maximum) return { text: value, truncated: false };
  return { text: points.slice(0, maximum).join(""), truncated: true };
}

/** Redacts credentials and common direct identifiers before applying the display limit. */
export function sanitiseConversationAuditText(value: string, maximum: number): AgentConversationAuditText {
  if (typeof value !== "string") throw new TypeError("ConversationAuditTextMustBeString");
  let text = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  let redactionCount = 0;
  for (const rule of REDACTION_RULES) {
    const redacted = replaceAndCount(text, rule);
    text = redacted.text;
    redactionCount += redacted.count;
  }
  const limited = sliceCodePoints(text, maximum);
  return { text: limited.text, truncated: limited.truncated, redactionCount };
}

export function sanitiseConversationAuditQuestion(value: string) {
  return sanitiseConversationAuditText(value, QUESTION_LIMIT);
}

export function sanitiseConversationAuditAnswer(value: string) {
  return sanitiseConversationAuditText(value, ANSWER_LIMIT);
}
