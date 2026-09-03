import {
  createManagedAgentSkill,
  findManagedAgentSkillByCreationRequestId,
  ManagedSkillError,
  parseCreateManagedSkillInput,
  type AgentManagedSkill,
  type CreateManagedSkillInput,
  type ManagedSkillOwner,
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
} from "./managed-skills.ts";

export const PERSONAL_SKILL_BUILDER_PROMPT_VERSION = "e3-personal-skill-builder-v1";

export type PersonalSkillBuilderProposal =
  | { action: "clarify"; question: string }
  | { action: "create"; skill: CreateManagedSkillInput };

export type PersonalSkillBuilderResult =
  | { status: "clarification"; answer: string }
  | { status: "created"; answer: string; skill: AgentManagedSkill };

type PersonalSkillProposalProvider = (input: { message: string }) => Promise<unknown>;

const MAX_BUILDER_MESSAGE = 2_000;
const MAX_CLARIFICATION = 300;
const SENSITIVE_REFERENCE_PATTERN = /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----|\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|\b(?:sk|pk|rk|key|token)-[a-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|(?<![a-z0-9])(?:github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,}|(?:sk|pk|rk)_(?:live|test)_[a-z0-9]{12,}|sk-ant-[a-z0-9_-]{12,}|hf_[a-z0-9]{20,}|npm_[a-z0-9]{20,}|SG\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})(?![a-z0-9])|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b|\b(?:using|with)\s+(?:(?:an?|the)\s+)?(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|auth(?:orization)?|client[\s_-]*secret|password|passcode|passwd|secret|session|cookie|credential|private[\s_-]*key|x-api-key)\s+["']?[a-z0-9._~+/=-]{8,}|\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|auth(?:orization)?|client[\s_-]*secret|password|passcode|passwd|secret|session|cookie|credential|private[\s_-]*key|x-api-key)\b\s*(?:(?::|=|is)\s*["']?[^\s"']{6,}|\s+["']?[a-z0-9._~+/=-]{12,})|(?:使用|用|通过).{0,8}(?:api\s*密钥|访问令牌|刷新令牌|客户端密钥|私钥|密码|口令|验证码|授权头|授权码|会话密钥|身份令牌|凭据)\s*(?:为|是|：|=)?\s*["']?[a-z0-9._~+/=-]{8,}|(?:api\s*密钥|访问令牌|刷新令牌|客户端密钥|私钥|密码|口令|验证码|授权头|授权码|会话密钥|身份令牌|凭据)\s*(?:为|是|：|=)\s*["']?[^\s"']{6,}/iu;
const SENSITIVE_QUALIFIED_REFERENCE_PATTERN = /\b(?:(?:authorization|auth)\s+(?:header|value)|secret\s+(?:phrase|value|text)|shared\s+secret|credential\s+(?:value|string))\b\s*(?:(?::|=|is)\s*)?["']?[^\s"']{6,}|(?:(?:授权|认证)(?:请求)?头|秘密短语|密钥短语|共享密钥|凭据值)\s*(?:为|是|：|=)?\s*["']?[^\s"']{6,}/iu;
const EXTERNAL_DESTINATION_PATTERN = /(?:https?|ftp):\/\/|\bmailto:|\bwebhooks?\b|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}\b|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/iu;
const UNSUPPORTED_ACTION_CLAUSE_PATTERN = /(?:^|(?:\b(?:and(?:\s+then)?|then|also|before|after|while|by|to|plus|followed\s+by)\b|[,;.!]\s*))\s*(?:(?:please|kindly|automatically|finally|afterwards|subsequently|immediately|directly|ultimately|eventually|next|also|then)\s+)*(?:updat(?:e|ing)|edit(?:ing)?|delet(?:e|ing)|remov(?:e|ing)|approv(?:e|ing)|reject(?:ing)?|reschedul(?:e|ing)|schedul(?:e|ing)|cancel(?:ling|ing)?|send(?:ing)?|post(?:ing)?|publish(?:ing)?|dispatch(?:ing)?|upload(?:ing)?|chang(?:e|ing)|mark(?:ing)?|submit(?:ting)?|clos(?:e|ing)|email(?:ing)?|export(?:ing)?|import(?:ing)?|notif(?:y|ying)|forward(?:ing)?|shar(?:e|ing)|assign(?:ing)?|reserv(?:e|ing)|refund(?:ing)?|invoic(?:e|ing)|charg(?:e|ing)|collect(?:ing)?|pay(?:ing)?|issu(?:e|ing)|call(?:ing)?|invok(?:e|ing)|execut(?:e|ing)|sav(?:e|ing)|download(?:ing)?)\b|(?:并|然后|再|随后|同时|之后|之前|通过|，|。|；)\s*(?:(?:请|务必|立即|马上|最终|最后|稍后|接着|顺便|同时|自动)\s*)*(?:更新|修改|删除|审批|批准|拒绝|改期|排期|取消|发送|发布|上传|写入|变更|标记|提交|关闭|发邮件|导出|导入|通知|转发|分享|分配|预留|退款|开票|收费|收款|付款|调用|执行|保存|下载)/iu;
const READ_TASK_DETAIL_PATTERN = /\b(?:summari[sz](?:e|es|ing)|show(?:s|ing)?|list(?:s|ing)?|find(?:s|ing)?|search(?:es|ing)?|explain(?:s|ing)?|compar(?:e|es|ing)|report(?:s|ing)?|review(?:s|ing)?|check(?:s|ing)?|identif(?:y|ies|ying)|describ(?:e|es|ing)|answer(?:s|ing)?|provid(?:e|es|ing)|calculat(?:e|es|ing)|count(?:s|ing)?|total(?:s|ling)?|analy[sz](?:e|es|ing)|read(?:s|ing)?)\b|(?:汇总|总结|显示|查看|列出|查找|搜索|说明|解释|比较|对比|报告|检查|识别|描述|回答|提供|计算|统计|读取|分析)/iu;
const DATA_SCOPE_DETAIL_PATTERN = /\b(?:inventory|stock|deliver(?:y|ies)|installation|site\s*visits?|quotation|projects?|payments?|reimbursements?|expense\s*claims?|reports?|announcements?|knowledge|schedules?|customers?|orders?|workspace|business\s+operations?)\b|(?:库存|存货|送货|配送|交付|安装|现场勘察|上门勘察|报价|项目|收款|付款|回款|报销|费用申请|报告|公告|通知|知识库|排期|日程|客户|订单|工作区|业务运营)/iu;
const NAME_ONLY_DETAIL_PATTERN = /\bskills?\s+(?:called|named)\s+(?![^,;.!?，；。！？]{0,120}\b(?:for|to|that|which)\b)[^,;.!?，；。！？]{1,120}[.!?]?\s*$|(?:skills?|技能)[，,\s]*(?:名字?叫|名为|叫做?)\s*(?![^，,；;。.!！？?]{0,80}(?:用于|用来|负责))[^，,；;。.!！？?]{1,80}[。.!！？?]?\s*$/iu;

function hasControlCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function containsSensitiveReferenceOrDestination(value: string) {
  const text = value.normalize("NFKC");
  return SENSITIVE_REFERENCE_PATTERN.test(text)
    || SENSITIVE_QUALIFIED_REFERENCE_PATTERN.test(text)
    || EXTERNAL_DESTINATION_PATTERN.test(text);
}

export function personalSkillBuilderMessageIsSafe(rawMessage: string) {
  return !containsSensitiveReferenceOrDestination(rawMessage);
}

export function personalSkillBuilderRequestIsComplete(rawMessage: string) {
  const normalized = rawMessage.normalize("NFKC").toLocaleLowerCase("en-AU");
  const englishTokens = normalized.match(/[a-z0-9]+/gu) || [];
  const englishBoilerplate = new Set([
    "a", "add", "agent", "an", "build", "configure", "create", "do", "e3", "for", "help", "i",
    "kindly", "like", "make", "me", "my", "need", "new", "ok", "okay", "one", "personal", "please",
    "save", "set", "skill", "skills", "that", "the", "to", "up", "want", "would", "write", "you",
  ]);
  const englishDetail = englishTokens.filter((token) => !englishBoilerplate.has(token)).join("");
  const chineseDetail = normalized
    .replace(/e3\s*agent|agent|skills?|技能/giu, "")
    .replace(/帮我|替我|麻烦|请|我想要|我想|我要|我需要|让|创建|新增|添加|加|新建|设置|配置|编写|写|做|保存|一个|新的|我的|个人|好的|现在|然后/gu, "")
    .replace(/[^\p{Script=Han}\p{N}]+/gu, "");
  const hasMeaningfulLength = englishDetail.length >= 5 || chineseDetail.length >= 4;
  if (!hasMeaningfulLength) return false;
  if (READ_TASK_DETAIL_PATTERN.test(normalized)) return true;
  return DATA_SCOPE_DETAIL_PATTERN.test(normalized) && !NAME_ONLY_DETAIL_PATTERN.test(normalized);
}

function safeClarification(value: unknown) {
  if (typeof value !== "string") throw new ManagedSkillError("The Skill Builder proposal is invalid.");
  const question = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!question || question.length > MAX_CLARIFICATION || hasControlCharacters(question)
    || containsSensitiveReferenceOrDestination(question)) {
    throw new ManagedSkillError("The Skill Builder proposal is invalid.");
  }
  return question;
}

function builderProposalIsUnsafe(skill: CreateManagedSkillInput) {
  const text = `${skill.name}\n${skill.description}\n${skill.trigger}\n${skill.prompt}`.normalize("NFKC").toLocaleLowerCase("en-AU");
  const readOnlyPrompt = /^(?:(?:summari[sz]e|show|list|find|search|explain|compare|report|review|check|identify|describe|answer|provide|calculate|count|total|analyse|analyze|read)\b|write\s+(?:a\s+|the\s+)?(?:summary|report|overview)\b|(?:汇总|总结|显示|查看|列出|查找|搜索|说明|解释|比较|对比|报告|检查|识别|描述|回答|提供|计算|统计|读取|分析)|写(?:一份)?(?:汇总|总结|报告))/iu.test(skill.prompt.trim());
  const unattended = /\b(?:automatically|autonomously|in\s+the\s+background|without\s+(?:me|a\s+user)\s+asking|daily\s+at|weekly\s+at|monitor\s+continuously|keep\s+watching)\b|自动(?:执行|运行|发送|更新|检查)?|后台(?:执行|运行|监控)|定时(?:执行|运行|发送)|每天自动|每周自动/u.test(text);
  return !readOnlyPrompt
    || containsSensitiveReferenceOrDestination(text)
    || unattended
    || UNSUPPORTED_ACTION_CLAUSE_PATTERN.test(skill.prompt.normalize("NFKC"));
}

export function isPersonalSkillBuilderIntent(rawMessage: string) {
  const message = rawMessage.normalize("NFKC").trim();
  if (!message) return false;
  if (/\b(?:do\s+not|don't|dont|never|stop|avoid)\b.{0,30}\b(?:create|make|build|add|write|set(?:\s*up)?|configure|save)\b.{0,40}\bskills?\b|(?:不要|别|不用|禁止|停止).{0,24}(?:创建|新增|添加|加|新建|设置|配置|编写|写|做|保存).{0,20}(?:skills?|技能)/iu.test(message)) {
    return false;
  }
  if (/\b(?:do\s+not|don't|dont|never|wait|hold\s+off|not\s+now)\b.{0,30}\b(?:create|make|build|add|write|set(?:\s*up)?|configure|save|it|that)\b|\b(?:create|make|build|add|write|set(?:\s*up)?|configure|save)\b.{0,30}\b(?:later|not\s+now|not\s+yet)\b|(?:不要|先别|暂时不要|现在不要|等一下|稍后再).{0,20}(?:创建|新增|添加|加|新建|设置|配置|编写|写|做|保存|它|这个)|(?:创建|新增|添加|加|新建|设置|配置|编写).{0,20}(?:以后再说|稍后再|暂时不要|先不要|现在不要)/iu.test(message)) {
    return false;
  }
  if (/\b(?:(?:how|where|when)\s+to|(?:how|what|where|when|why)\s+(?:do|can|should|would)\s+(?:i|we|you)|(?:can|could|would)\s+you\s+(?:explain|show|tell)(?:\s+me)?\s+how\s+to|(?:explain|show|tell)\s+me\s+how\s+to)\s+(?:create|make|build|add|write|set(?:\s*up)?|configure)\b.{0,40}\bskills?\b|(?:如何|怎么|怎样).{0,24}(?:创建|新增|添加|加|新建|设置|配置|编写).{0,20}(?:skills?|技能)/iu.test(message)) {
    return false;
  }
  if (/\bskills?\s+(?:permissions?|settings?|configuration|documentation|docs?|guide|manual)\b|(?:skills?|技能)\s*(?:权限|设置|配置|文档|说明|指南|手册)/iu.test(message)) {
    return false;
  }
  if (/\bskills?\b.{0,40}\b(?:what\s+does\s+(?:that|it)\s+mean|what\s+(?:permissions?|access)|which\s+permissions?|how\s+(?:does|do|would)|why\s+(?:would|do|does)|(?:will|would|does|can)\s+(?:it|this|that))\b|(?:skills?|技能).{0,40}(?:是什么意思|什么(?:意思|权限)|需要.{0,8}权限|如何|怎么|为什么|能做什么|有什么作用|会不会|是否会|会.{0,16}吗|是否.{0,8}(?:覆盖|替换|影响))/iu.test(message)) {
    return false;
  }
  const withoutVocative = message.replace(
    /^(?:(?:okay|ok|all\s+right|hey)[,\s]+)?(?:e3\s+agent|agent)[,，:\s]+|^(?:okay|ok|all\s+right)[,，:\s]+/iu,
    "",
  );
  const englishAction = String.raw`(?:create|make|build|add|write|set\s*up)`;
  const englishSkill = String.raw`(?:an?\s+|new\s+|personal\s+|agent\s+)*skills?`;
  const directEnglish = new RegExp(
    String.raw`^(?:(?:please|kindly)\s+(?:help\s+me\s+)?${englishAction}\s+(?:me\s+)?${englishSkill}\b|${englishAction}\s+(?:me\s+)?${englishSkill}\b|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+)?${englishAction}\s+(?:me\s+)?${englishSkill}\b|i(?:'d\s+like|\s+(?:want|need|would\s+like))\s+(?:(?:you\s+to\s+|to\s+)?${englishAction}\s+)?${englishSkill}\b)`,
    "iu",
  );
  const chineseMessage = withoutVocative.replace(/^(?:好的?|现在|然后)[，,\s]*/u, "");
  const directChinese = /^(?:(?:(?:请|麻烦)(?:帮我|替我)?|帮我|替我|(?:可以|能|能不能)(?:请)?帮我)?(?:创建|新增|添加|新建|编写|写|做).{0,40}(?:一个|个|新的|新|我的|个人)?\s*(?:skills?|技能)|(?:(?:请|麻烦)(?:帮我|替我)?|帮我|替我|(?:可以|能|能不能)(?:请)?帮我)?加\s*(?:一个|个|新的|新|我的|个人)\s*(?:skills?|技能)|(?:(?:请|麻烦)(?:帮我|替我)?|帮我|替我|(?:可以|能|能不能)(?:请)?帮我)?(?:设置|配置)\s*(?:一个|个|新的|新|我的|个人)\s*(?:skills?|技能)|(?:我想要|我要|我需要).{0,24}(?:一个|个|新的|新|我的|个人)?\s*(?:skills?|技能)|我想(?:让\s*(?:e3\s*)?agent\s*(?:帮我)?|请|要)?\s*(?:创建|新增|添加|加|新建|设置|配置|编写|写|做).{0,40}(?:skills?|技能))/iu;
  return directEnglish.test(withoutVocative) || directChinese.test(chineseMessage);
}

export function parsePersonalSkillBuilderProposal(value: unknown): PersonalSkillBuilderProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedSkillError("The Skill Builder proposal is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.action === "clarify") {
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "question")) {
      throw new ManagedSkillError("The Skill Builder proposal is invalid.");
    }
    return { action: "clarify", question: safeClarification(record.question) };
  }
  if (record.action === "create") {
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "skill")) {
      throw new ManagedSkillError("The Skill Builder proposal is invalid.");
    }
    const skill = parseCreateManagedSkillInput(record.skill);
    if (!skill.enabled || builderProposalIsUnsafe(skill)) {
      throw new ManagedSkillError("The proposed Skill is not a supported read-only, manually triggered workflow.");
    }
    return { action: "create", skill };
  }
  throw new ManagedSkillError("The Skill Builder proposal is invalid.");
}

function isChinese(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function safeRetryAnswer(message: string) {
  return isChinese(message)
    ? "我还不能安全地创建这个 Skill。请说明它要完成的只读任务、使用哪些数据，以及你想用哪句话触发它。"
    : "I cannot safely create that Skill yet. Describe its read-only task, the data it should use, and the exact phrase that should trigger it.";
}

function triggerConflictAnswer(message: string) {
  return isChinese(message)
    ? "这个触发词已被你的另一个 Skill 使用。请换一个明确且唯一的触发词。"
    : "That trigger is already used by one of your Skills. Choose a clear, unique trigger phrase.";
}

function skillLimitAnswer(message: string) {
  return isChinese(message)
    ? "你的个人 Skill 已达到上限。请先在 My Agent Skills 中删除一个，再创建新的 Skill。"
    : "Your personal Skill limit has been reached. Delete one in My Agent Skills before creating another.";
}

function createdAnswer(skill: AgentManagedSkill, message: string) {
  return isChinese(message)
    ? `已创建个人 Skill **${skill.name}**。\n\n触发词：\`${skill.trigger.replaceAll("`", "\\`")}\`\n\n它已保存到 My Agent Skills，并且只对你的账户生效。`
    : `Created your personal Skill **${skill.name}**.\n\nTrigger: \`${skill.trigger.replaceAll("`", "\\`")}\`\n\nIt is saved in My Agent Skills and applies only to your account.`;
}

export async function runPersonalSkillBuilder(input: {
  message: string;
  owner: ManagedSkillOwner;
  requestId: string;
  propose: PersonalSkillProposalProvider;
}): Promise<PersonalSkillBuilderResult> {
  const message = input.message.normalize("NFKC").trim().slice(0, MAX_BUILDER_MESSAGE);
  const existing = await findManagedAgentSkillByCreationRequestId(input.owner, input.requestId);
  if (existing) return { status: "created", skill: existing, answer: createdAnswer(existing, message) };
  if (!personalSkillBuilderRequestIsComplete(message)) {
    return { status: "clarification", answer: safeRetryAnswer(message) };
  }
  let proposal: PersonalSkillBuilderProposal;
  try {
    proposal = parsePersonalSkillBuilderProposal(await input.propose({ message }));
  } catch (error) {
    if (error instanceof ManagedSkillError) {
      return { status: "clarification", answer: safeRetryAnswer(message) };
    }
    throw error;
  }
  if (proposal.action === "clarify") {
    return { status: "clarification", answer: proposal.question };
  }
  try {
    const skill = await createManagedAgentSkill(proposal.skill, input.owner, { requestId: input.requestId });
    return { status: "created", skill, answer: createdAnswer(skill, message) };
  } catch (error) {
    if (error instanceof ManagedSkillError && error.code === "skill_trigger_exists") {
      return { status: "clarification", answer: triggerConflictAnswer(message) };
    }
    if (error instanceof ManagedSkillError && error.code === "skill_limit") {
      return { status: "clarification", answer: skillLimitAnswer(message) };
    }
    if (error instanceof ManagedSkillError && (error.code === "skills_conflict" || error.code === "skill_conflict")) {
      return { status: "clarification", answer: safeRetryAnswer(message) };
    }
    throw error;
  }
}
